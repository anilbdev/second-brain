# Second Brain

An AI agent that answers questions grounded in **your own notes**. Paste a URL
or some text, and it ingests, summarizes, chunks, embeds, and indexes it.
Ask a question and it retrieves the most relevant chunks, feeds them to an
LLM, and streams a cited answer.

Built on Cloudflare's stack as the take-home for a Software Engineer role.

**Live demo:** https://second-brain.anilbdev.workers.dev

---

## What's in the box

The assignment required an AI application with four components. Each one has a
real reason to be here — nothing is decorative.

| Requirement | This project | Why this primitive |
| --- | --- | --- |
| **LLM** | Workers AI · `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for chat and summarization; `@cf/baai/bge-base-en-v1.5` for embeddings | Fast, on-network, no external API keys |
| **Workflow / coordination** | Cloudflare **Workflows** — `IngestWorkflow` (fetch → summarize → chunk → embed → store → mark ready) | Ingest is genuinely multi-step and each step benefits from retries with exponential backoff |
| **UI** | Static HTML/CSS/JS served via the Worker's **assets binding** | Zero-build single page; streams responses over SSE |
| **Memory / state** | **Vectorize** (semantic recall over chunks) + **Durable Object** per session (conversation history + notes list) | Two kinds of memory with different consistency and access patterns — Vectorize for semantic retrieval, DO for strongly-consistent per-session state |

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Browser (chat UI)  ──  public/index.html + app.js         │
└──────────────┬───────────────────────────┬─────────────────┘
               │ POST /api/ingest           │ POST /api/chat
               ▼                            ▼
┌─────────────────────────┐    ┌───────────────────────────┐
│  Worker (router)        │    │  Worker (chat handler)    │
│  src/index.ts           │    │                           │
│                         │    │  1. embed(question)       │
│  starts →               │    │  2. VECTORIZE.query()     │
└──────┬──────────────────┘    │     filter by sessionId   │
       ▼                       │  3. SESSION.getHistory()  │
┌─────────────────────────┐    │  4. AI.run(llama, stream) │
│  IngestWorkflow         │    │  5. SESSION.appendMessage │
│  src/ingest-workflow.ts │    │  6. stream reply (SSE)    │
│                         │    └──────────┬────────────────┘
│  step 1: fetch source   │               │
│  step 2: summarize      │        ┌──────┴──────┬────────────┐
│  step 3: chunk          │        ▼             ▼            ▼
│  step 4: embed batches  │   ┌──────────┐  ┌──────────┐  ┌──────────┐
│  step 5: upsert vectors │──▶│ Workers  │  │Vectorize │  │SessionDO │
│  step 6: mark ready     │   │   AI     │  │  index   │  │(per-user │
└─────────────────────────┘   │ (llama + │  │ 768-dim  │  │ SQLite)  │
                              │  bge)    │  │  cosine  │  │          │
                              └──────────┘  └──────────┘  └──────────┘
```

## Design notes

- **Sessions are cookie-based.** No auth, no signup — first request sets an
  `sb_sid` cookie. That id becomes both the Durable Object key and the
  `sessionId` metadata on every vector, so all queries are naturally scoped
  to the current user.
- **Vectorize is filtered by `sessionId`** via a metadata index. One shared
  index, many logical namespaces.
- **The workflow calls back into the DO** to update the note's status
  (`processing` → `ready`/`failed`), so the UI polls one endpoint (`/api/notes`)
  for both metadata and progress.
- **SSE streaming** — the chat endpoint proxies Workers AI's SSE stream and
  appends a final `event: citations` frame once generation is done. The client
  parses both event types in the same loop.
- **Retries live in the workflow steps**, not in application code. Fetch and
  embed steps use exponential backoff so transient failures don't kill an
  ingest.

## Repository layout

```
├── src/
│   ├── index.ts             HTTP router + chat handler
│   ├── ingest-workflow.ts   Multi-step ingest workflow
│   └── session-do.ts        Durable Object: history + notes list
├── public/                  Static UI (served via ASSETS binding)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── wrangler.jsonc           All bindings: AI, Vectorize, DO, Workflow, Assets
├── package.json
└── tsconfig.json
```

## API

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/ingest` | Body: `{ url }` or `{ text, title? }`. Kicks off `IngestWorkflow`, returns `{ noteId, workflowId }` |
| `GET`  | `/api/ingest/:workflowId` | Raw workflow status |
| `GET`  | `/api/notes` | List of ingested notes for this session, with status |
| `POST` | `/api/chat` | Body: `{ question }`. Streams SSE: token chunks then a final `event: citations` frame |
| `GET`  | `/api/history` | Conversation history for this session |
| `DELETE` | `/api/history` | Clear conversation history |

All routes are session-scoped via the `sb_sid` cookie.

## Run it yourself

Prerequisites: Node 18+, a Cloudflare account.

```bash
npm install
npx wrangler login
npx wrangler vectorize create second-brain-notes --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index second-brain-notes \
  --property-name=sessionId --type=string
npx wrangler deploy
```

For local development:

```bash
npm run dev
# opens http://localhost:8787
```

`wrangler dev` binds remotely for Workers AI, Vectorize, and Workflows by
default, so the local server exercises the real cloud resources.

## Cost / limits notes

Everything used here is on Cloudflare's free tier or has generous free limits:

- Workers AI — free daily neuron quota; Llama 3.3 costs are visible in the
  dashboard once you exceed it
- Vectorize — 5M stored vectors and 30M queried vectors/month free
- Workflows — free during beta
- Durable Objects — SQLite-backed DOs are free on the Workers plan

## What I'd add next

- **Deduplication.** Same URL ingested twice creates duplicate chunks. A hash
  check in the workflow would fix it.
- **Delete a note.** Trivial API + Vectorize `deleteByIds`; ran out of
  weekend.
- **Better chunking.** Character-window chunking is fine for a demo; a
  semantic-boundary splitter (paragraphs, headings) would improve retrieval
  quality.
- **Auth.** Cookie-based sessions are enough for a demo. Real users would
  need OAuth (Google/GitHub) and a proper `user_id` on every vector.
