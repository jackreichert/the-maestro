/**
 * The draft queue's state outside any element: the app redraws the whole page on every live update, so what the person is typing (an edit,
 * a reject reason) and which draft is mid-request must survive it. Dependencies are injected so node:test runs it with no browser or server.
 * Approve always names the revision the card shows (`DraftRow.rev`, a hash of the text and every inline comment), so the server can refuse it if the draft changed since.
 */
import type { DraftRow, DraftsData } from './drafts-model.ts';
import type { DraftOp, DraftOutcome } from './drafts-api.ts';

/** `buffer` is the body being edited (or the reject reason); `comments` the texts of a review's inline comments, in order. */
export interface CardUi { mode: 'view' | 'edit' | 'reject'; buffer: string; comments?: string[]; busy: boolean; message?: string }
export interface DraftsModel { data: DraftsData | null; loaded: boolean; ui: Record<string, CardUi> }
export interface DraftsDeps { load(): Promise<DraftsData | null>; send(op: DraftOp, payload: Record<string, string>, comments?: string[]): Promise<DraftOutcome> }

export class DraftsStore {
  readonly #deps: DraftsDeps;
  readonly #listeners = new Set<() => void>();
  #model: DraftsModel = { data: null, loaded: false, ui: {} };

  constructor(deps: DraftsDeps) { this.#deps = deps; }
  get model(): DraftsModel { return this.#model; }
  subscribe(fn: () => void): () => void { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; }

  async load(): Promise<void> {
    const data = await this.#deps.load();
    this.#set({ data: data ?? this.#model.data, loaded: true });
  }

  #ui(id: string): CardUi { return this.#model.ui[id] ?? { mode: 'view', buffer: '', busy: false }; }
  #patch(id: string, p: Partial<CardUi>): void { this.#set({ ui: { ...this.#model.ui, [id]: { ...this.#ui(id), ...p } } }); }
  #draft(id: string): DraftRow | undefined { return this.#model.data?.drafts.find((d) => d.id === id); }
  #text(id: string): string { return this.#draft(id)?.text ?? ''; }

  startEdit(id: string): void { this.#patch(id, { mode: 'edit', buffer: this.#text(id), comments: this.#draft(id)?.review?.comments.map((c) => c.text), message: undefined }); }
  startReject(id: string): void { this.#patch(id, { mode: 'reject', buffer: '', message: undefined }); }
  cancel(id: string): void { this.#patch(id, { mode: 'view', buffer: '', message: undefined }); }
  /** Typing in an inline comment's box: kept without redrawing, like `setBuffer`. */
  setComment(id: string, index: number, text: string): void {
    const comments = [...(this.#ui(id).comments ?? [])];
    comments[index] = text;
    this.#model = { ...this.#model, ui: { ...this.#model.ui, [id]: { ...this.#ui(id), comments } } };
  }
  /** Typing: kept without redrawing, so the textarea is not rebuilt under the cursor. */
  setBuffer(id: string, buffer: string): void { this.#model = { ...this.#model, ui: { ...this.#model.ui, [id]: { ...this.#ui(id), buffer } } }; }

  async saveEdit(id: string): Promise<void> {
    const comments = this.#ui(id).comments;
    await this.#decide(id, 'edit', { id, text: this.#ui(id).buffer }, comments);
  }
  async approve(id: string): Promise<void> { await this.#decide(id, 'approve', { id, rev: this.#draft(id)?.rev ?? '' }); }
  async reject(id: string): Promise<void> { await this.#decide(id, 'reject', { id, reason: this.#ui(id).buffer }); }

  /** One decision at a time per card: a second press while one is in flight does nothing, so a double click is one request. */
  async #decide(id: string, op: DraftOp, payload: Record<string, string>, comments?: string[]): Promise<void> {
    if (this.#ui(id).busy) return;
    this.#patch(id, { busy: true, message: undefined });
    const out = await this.#deps.send(op, payload, comments);
    await this.load();   // the server's word on the state, whatever the outcome
    this.#patch(id, out.ok ? { busy: false, mode: 'view', buffer: '', message: op === 'approve' ? 'Posted.' : op === 'reject' ? 'Rejected. Nothing was posted.' : 'Saved.' } : { busy: false, message: out.message });
  }

  #set(patch: Partial<DraftsModel>): void {
    this.#model = { ...this.#model, ...patch };
    for (const fn of this.#listeners) fn();
  }
}
