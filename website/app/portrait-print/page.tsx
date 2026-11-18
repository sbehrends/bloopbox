import type { Metadata } from 'next'

import { SiteFooter } from '@/components/SiteFooter'
import { SiteHeader } from '@/components/SiteHeader'
import { site } from '@/lib/site'

import { PortraitPrintTool } from './PortraitPrintTool'
import styles from './PortraitPrintTool.module.css'

export const metadata: Metadata = {
  title: `Button photos — ${site.name}`,
  description: 'Frame a photo for each of the three buttons and print them true to size.',
  robots: { index: false, follow: false },
}

const NAV = [
  { href: '#photos', label: 'Photos' },
  { href: '#print', label: 'Print' },
] as const

export default function PortraitPrintPage() {
  return (
    <>
      {/* `display: contents`, so the header stays sticky against the page, and so the chrome can
          be dropped from the printout without touching the shared components. */}
      <div className={styles.screenOnly}>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <SiteHeader nav={NAV} />
      </div>

      <PortraitPrintTool />

      <div className={styles.screenOnly}>
        <SiteFooter />
      </div>
    </>
  )
}
