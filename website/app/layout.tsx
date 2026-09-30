import type { Metadata, Viewport } from 'next'
import { Nunito } from 'next/font/google'

import { site } from '@/lib/site'

import './globals.css'

const nunito = Nunito({
  subsets: ['latin'],
  weight: ['400', '600', '800', '900'],
  variable: '--font-nunito',
  display: 'swap',
})

export const metadata: Metadata = {
  title: `${site.name} — ${site.tagline}`,
  description: site.description,
  applicationName: site.name,
  icons: { icon: '/bloopbox-favicon.svg' },
  openGraph: {
    type: 'website',
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
