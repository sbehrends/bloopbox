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

CI runs `npm run check` on a push to `main` or a pull request that touches `website/`, and uploads
`out/` as an artifact.
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
├── print-prep/       a tool page: three photos laid out as button-cap prints. Not indexed
├── globals.css       element defaults and the primitives more than one section uses
└── tokens.css        the brand, machine-readable. The only file here with a colour literal
components/
├── SiteHeader.tsx    sticky chrome. Takes its section links as a prop — see below
├── SiteFooter.tsx    the navy band
├── Lockup.tsx        mark + wordmark
├── Figure.tsx        an illustration, or a placeholder carrying the prompt for one
├── GpioDiagram.tsx   the 40-pin header, drawn from data
├── LightSignature.tsx the box's lamp patterns, animated — see below
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
- **The hero is a photograph, full-bleed.** `public/bloopbox-hero.jpeg` is the background of the
  band, and the copy sits on a veil mixed from `var(--bg)` — which is what lets every token over
  it stay the token it already is in both themes while one unchanging photograph shows through.
  Below 64rem the photograph becomes a band across the bottom of the hero instead: portrait, a
  cover crop of a 16:9 frame is a 2.4x zoom into the middle of the box, with no object left in it.
  There used to be a working device here instead, `DeviceDemo.tsx`, holdable and running the box's
  own thresholds; it was removed on 2026-09-08 and the photograph is the hero on its own.
- **The header's nav is a prop, not a constant.** Both pages' section links are anchors *into
  themselves*, so a shared list would send a reader on the manual back to the home page to find
  "How it works". `SiteHeader` owns only the lockup, the manual link and the GitHub button.
- **The manual's placeholders are visible.** An illustration that does not exist yet renders as a
  dashed box containing the prompt that will generate it (`Figure.tsx`, which also
  owns the one house-style clause every prompt shares). Swapping one in is `prompt` out, `src` in.
  A page that hides its gaps is a page nobody finishes.
- **The light signature is animated, and it is a port.** `LightSignature.tsx` carries the box's own
  lamp demo from `box/software/public/brand/brand.css` — the same keyframes at the same timings,
  copied rather than imported for the same reason `tokens.css` is. It replaced a static table
  because the one difference that matters across a dark room is between a blink and a heartbeat,
  and a table can only write the word. It adds one rung the box's kit has no reason to carry: the
  three-flash "delivered" burst, which is a confirmation rather than a state. `docs/PRODUCT.md` §6
  stays the authority — these lamps are a picture of it.
- **Blocks arrive on scroll, and it is CSS, not an observer.** Two global classes in `globals.css`,
  `rise` and `rise-group`, fade a block up 1.25rem as it enters the scrollport, driven by
  `animation-timeline: view()`. No JavaScript, which is the only kind of entrance a static export
  can make honestly. Three things about it are load-bearing rather than stylistic:
  - **Every declaration sits inside `@supports (animation-timeline: view())`.** A browser without
    scroll-driven animations never applies the hidden `from` state, so it never hides copy it cannot
    then reveal (Firefox, today, gets no entrance at all). Reduced motion and print each get
    `animation: none`, which lands every block on its base style — the arrived one. The blanket rule
    at the top of `globals.css` cannot do that job: a scroll-driven animation ignores
    `animation-duration`.
  - **The ranges are measured in `cover`, not `entry`.** `entry` is the element's own height, so a
    one-line eyebrow would finish inside twenty pixels of scroll and pop rather than rise.
  - **The closing section on neither page animates, and that is what makes the rest visible.** A
    block at the very bottom has only its own height and the footer left to scroll through, so a
    range that ends late leaves it stuck half-arrived. The first version obeyed that by ending every
    range at `cover 20%` — and at 20% the effect is invisible, because a block finishes while it is
    still in the bottom quarter of the screen, long before anyone looks at it. Exempting the
    sign-off took the worst block on the page out of the calculation; the range is now
    `cover 15%`–`cover 45%`, which starts the fade around 85% of screen height and finishes it
    around 55%, in the reading zone. Measured at 1280×987, the tightest remaining block reaches
    `cover 96%` against the 60% the fourth child of a row asks for. Re-measure if a row grows past
    four, or if a new section lands between the last one and the footer.
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
- **The three caps in that band blink, and they blink the real pattern.** Each rests as the unlit
  lens (`--ch-N-off`, the cap colour dulled toward warm grey) and then plays the unread-message
  blink from `docs/PRODUCT.md` §6 — 0.8 s on, 0.8 s off, three times — before resting again, with a
  faint wash of that colour over its own card while it is lit. It is the same picture-of-the-ladder
  rule the light signature follows, so the rate is not a design choice to retune: a lamp on this
  site may only move the way a lamp on the object moves. The three are staggered so **one is lit at
  a time**, which is what "when that person answers, their colour is the thing that lights up"
  claims two paragraphs above it. Resting on the unlit lens rather than at 16% opacity is the one
  departure from `LightSignature`: there, the plate is the subject and a dark lamp is information;
  here, the cap is also the card's "which button", and it has to stay legible through the dark half.

## Before this goes live

- **`lib/site.ts` has a placeholder repository URL.** The repo has no git remote yet; every GitHub
  link on the site derives from that one constant.
- **`lib/site.ts` has a placeholder form endpoint.** `waitlist.endpoint` is `example.invalid`. Point
  it at a real service and flip `waitlist.configured` to drop the setup note.
- **The manual's download button leads nowhere**, because no release is published. It needs a
  `--audio-hat wm8960` build — `docs/deployment.md`.
- Nothing hosts `out/` yet. Any static host will do.
- There is no social preview image — `openGraph` declares no `images`.
