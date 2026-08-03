import type { NextConfig } from 'next'

/**
 * The site is a static export: `npm run build` writes `out/`, which is plain HTML, CSS and JS
 * with no server behind it. That is deliberate — a marketing page for a device you build
 * yourself has nothing to render per-request, and a folder of files can be hosted anywhere.
 *
 * The practical consequence: no Route Handlers, no middleware, no `next/image` optimisation,
 * no server actions. If one of those becomes necessary, that is a decision to take on purpose
 * rather than a setting to flip.
 */
const nextConfig: NextConfig = {
  output: 'export',

  // `/foo` emits `foo/index.html`, which is what static hosts serve without rewrite rules.
  trailingSlash: true,

  images: {
    // No optimiser exists in an export. Everything on the page is inline SVG or a static file,
    // so this only matters if someone reaches for `next/image` later.
    unoptimized: true,
  },
}

export default nextConfig
