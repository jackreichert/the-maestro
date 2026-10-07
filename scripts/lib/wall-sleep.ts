/**
 * Sleep that survives a closed lid. A Node timer runs on a clock that stops while macOS sleeps, so one long `setTimeout`
 * resumes late by however long the machine was asleep. `sleepUntil` sleeps in chunks of at most CHUNK_SECONDS and re-reads the
 * wall clock after each, so the caller catches up within a chunk of waking. `onChunk` runs before every chunk (the heartbeat).
 */
export const CHUNK_SECONDS = 60;

export interface WallSleepDeps {
  now?: () => number;
  /** Real sleep for the given seconds; replaced in tests. */
  sleep: (seconds: number) => Promise<void>;
  chunkSeconds?: number;
  /** Called before each chunk with the planned end (epoch ms). */
  onChunk?: (until: number) => void;
}

/** Sleeps until the wall clock reaches `until` (epoch ms). Returns at once when it already has. */
export async function sleepUntil(until: number, { now = Date.now, sleep, chunkSeconds = CHUNK_SECONDS, onChunk }: WallSleepDeps): Promise<void> {
  for (let left = until - now(); left > 0; left = until - now()) {
    onChunk?.(until);
    await sleep(Math.min(chunkSeconds, Math.max(0.05, left / 1000)));
  }
}
