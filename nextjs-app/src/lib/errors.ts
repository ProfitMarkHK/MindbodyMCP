/**
 * Normalize an unknown thrown value to a readable string.
 *
 * `catch (error)` binds `error` as `unknown` in strict TypeScript, so reading
 * `error.message` off it is a type error unless the value is first narrowed.
 * This helper does that narrowing once, so call sites can stop casting to
 * `any` and stop guessing at a message shape.
 */
export function errorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) return error.message || fallback;
  if (typeof error === 'string') return error.trim() !== '' ? error : fallback;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return fallback;
}
