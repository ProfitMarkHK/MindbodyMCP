/**
 * Unit tests for SimpleCache (src/cache/index.ts): the TTL contract.
 *
 * Time is faked with bun:test's setSystemTime, which moves both Date.now()
 * and `new Date()`. SimpleCache stamps entries with Date.now() but checks
 * expiry against `new Date()`, so stubbing Date.now alone would not move
 * the clock that get() and cleanup() read.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { SimpleCache } from '../src/cache/index';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const MINUTE = 60 * 1000;

function advanceTo(msAfterT0: number): void {
  setSystemTime(new Date(T0.getTime() + msAfterT0));
}

describe('SimpleCache', () => {
  beforeEach(() => {
    setSystemTime(T0);
  });

  afterEach(() => {
    setSystemTime(); // restore the real clock
  });

  test('get() returns null for a key that was never set', () => {
    const cache = new SimpleCache(5);
    expect(cache.get('missing')).toBeNull();
    expect(cache.has('missing')).toBe(false);
  });

  test('get() returns the stored value within TTL', () => {
    const cache = new SimpleCache(5);
    const value = { id: 1, name: 'Vinyasa' };
    cache.set('class', value);

    expect(cache.get<typeof value>('class')).toEqual(value);

    advanceTo(5 * MINUTE - 1);
    expect(cache.get<typeof value>('class')).toEqual(value);
    expect(cache.has('class')).toBe(true);
  });

  test('an entry is still live at the exact expiry instant', () => {
    // Expiry is a strict `expiresAt < now`, so the boundary millisecond is live.
    const cache = new SimpleCache(5);
    cache.set('k', 'v');

    advanceTo(5 * MINUTE);
    expect(cache.get<string>('k')).toBe('v');
  });

  test('get() returns null after TTL expiry', () => {
    const cache = new SimpleCache(5);
    cache.set('k', 'v');

    advanceTo(5 * MINUTE + 1);
    expect(cache.get('k')).toBeNull();
  });

  test('get() honours a per-entry TTL over the default', () => {
    const cache = new SimpleCache(5);
    cache.set('short', 'a', 1);
    cache.set('long', 'b', 60);

    advanceTo(1 * MINUTE + 1);
    expect(cache.get('short')).toBeNull();
    expect(cache.get<string>('long')).toBe('b');

    advanceTo(60 * MINUTE + 1);
    expect(cache.get('long')).toBeNull();
  });

  test('has() returns false after TTL expiry', () => {
    const cache = new SimpleCache(5);
    cache.set('k', 'v');
    expect(cache.has('k')).toBe(true);

    advanceTo(5 * MINUTE + 1);
    expect(cache.has('k')).toBe(false);
  });

  test('an expired entry stays expired when the clock is not rewound', () => {
    // get() deletes an expired entry, so a later read cannot resurrect it.
    const cache = new SimpleCache(5);
    cache.set('k', 'v');

    advanceTo(5 * MINUTE + 1);
    expect(cache.get('k')).toBeNull();

    setSystemTime(T0);
    expect(cache.get('k')).toBeNull();
  });

  test('cleanup() removes only expired entries and leaves live entries intact', () => {
    const cache = new SimpleCache(5);
    cache.set('expired-1', 1, 1);
    cache.set('expired-2', 2, 2);
    cache.set('live-1', 3, 10);
    cache.set('live-2', 4); // default 5 minutes

    advanceTo(3 * MINUTE);
    cache.cleanup();

    // Rewind the clock so get() itself cannot expire anything: what is left
    // is exactly what cleanup() kept.
    setSystemTime(T0);
    expect(cache.get('expired-1')).toBeNull();
    expect(cache.get('expired-2')).toBeNull();
    expect(cache.get<number>('live-1')).toBe(3);
    expect(cache.get<number>('live-2')).toBe(4);
  });

  test('cleanup() on a cache with nothing expired removes nothing', () => {
    const cache = new SimpleCache(5);
    cache.set('a', 1);
    cache.set('b', 2);

    cache.cleanup();
    expect(cache.get<number>('a')).toBe(1);
    expect(cache.get<number>('b')).toBe(2);
  });

  test('delete() removes a specific key without affecting others', () => {
    const cache = new SimpleCache(5);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    cache.delete('b');

    expect(cache.get('b')).toBeNull();
    expect(cache.has('b')).toBe(false);
    expect(cache.get<number>('a')).toBe(1);
    expect(cache.get<number>('c')).toBe(3);
  });

  test('delete() of an unknown key is a no-op', () => {
    const cache = new SimpleCache(5);
    cache.set('a', 1);

    cache.delete('never-set');
    expect(cache.get<number>('a')).toBe(1);
  });

  test('clear() empties the entire cache', () => {
    const cache = new SimpleCache(5);
    cache.set('a', 1);
    cache.set('b', 'two');
    cache.set('c', { three: 3 }, 60);

    cache.clear();

    for (const key of ['a', 'b', 'c']) {
      expect(cache.get(key)).toBeNull();
      expect(cache.has(key)).toBe(false);
    }
  });

  test('set() overwrites an existing key and restarts its TTL', () => {
    const cache = new SimpleCache(5);
    cache.set('k', 'old');

    advanceTo(4 * MINUTE);
    cache.set('k', 'new');

    advanceTo(8 * MINUTE); // 9 min after first set, 4 min after second
    expect(cache.get<string>('k')).toBe('new');

    advanceTo(9 * MINUTE + 1);
    expect(cache.get('k')).toBeNull();
  });

  test('instances do not share entries', () => {
    const a = new SimpleCache(5);
    const b = new SimpleCache(5);
    a.set('k', 'a');

    expect(b.get('k')).toBeNull();
  });
});
