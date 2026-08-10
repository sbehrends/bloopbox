import { io, type Socket } from 'socket.io-client';
import {
  actionButton,
  card,
  checkbox,
  checkboxField,
  element,
  field,
  numberInput,
  textInput,
} from '../shared/dom.ts';
import { CHANNEL_TOKENS } from '../shared/theme.ts';
// The same parser the device validates against, rather than a second one that can disagree.
import { parseTarget } from '../../src/config/schema.ts';

/**
 * Admin panel (PRODUCT.md §3).
 *
 * Deliberately plain: forms plus fetch. Every write goes through PUT /api/config, which
 * validates against the same Zod schema the device uses, so the UI cannot persist anything
 * the daemon would reject.
 *
 * Its widgets come from shared/dom.ts and its styling from shared/base.css — the panel adds
 * only what is specific to it (admin.css) and nothing that looks like a private button.
 */

type ButtonKey = 'button1' | 'button2' | 'button3';

type ContactView = { name: string; target: string; enabled: boolean };

type ConfigView = {
  version: number;
  system: { hostname: string; configured: boolean };
  wifi: { ssid: string; password: string };
  contacts: Record<ButtonKey, ContactView>;
  audio: {
    speakerVolumePercent: number;
    maxVolumeCapPercent: number;
    micGainPercent: number;
    maxRecordingSeconds: number;
  };
  quietHours: { enabled: boolean; startTime: string; endTime: string };
  buttons: {
    debounceMs: number;
    recordThresholdMs: number;
    minRecordingMs: number;
    resumeGraceMs: number;
    silentComboMs: number;
  };
  whatsapp: { markPlayedAsRead: boolean };
};

type StatusView = {
  state: string;
  silentMode: boolean;
  silentFromSchedule: boolean;
  whatsappConnected: boolean;
  wifiConnected: boolean;
  configured: boolean;
  unreadCounts: readonly number[];
  driver: string;
};

const BUTTON_KEYS: readonly ButtonKey[] = ['button1', 'button2', 'button3'];
const BUTTON_LABELS: Record<ButtonKey, string> = {
  button1: 'Button 1 (left)',
  button2: 'Button 2 (centre)',
  button3: 'Button 3 (right)',
};

const statusLine = document.querySelector<HTMLParagraphElement>('#status');
const sections = document.querySelector<HTMLElement>('#sections');

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} -> ${String(response.status)}`);
  return response.json();
}

async function putConfig(patch: unknown): Promise<void> {
  const response = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (response.ok) {
    // Settings are read at boot, so the daemon restarts to apply them.
    noteRestarting();
    return;
  }

  // Surface the server's own validation messages rather than inventing our own.
  const detail: unknown = await response.json().catch(() => null);
  throw new Error(describeApiError(detail) ?? `save failed (${String(response.status)})`);
}

/** Renders an untrusted value as text, refusing objects rather than showing [object Object]. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function describeApiError(detail: unknown): string | null {
  if (typeof detail !== 'object' || detail === null) return null;
  const record: Record<string, unknown> = { ...detail };
  const issues = record['issues'];
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((issue: unknown) => {
        if (typeof issue !== 'object' || issue === null) return '';
        const entry: Record<string, unknown> = { ...issue };
        return `${asText(entry['path'])}: ${asText(entry['message'])}`;
      })
      .filter(Boolean)
      .join('; ');
  }
  return typeof record['error'] === 'string' ? record['error'] : null;
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

type GroupOption = { id: string; subject: string };

/** Groups the linked account belongs to, for the picker. Empty if unavailable. */
async function fetchGroups(): Promise<GroupOption[]> {
  try {
    const payload = await getJson('/api/whatsapp/groups');
    if (typeof payload !== 'object' || payload === null || !('groups' in payload)) return [];
    const groups = payload.groups;
    if (!Array.isArray(groups)) return [];
    return groups.flatMap((entry: unknown): GroupOption[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const id = 'id' in entry ? asText(entry.id) : '';
      const subject = 'subject' in entry ? asText(entry.subject) : '';
      return id.length > 0 ? [{ id, subject: subject.length > 0 ? subject : id }] : [];
    });
  } catch {
    return [];
  }
}

function renderContacts(
  config: ConfigView,
  groups: readonly GroupOption[],
  onSave: SaveFn,
): HTMLElement {
  const section = card('Contacts');
  const inputs = new Map<
    ButtonKey,
    { name: HTMLInputElement; target: HTMLInputElement; enabled: HTMLInputElement }
  >();

  section.append(
    element(
      'p',
      'field-hint',
      'A button can point at one person or at one group. Only these targets can reach the ' +
        'device — anything else is dropped.',
    ),
  );

  for (const [index, key] of BUTTON_KEYS.entries()) {
    const contact = config.contacts[key];
    const row = element('div', 'contact');
    // The buttons are colour-coded on the enclosure (§Overview); the row wears the same colour
    // so a parent matches the form to the thing in front of the child without reading it.
    row.style.setProperty('--channel', `var(${CHANNEL_TOKENS[index] ?? '--border-strong'})`);
    row.append(element('h3', undefined, BUTTON_LABELS[key]));

    const name = textInput(contact.name, { maxLength: 24 });
    const target = textInput(contact.target, { placeholder: '15551234567' });
    const enabled = checkbox(contact.enabled);

    /*
     * The resolved JID, shown as it is typed.
     *
     * A phone number is unverifiable by eye — every wrong one looks exactly like a right one,
     * and the device has no screen to report the mistake on later. Echoing what the number
     * will actually become is the only feedback available before a child presses the button
     * and nothing happens.
     */
    const resolved = element('p', 'target-resolved');
    const showResolution = (): void => {
      const raw = target.value.trim();
      if (raw.length === 0) {
        resolved.textContent = '';
        resolved.classList.remove('is-bad');
        return;
      }
      const parsed = parseTarget(raw);
      resolved.classList.toggle('is-bad', parsed === null);
      resolved.textContent =
        parsed === null
          ? 'Not a usable target — a phone number needs its country code.'
          : `${parsed.kind === 'group' ? 'Group' : 'Sends to'} ${parsed.jid}`;
    };
    target.addEventListener('input', showResolution);
    showResolution();

    row.append(
      field('Name', name),
      field(
        'Phone number or group',
        target,
        'Phone: country code first. A +, 00, spaces or dashes are fine. ' +
          'Groups end in @g.us — use the picker.',
      ),
      resolved,
    );

    // A group JID is opaque, so offer the ones this account is actually in.
    if (groups.length > 0) {
      const picker = element('select');
      const blank = element('option');
      blank.value = '';
      blank.textContent = '— pick a group —';
      picker.append(blank);
      for (const group of groups) {
        const option = element('option');
        option.value = group.id;
        option.textContent = group.subject;
        if (group.id === contact.target) option.selected = true;
        picker.append(option);
      }
      picker.addEventListener('change', () => {
        if (picker.value.length === 0) return;
        target.value = picker.value;
        showResolution();
        // Adopt the group's name unless the parent has already written one.
        const chosen = groups.find((group) => group.id === picker.value);
        if (chosen && name.value.trim().length === 0) name.value = chosen.subject.slice(0, 24);
      });
      row.append(field('Or choose a group', picker));
    }

    row.append(checkboxField('Enabled', enabled));
    inputs.set(key, { name, target, enabled });
    section.append(row);
  }

  if (groups.length === 0) {
    section.append(
      element(
        'p',
        'field-hint',
        'No group list available — link WhatsApp first, then reload to pick from your groups.',
      ),
    );
  }

  section.append(
    saveButton('Save contacts', () => {
      const contacts: Partial<Record<ButtonKey, ContactView>> = {};
      for (const key of BUTTON_KEYS) {
        const row = inputs.get(key);
        if (!row) continue;
        contacts[key] = {
          name: row.name.value.trim(),
          target: row.target.value.trim(),
          enabled: row.enabled.checked,
        };
      }
      return onSave({ contacts });
    }),
  );

  return section;
}

function renderAudio(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = card('Audio');

  const volume = numberInput(config.audio.speakerVolumePercent, 0, 100);
  const cap = numberInput(config.audio.maxVolumeCapPercent, 0, 100);
  const gain = numberInput(config.audio.micGainPercent, 0, 100);
  const maxSeconds = numberInput(config.audio.maxRecordingSeconds, 1, 120);

  section.append(
    field('Speaker volume (%)', volume, 'Never exceeds the cap below.'),
    field('Maximum volume cap (%)', cap, 'Hard ceiling — this sits near a child’s ears.'),
    field('Microphone gain (%)', gain),
    field('Maximum recording length (s)', maxSeconds),
    saveButton('Save audio', () =>
      onSave({
        audio: {
          speakerVolumePercent: volume.valueAsNumber,
          maxVolumeCapPercent: cap.valueAsNumber,
          micGainPercent: gain.valueAsNumber,
          maxRecordingSeconds: maxSeconds.valueAsNumber,
        },
      }),
    ),
  );

  return section;
}

function renderQuietHours(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = card('Quiet hours');

  const enabled = checkbox(config.quietHours.enabled);
  const start = element('input');
  start.type = 'time';
  start.value = config.quietHours.startTime;
  const end = element('input');
  end.type = 'time';
  end.value = config.quietHours.endTime;

  section.append(
    checkboxField('Enabled', enabled),
    field('Start', start),
    field('End', end, 'May cross midnight, e.g. 20:00 to 07:00.'),
    saveButton('Save quiet hours', () =>
      onSave({
        quietHours: {
          enabled: enabled.checked,
          startTime: start.value,
          endTime: end.value,
        },
      }),
    ),
  );

  return section;
}

function renderReadReceipts(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = card('Read receipts');

  const markRead = checkbox(config.whatsapp.markPlayedAsRead);

  section.append(
    element(
      'p',
      'field-hint',
      'When the child plays a message, WhatsApp shows the sender two blue ticks. ' +
        'It is the only way they learn it was heard — but it also tells them when ' +
        'the child was at the box.',
    ),
    checkboxField('Mark messages as read once played', markRead),
    saveButton('Save read receipts', () =>
      onSave({ whatsapp: { markPlayedAsRead: markRead.checked } }),
    ),
  );

  return section;
}

function renderButtonTimings(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = card('Button timings');

  const debounce = numberInput(config.buttons.debounceMs, 0, 2000);
  const threshold = numberInput(config.buttons.recordThresholdMs, 100, 10_000);
  const minRecording = numberInput(config.buttons.minRecordingMs, 0, 10_000);
  const resumeGrace = numberInput(config.buttons.resumeGraceMs, 0, 3000);
  const combo = numberInput(config.buttons.silentComboMs, 500, 15_000);

  /** Shows the resulting press windows, so the numbers are not abstract. */
  const summary = element('p', 'field-hint');
  const refreshSummary = (): void => {
    const d = debounce.valueAsNumber;
    const t = threshold.valueAsNumber;
    const g = resumeGrace.valueAsNumber;
    const tail = g > 0 ? ` · then ${String(g)}ms to carry on before it sends` : '';
    summary.textContent =
      d < t
        ? `Under ${String(d)}ms: ignored · ${String(d)}–${String(t)}ms: tap to play · ` +
          `over ${String(t)}ms: record${tail}`
        : 'Debounce must be below the record threshold, or tapping to play is impossible.';
  };
  debounce.addEventListener('input', refreshSummary);
  threshold.addEventListener('input', refreshSummary);
  resumeGrace.addEventListener('input', refreshSummary);
  refreshSummary();

  section.append(
    element(
      'p',
      'field-hint',
      'Saving restarts the device to apply these. Tune them to suit the child.',
    ),
    field('Debounce (ms)', debounce, 'Presses shorter than this are ignored as accidental.'),
    field('Record threshold (ms)', threshold, 'Hold at least this long to record.'),
    field(
      'Minimum recording (ms)',
      minRecording,
      'Recordings with less actual audio than this are discarded rather than sent.',
    ),
    field(
      'Carry-on window (ms)',
      resumeGrace,
      'After letting go, pressing the same button again this soon continues the same ' +
        'message instead of sending it — for when a small hand slips. 0 sends immediately.',
    ),
    field('Silent-mode chord (ms)', combo, 'How long to hold Button 1 + Button 3 together.'),
    summary,
    saveButton('Save button timings', () =>
      onSave({
        buttons: {
          debounceMs: debounce.valueAsNumber,
          recordThresholdMs: threshold.valueAsNumber,
          minRecordingMs: minRecording.valueAsNumber,
          resumeGraceMs: resumeGrace.valueAsNumber,
          silentComboMs: combo.valueAsNumber,
        },
      }),
    ),
  );

  return section;
}

function renderWifi(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = card('Wi-Fi');

  const ssid = textInput(config.wifi.ssid, { maxLength: 32 });
  const password = element('input');
  password.type = 'password';
  password.placeholder = config.wifi.password.length > 0 ? 'unchanged' : '';
  password.maxLength = 63;

  section.append(
    field('Network name (SSID)', ssid),
    field('Password', password, 'Leave blank to keep the current password.'),
    saveButton('Save Wi-Fi', () => {
      const wifi: { ssid: string; password?: string } = { ssid: ssid.value.trim() };
      // Sending an empty password would erase a working one.
      if (password.value.length > 0) wifi.password = password.value;
      return onSave({ wifi });
    }),
  );

  return section;
}

/**
 * How often the panel asks the device for the current pairing code, and how often the
 * countdown redraws.
 *
 * Baileys rotates the QR every 20 s, and nothing pushes that to the browser — so the panel
 * polls. A code that has already lapsed is chased every tick instead, because the seconds
 * between a rotation and the panel noticing are seconds the parent spends aiming a phone at
 * a dead square.
 */
const QR_TICK_MS = 500;
const QR_POLL_TICKS = 4;

/**
 * Tells the device to open its WhatsApp socket, now that a method has actually been chosen.
 *
 * Nothing before this point has asked Baileys for anything — the device sits in `notLinked`
 * until this fires, specifically so a parent looking at the chooser or filling in a phone
 * number is not, in the background, already mid-QR-rotation on a method they didn't pick.
 */
async function beginLinking(): Promise<void> {
  try {
    await fetch('/api/whatsapp/link', { method: 'POST' });
  } catch {
    // The next poll's "unavailable" message covers this; nothing more to do here.
  }
}

function renderWhatsApp(status: StatusView): HTMLElement {
  const section = card('WhatsApp');
  const state = element('p', 'status', status.whatsappConnected ? 'Linked' : 'Not linked');
  const pairing = element('div', 'pairing');

  section.append(state, pairing);

  /*
   * Entering `awaitingPairing` used to render the QR code and the phone-number form together,
   * so a parent could request a pairing code while a QR scan was still in flight — two link
   * attempts racing on the same WhatsApp session, which tended to break both. The panel now
   * asks which method to use first and shows only that one; `method` records the choice and is
   * reset whenever pairing starts over. The block is otherwise built once per state/method and
   * then only updated in place, so a poll never clears the phone-number field under the
   * parent's fingers.
   */
  let method: 'qr' | 'phone' | null = null;
  let built = false;
  let image: HTMLImageElement | null = null;
  let countdown: HTMLElement | null = null;
  /** The code the visible image was drawn for, so a rotation is a string comparison. */
  let shownQr: string | null = null;
  /** Browser-clock deadline for that code; 0 while there is nothing to count down. */
  let deadline = 0;
  let polling = false;

  const drawCountdown = (): void => {
    if (countdown === null) return;
    const remaining = deadline === 0 ? 0 : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const expired = deadline !== 0 && remaining === 0;
    countdown.textContent = expired
      ? 'This code has expired — fetching a fresh one…'
      : `Expires in ${String(remaining)}s`;
    countdown.classList.toggle('is-expired', expired);
    image?.classList.toggle('is-expired', expired);
  };

  const backToChooser = (): HTMLButtonElement => {
    // Unstyled on purpose: the bare button is the design system's secondary.
    const back = element('button', undefined, 'Choose a different way to link');
    back.type = 'button';
    back.addEventListener('click', () => {
      method = null;
      image = null;
      countdown = null;
      shownQr = null;
      deadline = 0;
      buildChooser();
    });
    return back;
  };

  const buildChooser = (): void => {
    pairing.replaceChildren();
    built = true;

    const scan = element('button', 'primary', 'Scan a QR code');
    scan.type = 'button';
    scan.addEventListener('click', () => {
      method = 'qr';
      buildQr();
      void beginLinking();
      void poll();
    });

    const phoneButton = element('button', 'primary', 'Link with my phone number');
    phoneButton.type = 'button';
    phoneButton.addEventListener('click', () => {
      method = 'phone';
      buildPhone();
      void beginLinking();
    });

    pairing.append(
      element('h3', undefined, 'Link this device to WhatsApp'),
      element(
        'p',
        'field-hint',
        'Pick one way to link. Only one code is kept active at a time — starting the other ' +
          'way is what used to make both stop working.',
      ),
      scan,
      phoneButton,
    );
  };

  const buildQr = (): void => {
    pairing.replaceChildren();
    built = true;

    const frame = element('div', 'qr-frame');
    // Rendered server-side; the raw payload is a long string and unscannable as text.
    image = element('img', 'qr-image');
    image.alt = 'WhatsApp pairing QR code';
    image.addEventListener('error', () => {
      // A 404 means the code rotated out from under this request; the next poll re-arms it.
      deadline = Date.now();
      drawCountdown();
    });
    countdown = element('p', 'qr-countdown');
    frame.append(image, countdown);

    const again = element('button', undefined, 'Show a new code');
    again.type = 'button';
    again.addEventListener('click', () => {
      void poll();
    });

    pairing.append(
      element('h3', undefined, 'Scan this code'),
      element(
        'p',
        'field-hint',
        'On your phone: WhatsApp → Settings → Linked devices → Link a device. ' +
          'The code changes every 20 seconds; this panel keeps up on its own.',
      ),
      frame,
      again,
      backToChooser(),
    );
  };

  const buildPhone = (): void => {
    pairing.replaceChildren();
    built = true;

    const phone = textInput('', { placeholder: 'e.g. 4915512345678, not 004915512345678' });
    const codeOut = element('p', 'pair-code');
    const request = element('button', 'primary', 'Get a pairing code');
    request.type = 'button';
    request.addEventListener('click', () => {
      void (async (): Promise<void> => {
        request.disabled = true;
        codeOut.textContent = 'Requesting…';
        try {
          const response = await fetch('/api/whatsapp/pair', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ phone: phone.value.trim() }),
          });
          const body: unknown = await response.json();
          const code =
            typeof body === 'object' && body !== null && 'code' in body ? asText(body.code) : '';
          if (response.ok && code.length > 0) {
            codeOut.textContent = code;
          } else {
            codeOut.textContent = describeApiError(body) ?? 'Could not get a code.';
          }
        } catch {
          codeOut.textContent = 'Could not reach the device.';
        } finally {
          request.disabled = false;
        }
      })();
    });

    pairing.append(
      element('h3', undefined, 'Link with your phone number'),
      element(
        'p',
        'field-hint',
        'WhatsApp → Linked devices → Link a device → "Link with phone number instead", ' +
          'then type the code below.',
      ),
      field(
        'Your phone number',
        phone,
        'Country code first, no leading 0 — a +, 00, spaces or dashes in front of it are fine ' +
          'and get dropped automatically.',
      ),
      request,
      codeOut,
      backToChooser(),
    );
  };

  /** Reads the device's pairing state and brings the visible code into line with it. */
  const poll = async (): Promise<void> => {
    // Overlapping polls would race on `shownQr` and could swap in an older code.
    if (polling) return;
    polling = true;
    try {
      let payload: unknown;
      try {
        payload = await getJson('/api/whatsapp');
      } catch {
        state.textContent = 'State: unavailable — is the WhatsApp bridge running?';
        return;
      }
      const read = typeof payload === 'object' && payload !== null ? payload : {};
      const current = 'state' in read ? asText(read.state) || 'unknown' : 'unknown';
      state.textContent = `State: ${current}`;

      // `notLinked` is the chooser's own resting state; `connecting` covers the moment between
      // choosing a method and Baileys actually producing anything. Anything else — linked,
      // freshly logged out, or a transient drop — has nothing to link right now.
      const linkable =
        current === 'notLinked' || current === 'connecting' || current === 'awaitingPairing';
      if (!linkable) {
        if (built) {
          pairing.replaceChildren();
          method = null;
          built = false;
          image = null;
          countdown = null;
          shownQr = null;
          deadline = 0;
        }
        return;
      }

      if (!built) {
        if (method === 'qr') buildQr();
        else if (method === 'phone') buildPhone();
        else buildChooser();
      }

      if (method !== 'qr') return; // chooser and phone-number flows have nothing to poll-sync

      const qr = 'qr' in read ? asText(read.qr) : '';
      if (qr.length === 0) {
        // Awaiting pairing but between codes — the bridge is mid-rotation or reconnecting.
        deadline = Date.now();
        drawCountdown();
        return;
      }
      if (qr !== shownQr) {
        shownQr = qr;
        const age = 'qrAgeMs' in read && typeof read.qrAgeMs === 'number' ? read.qrAgeMs : 0;
        const life =
          'qrLifetimeMs' in read && typeof read.qrLifetimeMs === 'number' ? read.qrLifetimeMs : 0;
        // The device reports an age, not a timestamp, so its clock need not match this one.
        deadline = life === 0 ? 0 : Date.now() + Math.max(0, life - age);
        if (image !== null) image.src = `/api/whatsapp/qr.svg?t=${String(Date.now())}`;
      }
      drawCountdown();
    } finally {
      polling = false;
    }
  };

  void poll();

  let ticks = 0;
  const ticker = window.setInterval(() => {
    // The panel rebuilds itself on every save; the detached copy must stop polling.
    if (!section.isConnected) {
      window.clearInterval(ticker);
      return;
    }
    ticks += 1;
    drawCountdown();
    const lapsed = deadline !== 0 && Date.now() >= deadline;
    if (lapsed || ticks % QR_POLL_TICKS === 0) void poll();
  }, QR_TICK_MS);

  section.append(
    saveButton('Unlink WhatsApp', async () => {
      await fetch('/api/whatsapp/unlink', { method: 'POST' });
      /*
       * The route returns as soon as it has told the bridge to unlink, not once the bridge has
       * actually logged out, deleted credentials and settled into `notLinked` — that involves a
       * round trip to WhatsApp's servers. Polling immediately would likely still read the old
       * state.
       */
      await new Promise((resolve) => window.setTimeout(resolve, 2500));
      await poll();
    }),
  );

  return section;
}

type SaveFn = (patch: unknown) => Promise<void>;

/** The panel's flavour of the shared action button: a failure lands on the status line. */
function saveButton(label: string, run: () => Promise<void>): HTMLButtonElement {
  return actionButton(label, run, reportError);
}

/**
 * Tells the user the device is coming back.
 *
 * Socket.io reconnects on its own, so this is only about not leaving them staring at a page
 * that has silently stopped updating.
 */
function noteRestarting(): void {
  if (!statusLine) return;
  statusLine.textContent = 'Saved — device restarting to apply settings…';
  statusLine.classList.remove('error');
  // Reload once it is back, so every field reflects what was actually persisted.
  window.setTimeout(() => {
    void waitForDeviceThenReload();
  }, 1200);
}

async function waitForDeviceThenReload(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (response.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // Still down; keep waiting.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
  if (statusLine) {
    statusLine.textContent = 'Device did not come back — check that the server is running.';
    statusLine.classList.add('error');
  }
}

function reportError(error: unknown): void {
  if (!statusLine) return;
  statusLine.textContent = error instanceof Error ? error.message : 'something went wrong';
  statusLine.classList.add('error');
  setTimeout(() => statusLine.classList.remove('error'), 6000);
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

function isConfigView(value: unknown): value is ConfigView {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'contacts' in value &&
    'audio' in value &&
    'quietHours' in value &&
    'wifi' in value &&
    'buttons' in value
  );
}

function isStatusView(value: unknown): value is StatusView {
  if (typeof value !== 'object' || value === null) return false;
  return 'state' in value && 'silentMode' in value;
}

function describeStatus(status: StatusView): string {
  const parts = [status.state];
  if (status.silentMode) parts.push(status.silentFromSchedule ? 'silent (scheduled)' : 'silent');
  if (!status.wifiConnected) parts.push('wi-fi down');
  if (!status.whatsappConnected) parts.push('whatsapp unlinked');
  const unread = status.unreadCounts.reduce((total, count) => total + count, 0);
  if (unread > 0) parts.push(`${String(unread)} unread`);
  parts.push(status.driver);
  return parts.join(' · ');
}

async function main(): Promise<void> {
  if (!sections) return;

  let status: StatusView | null = null;
  try {
    const payload = await getJson('/api/status');
    if (isStatusView(payload)) status = payload;
  } catch {
    if (statusLine) {
      statusLine.textContent = 'Hardware server unreachable — start it with `npm run dev:hw`';
    }
    return;
  }

  if (status && statusLine) statusLine.textContent = describeStatus(status);

  let config: ConfigView | null = null;
  try {
    const payload = await getJson('/api/config');
    if (isConfigView(payload)) config = payload;
  } catch {
    // 401 before onboarding is expected; show what we can.
    sections.append(
      element('p', 'status', 'Configuration is protected. Reload and sign in to edit it.'),
    );
  }

  const onSave: SaveFn = (patch) => putConfig(patch);

  if (config) {
    const groups = await fetchGroups();
    sections.append(
      renderContacts(config, groups, onSave),
      renderAudio(config, onSave),
      renderButtonTimings(config, onSave),
      renderQuietHours(config, onSave),
      renderReadReceipts(config, onSave),
      renderWifi(config, onSave),
    );
  }
  if (status) sections.append(renderWhatsApp(status));

  // Live status without polling.
  const socket: Socket = io({ transports: ['websocket', 'polling'] });
  socket.on('sim:status', (payload: unknown) => {
    if (isStatusView(payload) && statusLine) statusLine.textContent = describeStatus(payload);
  });
}

void main();
