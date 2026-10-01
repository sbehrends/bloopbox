import styles from './GpioDiagram.module.css'

/** The Pi's 40-pin header, drawn from data. Pin roles come from `docs/hardware.md`. */

type Role = 'button' | 'lamp' | 'power' | 'ground' | 'free'

type Pin = {
  /** Physical position on the header, 1–40. What you count to when wiring. */
  readonly n: number
  /** What is printed on a pinout card: "GPIO17", "5V", "GND". */
  readonly label: string
  readonly role: Role
  /** Channel 1–3, for the six pins that belong to a button. Drives the colour. */
  readonly channel?: 1 | 2 | 3
  /** Shown beside the header, and what marks a pin as used: absent means dimmed. */
  readonly use?: string
}

const LEFT: readonly Pin[] = [
  { n: 1, label: '3V3', role: 'power' },
  { n: 3, label: 'GPIO2', role: 'free' },
  { n: 5, label: 'GPIO3', role: 'free' },
  { n: 7, label: 'GPIO4', role: 'free' },
  { n: 9, label: 'GND', role: 'ground', use: 'Button 1 — other leg' },
  { n: 11, label: 'GPIO17', role: 'button', channel: 1, use: 'Button 1 — switch' },
  { n: 13, label: 'GPIO27', role: 'button', channel: 2, use: 'Button 2 — switch' },
  { n: 15, label: 'GPIO22', role: 'button', channel: 3, use: 'Button 3 — switch' },
  { n: 17, label: '3V3', role: 'power' },
  { n: 19, label: 'GPIO10', role: 'free' },
  { n: 21, label: 'GPIO9', role: 'free' },
  { n: 23, label: 'GPIO11', role: 'free' },
  { n: 25, label: 'GND', role: 'ground', use: 'Button 2 — other leg' },
  { n: 27, label: 'GPIO0', role: 'free' },
  { n: 29, label: 'GPIO5', role: 'free' },
  { n: 31, label: 'GPIO6', role: 'free' },
  { n: 33, label: 'GPIO13', role: 'free' },
  { n: 35, label: 'GPIO19', role: 'free' },
  { n: 37, label: 'GPIO26', role: 'free' },
  { n: 39, label: 'GND', role: 'ground', use: 'Button 3 — other leg' },
]

const RIGHT: readonly Pin[] = [
  { n: 2, label: '5V', role: 'power' },
  { n: 4, label: '5V', role: 'power' },
  { n: 6, label: 'GND', role: 'ground' },
  { n: 8, label: 'GPIO14', role: 'free' },
  { n: 10, label: 'GPIO15', role: 'free' },
  { n: 12, label: 'GPIO18', role: 'free' },
  { n: 14, label: 'GND', role: 'ground', use: 'Lamp 1 — other leg' },
  { n: 16, label: 'GPIO23', role: 'lamp', channel: 1, use: 'Lamp 1 — drive' },
  { n: 18, label: 'GPIO24', role: 'lamp', channel: 2, use: 'Lamp 2 — drive' },
  { n: 20, label: 'GND', role: 'ground', use: 'Lamp 2 — other leg' },
  { n: 22, label: 'GPIO25', role: 'lamp', channel: 3, use: 'Lamp 3 — drive' },
  { n: 24, label: 'GPIO8', role: 'free' },
  { n: 26, label: 'GPIO7', role: 'free' },
  { n: 28, label: 'GPIO1', role: 'free' },
  { n: 30, label: 'GND', role: 'ground', use: 'Lamp 3 — other leg' },
  { n: 32, label: 'GPIO12', role: 'free' },
  { n: 34, label: 'GND', role: 'ground' },
  { n: 36, label: 'GPIO16', role: 'free' },
  { n: 38, label: 'GPIO20', role: 'free' },
  { n: 40, label: 'GPIO21', role: 'free' },
]

const ROW_H = 27
const TOP = 52
const ROWS = 20

/** Fill for a pin chip. Channel colours mean "which button" and nothing else, so only the six
 *  button-and-lamp pins get one; everything else is neutral. */
function fillFor(pin: Pin): string {
  if (pin.channel !== undefined) return `var(--ch-${pin.channel})`
  if (pin.role === 'power' || pin.role === 'ground') return 'var(--surface-sunken)'
  return 'var(--surface)'
}

function PinRow({ pin, side, y }: { readonly pin: Pin; readonly side: 'left' | 'right'; readonly y: number }) {
  const isLeft = side === 'left'
  const chipX = isLeft ? 168 : 312
  const numX = isLeft ? 272 : 288
  /* A pin with no `use` is a pin you never touch — every free line, but also the 3V3 and 5V
     rails and the ground pins that happen not to be the convenient ones. Dimming by "has a
     job in this build" rather than by role is what keeps the twelve wired pins the only thing
     the eye lands on; the power rails in particular used to read as significant, and a builder
     hunting for 5V on a board that needs none is a wrong turn the diagram was inviting. */
  const dim = pin.use === undefined

  return (
    <g opacity={dim ? 0.42 : 1}>
      {pin.use ? (
        <text
          className={styles.use}
          x={isLeft ? 148 : 410}
          y={y + 15}
          textAnchor={isLeft ? 'end' : 'start'}
        >
          {pin.use}
        </text>
      ) : null}

      <rect
        x={chipX}
        y={y}
        width={88}
        height={21}
        rx={6}
        fill={pin.role === 'lamp' ? 'var(--surface)' : fillFor(pin)}
        stroke={pin.channel !== undefined ? `var(--ch-${pin.channel})` : 'var(--border-strong)'}
        strokeWidth={pin.channel === undefined ? 1 : 2.5}
      />
      <text className={styles.pinLabel} x={chipX + 44} y={y + 15} textAnchor="middle">
        {pin.label}
      </text>

      <text className={styles.pinNumber} x={numX} y={y + 15} textAnchor={isLeft ? 'end' : 'start'}>
        {pin.n}
      </text>
    </g>
  )
}

export function GpioDiagram() {
  const height = TOP + ROWS * ROW_H + 16

  return (
    <div className={styles.scroll}>
      <svg
        className={styles.svg}
        viewBox={`0 0 600 ${height}`}
        role="img"
        aria-labelledby="gpio-title gpio-desc"
      >
        <title id="gpio-title">The Raspberry Pi 40-pin header, with this build’s connections</title>
        <desc id="gpio-desc">
          Buttons connect their switch legs to GPIO17 on physical pin 11, GPIO27 on pin 13 and
          GPIO22 on pin 15, and their other legs to any ground pin — 9, 25 and 39 are the
          convenient ones. The lamps run straight off the header: GPIO23 on pin 16, GPIO24 on pin
          18 and GPIO25 on pin 22, with their other legs on the ground pins 14, 20 and 30. Twelve
          wires in total, and no other pin is yours to touch.
        </desc>

        <text className={styles.head} x={212} y={30} textAnchor="middle">
          ODD PINS
        </text>
        <text className={styles.head} x={356} y={30} textAnchor="middle">
          EVEN PINS
        </text>

        <rect
          x={158}
          y={TOP - 8}
          width={244}
          height={ROWS * ROW_H + 8}
          rx={10}
          fill="none"
          stroke="var(--border)"
          strokeWidth={1.5}
        />

        {LEFT.map((pin, i) => (
          <PinRow key={pin.n} pin={pin} side="left" y={TOP + i * ROW_H} />
        ))}
        {RIGHT.map((pin, i) => (
          <PinRow key={pin.n} pin={pin} side="right" y={TOP + i * ROW_H} />
        ))}
      </svg>
    </div>
  )
}
