import { DurableObject } from "cloudflare:workers";

export interface Citation {
  noteId: string;
  title: string;
  snippet: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  ts: number;
}

export interface Note {
  id: string;
  title: string;
  summary?: string;
  status: "processing" | "ready" | "failed";
  error?: string;
  workflowId?: string;
  chunks?: number;
  createdAt: number;
}

const MAX_HISTORY = 40;

export class SessionDO extends DurableObject<Env> {
  async appendMessage(msg: ChatMessage): Promise<void> {
    const history = (await this.ctx.storage.get<ChatMessage[]>("history")) ?? [];
    history.push(msg);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    await this.ctx.storage.put("history", history);
  }

  async getHistory(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>("history")) ?? [];
  }

  async clearHistory(): Promise<void> {
    await this.ctx.storage.delete("history");
  }

  async addNote(note: Note): Promise<void> {
    const notes = (await this.ctx.storage.get<Note[]>("notes")) ?? [];
    notes.unshift(note);
    await this.ctx.storage.put("notes", notes);
  }

  async updateNote(id: string, patch: Partial<Note>): Promise<void> {
    const notes = (await this.ctx.storage.get<Note[]>("notes")) ?? [];
    const idx = notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    notes[idx] = { ...notes[idx], ...patch };
    await this.ctx.storage.put("notes", notes);
  }

  async listNotes(): Promise<Note[]> {
    return (await this.ctx.storage.get<Note[]>("notes")) ?? [];
  }
}
