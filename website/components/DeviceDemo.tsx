'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import styles from './DeviceDemo.module.css'

/**
 * The device, working, at the top of the page.
 *
 * It is the site's one interactive element on purpose: the product's whole interface is three
 * lamps and two gestures, and a visitor who holds a button for half a second has understood
 * the product. Describing it takes a paragraph nobody reads.
 *
 * The thresholds below are the box's shipped defaults (`config.buttons`, PRODUCT.md §1), so
 * the page feels like the object rather than approximating it. They are duplicated here rather
 * than imported — the site must not reach into box/software (website/README.md).
 */
const RECORD_THRESHOLD_MS = 500
const SENT_FLASH_MS = 900
const PLAYBACK_MS = 2400
const OOPS_MS = 600
/** Long enough that the page has settled and the visitor is reading, short enough to be seen. */
const FIRST_NOTE_MS = 2600

type LampState = 'off' | 'unread' | 'recording' | 'sent' | 'playing' | 'oops'

const BUTTONS = [
  { n: 1, token: 'ch-1', who: 'Mum' },
  { n: 2, token: 'ch-2', who: 'Dad' },
  { n: 3, token: 'ch-3', who: 'Grandma' },
] as const

const IDLE_CAPTION = 'Three lamps, two gestures. Hold a button to record; let go to send it.'

export function DeviceDemo() {
  const [lamps, setLamps] = useState<readonly LampState[]>(['off', 'off', 'off'])
  const [caption, setCaption] = useState(IDLE_CAPTION)

  /** Every pending timeout, so unmounting mid-recording cannot set state on a dead component. */
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  /** The press currently in flight: which button, and whether it has become a recording. */
  const press = useRef<{ index: number; recording: boolean } | null>(null)
  /** True once the visitor has touched anything, which retires the scripted first note. */
  const touched = useRef(false)

  const later = useCallback((ms: number, fn: () => void) => {
    const id = setTimeout(() => {
      timers.current.delete(id)
      fn()
    }, ms)
    timers.current.add(id)
    return id
  }, [])

  const setLamp = useCallback((index: number, state: LampState) => {
    setLamps((prev) => prev.map((current, i) => (i === index ? state : current)))
  }, [])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const id of pending) clearTimeout(id)
      pending.clear()
    }
  }, [])

  // The invitation: a voice note arrives on its own, so there is something to tap.
  useEffect(() => {
    const id = setTimeout(() => {
      if (touched.current) return
      setLamps((prev) => (prev.every((state) => state === 'off') ? ['off', 'off', 'unread'] : prev))
      setCaption('Grandma sent a voice note. Her button is blinking — tap it to hear it.')
    }, FIRST_NOTE_MS)
    return () => clearTimeout(id)
  }, [])

  const startPress = useCallback(
    (index: number) => {
      if (press.current) return
      touched.current = true
      press.current = { index, recording: false }

      // Below the threshold a press is still a tap, so nothing happens yet — the same reason
      // the device defers its "pop" cue instead of playing it at press time.
      later(RECORD_THRESHOLD_MS, () => {
        if (press.current?.index !== index) return
        press.current.recording = true
        setLamp(index, 'recording')
        setCaption(`Recording for ${BUTTONS[index]?.who}. The lamp stays solid while it listens.`)
      })
    },
    [later, setLamp],
  )

  const endPress = useCallback(
    (index: number) => {
      const active = press.current
      if (active?.index !== index) return
      press.current = null

      const who = BUTTONS[index]?.who ?? ''

      if (active.recording) {
        setLamp(index, 'sent')
        setCaption(`Sent. It lands in ${who}'s ordinary WhatsApp chat, as a voice note.`)
        later(SENT_FLASH_MS, () => setLamp(index, 'off'))
        return
      }

      // A tap. What it does depends on whether that lamp was blinking.
      setLamps((prev) => {
        if (prev[index] === 'unread') {
          setCaption(`Playing ${who}'s voice note. Everything waiting plays, oldest first.`)
          later(PLAYBACK_MS, () => {
            setLamp(index, 'off')
            setCaption('Played, and the lamp goes out. Dark means nothing is waiting.')
          })
          return prev.map((state, i) => (i === index ? 'playing' : state))
        }
        setCaption('Nothing waiting there. The box answers with a low double-beep and no more.')
        later(OOPS_MS, () => setLamp(index, 'off'))
        return prev.map((state, i) => (i === index ? 'oops' : state))
      })
    },
    [later, setLamp],
  )

  return (
    <div className={styles.stage}>
      <div className={styles.device}>
        <div className={styles.grille} aria-hidden="true" />
        <div className={styles.caps}>
          {BUTTONS.map((button, index) => (
            <div className={styles.slot} key={button.n}>
              <button
                type="button"
                className={styles.cap}
                data-state={lamps[index]}
                style={{ '--cap': `var(--${button.token})`, '--cap-off': `var(--${button.token}-off)` } as React.CSSProperties}
                aria-label={`Button ${button.n}, ${button.who}. Hold to record a voice note, tap to play.`}
                onPointerDown={(event) => {
                  startPress(index)
                  // Capture, so a finger that slides off the cap still delivers its pointerup
                  // here and the lamp cannot be left recording forever. Best-effort: a browser
                  // that refuses the capture must not cost us the press itself.
                  try {
                    event.currentTarget.setPointerCapture(event.pointerId)
                  } catch {
                    /* no capture; the pointerup below and onBlur still end the press */
                  }
                }}
                onPointerUp={() => endPress(index)}
                onPointerCancel={() => endPress(index)}
                onKeyDown={(event) => {
                  if (event.key !== ' ' && event.key !== 'Enter') return
                  event.preventDefault() // Space would scroll, and Enter would fire onClick too.
                  if (!event.repeat) startPress(index)
                }}
                onKeyUp={(event) => {
                  if (event.key !== ' ' && event.key !== 'Enter') return
                  endPress(index)
                }}
                onBlur={() => endPress(index)}
              >
                <span className={styles.lens} aria-hidden="true" />
              </button>
              <span className={styles.who}>{button.who}</span>
            </div>
          ))}
        </div>
        <span className={styles.nameplate} aria-hidden="true">
          bloopbox
        </span>
      </div>

      <p className={styles.caption} aria-live="polite">
        {caption}
      </p>
    </div>
  )
}
