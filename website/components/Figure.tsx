import styles from './Figure.module.css'

/** A manual illustration. Without `src` it renders a visible placeholder carrying its `prompt`. */
const STYLE =
  'Style: flat vector illustration, bold navy #1A2B48 line art with rounded corners, ' +
  'soft cream #F7F4EF background, accent colours strictly sunny yellow #F7B733, ' +
  'coral #FF6F61 and electric teal #00A7E1. Friendly, tactile, retro-futurist, no gradients, ' +
  'no photorealism, no text or labels in the image, generous negative space.'

export function Figure({
  src,
  alt,
  caption,
  prompt,
  ratio = '4 / 3',
}: {
  readonly src?: string
  /** Required with `src`. Empty string marks the image decorative. */
  readonly alt?: string
  readonly caption?: string
  /** What to generate. Given only when `src` is absent. */
  readonly prompt?: string
  /** Aspect the finished art should be drawn at, so swapping it in does not reflow the page. */
  readonly ratio?: string
}) {
  return (
    // Both states rise into view: the placeholders are as tall as the art they stand in for.
    <figure className={`${styles.figure} rise`}>
      {src ? (
        <div className={styles.frame} style={{ aspectRatio: ratio }}>
          <img src={src} alt={alt ?? ''} loading="lazy" decoding="async" />
        </div>
      ) : (
        /* No `aspectRatio` here on purpose. Reserving the finished art's shape leaves most of a
           screen of empty box between two paragraphs, and the manual has ten of these — the page
           becomes unreadable while it waits for pictures. The ratio is written in the label
           instead, which is where whoever generates the art will look for it. */
        <div className={styles.pending}>
          <span className={styles.pendingLabel}>
            Illustration to come
            <span className={styles.pendingRatio}>{ratio.replace(/\s/g, '')}</span>
          </span>
          <p className={styles.prompt}>
            {prompt} {STYLE}
          </p>
        </div>
      )}
      {caption ? <figcaption className={styles.caption}>{caption}</figcaption> : null}
    </figure>
  )
}
