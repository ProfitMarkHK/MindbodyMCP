/**
 * Error-value normalisation.
 *
 * `catch` blocks receive `unknown` in this repo (it compiles under `--strict`
 * with `useUnknownInCatchVariables`), so a thrown value may be an `Error`, a
 * string, an Axios-like object, or anything else. These helpers read a value
 * out of `unknown` without widening it to `any`.
 */

/** Read a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === 'string') return error.trim() !== '' ? error : fallback;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return fallback;
}
