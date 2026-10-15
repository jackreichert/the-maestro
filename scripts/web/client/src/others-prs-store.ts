/**
 * The Others' PRs tab's list, outside any element: the app redraws the whole page on every live update, so the loaded list must survive it.
 * Dependencies are injected so node:test runs it with no browser or server. A failed read keeps the list already shown.
 */
import type { OthersPrsData } from './types.ts';

export interface OthersPrsModel { data: OthersPrsData | null; loaded: boolean }

export class OthersPrsStore {
  readonly #load: () => Promise<OthersPrsData | null>;
  readonly #listeners = new Set<() => void>();
  #model: OthersPrsModel = { data: null, loaded: false };

  constructor(load: () => Promise<OthersPrsData | null>) { this.#load = load; }

  get model(): OthersPrsModel { return this.#model; }

  subscribe(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  async load(): Promise<void> {
    const data = await this.#load();
    this.#model = { data: data ?? this.#model.data, loaded: true };
    for (const fn of this.#listeners) fn();
  }
}
