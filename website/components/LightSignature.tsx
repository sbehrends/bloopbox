import styles from './LightSignature.module.css'

/**
 * The device's whole vocabulary, playing.
 *
 * A port of the light-signature ladder in the box's own brand kit
 * (`box/software/public/brand/`), with the same timings — see the header of the stylesheet for
 * why it is a copy rather than an import, and for why it is animated rather than tabulated.
 *
 * The authority for what each pattern *means* is `docs/PRODUCT.md` §6 and the animator in
 * `box/software/src/core`. These lamps are a picture of that, not a second implementation, so a
 * change to the ladder there is a change here — and the manual is where a parent will look first.
 */

/** Which lamps are lit, and how. `null` is a dark lamp; `'solid'` never moves. */
type Pattern =
  | 'boot'
  | 'connecting'
  | 'hotspot'
  | 'unread'
  | 'recording'
  | 'delivered'
  | 'silent'
  | 'error3'
  | 'error2'
  | 'idle'

type Rung = {
  readonly pattern: Pattern
  readonly title: string
  readonly body: string
}

/* Ordered the way a parent meets them: the ones you see while setting the box up, then the ones
   you see in use, then the two that mean something is wrong. Idle sits at the end because "all
   off" only reads as good news once you have seen everything else. */
const LADDER: readonly Rung[] = [
  {
    pattern: 'boot',
    title: 'Chasing left to right',
    body: 'Starting up. The first boot takes up to a minute; every one after it is quicker.',
  },
  {
    pattern: 'connecting',
    title: 'All three, together',
    body: 'Looking for Wi-Fi, or linking WhatsApp. Something is happening and it is not finished.',
  },
  {
    pattern: 'hotspot',
    title: 'All three, a double-pulse',
    body: 'The setup network is up and the setup page is waiting for you. A heartbeat rather than another blink rate — you can tell those apart across a room, and you cannot tell one blink speed from another.',
  },
  {
    pattern: 'unread',
    title: 'One button, blinking slowly',
    body: 'A voice note is waiting from that person, in their colour. Tap it to hear everything they sent, oldest first.',
  },
  {
    pattern: 'recording',
    title: 'One button, solid',
    body: 'That button is recording right now. It stays solid through the carry-on window too, so solid means “still listening”.',
  },
  {
    pattern: 'delivered',
    title: 'One button, three quick flashes',
    body: 'That message was delivered. The only light on this page that reports something finishing rather than something continuing.',
  },
  {
    pattern: 'silent',
    title: 'The outer two, a pulse every few seconds',
    body: 'Silent mode is on. Cue noises are suppressed; playback still works, because a child who taps a light expects to hear something.',
  },
  {
    pattern: 'error3',
    title: 'All three solid',
    body: 'No network, and no setup page either. Check the router first — this is the one that usually means the Wi-Fi changed.',
  },
  {
    pattern: 'error2',
    title: 'The left two solid',
    body: 'The network is fine; WhatsApp needs linking again. Go back to step 10.',
  },
  {
    pattern: 'idle',
    title: 'All off',
    body: 'Ready, and waiting. This is the normal state, and a box in a child’s bedroom at night is allowed to be dark.',
  },
]

/** Which of the three lamps this pattern pins permanently on. Everything else is animated by
 *  the stylesheet, or dark. */
const SOLID_LAMPS: Partial<Record<Pattern, readonly number[]>> = {
  recording: [0],
  error3: [0, 1, 2],
  error2: [0, 1],
}

/** Patterns whose movement is driven by a class on the plate. `idle` and the solids have none. */
const ANIMATED: Partial<Record<Pattern, string>> = {
  boot: styles.boot,
  connecting: styles.connecting,
  hotspot: styles.hotspot,
  unread: styles.unread,
  delivered: styles.delivered,
  silent: styles.silent,
}

function Lamps({ pattern, label }: { readonly pattern: Pattern; readonly label: string }) {
  const solid = SOLID_LAMPS[pattern] ?? []
  const animation = ANIMATED[pattern]

  return (
    // The plate carries the meaning for anyone who cannot see it move; the lamps themselves are
    // decorative, so the whole group is one labelled image rather than three unlabelled circles.
    <span className={`${styles.leds} ${animation ?? ''}`} role="img" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={`${styles.led} ${solid.includes(i) ? styles.solid : ''}`} />
      ))}
    </span>
  )
}

export function LightSignature() {
  return (
    <ul className={styles.ladder}>
      {LADDER.map((rung) => (
        <li className={styles.rung} key={rung.title}>
          <Lamps pattern={rung.pattern} label={rung.title} />
          <span className={styles.text}>
            <strong>{rung.title}</strong>
            <span>{rung.body}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}
