import type { EventType } from './types.ts';

/** Whether a watch of this type and target is standing: its expiry is pushed out instead of retiring it. Type-wide (`renews`) or decided by target (`renewsFor`). */
export const isStanding = (type: EventType | undefined, target: string): boolean => Boolean(type && (type.renews || type.renewsFor?.(target)));
