/**
 * Waits until `predicate` holds, yielding to the event loop between checks, and fails once
 * `timeoutMs` of real time has passed.
 *
 * Bounded by time, not by a count of yields. Real filesystem work runs on libuv's thread pool, and
 * on a loaded two-core CI runner it outlasted the fixed 500 turns each suite used to allow, so tests
 * passed on a laptop and failed on GitHub. `performance.now()` keeps the deadline real: no suite
 * fakes it, so this works under `vi.useFakeTimers` as long as `setImmediate` stays real.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(`waitFor timed out waiting for: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
