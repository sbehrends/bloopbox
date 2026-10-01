'use client'

import { useCallback, useMemo, useRef, useState } from 'react'

import styles from './PrintPrepTool.module.css'

// 29 mm button cutouts in a 118 x 32 mm block; each photo is clipped to an equal third.
const CIRCLE_DIAMETER_MM = 29
const CIRCLE_GAP_MM = 42
const BLOCK_WIDTH_MM = 118
const BLOCK_HEIGHT_MM = 32
const THIRD_WIDTH_MM = BLOCK_WIDTH_MM / 3

const SLOT_LABELS = ['Left button', 'Middle button', 'Right button'] as const

const SLOT_COLORS = ['#f7b733', '#ff6f61', '#00a7e1'] as const

type Slot = {
  url: string | null
  fileName: string | null
  aspect: number // natural width / height
  scale: number // 1 = cover the circle exactly, larger = zoomed in
  offsetX: number // percent of the displayed image's own box
  offsetY: number
}

const EMPTY_SLOT: Slot = {
  url: null,
  fileName: null,
  aspect: 1,
  scale: 1,
  offsetX: 0,
  offsetY: 0,
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function PrintPrepTool() {
  const [slots, setSlots] = useState<Slot[]>([{ ...EMPTY_SLOT }, { ...EMPTY_SLOT }, { ...EMPTY_SLOT }])

  const allReady = slots.every((slot) => slot.url !== null)

  const updateSlot = useCallback((index: number, patch: Partial<Slot>) => {
    setSlots((prev) => prev.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)))
  }, [])

  const handleFile = useCallback(
    (index: number, file: File | undefined) => {
      if (!file) return
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        updateSlot(index, {
          url,
          fileName: file.name,
          aspect: img.naturalWidth / img.naturalHeight,
          scale: 1,
          offsetX: 0,
          offsetY: 0,
        })
      }
      img.src = url
    },
    [updateSlot],
  )

  const handlePrint = useCallback(() => {
    window.print()
  }, [])

  return (
    <div className={styles.page}>
      <div className={styles.editor}>
        <header className={styles.header}>
          <h1>Button image print prep</h1>
          <p>
            Upload the 3 photos that go under the buttons, drag and zoom each one to frame it, then
            print. Circles are cut at {CIRCLE_DIAMETER_MM} mm diameter, {CIRCLE_GAP_MM} mm apart
            center to center — this page prints them true to size, no scaling needed.
          </p>
        </header>

        <div className={styles.slots}>
          {slots.map((slot, index) => (
            <SlotEditor
              key={index}
              label={SLOT_LABELS[index] ?? `Image ${index + 1}`}
              color={SLOT_COLORS[index] ?? '#333'}
              slot={slot}
              onFile={(file) => handleFile(index, file)}
              onChange={(patch) => updateSlot(index, patch)}
            />
          ))}
        </div>

        <section className={styles.previewSection}>
          <h2>Print preview</h2>
          <p>
            This is the exact layout that will print: a solid {BLOCK_WIDTH_MM} x{' '}
            {BLOCK_HEIGHT_MM} mm outline for the whole block, cut first, then each photo inside
            its own third of the block — the circle cut guides shown below are for framing only
            and won't print; cut the {CIRCLE_DIAMETER_MM} mm circles by eye once the block is
            cut out. Load plain paper into the printer and disable "fit to page" / scaling in the
            print dialog.
          </p>
          <PrintSheet slots={slots} />
        </section>

        <button className={styles.printButton} type="button" disabled={!allReady} onClick={handlePrint}>
          {allReady ? 'Print' : 'Upload all 3 images to print'}
        </button>
      </div>

      <div className={styles.printOnly}>
        <PrintSheet slots={slots} />
      </div>
    </div>
  )
}

function SlotEditor({
  label,
  color,
  slot,
  onFile,
  onChange,
}: {
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
    <div className={styles.slot}>
      <span className={styles.slotLabel}>{label}</span>
      <div
        className={styles.circle}
        style={{ borderColor: color }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {slot.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={slot.url} alt="" className={styles.circleImage} style={imgStyle} draggable={false} />
        ) : (
          <span className={styles.circlePlaceholder}>No image</span>
        )}
      </div>

      <label className={styles.fileInput}>
        {slot.fileName ?? 'Choose image'}
        <input
          type="file"
          accept="image/*"
          onChange={(event) => onFile(event.currentTarget.files?.[0])}
        />
      </label>

      {slot.url && (
        <label className={styles.zoomControl}>
          Zoom
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
  return (
    <div className={styles.block} style={{ width: `${BLOCK_WIDTH_MM}mm`, height: `${BLOCK_HEIGHT_MM}mm` }}>
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
            <div className={styles.cutGuide} style={{ borderColor: SLOT_COLORS[index] ?? '#333' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
