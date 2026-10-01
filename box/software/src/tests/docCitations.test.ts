import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `§` citation resolves to a heading that exists.
 *
 * The source cites the spec by section — `PRODUCT.md §6`, `docs/hardware.md § Audio` — which is why
 * PRODUCT.md's sections must never be renumbered. That rule was a sentence in CLAUDE.md, and named
 * citations had already drifted: `architecture.md § Networking` pointed at a bold paragraph, not a
 * heading. This reads every citation in the box, the docs and the root documents and checks it.
 *
 * A bare `§N` or `§ Name` means PRODUCT.md. A document named just before the `§` (`hardware.md §`,
 * `` `docs/architecture.md` § ``) is the one searched instead. A named citation matches a heading
 * when either one starts with the other, so `§ Hardware status` finds "Hardware status: one
 * reference board, proven…" and a sentence running on after the name still resolves. A `§`
 * followed by a backtick is the symbol being talked about, not a citation.
 */

const REPO = resolve(import.meta.dirname, '../../../..');

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'coverage',
  'release',
  'data',
  'sounds',
  '.git',
  'out',
  '.next',
]);
const TEXT = /\.(ts|md|css|sh|html)$/;
/**
 * A dated record, not a living document: its citations describe the tree on the day it was
 * written, and it uses `§N` as a placeholder.
 */
const HISTORICAL = new Set(['docs/review-2026-09.md']);
/** This file, which talks about citations rather than making them. */
const SELF = relative(REPO, import.meta.filename);

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (SKIP_DIRECTORIES.has(name)) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return walk(path);
    return TEXT.test(name) ? [path] : [];
  });
}

const FILES = [
  ...walk(join(REPO, 'box/software/src')),
  ...walk(join(REPO, 'box/software/public')),
  ...walk(join(REPO, 'box/software/scripts')),
  ...walk(join(REPO, 'box/software/deploy')),
  ...walk(join(REPO, 'docs')),
  ...[
    'README.md',
    'CLAUDE.md',
    'PENDING.md',
    'box/software/README.md',
    'box/software/CLAUDE.md',
  ].map((path) => join(REPO, path)),
].filter((path) => !HISTORICAL.has(relative(REPO, path)) && relative(REPO, path) !== SELF);

const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[*`_"“”]/g, '')
    .replaceAll(/\s+/g, ' ')
    .trim();

/** Heading texts per markdown file, normalised, with "6. " numbering kept and also stripped. */
const HEADINGS = new Map(
  FILES.filter((path) => path.endsWith('.md')).map((path) => {
    // Fenced code is dropped first: a `# comment` in a shell block is not a heading.
    const prose = readFileSync(path, 'utf8').replaceAll(/^```[\s\S]*?^```/gm, '');
    const headings = [...prose.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].flatMap(([, text = '']) => {
      const heading = normalise(text);
      return [heading, heading.replace(/^\d+\.\s*/, '')];
    });
    return [path, headings];
  }),
);

function documentsNamed(name: string | undefined): string[] {
  const wanted = name ?? 'PRODUCT.md';
  const exact = [...HEADINGS.keys()].filter((path) => relative(REPO, path).endsWith(wanted));
  return exact.length > 0
    ? exact
    : [...HEADINGS.keys()].filter((path) => basename(path) === basename(wanted));
}

function resolves(document: string | undefined, cited: string): boolean {
  const candidates = documentsNamed(document);
  const number = /^(\d+)\b/.exec(cited)?.[1];
  if (number !== undefined) {
    return candidates.some((path) =>
      (HEADINGS.get(path) ?? []).some((heading) => heading.startsWith(`${number}.`)),
    );
  }
  // A name: up to the first punctuation that ends a phrase, or a closing quote.
  const name = normalise(cited.replace(/^["“]/, '').split(/["”)`,;:]|\.(\s|$)/, 1)[0] ?? '');
  if (name.length < 3) return false;
  return candidates.some((path) =>
    (HEADINGS.get(path) ?? []).some(
      (heading) => heading.startsWith(name) || name.startsWith(heading),
    ),
  );
}

type Citation = {
  readonly where: string;
  readonly document: string | undefined;
  readonly cited: string;
};

const CITATIONS: Citation[] = FILES.flatMap((path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line, index) =>
      [...line.matchAll(/(?:([\w./-]+\.md)`?\)?\s*)?§\s?([^\s§`][^§]*)/g)].map(
        ([, document, cited = '']) => ({
          where: `${relative(REPO, path)}:${String(index + 1)}`,
          document,
          cited,
        }),
      ),
    ),
);

describe('§ citations', () => {
  it('are found, numbered and named', () => {
    expect(CITATIONS.length).toBeGreaterThan(60);
    expect(CITATIONS.some(({ cited }) => /^\d/.test(cited))).toBe(true);
    expect(CITATIONS.some(({ cited }) => /^[A-Z]/.test(cited))).toBe(true);
  });

  it('each resolve to a heading in the document they name', () => {
    const broken = CITATIONS.filter(({ document, cited }) => !resolves(document, cited)).map(
      ({ where, document, cited }) =>
        `${where}: ${document ?? 'PRODUCT.md'} § ${cited.slice(0, 50)}`,
    );
    expect(broken).toEqual([]);
  });
});
