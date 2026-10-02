import { io, type Socket } from 'socket.io-client';
import { element } from '../shared/dom.ts';
import { CHANNEL_OFF_TOKENS, CHANNEL_TOKENS, readToken } from '../shared/theme.ts';
import type { ServerToSimulatorEvents, SimulatorToServerEvents } from '../../src/ipc/events.ts';

/**
 * Virtual device front-end (PRODUCT.md §5).
 *
 * The browser is a dumb terminal for the real device pipeline: it reports button edges,
 * renders whatever LED states the server sends, and captures/plays audio. It makes no
 * decisions about LED patterns or timing — those live in src/core on the server, so what
 * you see here is exactly what the GPIO driver would receive.
 *
 * The enclosure it paints is the Retro-Futurist Intercom from docs/BRAND.md, drawn from the
 * --device-* and --ch-* tokens in shared/tokens.css. A canvas cannot use a class, so this is
 * the one place the design system has to be read rather than applied.
 */

type ButtonIndex = 0 | 1 | 2;

const BUTTON_COUNT = 3;
/** Typed so loops yield ButtonIndex directly instead of needing a cast. */
const BUTTON_INDICES: readonly ButtonIndex[] = [0, 1, 2];
const BUTTON_LABELS = ['Button 1 · Left', 'Button 2 · Centre', 'Button 3 · Right'] as const;

/** Matches the physical layout: 30mm arcade buttons in a row. */
const BUTTON_RADIUS = 68;

const TAU = Math.PI * 2;
/** The moulded shell inside the canvas, and the darker top panel carrying the grille. */
const PANEL_INSET = 8;
const PANEL_TOP = 74;
const PANEL_RADIUS = 30;

/**
 * The enclosure's colours, resolved once at load.
 *
 * Deliberately not re-read on a theme change: a physical object in a child's room does not
 * repaint itself because the parent switched their laptop to dark mode, and tokens.css keeps
 * these outside its dark-mode block for the same reason.
 */
type Triple = readonly [string, string, string];

/** A fixed triple, so a lens lookup by ButtonIndex is a string and never `string | undefined`. */
function readTriple(tokens: Triple, fallbacks: Triple): Triple {
  return [
    readToken(tokens[0], fallbacks[0]),
    readToken(tokens[1], fallbacks[1]),
    readToken(tokens[2], fallbacks[2]),
  ];
}

const device = {
  body: readToken('--device-body', '#e6dac3'),
  bodyTop: readToken('--device-body-top', '#d8c6a5'),
  edge: readToken('--device-edge', '#12203a'),
  ink: readToken('--device-ink', '#1a2b48'),
  display: readToken('--font-display', 'system-ui, sans-serif'),
  lens: readTriple(CHANNEL_TOKENS, ['#f7b733', '#ff6f61', '#00a7e1']),
  lensOff: readTriple(CHANNEL_OFF_TOKENS, ['#c4b58c', '#c39b93', '#8fa9b4']),
} as const;

// Typed by the shared maps (reversed: a client listens to what the server emits). The payload
// types below stay defensive anyway — they narrow what arrives, the maps say what should.
const socket: Socket<ServerToSimulatorEvents, SimulatorToServerEvents> = io({
  transports: ['websocket', 'polling'],
});

/** Authoritative LED state, pushed by the server. Never computed here. */
const ledStates: boolean[] = Array.from({ length: BUTTON_COUNT }, () => false);
/** Which buttons the mouse is currently holding, for the pressed-in look. */
const heldButtons = new Set<ButtonIndex>();

const canvas = document.querySelector<HTMLCanvasElement>('#device');
const statusLine = document.querySelector<HTMLParagraphElement>('#status');
const injectorRoot = document.querySelector<HTMLDivElement>('#injector');

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function buttonCentre(index: number, width: number, height: number): { x: number; y: number } {
  const gap = width / (BUTTON_COUNT + 1);
  // Centred in what is left of the panel below the grille, not in the canvas.
  return { x: gap * (index + 1), y: PANEL_TOP + (height - PANEL_TOP - PANEL_INSET) / 2 - 12 };
}

/** The shell: rounded body, darker top panel, hard navy edge. */
function drawShell(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const inner = new Path2D();
  inner.roundRect(
    PANEL_INSET,
    PANEL_INSET,
    width - PANEL_INSET * 2,
    height - PANEL_INSET * 2,
    PANEL_RADIUS,
  );

  // Clipped rather than filled per shape, so the top strip picks up the shell's own corners.
  ctx.save();
  ctx.clip(inner);
  ctx.fillStyle = device.body;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = device.bodyTop;
  ctx.fillRect(0, 0, width, PANEL_TOP);
  ctx.restore();

  ctx.strokeStyle = device.edge;
  ctx.lineWidth = 3;
  ctx.stroke(inner);
  ctx.beginPath();
  ctx.moveTo(PANEL_INSET, PANEL_TOP);
  ctx.lineTo(width - PANEL_INSET, PANEL_TOP);
  ctx.stroke();
}

/** Speaker holes on the left of the top panel, wordmark on the right. */
function drawTopPanel(ctx: CanvasRenderingContext2D, width: number): void {
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = device.edge;
  for (let row = 0; row < 2; row++) {
    for (let hole = 0; hole < 12; hole++) {
      ctx.beginPath();
      ctx.arc(46 + hole * 18, 28 + row * 18, 3.5, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();

  ctx.fillStyle = device.ink;
  ctx.font = `800 26px ${device.display}`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('bloopbox', width - 34, PANEL_TOP / 2);
}

/** One arcade button: navy bezel, colour-coded lens, glossy cap. */
function drawButton(ctx: CanvasRenderingContext2D, index: ButtonIndex): void {
  if (!canvas) return;
  const { x, y } = buttonCentre(index, canvas.width, canvas.height);
  const lit = ledStates[index] ?? false;
  const held = heldButtons.has(index);
  // A pressed button sits deeper in its bezel, which is the whole feel of the thing.
  const radius = held ? BUTTON_RADIUS - 5 : BUTTON_RADIUS;

  ctx.beginPath();
  ctx.arc(x, y, BUTTON_RADIUS + 10, 0, TAU);
  ctx.fillStyle = device.edge;
  ctx.fill();

  const lens = lit ? device.lens[index] : device.lensOff[index];

  if (lit) {
    // A soft glow makes fast patterns (the 0.1s flashes of a send) legible on screen.
    ctx.save();
    ctx.shadowColor = lens;
    ctx.shadowBlur = 38;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fillStyle = lens;
    ctx.fill();
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fillStyle = lens;
  ctx.fill();

  // Translucent moulded cap: a highlight up and left of centre.
  const gloss = ctx.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.4,
    radius * 0.05,
    x,
    y,
    radius,
  );
  gloss.addColorStop(0, `rgba(255, 255, 255, ${held ? '0.18' : '0.42'})`);
  gloss.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = gloss;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = device.edge;
  ctx.lineWidth = held ? 5 : 3;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.stroke();

  ctx.save();
  ctx.globalAlpha = 0.72;
  ctx.fillStyle = device.ink;
  ctx.font = `600 15px ${device.display}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(BUTTON_LABELS[index] ?? '', x, y + BUTTON_RADIUS + 40);
  ctx.restore();
}

function draw(): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawShell(ctx, canvas.width, canvas.height);
  drawTopPanel(ctx, canvas.width);
  for (const index of BUTTON_INDICES) drawButton(ctx, index);
}

/* ------------------------------------------------------------------ *
 * Button input
 * ------------------------------------------------------------------ */

function hitTest(event: PointerEvent): ButtonIndex | null {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  // The canvas is CSS-scaled, so map client coords into its coordinate space.
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;

  for (const index of BUTTON_INDICES) {
    const centre = buttonCentre(index, canvas.width, canvas.height);
    const distance = Math.hypot(x - centre.x, y - centre.y);
    if (distance <= BUTTON_RADIUS) return index;
  }
  return null;
}

function pressButton(index: ButtonIndex): void {
  if (heldButtons.has(index)) return;
  heldButtons.add(index);
  socket.emit('sim:buttonDown', { index });
  draw();
}

function releaseButton(index: ButtonIndex): void {
  if (!heldButtons.delete(index)) return;
  socket.emit('sim:buttonUp', { index });
  draw();
}

function releaseAll(): void {
  // Snapshot first — releaseButton deletes from the set as we go.
  for (const index of Array.from(heldButtons)) releaseButton(index);
}

if (canvas) {
  canvas.addEventListener('pointerdown', (event) => {
    const index = hitTest(event);
    if (index === null) return;
    // Capture so a drag off the canvas still delivers pointerup.
    canvas.setPointerCapture(event.pointerId);
    pressButton(index);
  });

  canvas.addEventListener('pointerup', (event) => {
    const index = hitTest(event);
    if (index === null) releaseAll();
    else releaseButton(index);
  });

  // A release outside the window would otherwise leave a button stuck down.
  canvas.addEventListener('pointercancel', releaseAll);
  window.addEventListener('blur', releaseAll);
}

/**
 * Keyboard shortcuts: 1/2/3 hold the corresponding button.
 *
 * Holding two keys is how you reach the silent-mode chord (1 + 3) without a second mouse.
 */
const KEY_TO_INDEX = new Map<string, ButtonIndex>([
  ['1', 0],
  ['2', 1],
  ['3', 2],
]);

window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  const index = KEY_TO_INDEX.get(event.key);
  if (index !== undefined) pressButton(index);
});

window.addEventListener('keyup', (event) => {
  const index = KEY_TO_INDEX.get(event.key);
  if (index !== undefined) releaseButton(index);
});

/* ------------------------------------------------------------------ *
 * Audio capture
 * ------------------------------------------------------------------ */

let mediaStream: MediaStream | null = null;

/**
 * Captures in flight, keyed by recording id.
 *
 * A map rather than a single handle because captures overlap: the interpreter starts one on
 * every press, so a second button going down while the first is still open — a tap over a
 * held button, the silent-mode chord — leaves two live at once. A single `activeRecordingId`
 * loses the older one, and an orphaned MediaRecorder never stops: it streams the room to the
 * server for as long as the tab is open.
 */
type Capture = { readonly instance: MediaRecorder; cancelled: boolean };
const captures = new Map<string, Capture>();

/**
 * Stops and cancels that arrived before their capture finished starting.
 *
 * `startCapture` awaits the microphone, so the server can answer a press we have not caught
 * up with yet — a tap is discarded well inside that window.
 */
const preempted = new Map<string, 'stop' | 'cancel'>();

/** Requested lazily: asking on page load would prompt before the user does anything. */
async function getStream(): Promise<MediaStream> {
  mediaStream ??= await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  return mediaStream;
}

function pickMimeType(): string {
  // Chrome gives WebM/Opus, Firefox can do Ogg/Opus. The server transcodes either way.
  for (const candidate of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

async function startCapture(recordingId: string): Promise<void> {
  try {
    const stream = await getStream();

    // The take may already be over — a tap is discarded inside the microphone's own latency.
    const early = preempted.get(recordingId);
    preempted.delete(recordingId);
    if (early === 'cancel') return;

    const mimeType = pickMimeType();
    const instance = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const capture: Capture = { instance, cancelled: false };
    captures.set(recordingId, capture);

    instance.addEventListener('dataavailable', (event) => {
      if (event.data.size === 0 || capture.cancelled) return;
      void (async (): Promise<void> => {
        const chunk = await event.data.arrayBuffer();
        socket.emit('sim:audioChunk', { recordingId, chunk });
      })();
    });

    instance.addEventListener('stop', () => {
      // A cancelled take is never delivered.
      if (capture.cancelled) return;
      // Chunks are queued as microtasks above; let them flush before signalling completion.
      setTimeout(() => {
        socket.emit('sim:audioComplete', { recordingId, mimeType: instance.mimeType });
      }, 50);
    });

    instance.start(250);
    if (early === 'stop') stopCapture(recordingId);
  } catch (error: unknown) {
    captures.delete(recordingId);
    preempted.delete(recordingId);
    socket.emit('sim:audioError', {
      recordingId,
      reason: error instanceof Error ? error.message : 'microphone unavailable',
    });
  }
}

function stopCapture(recordingId: string): void {
  const capture = captures.get(recordingId);
  if (!capture) {
    preempted.set(recordingId, 'stop');
    return;
  }
  captures.delete(recordingId);
  if (capture.instance.state !== 'inactive') capture.instance.stop();
}

function cancelCapture(recordingId: string): void {
  const capture = captures.get(recordingId);
  if (!capture) {
    preempted.set(recordingId, 'cancel');
    return;
  }
  captures.delete(recordingId);
  capture.cancelled = true;
  if (capture.instance.state !== 'inactive') capture.instance.stop();
}

/* ------------------------------------------------------------------ *
 * Playback
 * ------------------------------------------------------------------ */

let currentAudio: HTMLAudioElement | null = null;

function play(token: string, url: string, volumePercent: number): void {
  stopPlayback();

  const audio = new Audio(url);
  audio.volume = Math.min(Math.max(volumePercent / 100, 0), 1);
  currentAudio = audio;

  audio.addEventListener('ended', () => {
    if (currentAudio === audio) currentAudio = null;
    socket.emit('sim:playbackComplete', { token });
  });

  audio.addEventListener('error', () => {
    if (currentAudio === audio) currentAudio = null;
    socket.emit('sim:playbackError', { token, reason: 'audio element failed' });
  });

  void audio.play().catch((error: unknown) => {
    if (currentAudio === audio) currentAudio = null;
    socket.emit('sim:playbackError', {
      token,
      // Autoplay is blocked until the user interacts with the page at least once.
      reason: error instanceof Error ? error.message : 'playback rejected',
    });
  });
}

function stopPlayback(): void {
  if (!currentAudio) return;
  const audio = currentAudio;
  currentAudio = null;
  audio.pause();
  audio.src = '';
}

/* ------------------------------------------------------------------ *
 * Server events
 * ------------------------------------------------------------------ */

type LedPayload = { states?: unknown };
type CapturePayload = { recordingId?: unknown };
type PlayPayload = { token?: unknown; url?: unknown; cue?: unknown; volumePercent?: unknown };
type StatusPayload = { state?: unknown; silentMode?: unknown; driver?: unknown };

socket.on('sim:leds', (payload: LedPayload) => {
  if (!Array.isArray(payload.states)) return;
  for (let index = 0; index < BUTTON_COUNT; index++) {
    ledStates[index] = payload.states[index] === true;
  }
  draw();
});

socket.on('sim:startCapture', (payload: CapturePayload) => {
  if (typeof payload.recordingId === 'string') void startCapture(payload.recordingId);
});

socket.on('sim:stopCapture', (payload: CapturePayload) => {
  if (typeof payload.recordingId === 'string') stopCapture(payload.recordingId);
});

socket.on('sim:cancelCapture', (payload: CapturePayload) => {
  if (typeof payload.recordingId === 'string') cancelCapture(payload.recordingId);
});

socket.on('sim:play', (payload: PlayPayload) => {
  if (typeof payload.token !== 'string' || typeof payload.url !== 'string') return;
  play(payload.token, payload.url, asVolume(payload.volumePercent));
});

socket.on('sim:playCue', (payload: PlayPayload) => {
  if (typeof payload.token !== 'string' || typeof payload.cue !== 'string') return;
  play(payload.token, `/sounds/${payload.cue}.wav`, asVolume(payload.volumePercent));
});

socket.on('sim:stopPlayback', stopPlayback);

socket.on('sim:status', (payload: StatusPayload) => {
  if (!statusLine) return;
  const state = typeof payload.state === 'string' ? payload.state : 'unknown';
  const driver = typeof payload.driver === 'string' ? payload.driver : '';
  const silent = payload.silentMode === true ? ' · silent' : '';
  statusLine.textContent = `${state}${silent}${driver ? ` · ${driver}` : ''}`;
});

socket.on('connect', () => {
  if (statusLine) statusLine.textContent = 'connected';
});

socket.on('disconnect', () => {
  releaseAll();
  stopPlayback();
  if (statusLine) statusLine.textContent = 'disconnected — is the hardware server running?';
});

function asVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 70;
}

/* ------------------------------------------------------------------ *
 * Event injector
 * ------------------------------------------------------------------ */

const INJECTORS: readonly { label: string; run: () => void }[] = [
  {
    // Without this the device never leaves CONNECTING, so the normal-mode LED patterns
    // (all off, unread blink) are unreachable in the simulator.
    label: 'WhatsApp connected (go READY)',
    run: () => socket.emit('sim:injectWhatsAppConnected'),
  },
  {
    // The boot chase is otherwise only visible in the first seconds of process life.
    label: 'Reboot (replay boot chase)',
    run: () => socket.emit('sim:reboot'),
  },
  {
    label: 'Voice note from Button 1',
    run: () => socket.emit('sim:injectIncoming', { index: 0 }),
  },
  {
    label: '3 notes from Button 2',
    run: () => socket.emit('sim:injectIncoming', { index: 1, count: 3 }),
  },
  {
    label: 'Voice note from Button 3',
    run: () => socket.emit('sim:injectIncoming', { index: 2 }),
  },
  {
    label: 'Wi-Fi down',
    run: () => socket.emit('sim:injectWifiFailure', { down: true }),
  },
  {
    label: 'Wi-Fi restored',
    run: () => socket.emit('sim:injectWifiFailure', { down: false }),
  },
  {
    label: 'Setup hotspot up',
    run: () => socket.emit('sim:injectApMode', { active: true }),
  },
  {
    label: 'Setup hotspot down',
    run: () => socket.emit('sim:injectApMode', { active: false }),
  },
  {
    label: 'WhatsApp session expired',
    run: () => socket.emit('sim:injectSessionExpiry'),
  },
];

if (injectorRoot) {
  for (const injector of INJECTORS) {
    const button = element('button', undefined, injector.label);
    button.type = 'button';
    button.addEventListener('click', injector.run);
    injectorRoot.append(button);
  }
}

draw();
