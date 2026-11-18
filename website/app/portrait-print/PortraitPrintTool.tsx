'use client'

import { useCallback, useMemo, useRef, useState } from 'react'

import styles from './PortraitPrintTool.module.css'

// 29 mm button cutouts in a 110 x 34 mm block; each photo is clipped to an equal third.
// A blank tab sticks out of each side, vertically centred, so the whole piece is one outline.
const CIRCLE_DIAMETER_MM = 29
const BLOCK_WIDTH_MM = 110
const BLOCK_HEIGHT_MM = 34
const THIRD_WIDTH_MM = BLOCK_WIDTH_MM / 3
const TAB_WIDTH_MM = 60
const TAB_HEIGHT_MM = 18
const SHEET_WIDTH_MM = TAB_WIDTH_MM * 2 + BLOCK_WIDTH_MM
const TAB_TOP_MM = (BLOCK_HEIGHT_MM - TAB_HEIGHT_MM) / 2

// Clockwise from the top-left corner of the left tab.
const OUTLINE_PATH = [
  [0, TAB_TOP_MM],
  [TAB_WIDTH_MM, TAB_TOP_MM],
  [TAB_WIDTH_MM, 0],
  [TAB_WIDTH_MM + BLOCK_WIDTH_MM, 0],
  [TAB_WIDTH_MM + BLOCK_WIDTH_MM, TAB_TOP_MM],
  [SHEET_WIDTH_MM, TAB_TOP_MM],
  [SHEET_WIDTH_MM, TAB_TOP_MM + TAB_HEIGHT_MM],
  [TAB_WIDTH_MM + BLOCK_WIDTH_MM, TAB_TOP_MM + TAB_HEIGHT_MM],
  [TAB_WIDTH_MM + BLOCK_WIDTH_MM, BLOCK_HEIGHT_MM],
  [TAB_WIDTH_MM, BLOCK_HEIGHT_MM],
  [TAB_WIDTH_MM, TAB_TOP_MM + TAB_HEIGHT_MM],
  [0, TAB_TOP_MM + TAB_HEIGHT_MM],
]
  .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`)
  .join(' ')
  .concat(' Z')

// Left to right, in the channel order the logo mark and the enclosure use (tokens.css --ch-*).
const SLOTS = [
  { label: 'Left button', color: 'var(--ch-1)' },
  { label: 'Middle button', color: 'var(--ch-2)' },
  { label: 'Right button', color: 'var(--ch-3)' },
] as const

// What every browser can draw. HEIC (an iPhone's default) is not on the list: only Safari decodes
// it, so it would work on one machine and fail silently on the next.
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
const ACCEPTED_LABEL = 'JPG, PNG or WebP'

type Slot = {
  url: string | null
  fileName: string | null
  error: string | null
  aspect: number // natural width / height
  scale: number // 1 = cover the circle exactly, larger = zoomed in
  offsetX: number // percent of the displayed image's own box
  offsetY: number
}

const EMPTY_SLOT: Slot = {
  url: null,
  fileName: null,
  error: null,
  aspect: 1,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function PortraitPrintTool() {
  const [slots, setSlots] = useState<Slot[]>([{ ...EMPTY_SLOT }, { ...EMPTY_SLOT }, { ...EMPTY_SLOT }])

  const readyCount = slots.filter((slot) => slot.url !== null).length
  const allReady = readyCount === slots.length

  const updateSlot = useCallback((index: number, patch: Partial<Slot>) => {
    setSlots((prev) => prev.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)))
  }, [])

  const handleFile = useCallback(
    (index: number, file: File | undefined) => {
      if (!file) return
      // `accept` on the input is only a hint: the picker's "All files" option bypasses it.
      if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
        updateSlot(index, { error: `“${file.name}” isn’t a ${ACCEPTED_LABEL} file.` })
        return
      }
      // The file is read into this tab only: an object URL never leaves the browser.
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        updateSlot(index, {
          url,
          fileName: file.name,
          error: null,
          aspect: img.naturalWidth / img.naturalHeight,
          scale: 1,
          offsetX: 0,
          offsetY: 0,
        })
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        updateSlot(index, { error: `“${file.name}” couldn’t be opened. Try another photo.` })
      }
      img.src = url
    },
    [updateSlot],
  )

  const handlePrint = useCallback(() => {
    window.print()
  }, [])

  return (
    <>
      <main id="main" className={styles.screenOnly}>
        <section className={`wrap ${styles.hero}`}>
          <p className="eyebrow">Button photos</p>
          <h1>Put a face behind every button.</h1>
          <p className="lede">
            Pick a photo for each button, drag and zoom it until the face sits in the circle, then
            print the strip. It comes out true to size — no scaling, no measuring.
          </p>

          <dl className={styles.facts}>
            <div>
              <dt>Paper</dt>
              <dd>A4, landscape</dd>
            </div>
            <div>
              <dt>Strip</dt>
              <dd>
                {SHEET_WIDTH_MM} × {BLOCK_HEIGHT_MM} mm
              </dd>
            </div>
            <div>
              <dt>Circles</dt>
              <dd>{CIRCLE_DIAMETER_MM} mm</dd>
            </div>
          </dl>
        </section>

        <section className={`wrap ${styles.section}`} id="photos" aria-labelledby="photos-title">
          <p className="eyebrow">Frame the photos</p>
          <h2 className={styles.sectionTitle} id="photos-title">
            One photo for each colour.
          </h2>
          <p className={`lede ${styles.sectionLede}`}>
            Left to right, in the same order as the buttons on the box. Drag a photo to move it
            inside its circle; the slider zooms in. {ACCEPTED_LABEL} photos work.
          </p>

          <p className={styles.privacy}>
            <strong>Your photos stay on this computer.</strong> Nothing is uploaded: the page opens
            them, frames them and prints them right here in your browser, and forgets them when you
            close the tab.
          </p>

          <div className={styles.slots}>
            {slots.map((slot, index) => (
              <SlotEditor
                key={index}
                index={index}
                label={SLOTS[index]?.label ?? `Button ${index + 1}`}
                color={SLOTS[index]?.color ?? 'var(--border-strong)'}
                slot={slot}
                onFile={(file) => handleFile(index, file)}
                onChange={(patch) => updateSlot(index, patch)}
              />
            ))}
          </div>
        </section>

        <section className={`wrap ${styles.section}`} id="print" aria-labelledby="print-title">
          <p className="eyebrow">Print and cut</p>
          <h2 className={styles.sectionTitle} id="print-title">
            This is exactly what prints.
          </h2>

          <div className={styles.paper}>
            <div className={styles.previewScroll}>
              <PrintSheet slots={slots} />
            </div>
          </div>

          <ol className={styles.howTo}>
            <li>
              In the print dialog, choose <strong>A4 landscape</strong> and turn off{' '}
              <strong>Fit to page</strong> — print at 100%.
            </li>
            <li>
              Cut along the solid outline first: the {BLOCK_WIDTH_MM} × {BLOCK_HEIGHT_MM} mm strip
              with a {TAB_WIDTH_MM} × {TAB_HEIGHT_MM} mm tab on each side.
            </li>
            <li>
              The coloured circles are for framing on screen and don&rsquo;t print. Cut the{' '}
              {CIRCLE_DIAMETER_MM} mm circles by eye once the strip is out.
            </li>
          </ol>

          <div className={styles.printBar}>
            <button className={`btn btn-primary ${styles.printButton}`} type="button" disabled={!allReady} onClick={handlePrint}>
              Print
            </button>
            <p className={styles.printHint} aria-live="polite">
              {allReady ? 'All three photos are in.' : `${readyCount} of 3 photos added — add all three to print.`}
            </p>
          </div>
        </section>
      </main>

      <div className={styles.printOnly}>
        <PrintSheet slots={slots} />
      </div>
    </>
  )
}

function SlotEditor({
  index,
  label,
  color,
  slot,
  onFile,
  onChange,
}: {
  index: number
  label: string
  color: string
  slot: Slot
  onFile: (file: File | undefined) => void
  onChange: (patch: Partial<Slot>) => void
}) {
  const dragState = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(
    null,
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!slot.url) return
      ;(event.target as HTMLElement).setPointerCapture(event.pointerId)
      dragState.current = {
        startX: event.clientX,
        startY: event.clientY,
        offsetX: slot.offsetX,
        offsetY: slot.offsetY,
      }
    },
    [slot.url, slot.offsetX, slot.offsetY],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragState.current
      if (!drag) return
      const box = event.currentTarget.getBoundingClientRect()
      const dxPercent = ((event.clientX - drag.startX) / box.width) * 100
      const dyPercent = ((event.clientY - drag.startY) / box.height) * 100
      onChange({
        offsetX: clamp(drag.offsetX + dxPercent / slot.scale, -100, 100),
        offsetY: clamp(drag.offsetY + dyPercent / slot.scale, -100, 100),
      })
    },
    [onChange, slot.scale],
  )

  const onPointerUp = useCallback(() => {
    dragState.current = null
  }, [])

  const imgStyle = useMemo(() => imageStyle(slot), [slot])

  return (
    <div className={`card ${styles.slot}`} style={{ '--slot-color': color } as React.CSSProperties}>
      <p className={styles.slotLabel}>
        <span className={styles.slotNumber} aria-hidden="true">
          {index + 1}
        </span>
        {label}
      </p>

      <div
        className={styles.circle}
        data-empty={slot.url ? undefined : ''}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {slot.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={slot.url} alt="" className={styles.circleImage} style={imgStyle} draggable={false} />
        ) : (
          <span className={styles.circlePlaceholder}>No photo yet</span>
        )}
      </div>

      <label className={`btn btn-secondary ${styles.fileButton}`}>
        <span className={styles.fileName}>{slot.fileName ? 'Change photo' : 'Choose photo'}</span>
        <input
          className={styles.srOnly}
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          aria-label={`Photo for the ${label.toLowerCase()}`}
          onChange={(event) => {
            onFile(event.currentTarget.files?.[0])
            // Cleared so picking the same file again after an error still fires a change.
            event.currentTarget.value = ''
          }}
        />
      </label>

      {slot.error && (
        <p className={styles.slotError} role="alert">
          {slot.error}
        </p>
      )}

      {slot.url && (
        <label className={styles.zoomControl}>
          <span>Zoom</span>
          <input
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={slot.scale}
            onChange={(event) => onChange({ scale: Number(event.currentTarget.value) })}
          />
        </label>
      )}
    </div>
  )
}

function imageStyle(slot: Slot): React.CSSProperties {
  // Cover-fit a square box; height/width:auto keeps the aspect ratio with no pixel math.
  const base =
    slot.aspect >= 1 ? { height: '100%', width: 'auto' } : { width: '100%', height: 'auto' }
  return {
    ...base,
    transform: `translate(-50%, -50%) translate(${slot.offsetX}%, ${slot.offsetY}%) scale(${slot.scale})`,
  }
}

function PrintSheet({ slots }: { slots: Slot[] }) {
  const viewBox = `0 0 ${SHEET_WIDTH_MM} ${BLOCK_HEIGHT_MM}`
  return (
    <div className={styles.sheet} style={{ width: `${SHEET_WIDTH_MM}mm`, height: `${BLOCK_HEIGHT_MM}mm` }}>
      {/* The paper itself, tabs included, under the photos; the cut line is drawn again on top. */}
      <svg className={`${styles.outline} ${styles.outlineFill}`} viewBox={viewBox} aria-hidden="true">
        <path d={OUTLINE_PATH} />
      </svg>
      <div
        className={styles.block}
        style={{ left: `${TAB_WIDTH_MM}mm`, width: `${BLOCK_WIDTH_MM}mm`, height: `${BLOCK_HEIGHT_MM}mm` }}
      >
        {slots.map((slot, index) => (
          <div key={index} className={styles.printColumn} style={{ width: `${THIRD_WIDTH_MM}mm` }}>
            <div
              className={styles.printFrame}
              style={{ width: `${CIRCLE_DIAMETER_MM}mm`, height: `${CIRCLE_DIAMETER_MM}mm` }}
            >
              {slot.url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={slot.url} alt="" className={styles.printImage} style={imageStyle(slot)} draggable={false} />
              )}
              <div className={styles.cutGuide} style={{ borderColor: SLOTS[index]?.color ?? 'var(--border-strong)' }} />
            </div>
          </div>
        ))}
      </div>
      <svg className={`${styles.outline} ${styles.outlineStroke}`} viewBox={viewBox} aria-hidden="true">
        <path d={OUTLINE_PATH} />
      </svg>
    </div>
  )
}
