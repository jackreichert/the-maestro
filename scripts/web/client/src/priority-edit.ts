/**
 * The pure part of editing today's priorities from the page: the list arithmetic and the words. No DOM and no network,
 * so the optimistic update the component shows is the same one tested here, and the server's answer replaces it.
 */
import type { Priority } from './types.ts';

/** `3 of 5`, and whether the list is full or over the cap. */
export function counter(count: number, max: number): { label: string; full: boolean; over: boolean } {
  return { label: `${count} of ${max}`, full: count >= max, over: count > max };
}

/** Why Add is unavailable, or null when it is not. Names the cap and what to do; an over-cap list is told how many to remove. */
export function addBlockedReason(count: number, max: number): string | null {
  if (count > max) return `Over the cap (${count} of ${max}). Remove ${count - max} to add another.`;
  if (count >= max) return `Full (${count} of ${max}). Remove one first.`;
  return null;
}

/** A copy of `items` with the one at `from` moved to `to`; out-of-range indexes leave the list as it was. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= out.length || to >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x as T);
  return out;
}

/** A copy of `items` without the one at `index`. */
export const removeItem = <T>(items: readonly T[], index: number): T[] => items.filter((_, i) => i !== index);

/** The text a screen reader hears for a button that acts on one priority: the action, then which one. */
export const actionLabel = (action: string, p: Priority): string => `${action}: ${p.text}`;

/** What the page tells the user after a refused or failed edit when the server gave no message of its own. */
export const GENERIC_FAILURE = 'The change was not saved. The list is back as it was.';

const MAX_TEXT = 200;

/**
 * Why `text` (already trimmed) will not be accepted, so the page can say so before it shows a guess the server would refuse,
 * or null. The server checks the same rules again and is the one that decides.
 */
export function refuseDraft(text: string): string | null {
  if (text.length > MAX_TEXT) return `A priority is at most ${MAX_TEXT} characters.`;
  if (/[<>]/.test(text)) return 'A priority is plain text: no angle brackets.';
  if (text.includes(' | ')) return 'Leave out " | ": pick the stream in the stream box instead.';
  if (/[\u0000-\u001f\u007f]/.test(text)) return 'A priority is one line of plain text.';
  return null;
}
