import { Lockup } from './Lockup'
import { links } from '@/lib/site'

import styles from './SiteHeader.module.css'

/**
 * The sticky chrome at the top of every page.
 *
 * `nav` differs per page because the home page's links are anchors into itself and the manual's
 * are anchors into itself; a single shared list would send a reader on the manual back to the
 * home page to find "How it works". So the caller passes its own, and only the lockup, the
 * manual link and the two buttons are fixed.
 */
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
          <a href={links.manual} aria-current={current === 'manual' ? 'page' : undefined}>
            Manual
          </a>
        </nav>
        {/* Both buttons share the auto margin so the pair sits right of the lockup while the
            nav is hidden; the nav takes it back at the wide breakpoint. */}
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
