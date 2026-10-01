import styles from './Lockup.module.css'

/** The mark beside the wordmark, in two sizes. See `docs/BRAND.md` for the wordmark's ink. */
export function Lockup({ size = 'chrome' }: { readonly size?: 'chrome' | 'hero' }) {
  return (
    <span className={size === 'hero' ? styles.hero : styles.chrome}>
      <img src="/bloopbox-iso-dark.svg" alt="" className={styles.mark} />
      <span className={styles.word}>bloopbox</span>
    </span>
  )
}
