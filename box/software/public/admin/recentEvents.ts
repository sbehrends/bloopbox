/**
 * The health card's "Recently" list: what `GET /api/system/events` returns, narrowed and said in
 * one line each. DOM-free, so the wording is tested in node (`src/tests/adminRecentEvents.test.ts`).
 */

export type RecentEventView = {
  readonly atMs: number;
  readonly level: 'warn' | 'error' | 'fatal';
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

const LEVELS = new Set(['warn', 'error', 'fatal']);

function isRecentEvent(value: unknown): value is RecentEventView {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'atMs' in value &&
    typeof value.atMs === 'number' &&
    'level' in value &&
    typeof value.level === 'string' &&
    LEVELS.has(value.level) &&
    'message' in value &&
    typeof value.message === 'string' &&
    'fields' in value &&
    typeof value.fields === 'object' &&
    value.fields !== null
  );
}

/** The list, or null when the answer is not one: an older box, or a restart mid-request. */
export function readRecentEvents(payload: unknown): RecentEventView[] | null {
  if (typeof payload !== 'object' || payload === null || !('events' in payload)) return null;
  const { events } = payload;
  return Array.isArray(events) ? events.filter(isRecentEvent) : null;
}

/**
 * `device fault: capture-start, button 1 — ENOENT`. Only the facts a parent or a helper on the
 * phone can act on: what happened, which button, and the error's own words.
 */
export function describeRecentEvent(event: RecentEventView): string {
  const { fault, index, error } = event.fields;
  const facts = [
    typeof fault === 'string' ? fault : null,
    typeof index === 'number' ? `button ${String(index + 1)}` : null,
  ].filter((fact) => fact !== null);
  const head = facts.length > 0 ? `${event.message}: ${facts.join(', ')}` : event.message;
  return typeof error === 'string' && error.length > 0 ? `${head} — ${error}` : head;
}
