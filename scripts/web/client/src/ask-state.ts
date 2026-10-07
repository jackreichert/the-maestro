/**
 * What the page remembers about asks so a redraw cannot lose it, with no DOM in it so it can be tested under node.
 *
 * A live update rebuilds every card. A half-typed answer and a "copied for chat" card (the only place that
 * answer lives until the page can write to the ledger) are therefore kept here, keyed by ask id, and restored into the
 * rebuilt cards. UpdateGate decides when newer data may be shown at all: never while a pointer press is in flight (a
 * redraw between mousedown and mouseup swallows the click) or while a field the user is typing in has focus.
 */

export class AskState {
  readonly #drafts = new Map<string, string>();
  readonly #resolved = new Map<string, string>();

  draft(id: string): string { return this.#drafts.get(id) ?? ''; }

  setDraft(id: string, text: string): void {
    if (text === '') this.#drafts.delete(id);
    else this.#drafts.set(id, text);
  }

  /** The answer the card was copied for chat with, or null while it is still open. */
  resolvedAnswer(id: string): string | null { return this.#resolved.get(id) ?? null; }

  /** Settle the ask. True the first time only: a second call for an ask already settled changes nothing, so it cannot announce twice. */
  resolve(id: string, answer: string): boolean {
    if (this.#resolved.has(id)) return false;
    this.#resolved.set(id, answer);
    this.#drafts.delete(id);
    return true;
  }

  /** The user chose Edit answer: the card is open again and the answer goes back to being a draft. */
  reopen(id: string, draft: string): void {
    this.#resolved.delete(id);
    this.setDraft(id, draft);
  }

  /** Forget asks that are no longer on the board (answered elsewhere), so their text cannot come back on a reused id. */
  prune(liveIds: Iterable<string>): void {
    const keep = new Set(liveIds);
    for (const id of [...this.#drafts.keys()]) if (!keep.has(id)) this.#drafts.delete(id);
    for (const id of [...this.#resolved.keys()]) if (!keep.has(id)) this.#resolved.delete(id);
  }
}

/** The page's shared memory; ask cards read and write it. */
export const askState = new AskState();

export interface GateInput { pointer?: boolean; typing?: boolean; busy?: boolean }

/** Holds the newest data back while the user is mid-interaction, and hands it over once they are not. */
export class UpdateGate<T> {
  #held: T | null = null;
  #pointer = false;
  #typing = false;
  #busy = false;   // an action the card started has not finished (the clipboard write behind Copy answer)

  get blocked(): boolean { return this.#pointer || this.#typing || this.#busy; }
  get held(): boolean { return this.#held !== null; }

  /** New data: returned to show now, or null when it was held (and replaces anything held before). */
  offer(data: T): T | null {
    if (this.blocked) { this.#held = data; return null; }
    this.#held = null;
    return data;
  }

  /** Record what the user is doing; returns the held data when this ends the last reason to hold it. */
  set(input: GateInput): T | null {
    if (input.pointer !== undefined) this.#pointer = input.pointer;
    if (input.typing !== undefined) this.#typing = input.typing;
    if (input.busy !== undefined) this.#busy = input.busy;
    if (this.blocked || this.#held === null) return null;
    const data = this.#held;
    this.#held = null;
    return data;
  }
}
