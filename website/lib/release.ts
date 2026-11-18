import pkg from '../package.json'

import { site } from './site'

// Its own module, apart from site.ts, because site.ts reaches client components (the waitlist form)
// and this import would carry the whole package.json into the browser bundle with it. Import it
// from server components only.

/**
 * The release the manual downloads. The site's version moves with the box's on every release, and
 * the asset name is the one release.yml builds — `bloopbox-<version>-<hat>-sd.img.xz` — so the
 * button is a direct link to the file, not to a page of them. Vercel deploys the bump before the
 * release finishes building (~30 min), and the link 404s for that window.
 */
const release = { tag: `v${pkg.version}`, image: `bloopbox-${pkg.version}-wm8960-sd.img.xz` } as const

export const download = {
  image: `${site.repo}/releases/download/${release.tag}/${release.image}`,
  release: `${site.repo}/releases/tag/${release.tag}`,
  etcher: 'https://etcher.balena.io/',
  imager: 'https://www.raspberrypi.com/software/',
} as const
