const $ = (sel) => document.querySelector(sel);

const notesList = $("#notes-list");
const notesCount = $("#notes-count");
const messages = $("#messages");
const chatForm = $("#chat-form");
const chatInput = $("#chat-input");
const urlInput = $("#url-input");
const textInput = $("#text-input");
const textTitle = $("#text-title");
const ingestUrlBtn = $("#ingest-url");
const ingestTextBtn = $("#ingest-text");
const clearBtn = $("#clear-history");

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("hidden", p.dataset.panel !== tab.dataset.tab);
    });
  });
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderNotes(notes) {
  notesCount.textContent = notes.length;
  if (notes.length === 0) {
    notesList.innerHTML =
      '<li style="color: var(--muted); font-size: 12px;">No notes yet. Ingest a URL or paste text to get started.</li>';
    return;
  }
  notesList.innerHTML = notes
    .map(
      (n) => `
      <li class="note" data-id="${n.id}">
        <div class="note-title" title="${escapeHtml(n.title)}">${escapeHtml(n.title)}</div>
        ${n.summary ? `<div class="note-summary">${escapeHtml(n.summary)}</div>` : ""}
        <div class="note-status">
          <span class="dot ${n.status}"></span>
          ${n.status === "processing" ? "Ingesting..." : ""}
          ${n.status === "ready" ? `${n.chunks ?? 0} chunks indexed` : ""}
          ${n.status === "failed" ? `Failed: ${escapeHtml(n.error ?? "unknown")}` : ""}
        </div>
      </li>
    `,
    )
    .join("");
}

async function loadNotes() {
  const res = await fetch("/api/notes");
  const { notes } = await res.json();
  renderNotes(notes);
  return notes;
}

async function loadHistory() {
  const res = await fetch("/api/history");
  const { history } = await res.json();
  if (history.length === 0) return;
  document.querySelector(".empty")?.remove();
  for (const msg of history) {
    appendMessage(msg.role, msg.content, msg.citations);
  }
}

function appendMessage(role, content, citations) {
  document.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = content;
  if (citations && citations.length > 0) {
    const cites = document.createElement("div");
    cites.className = "citations";
    cites.innerHTML = citations
      .map(
        (c, i) => `
        <div class="cite">
          <span class="cite-num">[${i + 1}]</span>
          <span><strong>${escapeHtml(c.title)}</strong> &mdash; ${escapeHtml(c.snippet)}${c.snippet.length >= 200 ? "..." : ""}</span>
        </div>
      `,
      )
      .join("");
    el.appendChild(cites);
  }
  messages.appendChild(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

async function pollNoteUntilDone(workflowId, noteId, retries = 60) {
  for (let i = 0; i < retries; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    await loadNotes();
    const li = notesList.querySelector(`[data-id="${noteId}"]`);
    if (li && !li.querySelector(".dot.processing")) return;
  }
}

async function ingest(body, btn) {
  btn.disabled = true;
  try {
    const res = await fetch("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert("Ingest failed: " + (err.error ?? res.statusText));
      return;
    }
    const { workflowId, noteId } = await res.json();
    await loadNotes();
    pollNoteUntilDone(workflowId, noteId);
  } finally {
    btn.disabled = false;
  }
}

ingestUrlBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  await ingest({ url }, ingestUrlBtn);
  urlInput.value = "";
});

ingestTextBtn.addEventListener("click", async () => {
  const text = textInput.value.trim();
  if (!text) return;
  await ingest({ text, title: textTitle.value.trim() || undefined }, ingestTextBtn);
  textInput.value = "";
  textTitle.value = "";
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  chatInput.value = "";
  appendMessage("user", question);
  const assistantEl = appendMessage("assistant", "");

  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });

  if (!res.ok || !res.body) {
    assistantEl.textContent = "Error: " + res.statusText;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let citations = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const evt of events) {
      const lines = evt.split("\n");
      let event = "message";
      let data = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data || data === "[DONE]") continue;
      if (event === "citations") {
        try {
          citations = JSON.parse(data);
        } catch {}
      } else {
        try {
          const obj = JSON.parse(data);
          if (obj.response) {
            answer += obj.response;
            assistantEl.textContent = answer;
            messages.scrollTop = messages.scrollHeight;
          }
        } catch {}
      }
    }
  }

  if (citations.length > 0) {
    const cites = document.createElement("div");
    cites.className = "citations";
    cites.innerHTML = citations
      .map(
        (c, i) => `
        <div class="cite">
          <span class="cite-num">[${i + 1}]</span>
          <span><strong>${escapeHtml(c.title)}</strong> &mdash; ${escapeHtml(c.snippet)}${c.snippet.length >= 200 ? "..." : ""}</span>
        </div>
      `,
      )
      .join("");
    assistantEl.appendChild(cites);
    messages.scrollTop = messages.scrollHeight;
  }
});

clearBtn.addEventListener("click", async () => {
  if (!confirm("Clear conversation history?")) return;
  await fetch("/api/history", { method: "DELETE" });
  messages.innerHTML = "";
  location.reload();
});

loadNotes();
loadHistory();
setInterval(() => {
  if (notesList.querySelector(".dot.processing")) loadNotes();
}, 2500);
