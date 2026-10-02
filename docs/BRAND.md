# The bloopbox Brand Kit

The **living** brand kit is a page, not this file: `box/software/public/brand/index.html`, served
at `/brand/` (`npm run dev:web` in `box/software/` → http://localhost:5174/brand/). It loads the
same `public/shared/base.css` (and through it `tokens.css`) that the setup portal, the admin panel
and the simulator load, so it cannot drift from the product — every swatch, button and field on it
is the real component. Look there first.

This file is the direction it implements, and the decisions taken while implementing it.

---

## Part 1 — The direction

### The core visual language

The primary brand identity mark and logotype for bloopbox, a screenless, tactile WhatsApp
messenger for toddlers, defining the **Retro-Futurist Intercom** visual language.

**Visual description.** The mark is a rounded speech-bubble pill with a tail, drawn as line art:
a **sunny yellow** arc forming its left end, an **electric teal** arc forming its right, a **coral
pink** ring overlapping both in the middle, and three small concentric ring "buttons" on the centre
line in the same three colours. Left to right the order is yellow, coral, teal — the order of the
caps on the enclosure. Every shape carries a heavy outline in the cartoon style, and every interior
is transparent, so the mark sits on a background rather than covering a piece of one. Below the
mark, the wordmark "bloopbox" is set in a chunky, rounded, geometric face, in amber, with thick
letterforms and tight spacing.

A **compact mark** carries the same pill and tail for small sizes: three flat overlapping colour
fields in the same order, no inner outlines and no buttons.

**Aesthetic mood.** Bold, playful, tactile, screenless, friendly, retro-modern, geometric.

**Typography.** A custom, ultra-bold, rounded geometric sans-serif that looks like it belongs on
a retro-futuristic arcade panel.

**Rationale.** The logo bridges the device's technical capabilities (sound waves, intercom form)
with its physical user experience (large, tactile, colour-coded buttons). The chunky font and
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
that level, which matters: all of this is served off a Pi, some of it over the device's own
hotspot. Paths are under `box/software/public/`.

| Layer | File | What it holds |
| ----- | ---- | ------------- |
| 1. Tokens | `shared/tokens.css` | The palette, type scale, spacing, radii, motion. **The only stylesheet allowed to contain a colour literal.** |
| 2. Components | `shared/base.css` | Every shared component, as CSS classes: lockup, card, button, field, choice row, status, alert, kbd. Imports `tokens.css`. |
| 3. Builders | `shared/dom.ts` | The DOM those classes expect — `card()`, `field()`, `checkboxField()`, `actionButton()`. Pages never hand-assemble markup a class depends on. |
| 4. Token bridge | `shared/theme.ts` | `readToken()` and the channel token names, for code that cannot use a class — the simulator's canvas and the admin panel's row tints. |

Plus the artwork, also in `shared/`:

| File | Drawing | Used for |
| ---- | ------- | -------- |
| `bloopbox-logo-light.svg`, `bloopbox-logo-dark.svg` | The line-art mark, in a 279 × 118 frame | Hero lockups at display size; the simulator's header |
| `bloopbox-iso-light.svg`, `bloopbox-iso-dark.svg` | The compact mark, 120 × 120 | Chrome lockups beside the wordmark — the admin panel, the portal, the kit's own header |
| `bloopbox-favicon.svg` | The compact mark again, in the palette's hexes, switching its own ink | `rel="icon"` on all four pages |

All of them are byte-for-byte copies of the site's files in `website/public/` — the site and the box
share a brand, not a build, so **change one, change the other.** `bloopbox-mark.svg`, an earlier
drawing, is still in both directories and nothing references it.

**Rule for layer 2:** nothing enters `base.css` unless two or more pages use it. Page-specific
styling lives beside its page — `admin/admin.css`, `simulator/simulator.css`,
`portal/portal.css`, `brand/brand.css`. A design system that ships its own documentation's
styling to a device is carrying dead weight.

### Reference the semantic token, not the brand one

`var(--accent)`, never `var(--brand-teal)`. The brand layer names a colour; the semantic layer
names a job. Dark mode overrides only the semantic layer, which is why it is one short block and
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
phone before and after. Noted in `PENDING.md`. The website is not served off a Pi and ships Nunito,
so on a non-Apple machine the two surfaces differ in exactly this.

The **wordmark** pushes the same stack harder than any heading does — weight 900 and `-0.035em`
tracking — because the artwork's letterforms are chunky and nearly touching. It is the closest a
system face gets, and it is the part of the identity a webfont would most improve.

### The wordmark's ink is contextual

Amber in the **hero lockup** (`.lockup-hero`: mark above, wordmark below, display size), exactly
as the artwork draws it. Navy in **chrome lockups** (`.lockup`: mark beside wordmark, header
size), because amber on cream is **1.6:1** — fine for a logotype, which WCAG exempts, and not
fine for the element that is also the page's `h1`. In dark mode amber would pass easily (9.7:1 on
the dark background), but a wordmark that changes colour with the OS theme is a worse answer than
one that changes with its own size.

### The mark ships as a light file and a dark file

Every interior of the mark is transparent, so its outline sits directly against whatever is behind
it, and that boundary cannot be a single fixed colour: black disappears into a navy page exactly as
it needs to stand out on cream. So each drawing ships as **two files that differ in the outline's
fill** — `-light` inked black, `-dark` inked white. Every coloured arc, ring, field and button keeps
its exact artwork hex in both.

A surface that follows the OS picks between them with `<picture>` and a
`(prefers-color-scheme: dark)` `<source>`, as the kit's own header does. **Where the colour is
pinned, pin the file too**, and check it by eye: `<picture>` reads the OS, not the element, so it
cannot see a fixed cream card, a teal chip or a printed sticker. That is why `/brand/` §1's specimen
panels pin the ground each file was inked for, rather than following the theme.

The admin panel, the portal and the simulator do not pick yet: each hard-codes the `-light` file,
so in dark mode the outline is black on navy. Noted in `PENDING.md`.

**`bloopbox-logo-dark.svg` is a bad export**, not the light file with its outline reversed: the left
arc is teal where it should be yellow, the three button outlines are still black so they vanish on
navy, and it carries an opaque white backing the light file does not. Nothing in the product uses
it; `/brand/` §1 shows it captioned as known-bad, because a kit that quietly substituted the good
file would be the one page the defect could not be seen on. `bloopbox-iso-dark.svg` is a clean
swap and is fine. Fix the logo in the site and re-copy.

### There is no reversed asset — but the mark's ink does switch, in the favicon

`bloopbox-favicon.svg` is the one drawing that is a single file for both themes. Its outline is the
one part with a class, `.ink`, and a `<style>` block in the SVG switches it from navy to cream under
`@media (prefers-color-scheme: dark)` — the same signal `tokens.css` uses for the page. It can
afford to: it is a solid drawing with a single ink, and every page's `rel="icon"` names this one
file whatever the theme. **The `.ink` class and the `<style>` block are part of the asset** — lose them
in a copy and dark mode loses the outline.

### The favicon is its own drawing

**The line-art mark stops working below about 24px.** The arcs, the outlines and the button holes
collapse into a single blur, and a browser tab is 16px. So the favicon is the compact mark — the
same pill and tail, filled edge to edge with three flat colour fields, no inner outlines and no
buttons — and every page points `rel="icon"` at it while the lockups use the logo and iso files.

This is a different job, not a variant. The favicon shares no code with the others, so **a colour
or button-order change has to be made in every drawing.** The `/brand/` kit renders the marks at
20px next to the favicon at 16px so the reason stays visible.

### The artwork lives in `website/public/`, and the box copies it

The copy that gets refined is the site's. The box's files are those files, byte for byte, so a
drift check is `cmp` and nothing cleverer.

That also means the artwork carries hexes of its own: the logo and iso files draw `#F3B333`,
`#F0776C` and `#0B97C4`, which are **not** `--brand-yellow`, `--brand-coral` and `--brand-teal`.
Teal is the visible one. Reconciling them is a change to the artwork, in the site, not a retint in
the box — retinting here would break the copy. Noted in `PENDING.md`.

Whatever arrives next: **no `--` inside an XML comment**. It is illegal, and it makes the whole SVG
unparseable, which surfaces as a silent broken-image icon on all four pages and not as a build
error.

### Teal is an accent, not an ink

Teal on cream is 2.5:1 and fails for text, so two derived tokens settle it permanently:
`--accent-ink` (`#0a6e8f`, 5.3:1 on cream) for accent-coloured wording and links, and
`--on-accent` (navy, 5.1:1 on teal) for text on a teal button. White on teal is 2.8:1 and is
never used. `--muted` is 4.9:1 on cream, also deliberate.

### Errors are their own colour, never coral

Coral is a brand accent and a button's identity. `--danger` (`#b03a31`, 5.5:1 on cream) is a
different, darker red so that "something went wrong" can never be confused with "button 2".

### The three channels mean "which button", and nothing else

`--ch-1/2/3` are **yellow, coral, teal** — the order the three buttons run in the mark, matching
Button 1 left / 2 centre / 3 right and the colour-coded caps on the enclosure (`PRODUCT.md`
§1, and `hardware.md`). They appear as the contact row stripes in the admin panel, the lenses in the
simulator and the lamps in the kit's light signature. A channel colour never carries any other
meaning.

The order comes from the artwork and is the artwork's to change: **redraw every mark file if you
reorder these**, or the box in the child's room stops matching the picture of it. Note that
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
signals as animated lamps rather than prose. Those animations are a **picture** of the signals —
the authority is `src/core/ledAnimator.ts`, `PRODUCT.md` §6 and the ladder in
`architecture.md` § The LED priority ladder. Solid always means error, except on the button being
held; nothing in the ladder has a chime attached.

### Voice

Plain and warm, addressed to a competent adult in a hurry. Say what will happen, name the real
cause, and never make a parent diagnose anything. No baby talk (the child never reads a word of
this), no jargon on the portal, no cheerful blame. Examples in `/brand/` §6.
