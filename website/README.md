# website

The marketing site for bloopbox: one page, showing the device off to a parent who has never heard
of it, with two calls to action — **build one yourself** and **download the software**.

Next.js 16 (App Router), statically exported. `npm run build` writes `out/`, which is plain HTML,
CSS and JS with no server behind it.

## Commands

Everything here runs from `website/`. It is a **separate package** from `box/software/` — its own
`package.json`, its own lockfile, its own `node_modules`.

```bash
npm install
npm run dev        # http://localhost:3000
npm run check      # tsc --noEmit, then a full static export. This is the gate
npm run build      # export only, into out/
npm run preview    # serve out/ the way a static host would
```

CI runs `npm run check` on any push that touches `website/`, and uploads `out/` as an artifact.
Nothing publishes it yet — there is no host configured.

## Layout

```
app/
├── layout.tsx      metadata, the font, <html>
├── page.tsx        the whole page: every section, and its copy
├── globals.css     element defaults and the primitives more than one section uses
├── page.module.css layout for the page's own sections
└── tokens.css      the brand, machine-readable. The only file here with a colour literal
components/
├── DeviceDemo.tsx  the interactive box in the hero
└── Lockup.tsx      mark + wordmark
lib/site.ts         the links and names the page repeats
public/             the mark and the favicon
```

## The rule that keeps this decoupled

**The website must not import from `box/software/`.** They share a brand, not a build.

`box/software/public/shared/` holds a design system — tokens, components, the mark — and it is
good. But it is built for a Pi Zero 2 W serving pages over its own hotspot: no framework, no
webfont, CSS classes rather than components so a captive-portal webview can render them. Those
constraints are not the website's, and coupling the two means a marketing tweak can break the
setup page a parent needs at 3am.

So `app/tokens.css` and the two SVGs in `public/` are **deliberate copies**, and each one says so
at the top. `docs/BRAND.md` governs both. **A colour or a button-order change is made in two
places** — that is the accepted cost of the split, and it is cheaper than the coupling.

## Decisions taken here

- **Static export, not a server.** A page about a device you build yourself has nothing to render
  per-request. It also means no Route Handlers, no middleware, no image optimisation and no server
  actions — reach for one of those on purpose, not by accident.
- **A real webfont, unlike the box.** Nunito, self-hosted by `next/font`, with the box's exact
  fallback stack behind it. The brand asks for a chunky rounded geometric sans; the box settles for
  `ui-rounded` because a late font on the setup page is a page a parent stares at. The site is not
  served off a Pi and can afford the thing itself.
- **No npm workspaces at the root, still.** Two packages would justify them, but hoisting
  `node_modules` to the root moves it away from the tree `box/software/scripts/build-release.sh`
  assumes. When they arrive, re-run `npm run release:smoke` — that is the thing hoisting breaks.
- **No ESLint.** The box cannot use it (TypeScript 7 removed the compiler API `typescript-eslint`
  needs) and the site does not need a second opinion on a hundred lines of JSX. `npm run check` is
  the gate.
- **The hero demo is the argument.** The device's whole interface is three lamps and two gestures,
  so the page lets you hold a button rather than describing what would happen if you did. Its
  thresholds are the box's shipped defaults, duplicated rather than imported, per the rule above.
- **The site sells; it does not document.** An earlier draft carried the full LED signal matrix and
  a "where this actually is" section listing what has never run on hardware. Both are gone by
  decision: the page's job is to make a parent want one and click through. The reference lives in
  `docs/PRODUCT.md` §6, the status in `PENDING.md`, and the page links to the repository, which is
  where a reader who wants either will end up. **The consequence to hold the line on: nothing on the
  page may imply the device is buyable or shipping.** Every call to action is "build one", and no
  copy claims a finished product exists.
- **One dark band, and it is the section about the three buttons.** Three saturated colours on cream
  are swatches; on navy they are lamps, which is what they are on the object. The footer runs on the
  same navy, which is also the only place the wordmark can be amber (10.8:1 there, 1.6:1 on cream).

## Before this goes live

- **`lib/site.ts` has a placeholder repository URL.** The repo has no git remote yet; every GitHub
  link on the page derives from that one constant.
- Nothing hosts `out/` yet. Any static host will do.
- There is no social preview image — `openGraph` declares no `images`.
