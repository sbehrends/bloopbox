import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The decisions table in `docs/architecture.md` and the tests that lock each row stay in step.
 *
 * Every row names the test files that lock it, and those files cite the row's ID in a test title —
 * `describe('lockout — one button owns the box [D-05]')`. Without this, "Locked by" was a claim:
 * the table said `deviceController.test.ts` locked "whoosh after finalise", and no test there did.
 */

const ARCHITECTURE = resolve(import.meta.dirname, '../../../../docs/architecture.md');
const TESTS = import.meta.dirname;

type Decision = {
  readonly id: string;
  readonly name: string;
  readonly lockedBy: readonly string[];
};

function decisions(): Decision[] {
  const markdown = readFileSync(ARCHITECTURE, 'utf8');
  const start = markdown.indexOf('\n## Decisions the spec left open');
  if (start === -1)
    throw new Error('architecture.md has no "Decisions the spec left open" section');
  const end = markdown.indexOf('\n## ', start + 1);
  const section = markdown.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/^\| (D-\d{2}) \| ([^|]+) \|.*\| ([^|]+) \|$/gm)].map(
    ([, id = '', name = '', lockedBy = '']) => ({
      id,
      name: name.replaceAll('*', '').trim(),
      lockedBy: [...lockedBy.matchAll(/`([\w.]+\.test\.ts)`/g)].map(([, file = '']) => file),
    }),
  );
}

/** Which IDs each test file cites in a `describe` or `it` title. */
function citations(): Map<string, Set<string>> {
  const cited = new Map<string, Set<string>>();
  // Not this file: its own comments quote a citation as an example.
  const files = readdirSync(TESTS).filter(
    (name) => name.endsWith('.test.ts') && name !== 'decisions.test.ts',
  );
  for (const file of files) {
    const source = readFileSync(join(TESTS, file), 'utf8');
    const ids = new Set(
      [...source.matchAll(/\b(?:describe|it)\(\s*(['"`])((?:(?!\1).)*)\1/g)].flatMap(
        ([, , title = '']) => [...title.matchAll(/\[(D-\d{2})\]/g)].map(([, id = '']) => id),
      ),
    );
    if (ids.size > 0) cited.set(file, ids);
  }
  return cited;
}

const DECISIONS = decisions();
const CITED = citations();

describe('the decisions table', () => {
  it('is found, numbered from D-01 with no gaps or repeats', () => {
    expect(DECISIONS.length).toBeGreaterThan(10);
    expect(DECISIONS.map(({ id }) => id)).toEqual(
      DECISIONS.map((_, index) => `D-${String(index + 1).padStart(2, '0')}`),
    );
  });

  it('names test files that exist', () => {
    const files = new Set(readdirSync(TESTS));
    const missing = DECISIONS.flatMap(({ id, lockedBy }) =>
      lockedBy.filter((file) => !files.has(file)).map((file) => `${id}: ${file}`),
    );
    expect(missing).toEqual([]);
  });

  it('has every "Locked by" file cite the decision in a test title', () => {
    const uncited = DECISIONS.flatMap(({ id, name, lockedBy }) =>
      lockedBy
        .filter((file) => !CITED.get(file)?.has(id))
        .map((file) => `${id} (${name}): ${file} has no test titled [${id}]`),
    );
    expect(uncited).toEqual([]);
  });

  it('lists every file that cites a decision, and every ID cited is in it', () => {
    const known = new Map(DECISIONS.map((decision) => [decision.id, decision]));
    const stray = [...CITED].flatMap(([file, ids]) =>
      [...ids]
        .filter((id) => !known.get(id)?.lockedBy.includes(file))
        .map(
          (id) =>
            `${file} cites [${id}], which ${known.has(id) ? 'does not list it' : 'is not a decision'}`,
        ),
    );
    expect(stray).toEqual([]);
  });
});
