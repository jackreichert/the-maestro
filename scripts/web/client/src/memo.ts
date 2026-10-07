/** Memoising by string key. Pure and DOM-free, so node:test covers it. */

/** Wrap `make` so each distinct key is built once and every later call with that key gets the same value back. */
export function memoByKey<T>(make: (key: string) => T): (key: string) => T {
  const made = new Map<string, T>();
  return (key) => {
    if (!made.has(key)) made.set(key, make(key));
    return made.get(key) as T;
  };
}
