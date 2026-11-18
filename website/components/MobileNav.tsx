'use client'

import { type MouseEvent, useRef } from 'react'

import styles from './SiteHeader.module.css'

/**
 * The section links below 56rem, where the inline nav does not fit. A `<details>` so it opens
 * before hydration and with JavaScript off; the handler only closes it after a tap, since most of
 * these links are anchors on the same page and would otherwise leave the panel over the content.
 */
export function MobileNav({
  items,
}: {
  readonly items: readonly { readonly href: string; readonly label: string }[]
}) {
  const ref = useRef<HTMLDetailsElement>(null)

  const close = (event: MouseEvent<HTMLElement>) => {
    if (ref.current && (event.target as HTMLElement).closest('a')) ref.current.open = false
  }

  return (
    <details ref={ref} className={styles.menu}>
      <summary className={styles.menuButton} aria-label="Menu">
        <span className={styles.menuIcon} aria-hidden="true" />
      </summary>
      <nav className={styles.menuPanel} aria-label="Sections" onClick={close}>
        {items.map((item) => (
          <a key={item.href} href={item.href}>
            {item.label}
          </a>
        ))}
      </nav>
    </details>
  )
}
