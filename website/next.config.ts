import type { NextConfig } from 'next'

// Static export: no Route Handlers, middleware, `next/image` optimisation or server actions.
const nextConfig: NextConfig = {
  output: 'export',

  trailingSlash: true,

  images: {
    unoptimized: true,
  },
}

export default nextConfig
