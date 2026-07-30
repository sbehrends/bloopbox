import { io, type Socket } from 'socket.io-client';

/**
 * Virtual device front-end (PRODUCT.md §5).
 *
 * The browser is a dumb terminal for the real device pipeline: it reports button edges,
 * renders whatever LED states the server sends, and captures/plays audio. It makes no
 * decisions about LED patterns or timing — those live in src/core on the server, so what
 * you see here is exactly what the GPIO driver would receive.
 */

type ButtonIndex = 0 | 1 | 2;

const BUTTON_COUNT = 3;
/** Typed so loops yield ButtonIndex directly instead of needing a cast. */
const BUTTON_INDICES: readonly ButtonIndex[] = [0, 1, 2];
const BUTTON_LABELS = ['Button 1 · Left', 'Button 2 · Centre', 'Button 3 · Right'] as const;

/** Matches the physical layout: 60mm arcade buttons in a row. */
const BUTTON_RADIUS = 74;

const socket: Socket = io({ transports: ['websocket', 'polling'] });

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
  return { x: gap * (index + 1), y: height / 2 - 10 };
}

function draw(): void {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const index of BUTTON_INDICES) {
    const { x, y } = buttonCentre(index, canvas.width, canvas.height);
    const lit = ledStates[index] ?? false;
    const held = heldButtons.has(index);
    const radius = held ? BUTTON_RADIUS - 4 : BUTTON_RADIUS;

    // Bezel.
    ctx.beginPath();
    ctx.arc(x, y, radius + 8, 0, Math.PI * 2);
    ctx.fillStyle = '#0d0d14';
    ctx.fill();

    // Lens. Lit is the LED being on, which is the whole point of the simulator.
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = lit ? '#ffd54a' : '#2a2a34';
    ctx.fill();

    if (lit) {
      // A soft glow makes fast patterns (0.1s flashes) legible on screen.
      ctx.shadowColor = '#ffd54a';
      ctx.shadowBlur = 34;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.strokeStyle = held ? '#ffffff' : '#43434f';
    ctx.lineWidth = held ? 4 : 3;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#8b8b99';
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(BUTTON_LABELS[index] ?? '', x, y + radius + 32);
  }
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
let recorder: MediaRecorder | null = null;
let activeRecordingId: string | null = null;

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
    const mimeType = pickMimeType();
    const instance = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    activeRecordingId = recordingId;
    recorder = instance;

    instance.addEventListener('dataavailable', (event) => {
      if (event.data.size === 0) return;
      void (async (): Promise<void> => {
        const chunk = await event.data.arrayBuffer();
        socket.emit('sim:audioChunk', { recordingId, chunk });
      })();
    });

    instance.addEventListener('stop', () => {
      // Chunks are queued as microtasks above; let them flush before signalling completion.
      setTimeout(() => {
        socket.emit('sim:audioComplete', { recordingId, mimeType: instance.mimeType });
      }, 50);
    });

    instance.start(250);
  } catch (error: unknown) {
    activeRecordingId = null;
    recorder = null;
    socket.emit('sim:audioError', {
      recordingId,
      reason: error instanceof Error ? error.message : 'microphone unavailable',
    });
  }
}

function stopCapture(recordingId: string): void {
  if (activeRecordingId !== recordingId || !recorder) return;
  if (recorder.state !== 'inactive') recorder.stop();
  recorder = null;
  activeRecordingId = null;
}

function cancelCapture(recordingId: string): void {
  if (activeRecordingId !== recordingId || !recorder) return;
  const instance = recorder;
  recorder = null;
  activeRecordingId = null;
  // Detach the completion handler so a cancelled take is never delivered.
  instance.onstop = null;
  if (instance.state !== 'inactive') instance.stop();
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
    // (all off, unread blink, silent heartbeat) are unreachable in the simulator.
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
    label: 'WhatsApp session expired',
    run: () => socket.emit('sim:injectSessionExpiry'),
  },
];

if (injectorRoot) {
  for (const injector of INJECTORS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = injector.label;
    button.addEventListener('click', injector.run);
    injectorRoot.append(button);
  }
}

draw();
