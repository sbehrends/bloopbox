import type { Metadata, Viewport } from 'next'
import localFont from 'next/font/local'

import { site } from '@/lib/site'

import './globals.css'

// Committed rather than fetched from Google at build time: `next/font/google` failed on GitHub's
// runners while passing locally and on Vercel. One variable file, Latin subset, covers 400–900.
// Nunito is OFL-licensed (fonts/Nunito-OFL.txt).
const nunito = localFont({
  src: './fonts/nunito-latin-var.woff2',
  weight: '400 900',
  variable: '--font-nunito',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: `${site.name} — ${site.tagline}`,
  description: site.description,
  applicationName: site.name,
  icons: { icon: '/bloopbox-favicon.svg' },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: site.name,
    title: `${site.name} — ${site.tagline}`,
    description: site.description,
  },
  twitter: {
    card: 'summary_large_image',
    title: `${site.name} — ${site.tagline}`,
    description: site.description,
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f4ef' },
    { media: '(prefers-color-scheme: dark)', color: '#131a2c' },
  ],
}

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en" className={nunito.variable}>
      <body>{children}</body>
    </html>
  )
}
