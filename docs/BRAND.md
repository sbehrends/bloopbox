# The bloopbox Brand Kit

The **living** brand kit is a page, not this file: `public/brand/index.html`, served at
`/brand/` (`npm run dev:web` → http://localhost:5174/brand/). It loads the same
`public/shared/tokens.css` and `public/shared/base.css` that the setup portal, the admin panel
and the simulator load, so it cannot drift from the product — every swatch, button and field on
it is the real component. Look there first.

This file is the direction it implements, and the decisions taken while implementing it.

---

## Part 1 — The direction

### The core visual language

The primary brand identity mark and logotype for bloopbox, a screenless, tactile WhatsApp
messenger for toddlers, defining the **Retro-Futurist Intercom** visual language.

**Visual description.** The mark is three concentric ring pairs that overlap into a single
speech bubble with a tail. The big rings cluster tightly so the silhouette closes into one shape;
the three small "buttons" fan out evenly across it. Left to right they are **sunny yellow, coral
pink and electric teal** — the order of the caps on the enclosure. Every ring is a colour band
edged in a navy hairline with a cream interior. Below the mark, the wordmark "bloopbox" is set in
a chunky, rounded, geometric face, in amber, with thick letterforms and tight spacing.

The vector is `public/shared/bloopbox-mark.svg`, traced from the artwork by measuring it: ring
outer radius 17.6 units in a 64 box, band 4.8, buttons at radius 6.7 with holes at 2.5, ring
centres 11.3 apart and button centres 15 apart.

**Aesthetic mood.** Bold, playful, tactile, screenless, friendly, retro-modern, geometric.

**Typography.** A custom, ultra-bold, rounded geometric sans-serif that looks like it belongs on
a retro-futuristic arcade panel.

**Rationale.** The logo bridges the device's technical capabilities (sound waves, intercom form)
with its physical user experience (large, tactile, color-coded buttons). The chunky font and
primary palette reassure parents that the tech is playful and approachable for little humans,
not complex and "digital".

### The primary palette

| Role            | Colour              | Why                                              |
| --------------- | ------------------- | ------------------------------------------------ |
| Main accent     | Electric Teal `#00A7E1`  | Energetic, modern connection                |
| Secondary       | Sunny Yellow `#F7B733`   | Joy, warmth, classic arcade cue             |
| Tertiary        | Coral Pink `#FF6F61`     | Fun, approachability, soft pop              |
| Primary text    | Deep Navy `#1A2B48`      | Trusted, stable communication               |
| Base            | Soft Cream `#F7F4EF`     | Soft on the eyes, avoids stark white        |

---

## Part 2 — How it is implemented

Four layers, in the order a page reaches for them. Each is the cheapest thing that could work at
that level, which matters: all of this is served off a Pi Zero 2 W, some of it over the device's
own hotspot.

| Layer | File | What it holds |
| ----- | ---- | ------------- |
| 1. Tokens | `public/shared/tokens.css` | The palette, type scale, spacing, radii, motion. **The only file in the repository allowed to contain a colour literal.** |
| 2. Components | `public/shared/base.css` | Every shared component, as CSS classes: lockup, card, button, field, choice row, status, alert, kbd. |
| 3. Builders | `public/shared/dom.ts` | The DOM those classes expect — `card()`, `field()`, `checkboxField()`, `actionButton()`. Pages never hand-assemble markup a class depends on. |
| 4. Token bridge | `public/shared/theme.ts` | `readToken()` and the channel token names, for code that cannot use a class — the simulator's canvas and the admin panel's row tints. |

Plus one asset: `public/shared/bloopbox-mark.svg`, which is the mark, the lockup's partner and
the favicon on all four pages.

**Rule for layer 2:** nothing enters `base.css` unless two or more pages use it. Page-specific
styling lives beside its page — `admin/admin.css`, `simulator/simulator.css`,
`portal/portal.css`, `brand/brand.css`. A design system that ships its own documentation's
styling to a device is carrying dead weight.

### Reference the semantic token, not the brand one

`var(--accent)`, never `var(--brand-teal)`. The brand layer names a colour; the semantic layer
names a job. Dark mode overrides only the semantic layer, which is why it is fifteen lines and
not a second stylesheet.

---

## Part 3 — Decisions this kit locked in

Change any of these deliberately, in one place, and update `/brand/` in the same commit.

### Light is the default, dark is supported

The palette is a cream-and-navy one, so the pages are light. But the setup portal gets read on a
phone at 3am because the router died, so `tokens.css` carries a
`@media (prefers-color-scheme: dark)` block that moves the **semantic** tokens only. All three
accents keep their exact hex — they are bright enough on deep navy — and the pages are one
stylesheet either way.

### No webfont: `ui-rounded` and a fallback stack

The direction asks for a custom ultra-bold rounded geometric sans. `--font-display` starts with
`ui-rounded`, which **is** SF Pro Rounded on Apple platforms — precisely that letterform, for
zero bytes — followed by Nunito, Quicksand, Varela Round and `system-ui`. Body copy is
`system-ui`, which stays comfortable at length in a way a rounded display face does not.

Shipping a real webfont was rejected, not forgotten: the portal is served from a Pi over its own
hotspot, and a font that arrives late is a page a parent stares at. Revisit only with a
subsetted, self-hosted WOFF2 and `font-display: swap`, and measure the portal's first paint on a
phone before and after. Noted in `PENDING.md`.

The **wordmark** pushes the same stack harder than any heading does — weight 900 and `-0.035em`
tracking — because the artwork's letterforms are chunky and nearly touching. It is the closest a
system face gets, and it is the part of the identity a webfont would most improve.

### The wordmark's ink is contextual

Amber in the **hero lockup** (`.lockup-hero`: mark above, wordmark below, display size), exactly
as the artwork draws it. Navy in **chrome lockups** (`.lockup`: mark beside wordmark, header
size), because amber on cream is **1.6:1** — fine for a logotype, which WCAG exempts, and not
fine for the element that is also the page's `h1`. In dark mode amber would pass easily (10.8:1),
but a wordmark that changes colour with the OS theme is a worse answer than one that changes with
its own size.

### There is no reversed asset, and no theme switching in the mark

The ring interiors are **opaque cream**, which is what makes the overlaps read — a ring drawn
later occludes the one behind it. That also settles dark mode for free: on cream the interiors
disappear into the page and the mark is three rings; on navy the bubble lights up. One file, both
themes, no `prefers-color-scheme` block and no variant to keep in step.

(An earlier mark did invert itself. It had a solid navy body, so it had to.)

### One exception to "one drawing": the favicon

**The mark stops working below about 24px.** Three nested rings, four hairlines and three holes
collapse into a single blur, and a browser tab is 16px. So `bloopbox-favicon.svg` is a second,
simpler drawing — three solid discs and the tail, one hairline, no holes — and every page points
`rel="icon"` at it while the `<img>` lockups use the mark.

This is a different job, not a variant, which is the only reason two files are allowed. They
share no code, so **a colour or button-order change has to be made in both.** The `/brand/` kit
renders the mark at 20px next to the favicon at 16px so the reason stays visible.

### The mark is traced, not eyeballed

`docs/` has no source vector — the artwork arrived as a raster. The SVG was built by measuring
that raster (scan lines across the ring centres, colour bounding boxes) rather than by tracing by
hand, which is why the numbers in it are odd. If new artwork arrives, measure it the same way.

Also: **no `--` inside an XML comment.** It is illegal, and it makes the whole SVG unparseable —
which surfaces as a silent broken-image icon on all four pages, not as a build error.

### Teal is an accent, not an ink

Teal on cream is 2.5:1 and fails for text, so two derived tokens settle it permanently:
`--accent-ink` (`#0a6e8f`, 5.1:1 on cream) for accent-coloured wording and links, and
`--on-accent` (navy, 4.6:1 on teal) for text on a teal button. White on teal is 2.9:1 and is
never used. `--muted` is 4.7:1 on cream, also deliberate.

### Errors are their own colour, never coral

Coral is a brand accent and a button's identity. `--danger` (`#b03a31`, 5.3:1 on cream) is a
different, darker red so that "something went wrong" can never be confused with "button 3".

### The three channels mean "which button", and nothing else

`--ch-1/2/3` are **yellow, coral, teal** — the order the three buttons run in the mark, matching
Button 1 left / 2 centre / 3 right and the colour-coded caps on the enclosure (`PRODUCT.md`
§1, and `hardware.md`). They appear as the contact row stripes in the admin panel, the lenses in the
simulator and the lamps in the kit's light signature. A channel colour never carries any other
meaning.

The order comes from the artwork and is the artwork's to change: **redraw the mark and the favicon
if you reorder these**, or the box in the child's room stops matching the picture of it. Note that
teal being `--ch-3` and `--accent` at the same time is fine — one says "the right-hand button",
the other says "the thing to press".

### Controls have travel

Every button has a hard bottom edge that collapses on `:active`. It is the enclosure's tactility
restated in CSS, and it costs two declarations. `--tap: 3rem` is the floor for anything a
standing parent has to hit.

### `.error-box`, not `.error`

The alert box is `.error-box` because `.status.error` is a *recoloured line of status text* — a
bare `.error` selector also matches it and would wrap the admin panel's status line in a border.

### The enclosure does not follow the page theme

`--device-*` and `--ch-N-off` sit outside the dark-mode block. An object in a child's room does
not repaint itself because a parent switched their laptop to dark mode, so the simulator's
device looks the same in both themes.

### The light signature is part of the brand, not a footnote

The device has no screen: three lamps are its entire vocabulary, so `/brand/` documents the LED
ladder as animated lamps rather than prose. Those animations are a **picture** of the ladder —
the authority is `src/core` and the ladder in `CLAUDE.md`. Solid always means error; nothing in
the ladder has a chime attached.

### Voice

Plain and warm, addressed to a competent adult in a hurry. Say what will happen, name the real
cause, and never make a parent diagnose anything. No baby talk (the child never reads a word of
this), no jargon on the portal, no cheerful blame. Examples in `/brand/` §6.
