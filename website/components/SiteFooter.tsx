import { Lockup } from './Lockup'
import { links } from '@/lib/site'

import styles from './SiteFooter.module.css'

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={`wrap ${styles.footerInner}`}>
        <div>
          <Lockup size="hero" />
          <p className={styles.footerTag}>
            A screenless WhatsApp voice messenger for children.
          </p>
        </div>
        <nav className={styles.footerNav} aria-label="Elsewhere">
          <a href={links.manual}>Build manual</a>
          <a href={links.repo}>Source on GitHub</a>
          <a href={links.releases}>Releases</a>
          <a href={links.hardware}>Wiring and parts</a>
          <a href={links.product}>What it does, precisely</a>
        </nav>
      </div>
    </footer>
  )
}
