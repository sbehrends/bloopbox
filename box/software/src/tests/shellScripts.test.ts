import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Rules for the shell scripts that neither ShellCheck nor the TypeScript gate can see.
 *
 * Shell is a third of this project — the installer, the root agent, the release and image builds —
 * and it runs where a failure is hardest to see: as root at boot, or inside an arm64 container.
 */

const SOFTWARE = resolve(import.meta.dirname, '../..');
const REPO = resolve(SOFTWARE, '../..');

function scripts(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map((path) => join(directory, path))
    .filter((path) => {
      if (path.endsWith('.sh')) return true;
      try {
        return /^#!.*\b(ba)?sh\b/.test(readFileSync(path, 'utf8').split('\n', 1)[0] ?? '');
      } catch {
        return false; // a directory
      }
    });
}

const SCRIPTS = [
  ...['deploy', 'scripts', 'packaging'].flatMap((directory) => scripts(join(SOFTWARE, directory))),
  join(REPO, '.githooks/pre-commit'),
].toSorted();

/** `set -o pipefail`, `set -euo pipefail`, `bash -euo pipefail -c '…'`. */
const ENABLES_PIPEFAIL = /^\s*(set|bash)\s+(-[a-z]*o\s+|-o\s+)pipefail\b/m;
/** A pipe into a grep that exits at its first match: `-q`, `-qE`, `-Fq`, `--quiet`. */
const PIPE_INTO_QUIET_GREP = /\|\s*grep\s+(-[A-Za-z]*q[A-Za-z]*|--quiet)\b/;

describe('shell scripts', () => {
  it('finds them', () => {
    expect(SCRIPTS.length).toBeGreaterThan(15);
  });

  it('never pipe into `grep -q` once pipefail is on', () => {
    /*
     * grep -q exits at the first match, the producer takes a SIGPIPE, and pipefail reports the
     * pipeline as failed: a check that passes reads as one that failed, or — under `!` — the
     * reverse. It bit three checks during bring-up and the pre-commit hook's own gate. Capture
     * the output and match it with `case` or `[[ =~ ]]` instead. doctor.sh and wifi-apply.sh
     * leave pipefail off on purpose so they can keep the idiom.
     */
    const offenders = SCRIPTS.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      if (!ENABLES_PIPEFAIL.test(source)) return [];
      return source
        .split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => !line.trimStart().startsWith('#') && PIPE_INTO_QUIET_GREP.test(line))
        .map(({ line, number }) => `${relative(REPO, path)}:${String(number)}: ${line.trim()}`);
    });
    expect(offenders).toEqual([]);
  });
});
