/**
 * Virtual device front-end.
 *
 * Phase 1: entry point only — renders the three buttons so the build and typecheck
 * have real inputs. Phase 2d wires this to the simulator HAL driver over Socket.io:
 * mouse-hold -> buttonDown/buttonUp, live LED state from the driver, getUserMedia
 * capture, queued playback, and the event injector.
 */

const BUTTON_COUNT = 3;
const BUTTON_LABELS = ['Button 1', 'Button 2', 'Button 3'] as const;

/** Placeholder LED state until the Socket.io driver feeds real values. */
const ledState: boolean[] = Array.from({ length: BUTTON_COUNT }, () => false);

/* Exported so this file is a module rather than a global script — as a script its
   top-level names would merge with the other page's. */
export function drawDevice(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const radius = 70;
  const gap = canvas.width / (BUTTON_COUNT + 1);

  for (let i = 0; i < BUTTON_COUNT; i++) {
    const cx = gap * (i + 1);
    const cy = canvas.height / 2;
    const lit = ledState[i] ?? false;

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = lit ? '#ffd54a' : '#2a2a32';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#12121a';
    ctx.stroke();

    ctx.fillStyle = lit ? '#12121a' : '#8b8b99';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(BUTTON_LABELS[i] ?? '', cx, cy + radius + 28);
  }
}

function main(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#device');
  const status = document.querySelector<HTMLParagraphElement>('#status');

  if (!canvas) {
    throw new Error('simulator: #device canvas missing');
  }

  drawDevice(canvas);

  if (status) {
    status.textContent = 'Simulator shell ready — interaction lands in Phase 2d';
  }
}

main();
