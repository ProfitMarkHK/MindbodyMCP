/**
 * The site's late-cancel window. The Mindbody v6 spec exposes no such value
 * (`Program.CancelOffset` is undocumented: no unit, no meaning), so the operator
 * states it. Without it a `lateCancel: true` request is refused, never guessed.
 */
export const LATE_CANCEL_WINDOW_ENV = 'MINDBODY_LATE_CANCEL_WINDOW_HOURS';

export const LATE_CANCEL_WINDOW_UNKNOWN =
  `late cancel refused: the site's late-cancel window is unknown. Set ${LATE_CANCEL_WINDOW_ENV} ` +
  'to the number of hours before the start within which a cancellation counts as late, or cancel without lateCancel';

/** The configured window in hours, or undefined when unset or not a positive number. */
export function lateCancelWindowHours(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[LATE_CANCEL_WINDOW_ENV]?.trim();
  if (!raw) return undefined;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

/** Why a late cancel of something starting at `startMs` is refused, or null if it is inside the window. */
export function lateCancelWindowRefusal(startMs: number, nowMs: number, windowHours: number): string | null {
  if (startMs - nowMs <= windowHours * 3_600_000) return null;
  return `late cancel refused: it starts more than ${windowHours} hour(s) from now, outside the site's late-cancel window; cancel without lateCancel`;
}
