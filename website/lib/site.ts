/**
 * The handful of facts the page repeats. One place, because "download the software" appears
 * three times and a stale link in one of them is the worst kind of bug on a marketing site.
 *
 * TODO: `repo` is a guess — the repository has no git remote yet. Set it before the site is
 * published; every GitHub link on the page derives from it.
 */
export const site = {
  name: 'bloopbox',
  tagline: 'A WhatsApp voice messenger with three buttons and no screen.',
  description:
    'bloopbox is a screenless WhatsApp voice messenger for children aged 2–5. Three illuminated arcade buttons, one per family member: hold to send a voice note, tap to play what arrived. Open source — build it yourself on a Raspberry Pi Zero 2 W.',
  repo: 'https://github.com/sergiobehrends/bloopbox',
} as const

export const links = {
  repo: site.repo,
  releases: `${site.repo}/releases`,
  hardware: `${site.repo}/blob/main/docs/hardware.md`,
  product: `${site.repo}/blob/main/docs/PRODUCT.md`,
  deployment: `${site.repo}/blob/main/docs/deployment.md`,
  /** The build manual. Internal, and the only link here that is not a GitHub one. */
  manual: '/manual/',
  /**
   * "Build one yourself" — the site's primary call to action, everywhere it appears.
   *
   * It used to point at the repository's install section, because that was the only build
   * instructions that existed. The manual is now that, written for the reader the button is
   * aimed at, so the CTA lands there instead. Kept as its own name rather than inlining
   * `manual`: the destination is "how to build one", and if that ever splits from the manual
   * page this is the one line that moves.
   */
  build: '/manual/',
} as const

/** Button 1 left, 2 centre, 3 right — the order of the caps on the enclosure and of the rings
 *  in the logo mark. The names are examples, not defaults the device ships with. */
export const channels = [
  { n: 1, token: 'ch-1', example: 'Mum' },
  { n: 2, token: 'ch-2', example: 'Dad' },
  { n: 3, token: 'ch-3', example: 'Grandma' },
] as const

/**
 * Where the "ready-made package" form posts.
 *
 * The site is a **static export** — no Route Handlers, no server actions (see `next.config.ts`),
 * so a form on it has to post somewhere else. This is a plain `<form action>` rather than fetch
 * so it still works with JavaScript off, which is the whole point of a page a parent reads on a
 * phone in a hallway.
 *
 * TODO: placeholder. Point it at a real form endpoint (Formspree, Buttondown, a Google Form's
 * `formResponse` URL) before the site is published. Until then the form renders and submits
 * nowhere useful, which `WaitlistForm` says out loud rather than pretending otherwise.
 */
export const waitlist = {
  endpoint: 'https://example.invalid/bloopbox-waitlist',
  configured: false,
} as const

/** Where the SD card image is downloaded from. TODO: no release is published yet. */
export const download = {
  image: `${site.repo}/releases/latest`,
  etcher: 'https://etcher.balena.io/',
  imager: 'https://www.raspberrypi.com/software/',
} as const

/**
 * The bill of materials, as the manual lists it.
 *
 * `href: null` means "no authoritative page to link to" — a generic part somebody buys wherever
 * they already shop. A made-up shop link would rot faster than the part does, so those render as
 * plain text and the note carries the spec instead.
 *
 * Kept here rather than in the page because the same list will be wanted by a parts-only page
 * later, and because a price or a link changing should be a one-line edit somebody can find.
 */
export const parts = [
  {
    name: 'Raspberry Pi 3B+',
    qty: '1',
    href: 'https://www.raspberrypi.com/products/raspberry-pi-3-model-b-plus/',
    note: 'The brain. This is the board the build was tested on — see the note below about the other models.',
  },
  {
    name: 'Waveshare WM8960 audio HAT',
    qty: '1',
    href: 'https://www.waveshare.com/wm8960-audio-hat.htm',
    note: 'Sound card, microphones and speaker amplifier on one board. It sits on the Pi’s pins — no wiring.',
  },
  {
    name: 'Illuminated arcade buttons, 30 mm',
    qty: '3',
    href: null,
    note: 'One yellow, one red, one blue. They must be the illuminated kind with a 5 V lamp inside — that lamp is the whole interface.',
  },
  {
    name: 'Small 8 Ω speakers',
    qty: '1 pair',
    href: null,
    note: 'The HAT drives these directly through its screw terminals. Anything in the 2–5 W range is fine.',
  },
  {
    name: 'microSD card, 8 GB or larger',
    qty: '1',
    href: null,
    note: 'Class 10 or better. 4 GB is too tight once the software is on it.',
  },
  {
    name: '5 V 2.5 A power supply',
    qty: '1',
    href: null,
    note: 'Micro-USB for the 3B+ and Zero 2 W; USB-C for the Pi 4 and 5. No battery and no power switch — the box is always on.',
  },
  {
    name: 'ULN2003 driver board',
    qty: '1',
    href: null,
    note: 'The Pi’s pins cannot light a 5 V arcade lamp on their own. This little board does it for them.',
  },
  {
    name: '2×20 stacking header',
    qty: '1',
    href: null,
    note: 'The HAT covers the Pi’s pins. This lifts them back up so the buttons have somewhere to go.',
  },
  {
    name: 'Female-to-female jumper wires',
    qty: '~12',
    href: null,
    note: 'For the buttons and the driver board. No soldering anywhere in this build.',
  },
  {
    name: 'An enclosure',
    qty: '1',
    href: null,
    note: 'A 3D-printable one is in the repository, and a wooden box works just as well. See below.',
  },
] as const
