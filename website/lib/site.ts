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
  build: `${site.repo}#install`,
  hardware: `${site.repo}/blob/main/docs/hardware.md`,
  product: `${site.repo}/blob/main/docs/PRODUCT.md`,
} as const

/** Button 1 left, 2 centre, 3 right — the order of the caps on the enclosure and of the rings
 *  in the logo mark. The names are examples, not defaults the device ships with. */
export const channels = [
  { n: 1, token: 'ch-1', example: 'Mum' },
  { n: 2, token: 'ch-2', example: 'Dad' },
  { n: 3, token: 'ch-3', example: 'Grandma' },
] as const
