# website

The marketing site for bloopbox. **Nothing built yet** — this folder is a placeholder so the
monorepo layout is settled before the work starts.

(It also gives git something to track. Git cannot record an empty directory, so removing this file
removes the folder.)

## When it starts

Add a `package.json` here and the repo becomes genuinely multi-package. Two things to do at that
moment, neither of them urgent until then:

1. **Introduce npm workspaces at the root.** Deliberately absent today: with one package they buy
   nothing, and hoisting `node_modules` to the root moves it away from the tree
   `box/software/scripts/build-release.sh` assumes. When there are two packages, a root
   `package.json` with `workspaces: ["box/software", "website"]` is worth the change — but re-run
   `npm run release:smoke` afterwards, because that is the thing hoisting would break.
2. **Give CI a path filter.** `.github/workflows/ci.yml` currently runs the box's full gate on every
   push. A website-only change should not spend ten minutes emulating arm64 to build a Pi tarball.

## One rule worth fixing now

**The website must not import from `box/software/`.** They share a brand, not a build.

The temptation will be real, because `box/software/public/shared/` already holds a design system —
tokens, components, the logo mark — and it is genuinely good. But it is built for a Pi Zero 2 W
serving pages over its own hotspot: no framework, no webfont, CSS classes rather than components
precisely so a captive-portal webview can render them. Those constraints are not the website's, and
coupling the two means a marketing tweak can break the setup page a parent needs at 3am.

If something really does need to be shared, promote it deliberately — copy the tokens, or extract a
third package — rather than reaching across with a relative import.

## What it needs to cover

- What the box is, in the first screen, to a parent who has never heard of it.
- The light vocabulary, because it is the whole UI and it photographs well.
- Honesty about status: this is not a product you can buy yet.
- `docs/BRAND.md` is the visual direction, and it already governs the box's four UIs. The site
  should look like the same object — same palette, same rounded geometry, same voice ("plain and
  warm, addressed to a competent adult in a hurry").
