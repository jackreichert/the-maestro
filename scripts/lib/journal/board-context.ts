import { fold as foldWith, mapStreamWith } from '../ledger-core.ts';
import type { Args } from './args.ts';
import type { BoardContext } from './board.ts';
import type { Store } from './store.ts';

/** The run settings the board context needs beyond the store: the flags, the clock and whether writes are suppressed. */
export interface BoardRun { has: Args['has']; today: () => string; dryRun: boolean }

/**
 * The one definition of the board context. `fold` and `mapStream` read the registry through the store on every call,
 * so a registry saved mid-run is seen by later reads. The CLI and the web app both build their board from this.
 */
export function boardContextFor(store: Store, run: BoardRun): BoardContext {
    const { readLedger, rollPoint, loadRegistry, ensureDir, dir } = store;
    return {
        readLedger,
        rollPoint,
        loadRegistry,
        ensureDir,
        dir,
        fold: (entries) => foldWith(entries, loadRegistry()),
        mapStream: (s) => mapStreamWith(loadRegistry(), s),
        today: run.today,
        has: run.has,
        dryRun: run.dryRun,
    };
}
