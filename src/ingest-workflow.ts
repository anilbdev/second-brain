import {
  WorkflowEntrypoint,
  WorkflowEvent,
  WorkflowStep,
} from "cloudflare:workers";

export interface IngestParams {
  source:
    | { kind: "url"; url: string }
    | { kind: "text"; text: string; title?: string };
  noteId: string;
  sessionId: string;
}

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;
const EMBED_BATCH = 50;
const MAX_SOURCE_CHARS = 40_000;
const MAX_SUMMARY_INPUT = 8_000;

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  const stride = CHUNK_SIZE - CHUNK_OVERLAP;
  for (let i = 0; i < text.length; i += stride) {
    const chunk = text.slice(i, i + CHUNK_SIZE).trim();
    if (chunk.length > 40) chunks.push(chunk);
    if (i + CHUNK_SIZE >= text.length) break;
  }
  return chunks;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html: string, fallback: string): string {
  const m =
    html.match(/<title>([^<]{1,200})<\/title>/i) ||
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i);
  return (m?.[1] || fallback).trim();
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const { source, noteId, sessionId } = event.payload;
    const sessionStub = this.env.SESSION.get(
      this.env.SESSION.idFromName(sessionId),
    );

    try {
      const { title, text } = await step.do(
        "fetch-source",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          if (source.kind === "url") {
            const res = await fetch(source.url, {
              headers: {
                "user-agent":
                  "Mozilla/5.0 (compatible; second-brain-bot/1.0; +https://github.com/)",
                accept:
                  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              },
              redirect: "follow",
            });
            if (!res.ok) {
              throw new Error(`Fetch failed for ${source.url}: HTTP ${res.status}`);
            }
            const html = await res.text();
            return {
              title: extractTitle(html, source.url),
              text: stripHtml(html).slice(0, MAX_SOURCE_CHARS),
            };
          }
          const cleaned = source.text.trim();
          return {
            title:
              source.title?.trim() ||
              cleaned.split("\n")[0].slice(0, 80) ||
              "Untitled note",
            text: cleaned.slice(0, MAX_SOURCE_CHARS),
          };
        },
      );

      if (!text || text.length < 20) {
        throw new Error("Source contained no meaningful text.");
      }

      const summary = await step.do(
        "summarize",
        { retries: { limit: 2, delay: "3 seconds" } },
        async () => {
          const res = await this.env.AI.run(
            "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            {
              messages: [
                {
                  role: "system",
                  content:
                    "Summarize the note in 2-3 sentences. Capture the main claims and any concrete facts. Reply with only the summary, no preamble.",
                },
                { role: "user", content: text.slice(0, MAX_SUMMARY_INPUT) },
              ],
              max_tokens: 200,
            },
          );
          return (res as { response: string }).response.trim();
        },
      );

      const chunks = await step.do("chunk", async () => chunkText(text));

      const chunkCount = await step.do(
        "embed-and-store",
        { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
        async () => {
          const vectors: Array<{
            id: string;
            values: number[];
            metadata: Record<string, string | number>;
          }> = [];

          for (let start = 0; start < chunks.length; start += EMBED_BATCH) {
            const batch = chunks.slice(start, start + EMBED_BATCH);
            const embRes = await this.env.AI.run(
              "@cf/baai/bge-base-en-v1.5",
              { text: batch },
            );
            const embeddings = (embRes as { data: number[][] }).data;
            for (let i = 0; i < batch.length; i++) {
              vectors.push({
                id: `${noteId}#${start + i}`,
                values: embeddings[i],
                metadata: {
                  noteId,
                  sessionId,
                  title,
                  chunkIdx: start + i,
                  text: batch[i].slice(0, 1500),
                },
              });
            }
          }

          if (vectors.length > 0) {
            await this.env.VECTORIZE.upsert(vectors);
          }
          return vectors.length;
        },
      );

      await step.do("mark-ready", async () => {
        await sessionStub.updateNote(noteId, {
          status: "ready",
          title,
          summary,
          chunks: chunkCount,
        });
      });

      return { noteId, title, summary, chunks: chunkCount };
    } catch (err) {
      await sessionStub.updateNote(noteId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}
