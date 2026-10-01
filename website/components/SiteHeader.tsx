import { Lockup } from './Lockup'
import { links } from '@/lib/site'

import styles from './SiteHeader.module.css'

/** The sticky top bar. Each page passes its own `nav` anchors. */
export function SiteHeader({
  nav = [],
  current,
}: {
  readonly nav?: readonly { readonly href: string; readonly label: string }[]
  /** Which fixed link is the page being rendered, if any. Drives `aria-current`. */
  readonly current?: 'manual'
}) {
  return (
    <header className={styles.header}>
      <div className={`wrap ${styles.headerInner}`}>
        <a className={styles.brand} href="/">
          <Lockup />
        </a>
        <nav className={styles.nav} aria-label="Sections">
          {nav.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
          {current !== 'manual' && <a href={links.manual}>Manual</a>}
          {current === 'manual' && <a href={links.lights}>Lights</a>}
        </nav>
        <div className={styles.headerActions}>
          <a className={`btn btn-secondary ${styles.headerCta}`} href={links.repo}>
            GitHub
          </a>
          <a
            className={`btn btn-primary ${styles.headerCta}`}
            href={links.build}
            aria-current={current === 'manual' ? 'page' : undefined}
          >
            Build
          </a>
        </div>
      </div>
    </header>
  )
}
