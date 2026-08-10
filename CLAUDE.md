# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

bloopbox. Screenless IoT appliance: 3 illuminated arcade buttons on a Raspberry Pi Zero 2 W let a
2–5 year old send and receive WhatsApp voice notes. **Hold to send, tap to play.** No screen, ever.

## Repository layout — this is a monorepo

```
box/
├── software/     the two daemons, the four browser UIs, packaging, deploy  ← the project today
└── hardware/     enclosure models, PCB. Effectively empty
website/          the marketing site: one statically exported Next.js page
docs/             all documentation, for every package. Deliberately flat
.github/          CI. Its box steps are working-directory'd into box/software, its site steps into website
.githooks/        the pre-commit gate. Must stay at root
```

**Two packages, no root `package.json` and no npm workspaces.** npm commands run from
`box/software/` (the device) or `website/` (the site), and the two never import from each other.
Workspaces stay absent on purpose: hoisting `node_modules` to the root moves it away from the tree
`box/software/scripts/build-release.sh` assumes. The Bash tool's working directory persists between
calls, so `cd` into the right package **once** per session and then run bare commands; that also
keeps them matching the allowlist in `.claude/settings.json`, which is written against bare
`npm run …` forms.

Three layout constraints that are easy to undo by accident:

- **`scripts/`, `deploy/`, `packaging/` and `.dockerignore` stay in `box/software/` together.** Every
  release script derives its root from its own location (`dirname "${BASH_SOURCE[0]}"/..`), not from
  git. Moving them as a unit is what let the whole package relocate without editing one of them.
  Separating them breaks the tarball build with no error message worth reading.
- **`.githooks/` stays at the repo root.** `core.hooksPath` resolves a relative path against the top
  of the working tree and git runs hooks from there, so a hook one directory down is never found.
- **`docs/` stays flat at the root.** The `§` citations in the source name sections, not paths.

## Where the rules live

Context is loaded in three tiers, on purpose. Claude Code reads a `CLAUDE.md` **up** the tree
eagerly at launch, but one **below** the cwd only when it first touches a file in that directory.

| Tier | File | Loaded | Holds |
| ---- | ---- | ------ | ----- |
| 1 | this file | always | The map, the gate, and tripwires as one-liners |
| 2 | `box/software/CLAUDE.md` | when a box file is touched | Toolchain, Baileys, opengpio, packaging, the decisions and which test locks each |
| 3 | `docs/*.md` | on demand, by `Read` | The full reasoning, with diagrams |

**When adding a rule, put it in the lowest tier that still catches the mistake.** A rule only needed
once you are editing box code belongs in tier 2. A rule that must be known *before* the first edit —
because acting on it wastes the whole task — belongs here, however deep its subject. That is why the
ESLint and opengpio tripwires are duplicated below as single lines.

## Before you report a task done

```bash
cd box/software && npm run check     # format + lint + typecheck + test
cd website      && npm run check     # typecheck + static export — only if you touched the site
```

The box gate must pass. That is the only gate for device work; the site has its own, and neither
knows about the other.

It is also a **pre-commit hook** (`.githooks/pre-commit`, wired up by the `prepare` script in
`box/software/package.json`, so `npm install` installs it — no husky). The whole gate takes about six
seconds, so the hook runs all of it rather than just a typecheck, plus `bash -n` over any staged
shell script since neither prettier nor oxlint looks at those, plus a relative-link check over any
staged markdown. It **skips the npm half entirely when nothing under `box/software/` is staged**, so a
docs-only commit is instant. `git commit --no-verify` bypasses it.

The hook checks the working tree, not the staged snapshot: committing a subset of files can still
pass here and be broken in isolation, which is what CI is for.

## Tripwires

Violating any of these wastes a whole task or ships a broken device. The reasoning is one tier down.

- **oxlint, never ESLint.** TypeScript 7 no longer exposes the classic JS compiler API, so
  `typescript-eslint` cannot work on this project at all — not even canary.
- **Never import `opengpio` statically.** It is an `optionalDependency` that does not build on
  macOS; `src/hal/index.ts` loads it via dynamic `import()`. Importing the HAL factory has to stay
  safe on a dev machine.
- **Never pass an options object to opengpio's `watch()`.** 2.0.2 transposes `bias` and `debounce`
  when calling its native binding, so asking for a pull-up silently leaves the line floating.
- **Config is snapshot at boot; saving restarts the daemon.** There is no live-reload path and
  adding one is not wanted.
- **A new config section is wired in FOUR places.** Miss `mergeConfig` and the save validates,
  answers `200`, restarts the daemon and silently discards the change.
- **Use `.prefault({})` for a new config section, never `.default({})`.** Zod's `.default()` does
  not parse the literal, so every field comes back `undefined`.
- **Nothing in `src/core/` may do I/O.** It only calls `hal.setLed()`. That purity is what makes the
  timing behaviour testable on fake timers.
- **Never add a real sleep to a test.** Timing-sensitive suites run on fake timers; where real
  filesystem work is awaited, assert with a `waitFor` condition, not a fixed number of yields.
- **Do not write `cmd | grep -q` in the shell scripts.** `grep -q` exits at the first match, the
  producer takes a SIGPIPE, and `set -o pipefail` fails the whole check. This bit three separate
  checks during bring-up.
- **`gpioDriver.ts` has never run on real hardware.** Do not add code paths that only work with real
  GPIO, and treat anything it claims as unverified.
- **The whitelist in `src/whatsapp/whitelist.ts` is the safety boundary of the product.** A toddler
  must not be reachable by strangers. Change it only deliberately, and read its tests first.
- **Timing values live in exactly one place and are exported**, so tests assert against the same
  numbers the runtime uses. Anything a user might want to tune belongs in the Zod schema, not in a
  module constant.
- **Conventional commits** (`feat:`, `fix:`, `test:`, `chore:`, `docs:`), one per milestone.

## Which document owns what

| Document                   | Owns                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| `README.md`                | The monorepo front door: what bloopbox is, the layout, install, set up, use |
| `box/software/README.md`   | The dev-facing half: environment, the gate, the simulator, the scripts    |
| `box/software/CLAUDE.md`   | Tier 2 above — the rules for changing the box software                    |
| `docs/PRODUCT.md`          | What the device does. Behaviour, the LED matrix, the config schema. **Do not renumber its sections** — 39 source files cite them |
| `docs/architecture.md`     | How the software is put together, and the decisions behind it             |
| `docs/hardware.md`         | Parts, wiring, GPIO pins, ALSA. Authoritative over `box/hardware/`       |
| `docs/deployment.md`       | Releases, the installer, the SD image, systemd, CI                       |
| `docs/hardware-bringup.md` | The gated plan for the first real device, and the debugging kit           |
| `docs/BRAND.md`            | Visual direction and the design system's locked decisions                |
| `PENDING.md`               | The backlog: known gaps, unverified claims, watch items                  |

**When you change behaviour, update the document that owns it in the same commit.** Findings go in
`PENDING.md` rather than staying in conversation — check it before starting something.

`docs/` is the single source of truth for reasoning. Tiers 1 and 2 hold rules and pointers, not
prose: if you find yourself explaining *why* at length in a `CLAUDE.md`, it belongs in `docs/`.

## CI

`.github/workflows/ci.yml` runs a cheap `changes` job first and gates the rest on it, so a docs-only
or website-only push does not build an arm64 tarball. **The single required status check is the
aggregating `ci` job**, not the individual ones — a skipped job passes branch protection, whereas
filtering with `on: push: paths:` would make a required check never report and block the PR forever.

`.github/workflows/release.yml` is deliberately **not** filtered: a tag must rebuild everything.
