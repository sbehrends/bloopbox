/** TODO: `repo` is a guess; the repository has no git remote yet. */
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
  manual: '/manual/',
  lights: '/manual/#lights',
  build: '/manual/',
} as const

export const channels = [
  { n: 1, token: 'ch-1', example: 'Mum' },
  { n: 2, token: 'ch-2', example: 'Dad' },
  { n: 3, token: 'ch-3', example: 'Grandma' },
] as const

/** The HubSpot account and its waitlist form (`website/README.md`). The account is in the EU data centre, hence the `-eu1` host. */
const hubspot = {
  host: 'api-eu1.hsforms.com',
  portalId: '149623017',
  formGuid: '15bf1490-5e79-4ddb-89b5-6886660048ba',
} as const

export const waitlist = {
  endpoint: `https://${hubspot.host}/submissions/v3/integration/submit/${hubspot.portalId}/${hubspot.formGuid}`,
} as const

export const download = {
  image: `${site.repo}/releases/latest`,
  etcher: 'https://etcher.balena.io/',
  imager: 'https://www.raspberrypi.com/software/',
} as const

/** Bill of materials. An empty `links` renders the part as plain text. */
export const parts = [
  {
    name: 'Raspberry Pi 3B+',
    qty: '1',
    links: [
      {
        label: 'raspberrypi.com',
        href: 'https://www.raspberrypi.com/products/raspberry-pi-3-model-b-plus/',
      },
    ],
    note: 'The brain. This build was tested with Raspberry Pi 3B+ but it should work on Pi 4, Pi 5 or Pi Zero 2 W.',
  },
  {
    name: 'Waveshare WM8960 audio HAT',
    qty: '1',
    links: [{ label: 'waveshare.com', href: 'https://www.waveshare.com/wm8960-audio-hat.htm' }],
    note: 'Sound card, microphones and speaker amplifier on one board. It sits on the Pi’s pins — no wiring. Many listings include a speaker or two, which is worth checking before you buy the next line.',
  },
  {
    name: 'Illuminated arcade buttons, 30 mm',
    qty: '3',
    links: [],
    note: 'One yellow, one red, one blue. They must be the illuminated kind, with a 3 V lamp inside — that lamp is the whole interface, and 3 V is what lets it run straight off the Pi.',
  },
  {
    name: 'Small 8 Ω speakers',
    qty: '1 pair',
    links: [],
    note: 'Check the HAT listing first — plenty of them ship with a pair in the box, and then this line costs you nothing. If not, anything 8 Ω in the 2–5 W range works; the HAT drives them directly through its screw terminals.',
  },
  {
    name: 'microSD card, 8 GB or larger',
    qty: '1',
    links: [],
    note: 'Class 10 or better.',
  },
  {
    name: '5 V 2.5 A power supply',
    qty: '1',
    links: [],
    note: 'Micro-USB for the 3B+ and Zero 2 W; USB-C for the Pi 4 and 5. No battery and no power switch — the box is always on.',
  },
  {
    name: '2.8 mm flat connector to Dupont lead',
    qty: '12',
    links: [],
    note: 'One end pushes onto a button terminal, the other onto a Pi pin. Six for the switches, six for the lamps.',
  },
  {
    name: 'An enclosure',
    qty: '1',
    links: [],
    note: 'A 3D-printable one is in the repository, and a wooden box works just as well.',
  },
] as const
