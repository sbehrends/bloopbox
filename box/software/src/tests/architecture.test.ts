import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The layering rules, checked against the import graph instead of left to a paragraph.
 *
 * Each rule here used to live only in a CLAUDE.md or `docs/architecture.md`, which is to say it
 * held until somebody did not read it: `src/core/` was documented as I/O-free while
 * `DeviceController` imported `rm`. The walker is deliberately small and dependency-free — TS 7 no
 * longer exposes a compiler API to lean on — so it reads specifiers with regular expressions over
 * comment-stripped source. That is enough for this codebase's import style, and the first describe
 * block proves it sees the edges the rules depend on, so a parser regression cannot make every rule
 * pass by seeing nothing.
 *
 * Type-only means `import type` / `export type`. Under `verbatimModuleSyntax` that is the only form
 * erased on emit: `import { type X } from` still loads the module at runtime, so it counts as a
 * runtime edge here too.
 */

const ROOT = resolve(import.meta.dirname, '../..');

type Edge = {
  /** A repo-relative path for a local module; the package or `node:` name otherwise. */
  readonly target: string;
  readonly local: boolean;
  readonly typeOnly: boolean;
  readonly dynamic: boolean;
};

function sourceFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'))
    .map((path) => join(directory, path))
    .filter((path) => !path.startsWith('src/tests/') && !path.endsWith('.test.ts'))
    .toSorted();
}

function stripComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/(^|[^:'"\w])\/\/.*$/gm, '$1');
}

/** `node:events`, `zod`, `socket.io-client`, `@scope/name` — the package, not the subpath. */
function packageName(specifier: string): string {
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function edgesOf(file: string): Edge[] {
  const source = stripComments(readFileSync(join(ROOT, file), 'utf8'));
  const found: { specifier: string; typeOnly: boolean; dynamic: boolean }[] = [];
  for (const match of source.matchAll(
    /^\s*(?:import|export)\s+(type\s+)?[^'";]*?\bfrom\s+['"]([^'"]+)['"]/gm,
  )) {
    found.push({ specifier: match[2] ?? '', typeOnly: match[1] !== undefined, dynamic: false });
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    found.push({ specifier: match[1] ?? '', typeOnly: false, dynamic: false });
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ specifier: match[1] ?? '', typeOnly: false, dynamic: true });
  }
  return found.map(({ specifier, typeOnly, dynamic }) => {
    const local = specifier.startsWith('.');
    const target = local
      ? relative(ROOT, resolve(ROOT, dirname(file), specifier))
      : packageName(specifier);
    return { target, local, typeOnly, dynamic };
  });
}

const FILES = [...sourceFiles('src'), ...sourceFiles('public')];
const GRAPH = new Map(FILES.map((file) => [file, edgesOf(file)]));

type Walk = { readonly runtimeOnly?: boolean };

/** Every module and package reachable from `entries`, following local imports transitively. */
function reach(entries: readonly string[], { runtimeOnly = false }: Walk = {}): Set<string> {
  const seen = new Set<string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const edge of GRAPH.get(file) ?? []) {
      if (runtimeOnly && edge.typeOnly) continue;
      if (edge.local) pending.push(edge.target);
      else seen.add(edge.target);
    }
  }
  return seen;
}

const isLocal = (name: string): boolean => name.startsWith('src/') || name.startsWith('public/');
const under = (prefix: string, files: readonly string[]): string[] =>
  files.filter((file) => file.startsWith(prefix));

describe('the import walker', () => {
  it('finds every source file, and every local import resolves to one', () => {
    expect(FILES.length).toBeGreaterThan(40);
    const unresolved = [...GRAPH].flatMap(([file, edges]) =>
      edges
        .filter((edge) => edge.local && !GRAPH.has(edge.target))
        .map((e) => `${file} → ${e.target}`),
    );
    expect(unresolved).toEqual([]);
  });

  it('sees static, type-only, multi-line and dynamic imports', () => {
    expect(GRAPH.get('src/hal/index.ts')).toContainEqual(
      expect.objectContaining({ target: 'src/hal/gpioDriver.ts', dynamic: true }),
    );
    expect(GRAPH.get('src/hal/gpioDriver.ts')).toContainEqual(
      expect.objectContaining({ target: 'opengpio', typeOnly: true }),
    );
    expect(reach(under('src/core/', FILES))).toContain('src/audio/queueManager.ts');
    expect(reach(['src/processes/hardware-server.ts'])).toContain('express');
  });
});

describe('src/core/ does no I/O', () => {
  const FORBIDDEN =
    /^src\/(server|net|system|stats|whatsapp|processes)\/|^src\/hal\/(gpioDriver|simulatorDriver|mockDriver|index)\.ts$|^src\/config\/configManager\.ts$|^src\/logger\.ts$/;
  const reached = [...reach(under('src/core/', FILES))];

  it('reaches no Node built-in but events', () => {
    expect(reached.filter((name) => name.startsWith('node:'))).toEqual(['node:events']);
  });

  it('reaches no package but zod', () => {
    expect(reached.filter((name) => !isLocal(name) && !name.startsWith('node:'))).toEqual(['zod']);
  });

  it('reaches none of the modules that do I/O, even for a type', () => {
    expect(reached.filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });
});

describe('the two daemons stay apart', () => {
  it('nothing the hardware server reaches, even for a type, touches WhatsApp', () => {
    const reached = [...reach(['src/processes/hardware-server.ts'])];
    expect(
      reached.filter((name) => name === 'baileys' || name.startsWith('src/whatsapp/')),
    ).toEqual([]);
  });

  it('nothing the WhatsApp bridge reaches, even for a type, touches the HAL or GPIO', () => {
    // Type-only included since the note-file contract moved to ipc/noteFiles.ts: the bridge's
    // one path into hal/ was a type, via audio/recovery.ts and the queue.
    const reached = [...reach(['src/processes/whatsapp-bridge.ts'])];
    expect(reached.filter((name) => name === 'opengpio' || name.startsWith('src/hal/'))).toEqual(
      [],
    );
  });
});

describe('the browser UIs', () => {
  /** The shared contract `tsconfig.web.json` names. tsc follows imports, so its list restricts nothing. */
  const SHARED = new Set([
    'src/audio/cues.ts',
    'src/config/schema.ts',
    'src/ipc/events.ts',
    'src/ipc/payload.ts',
  ]);

  it('import only the shared contract out of src/, and nothing from Node', () => {
    const reached = [...reach(under('public/', FILES))];
    expect(reached.filter((name) => name.startsWith('src/') && !SHARED.has(name))).toEqual([]);
    expect(reached.filter((name) => name.startsWith('node:'))).toEqual([]);
  });

  it('keep the captive portal self-contained', () => {
    // The portal is what a phone loads on the setup hotspot; it must not pull a shared chunk.
    const reached = [...reach(under('public/portal/', FILES))];
    expect(reached.filter((name) => !name.startsWith('public/portal/'))).toEqual([]);
  });
});

describe('opengpio', () => {
  it('is referenced statically only for types', () => {
    // It does not build on macOS; a runtime import anywhere would break the dev machine.
    const offenders = [...GRAPH].flatMap(([file, edges]) =>
      edges
        .filter((edge) => edge.target === 'opengpio' && !edge.typeOnly && !edge.dynamic)
        .map(() => file),
    );
    expect(offenders).toEqual([]);
  });
});

describe('module cycles', () => {
  it('there are none among runtime imports', () => {
    const cycles: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];
    const visit = (file: string): void => {
      state.set(file, 'visiting');
      stack.push(file);
      for (const edge of GRAPH.get(file) ?? []) {
        if (!edge.local || edge.typeOnly) continue;
        const mark = state.get(edge.target);
        if (mark === 'visiting') {
          cycles.push([...stack.slice(stack.indexOf(edge.target)), edge.target].join(' → '));
        } else if (mark === undefined) {
          visit(edge.target);
        }
      }
      stack.pop();
      state.set(file, 'done');
    };
    for (const file of FILES) if (!state.has(file)) visit(file);

    expect(cycles).toEqual([]);
  });
});
