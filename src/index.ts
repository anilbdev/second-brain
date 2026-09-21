import { SessionDO, type Citation } from "./session-do";
import { IngestWorkflow, type IngestParams } from "./ingest-workflow";

export { SessionDO, IngestWorkflow };

const COOKIE = "sb_sid";
const YEAR = 60 * 60 * 24 * 365;

function getSession(request: Request): { sid: string; setCookie: string | null } {
  const raw = request.headers.get("cookie") ?? "";
  const m = raw.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`));
  if (m) return { sid: m[1], setCookie: null };
  const sid = crypto.randomUUID();
  return {
    sid,
    setCookie: `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${YEAR}`,
  };
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function handleIngest(request: Request, env: Env, sid: string): Promise<Response> {
  const body = await request.json<{ url?: string; text?: string; title?: string }>();
  const noteId = crypto.randomUUID();

  let source: IngestParams["source"];
  let provisionalTitle: string;
  if (body.url) {
    source = { kind: "url", url: body.url };
    provisionalTitle = body.url;
  } else if (body.text?.trim()) {
    source = { kind: "text", text: body.text, title: body.title };
    provisionalTitle =
      body.title?.trim() || body.text.trim().split("\n")[0].slice(0, 80);
  } else {
    return json({ error: "Provide either `url` or `text`." }, { status: 400 });
  }

  const instance = await env.INGEST.create({
    params: { source, noteId, sessionId: sid },
  });

  const session = env.SESSION.get(env.SESSION.idFromName(sid));
  await session.addNote({
    id: noteId,
    title: provisionalTitle,
    status: "processing",
    workflowId: instance.id,
    createdAt: Date.now(),
  });

  return json({ noteId, workflowId: instance.id });
}

async function handleIngestStatus(workflowId: string, env: Env): Promise<Response> {
  const instance = await env.INGEST.get(workflowId);
  const status = await instance.status();
  return json(status);
}

async function handleChat(request: Request, env: Env, sid: string): Promise<Response> {
  const { question } = await request.json<{ question: string }>();
  if (!question?.trim()) {
    return json({ error: "`question` required" }, { status: 400 });
  }

  const embRes = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [question],
  });
  const queryVec = (embRes as { data: number[][] }).data[0];

  const results = await env.VECTORIZE.query(queryVec, {
    topK: 5,
    returnMetadata: "all",
    filter: { sessionId: sid },
  });

  const contextBlocks = results.matches.map((m, i) => {
    const md = m.metadata as { title: string; text: string; noteId: string };
    return `[${i + 1}] ${md.title}\n${md.text}`;
  });
  const citations: Citation[] = results.matches.map((m) => {
    const md = m.metadata as { title: string; text: string; noteId: string };
    return {
      noteId: md.noteId,
      title: md.title,
      snippet: md.text.slice(0, 200),
    };
  });

  const session = env.SESSION.get(env.SESSION.idFromName(sid));
  const history = await session.getHistory();

  const messages = [
    {
      role: "system" as const,
      content:
        "You are the user's second brain: an assistant that answers questions using ONLY the numbered notes below. If the notes do not contain the answer, say so plainly rather than guessing. Cite sources inline as [1], [2] matching the numbered notes.\n\nNotes:\n" +
        (contextBlocks.join("\n\n---\n\n") || "(no notes ingested yet)"),
    },
    ...history.slice(-10).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: question },
  ];

  const stream = (await env.AI.run(
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    { messages, stream: true, max_tokens: 800 },
  )) as ReadableStream;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    let answer = "";
    let buffer = "";
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const obj = JSON.parse(data) as { response?: string };
            if (obj.response) answer += obj.response;
          } catch {
            /* ignore malformed lines */
          }
        }
      }
      await writer.write(
        encoder.encode(
          `event: citations\ndata: ${JSON.stringify(citations)}\n\n`,
        ),
      );
    } catch (err) {
      await writer.write(
        encoder.encode(
          `event: error\ndata: ${JSON.stringify({ message: String(err) })}\n\n`,
        ),
      );
    } finally {
      await writer.close();
      const ts = Date.now();
      await session.appendMessage({ role: "user", content: question, ts });
      await session.appendMessage({
        role: "assistant",
        content: answer,
        citations,
        ts: ts + 1,
      });
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

async function handleHistory(env: Env, sid: string): Promise<Response> {
  const session = env.SESSION.get(env.SESSION.idFromName(sid));
  return json({ history: await session.getHistory() });
}

async function handleClearHistory(env: Env, sid: string): Promise<Response> {
  const session = env.SESSION.get(env.SESSION.idFromName(sid));
  await session.clearHistory();
  return json({ ok: true });
}

async function handleListNotes(env: Env, sid: string): Promise<Response> {
  const session = env.SESSION.get(env.SESSION.idFromName(sid));
  return json({ notes: await session.listNotes() });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { sid, setCookie } = getSession(request);

    let response: Response;
    try {
      if (url.pathname === "/api/ingest" && request.method === "POST") {
        response = await handleIngest(request, env, sid);
      } else if (
        url.pathname.startsWith("/api/ingest/") &&
        request.method === "GET"
      ) {
        response = await handleIngestStatus(
          url.pathname.slice("/api/ingest/".length),
          env,
        );
      } else if (url.pathname === "/api/chat" && request.method === "POST") {
        response = await handleChat(request, env, sid);
      } else if (url.pathname === "/api/notes" && request.method === "GET") {
        response = await handleListNotes(env, sid);
      } else if (url.pathname === "/api/history" && request.method === "GET") {
        response = await handleHistory(env, sid);
      } else if (url.pathname === "/api/history" && request.method === "DELETE") {
        response = await handleClearHistory(env, sid);
      } else {
        response = await env.ASSETS.fetch(request);
      }
    } catch (err) {
      console.error("Unhandled error:", err);
      response = json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }

    if (setCookie) {
      const headers = new Headers(response.headers);
      headers.append("set-cookie", setCookie);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
