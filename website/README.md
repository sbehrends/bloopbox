# website

The site for bloopbox. Two pages, and they have different jobs:

| Page | Job |
| ---- | --- |
| `/` | Show the device off to a parent who has never heard of it, and get them to click through |
| `/manual/` | Take that parent from an empty desk to a working box — parts, wiring, setup |

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
├── layout.tsx        metadata, the font, <html>
├── page.tsx          the home page: every section, and its copy
├── page.module.css   layout for the home page's sections
├── manual/
│   ├── page.tsx      the build manual: eleven steps, the parts, the wiring
│   └── page.module.css
├── globals.css       element defaults and the primitives more than one section uses
└── tokens.css        the brand, machine-readable. The only file here with a colour literal
components/
├── SiteHeader.tsx    sticky chrome. Takes its section links as a prop — see below
├── SiteFooter.tsx    the navy band
├── DeviceDemo.tsx    the interactive box in the home hero
├── Lockup.tsx        mark + wordmark
├── Figure.tsx        an illustration, or a placeholder carrying the prompt for one
├── GpioDiagram.tsx   the 40-pin header, drawn from data
└── WaitlistForm.tsx  "I'd rather not build it myself"
lib/site.ts           the links, the parts list and the names the pages repeat
public/               the mark, the favicon, and the manual's photography
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
- **The header's nav is a prop, not a constant.** Both pages' section links are anchors *into
  themselves*, so a shared list would send a reader on the manual back to the home page to find
  "How it works". `SiteHeader` owns only the lockup, the manual link and the GitHub button.
- **The manual's placeholders are visible.** Six of its nine illustrations do not exist yet, and
  each renders as a dashed box containing the prompt that will generate it (`Figure.tsx`, which also
  owns the one house-style clause every prompt shares). Swapping one in is `prompt` out, `src` in.
  A page that hides its gaps is a page nobody finishes.
- **The light signature is animated, and it is a port.** `LightSignature.tsx` carries the box's own
  lamp demo from `box/software/public/brand/brand.css` — the same keyframes at the same timings,
  copied rather than imported for the same reason `tokens.css` is. It replaced a static table
  because the one difference that matters across a dark room is between a blink and a heartbeat,
  and a table can only write the word. It adds one rung the box's kit has no reason to carry: the
  three-flash "delivered" burst, which is a confirmation rather than a state. `docs/PRODUCT.md` §6
  stays the authority — these lamps are a picture of it.
- **The pin map is drawn from data, not illustrated.** `GpioDiagram.tsx` transcribes the 40-pin
  header and colours it from `docs/hardware.md`. Every other picture on the site can be a generated
  illustration; this one cannot, because an image generator does not know which pin GPIO27 is and
  somebody will follow it with a wire in their hand.
- **The waitlist form posts to a third party, and says so while it doesn't.** A static export has no
  Route Handler to post to, so `waitlist.endpoint` in `lib/site.ts` names an external form service.
  It is a plain `<form action>` rather than `fetch`, so it works before hydration. While
  `waitlist.configured` is false the panel renders a visible note admitting submissions go nowhere —
  quietly discarding a parent's email is the worse failure.
- **The home page sells; the manual documents.** An earlier draft of `/` carried the full LED signal
  matrix and a "where this actually is" section listing what has never run on hardware. Both were
  cut, and that still holds for the home page: its job is to make a parent want one and click
  through. The LED reference now lives on the site after all, in the manual's dark band — a parent
  who has just finished building one needs to know what solid means, and that is a different reader
  with a different question. The split is the point, not the absence. Status stays in `PENDING.md`.
  **The consequence to hold the line on: nothing on either page may imply the device is buyable or
  shipping.** Every call to action is "build one". The waitlist form is where this is most likely to
  erode — it says twice that no kit exists and that it is not a pre-order, and it must keep saying
  so.
- **One dark band, and it is the section about the three buttons.** Three saturated colours on cream
  are swatches; on navy they are lamps, which is what they are on the object. The footer runs on the
  same navy, which is also the only place the wordmark can be amber (10.8:1 there, 1.6:1 on cream).

## Before this goes live

- **`lib/site.ts` has a placeholder repository URL.** The repo has no git remote yet; every GitHub
  link on the site derives from that one constant.
- **`lib/site.ts` has a placeholder form endpoint.** `waitlist.endpoint` is `example.invalid`. Point
  it at a real service and flip `waitlist.configured` to drop the setup note.
- **The manual's download button leads nowhere**, because no release is published. It needs a
  `--audio-hat wm8960` build — `docs/deployment.md`.
- **Six of the manual's nine illustrations are placeholders.** They are listed, with their prompts,
  on the page itself.
- Nothing hosts `out/` yet. Any static host will do.
- There is no social preview image — `openGraph` declares no `images`.
