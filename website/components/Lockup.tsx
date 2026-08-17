import styles from './Lockup.module.css'

/**
 * The mark beside the wordmark. Two sizes, and the wordmark's ink is contextual:
 * amber at hero size exactly as the artwork draws it, navy in chrome — amber on cream is
 * 1.6:1, which WCAG exempts for a logotype and which is not good enough for a heading.
 * `docs/BRAND.md` §"The wordmark's ink is contextual".
 */
export function Lockup({ size = 'chrome' }: { readonly size?: 'chrome' | 'hero' }) {
  return (
    <span className={size === 'hero' ? styles.hero : styles.chrome}>
      {/* Decorative here: the wordmark beside it already carries the name. */}
      <img src="/bloopbox-iso-dark.svg" alt="" className={styles.mark} />
      <span className={styles.word}>bloopbox</span>
    </span>
  )
}
