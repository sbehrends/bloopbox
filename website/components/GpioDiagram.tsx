import styles from './GpioDiagram.module.css'

/**
 * The Pi's 40-pin header, with the pins this build uses called out.
 *
 * **Drawn from data, not illustrated.** Every other picture in the manual can be a generated
 * illustration; this one cannot. A wiring diagram with a wrong pin number is worse than no
 * diagram — somebody follows it — and an image generator has no idea which pin GPIO27 is. So
 * the map below is transcribed from the standard 40-pin pinout, the four roles come from
 * `docs/hardware.md`, and the picture is generated from them.
 *
 * If the pin assignments ever change, they change in `box/software/src/hal/gpioDriver.ts` first
 * (`GPIO_PINS`), then in `docs/hardware.md`, then here.
 */

type Role = 'button' | 'lamp' | 'hat' | 'power' | 'ground' | 'free'

type Pin = {
  /** Physical position on the header, 1–40. What you count to when wiring. */
  readonly n: number
  /** What is printed on a pinout card: "GPIO17", "5V", "GND". */
  readonly label: string
  readonly role: Role
  /** Channel 1–3, for the six pins that belong to a button. Drives the colour. */
  readonly channel?: 1 | 2 | 3
  /** Shown to the right of the header. Absent for a pin this build does not touch. */
  readonly use?: string
}

/* Odd pins run down the left of the header, even pins down the right, exactly as they sit on
   the board when the USB ports face you. */
const LEFT: readonly Pin[] = [
  { n: 1, label: '3V3', role: 'power' },
  { n: 3, label: 'GPIO2', role: 'hat', use: 'HAT — I²C data' },
  { n: 5, label: 'GPIO3', role: 'hat', use: 'HAT — I²C clock' },
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
  { n: 35, label: 'GPIO19', role: 'hat', use: 'HAT — I²S' },
  { n: 37, label: 'GPIO26', role: 'free' },
  { n: 39, label: 'GND', role: 'ground', use: 'Button 3 — other leg' },
]

const RIGHT: readonly Pin[] = [
  { n: 2, label: '5V', role: 'power', use: 'ULN2003 — lamp power' },
  { n: 4, label: '5V', role: 'power' },
  { n: 6, label: 'GND', role: 'ground', use: 'ULN2003 — ground' },
  { n: 8, label: 'GPIO14', role: 'free' },
  { n: 10, label: 'GPIO15', role: 'free' },
  { n: 12, label: 'GPIO18', role: 'hat', use: 'HAT — I²S' },
  { n: 14, label: 'GND', role: 'ground' },
  { n: 16, label: 'GPIO23', role: 'lamp', channel: 1, use: 'Lamp 1 → ULN2003 IN1' },
  { n: 18, label: 'GPIO24', role: 'lamp', channel: 2, use: 'Lamp 2 → ULN2003 IN2' },
  { n: 20, label: 'GND', role: 'ground' },
  { n: 22, label: 'GPIO25', role: 'lamp', channel: 3, use: 'Lamp 3 → ULN2003 IN3' },
  { n: 24, label: 'GPIO8', role: 'free' },
  { n: 26, label: 'GPIO7', role: 'free' },
  { n: 28, label: 'GPIO1', role: 'free' },
  { n: 30, label: 'GND', role: 'ground' },
  { n: 32, label: 'GPIO12', role: 'free' },
  { n: 34, label: 'GND', role: 'ground' },
  { n: 36, label: 'GPIO16', role: 'free' },
  { n: 38, label: 'GPIO20', role: 'hat', use: 'HAT — I²S' },
  { n: 40, label: 'GPIO21', role: 'hat', use: 'HAT — I²S' },
]

const ROW_H = 27
const TOP = 52
const ROWS = 20

/** Fill for a pin chip. Channel colours mean "which button" and nothing else, so only the six
 *  button-and-lamp pins get one; everything else is neutral. */
function fillFor(pin: Pin): string {
  if (pin.channel !== undefined) return `var(--ch-${pin.channel})`
  if (pin.role === 'hat') return 'var(--accent-soft)'
  if (pin.role === 'power' || pin.role === 'ground') return 'var(--surface-sunken)'
  return 'var(--surface)'
}

function PinRow({ pin, side, y }: { readonly pin: Pin; readonly side: 'left' | 'right'; readonly y: number }) {
  const isLeft = side === 'left'
  const chipX = isLeft ? 168 : 312
  const numX = isLeft ? 272 : 288
  const dim = pin.role === 'free'

  return (
    <g opacity={dim ? 0.42 : 1}>
      {/* The use, clear of the chip on the side the pin is on — the left column's chip starts at
          168 and the right column's ends at 400, so these two numbers are the edges of the
          connector, not padding. Anything closer disappears behind a chip. */}
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

      {/* The pin chip itself. A lamp pin is an output, so it is drawn hollow — the colour is
          the channel either way, but hollow-versus-filled says which direction it runs. */}
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

      {/* Physical pin number, between the two columns — this is what you actually count. */}
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
          convenient ones. Lamp drive runs from GPIO23 on pin 16, GPIO24 on pin 18 and GPIO25 on
          pin 22 into inputs 1 to 3 of the ULN2003 board, which takes its own power from 5 volts on
          pin 2 and ground on pin 6. The audio HAT occupies GPIO2 and GPIO3 on pins 3 and 5 for
          I²C, and GPIO18, GPIO19, GPIO20 and GPIO21 on pins 12, 35, 38 and 40 for I²S. No other
          pin is used.
        </desc>

        {/* Column headings */}
        <text className={styles.head} x={212} y={30} textAnchor="middle">
          ODD PINS
        </text>
        <text className={styles.head} x={356} y={30} textAnchor="middle">
          EVEN PINS
        </text>

        {/* The header's own outline, so the two columns read as one physical connector. */}
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
