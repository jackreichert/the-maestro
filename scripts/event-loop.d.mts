// Declarations for the parts of event-loop.mjs that typed code imports. Delete this file when event-loop.mjs becomes event-loop.ts.
import type { CadenceConfig } from './lib/cadence.ts';
import type { TypeRegistry } from './event-types/index.ts';
import type { DigestEvent, LoopContext, Run } from './lib/types.ts';
import type { NotifyRun } from './lib/notify.ts';

export const defaultRun: Run;

export interface TickDeps {
  dir: string;
  types: TypeRegistry;
  ctx?: LoopContext;
  config?: CadenceConfig;
  now?: number;
  notifyCommand?: string[];
  notifyRun?: NotifyRun;
}

export interface TickResult {
  events: DigestEvent[];
  retired: { id: string; reason: string }[];
  skipped: string[];
  waiting: string[];
}

export function tick(deps: TickDeps): TickResult;
