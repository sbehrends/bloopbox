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
    ampVolumePercent: number;
    ampBoostDc: number;
    ampBoostAc: number;
    micGainPercent: number;
    enhanceCapture: boolean;
    normalisePlayback: boolean;
    maxRecordingSeconds: number;
  };
  quietHours: { enabled: boolean; startTime: string; endTime: string; timezone: string };
  buttons: {
    debounceMs: number;
    recordThresholdMs: number;
    minRecordingMs: number;
    resumeGraceMs: number;
    silentComboMs: number;
  };
  whatsapp: { markPlayedAsRead: boolean };
  mode: { readOnly: boolean };
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

/**
 * Plays the boot cue on the box.
 *
 * Sits **above** the save button on purpose, and says so: the settings are read at boot, so
 * this proves what the device is running right now, not what is typed in the boxes above it.
 * Saving restarts the daemon, which is what makes an edit audible.
 */
function testSpeakerButton(): HTMLElement {
  const row = element('div', 'field');
  row.append(
    actionButton(
      'Test speaker',
      async () => {
        const response = await fetch('/api/audio/test', { method: 'POST' });
        if (!response.ok) throw new Error('the device could not play the test sound');
      },
      reportError,
    ),
    element('span', 'field-hint', 'Plays the start-up sound at the settings currently running.'),
  );
  return row;
}

function renderAudio(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = collapsibleCard('Audio');

  const volume = numberInput(config.audio.speakerVolumePercent, 0, 100);
  const ampVolume = numberInput(config.audio.ampVolumePercent, 0, 100);
  const boostDc = numberInput(config.audio.ampBoostDc, 0, 5);
  const boostAc = numberInput(config.audio.ampBoostAc, 0, 5);
  const gain = numberInput(config.audio.micGainPercent, 0, 100);
  const enhance = checkbox(config.audio.enhanceCapture);
  const normalise = checkbox(config.audio.normalisePlayback);
  const maxSeconds = numberInput(config.audio.maxRecordingSeconds, 1, 120);

  /*
   * Four numbers rather than one because the output chain has four stages and they multiply.
   * On the WM8960 the amplifier stages shipped at -20 dB and no boost, which no amount of
   * turning the first one up could reach — see docs/hardware.md.
   */
  /*
   * Every recommended value below is measured on a real device — docs/audio-quality.md has the
   * tables. The panel repeats the conclusions rather than the numbers: a parent needs to know
   * which way to turn a dial and what the symptom of overdoing it is, not the dB.
   */
  section.append(
    element(
      'p',
      'field-hint',
      'Which dial to turn: if messages the box PLAYS are too quiet, raise the amplifier volume ' +
        'and the two boosts — that is where the loudness is. If messages the box SENDS sound ' +
        'bad, that is microphone gain, and lowering it usually helps more than raising it.',
    ),
    field(
      'Speaker volume (%)',
      volume,
      'Digital volume, before the amplifier. Recommended 80-100. This is the smallest of the ' +
        'three playback stages — if it is already at 100 and the box is still quiet, the ' +
        'loudness you are missing is in the two below.',
    ),
    field(
      'Amplifier volume (%)',
      ampVolume,
      'The analogue output stage, and where most of the loudness lives — the WM8960 HAT powers ' +
        'up 20 dB down. Recommended 100: measured on a real box, 50 to 100 gained 18 dB with no ' +
        'measurable rise in distortion.',
    ),
    field(
      'Amplifier boost — DC (0-5)',
      boostDc,
      'Recommended 5. Worth about 5 dB over 0, and distortion did not measurably worsen up to 5.',
    ),
    field(
      'Amplifier boost — AC (0-5)',
      boostAc,
      'Class-D boost, normally set equal to DC. Recommended 5. Turn both down together if the ' +
        'box buzzes or rattles on loud messages — that is the enclosure, and these are the stage ' +
        'that trades headroom for loudness.',
    ),
    field(
      'Microphone gain (%)',
      gain,
      'Recommended 60-70. The one dial where higher is not better: measured on a real box, the ' +
        'signal-to-noise ratio barely moves across the whole range, so all it really decides is ' +
        'headroom. At 100 an ordinary speaking voice clips, which sounds harsh and crackly ' +
        'rather than loud. If the person receiving says messages are too quiet, this is not the ' +
        'fix — the level is set after recording, by the clean-up below.',
    ),
    checkboxField('Clean up the microphone (high-pass, denoise, normalise)', enhance),
    checkboxField('Match the loudness of arriving messages', normalise),
    element(
      'p',
      'field-hint',
      'Both are on by default and can be switched off to compare. Cleaning up the microphone also ' +
        'makes sending slightly quicker, because the encoder has less noise to work through.',
    ),
    field(
      'Maximum recording length (s)',
      maxSeconds,
      'Recommended 30. A held button stops recording here, so it also bounds how much space one ' +
        'stuck button can use.',
    ),
    testSpeakerButton(),
    saveButton('Save audio', () =>
      onSave({
        audio: {
          speakerVolumePercent: volume.valueAsNumber,
          ampVolumePercent: ampVolume.valueAsNumber,
          ampBoostDc: boostDc.valueAsNumber,
          ampBoostAc: boostAc.valueAsNumber,
          micGainPercent: gain.valueAsNumber,
          enhanceCapture: enhance.checked,
          normalisePlayback: normalise.checked,
          maxRecordingSeconds: maxSeconds.valueAsNumber,
        },
      }),
    ),
  );

  return section;
}

/**
 * The zone list, from the browser rather than a list we ship.
 *
 * `Intl.supportedValuesOf` is the whole tzdata and stays current with the browser. Where it
 * is missing the fallback is deliberately tiny — the stored value plus UTC plus wherever this
 * browser thinks it is, which between them cover "leave it alone" and "set it to here", the
 * only two things a parent on an old phone actually needs.
 */
function timeZoneNames(current: string): readonly string[] {
  // try/catch rather than a feature test: TypeScript's lib types `supportedValuesOf` as
  // always present, so an optional call is a lint error even though old browsers lack it.
  let supported: readonly string[] = [];
  try {
    supported = Intl.supportedValuesOf('timeZone');
  } catch {
    supported = [];
  }
  const names = supported.length > 0 ? supported : [browserTimeZone(), 'UTC'];
  return [...new Set([current, ...names])].toSorted((a, b) => a.localeCompare(b));
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function timeZoneSelect(current: string): HTMLSelectElement {
  const select = element('select');
  for (const name of timeZoneNames(current)) {
    const option = element('option', undefined, name);
    option.value = name;
    select.append(option);
  }
  select.value = current;
  return select;
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
  const timezone = timeZoneSelect(config.quietHours.timezone);

  /*
   * Off is the shipped default, so the window's controls open greyed out. Without this the
   * panel invites a parent to set 20:00–07:00, shows it saved, and does nothing — the times
   * are stored either way, but only `enabled` decides whether they mean anything.
   */
  const schedule = [start, end, timezone];
  const syncEnabled = (): void => {
    for (const input of schedule) input.disabled = !enabled.checked;
  };
  enabled.addEventListener('change', syncEnabled);
  syncEnabled();

  section.append(
    checkboxField('Enabled', enabled),
    field('Start', start),
    field('End', end, 'May cross midnight, e.g. 20:00 to 07:00.'),
    field(
      'Timezone',
      timezone,
      `The times above are read in this zone, not the box's clock. This browser is in ${browserTimeZone()}.`,
    ),
    saveButton('Save quiet hours', () =>
      onSave({
        quietHours: {
          enabled: enabled.checked,
          startTime: start.value,
          endTime: end.value,
          timezone: timezone.value,
        },
      }),
    ),
  );

  return section;
}

/**
 * Read-only mode: the box receives and plays, and can never send.
 *
 * Sits with contacts rather than under Advanced because it is not a tuning knob — it changes
 * what half the device does, and a parent who wants it wants it on the first visit.
 */
function renderSending(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = card('Sending');

  const readOnly = checkbox(config.mode.readOnly);

  section.append(
    element(
      'p',
      'field-hint',
      'Read-only leaves receiving untouched: notes still arrive, the lamp still blinks, and ' +
        'tapping still plays them. Only the hold-to-send half is switched off — holding a ' +
        'button answers with the "oops" beep instead of opening the microphone, so a child ' +
        'hears that it did not send rather than pressing harder at a box that looks broken.',
    ),
    checkboxField('Read-only — receive and play, never send', readOnly),
    saveButton('Save sending mode', () => onSave({ mode: { readOnly: readOnly.checked } })),
  );

  return section;
}

function renderButtonTimings(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = collapsibleCard('Button timings');

  const debounce = numberInput(config.buttons.debounceMs, 0, 2000);
  const threshold = numberInput(config.buttons.recordThresholdMs, 100, 10_000);
  const minRecording = numberInput(config.buttons.minRecordingMs, 0, 10_000);
  const resumeGrace = numberInput(config.buttons.resumeGraceMs, 0, 3000);
  const combo = numberInput(config.buttons.silentComboMs, 500, 15_000);

  /**
   * Shows the resulting press windows, so the numbers are not abstract.
   *
   * The tap window ends at threshold + minimum recording, not at the threshold: the bip plays
   * there and the microphone opens behind it, but a press that catches less than the minimum
   * is still a tap. Showing the threshold as the boundary would have a parent tuning the wrong
   * number when taps stopped working.
   */
  const summary = element('p', 'field-hint');
  const refreshSummary = (): void => {
    const d = debounce.valueAsNumber;
    const t = threshold.valueAsNumber;
    const m = minRecording.valueAsNumber;
    const g = resumeGrace.valueAsNumber;
    const tail = g > 0 ? ` · then ${String(g)}ms to carry on before it sends` : '';
    summary.textContent =
      d < t
        ? `Under ${String(d)}ms: ignored · ${String(d)}–${String(t + m)}ms: tap to play · ` +
          `over ${String(t + m)}ms: record · bip at ${String(t)}ms${tail}`
        : 'Debounce must be below the record threshold, or tapping to play is impossible.';
  };
  for (const input of [debounce, threshold, minRecording, resumeGrace]) {
    input.addEventListener('input', refreshSummary);
  }
  refreshSummary();

  section.append(
    element(
      'p',
      'field-hint',
      'Saving restarts the device to apply these. Tune them to suit the child.',
    ),
    field('Debounce (ms)', debounce, 'Presses shorter than this are ignored as accidental.'),
    field(
      'Bip delay (ms)',
      threshold,
      'How long a press waits before the bip plays and the microphone opens. Nothing said ' +
        'before the bip is recorded, so shorter means less of the first word is lost.',
    ),
    field(
      'Minimum recording (ms)',
      minRecording,
      'How much the microphone must catch for a press to be a message. Under this it counts ' +
        'as a tap and plays whatever is waiting instead.',
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

function renderWhatsApp(
  status: StatusView,
  config: ConfigView | null,
  onSave: SaveFn,
): HTMLElement {
  const section = card('WhatsApp');
  const state = element('p', 'status', status.whatsappConnected ? 'Linked' : 'Not linked');
  const pairing = element('div', 'pairing');

  // Built now, shown later: both depend on a live state the first poll has not read yet, so
  // they start hidden rather than flashing into view and back out again.
  const receipts = element('div', 'wa-section');
  receipts.hidden = true;
  const unlinkBlock = element('div', 'wa-section');
  unlinkBlock.hidden = true;

  section.append(state, pairing, receipts, unlinkBlock);

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
  /**
   * Which pairing view is on screen, rather than a bare "is anything built".
   *
   * The connecting placeholder made the distinction load-bearing: a poll has to be able to
   * tell "the chooser is up" from "the waiting message is up" to know whether to swap them.
   */
  let builtAs: 'chooser' | 'qr' | 'phone' | 'connecting' | null = null;
  let image: HTMLImageElement | null = null;
  let countdown: HTMLElement | null = null;
  /** The code the visible image was drawn for, so a rotation is a string comparison. */
  let shownQr: string | null = null;
  /** Browser-clock deadline for that code; 0 while there is nothing to count down. */
  let deadline = 0;
  let polling = false;
  /** Whether this page has ever seen a state other than `connected` — see the reload below. */
  let sawUnlinked = false;
  let reloading = false;

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

  /**
   * The gap between asking the bridge for a socket and Baileys producing anything.
   *
   * The chooser used to stay on screen through it, so a parent could press "Scan a QR code"
   * while the device was already mid-connect — a second link attempt on a session that was
   * still opening. Nothing to press is the honest answer while the answer is unknown.
   */
  const buildConnecting = (): void => {
    pairing.replaceChildren(
      element('h3', undefined, 'Connecting…'),
      element(
        'p',
        'field-hint',
        'Talking to WhatsApp. If this does not settle in a few seconds, check that the box is ' +
          'online and that the WhatsApp bridge is running.',
      ),
    );
    builtAs = 'connecting';
  };

  const buildChooser = (): void => {
    pairing.replaceChildren();
    builtAs = 'chooser';

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
      rowOf(scan, phoneButton),
    );
  };

  const buildQr = (): void => {
    pairing.replaceChildren();
    builtAs = 'qr';

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
      rowOf(again, backToChooser()),
    );
  };

  const buildPhone = (): void => {
    pairing.replaceChildren();
    builtAs = 'phone';

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

      /*
       * Read receipts is a setting for a live account, so it waits for one.
       *
       * Unlink hides while someone is *trying* to link — there is no session to drop yet, and a
       * destructive button beside the QR code they are mid-scan on is a trap. It stays for
       * `connecting`, `disconnected` and `loggedOut`, which is exactly when clearing a stuck
       * session is the way out.
       */
      receipts.hidden = current !== 'connected';
      unlinkBlock.hidden =
        current === 'notLinked' || current === 'awaitingPairing' || current === 'unknown';

      if (current === 'connected') {
        /*
         * First link of this page's life. Contacts, and the group picker inside it, are
         * rendered once at load from an account that did not exist yet — so the panel that
         * onboarding leaves behind is missing the very section it was setting up. Reloading is
         * the honest fix: everything re-reads from a linked account.
         *
         * Guarded on having *seen* an unlinked state, not on the state alone, or a panel opened
         * against an already-linked box would reload itself forever.
         */
        if (sawUnlinked && !reloading) {
          reloading = true;
          state.textContent = 'Linked — reloading the panel…';
          window.location.reload();
        }
      } else if (current !== 'unknown') {
        sawUnlinked = true;
      }

      // `notLinked` is the chooser's own resting state; `connecting` covers the moment between
      // choosing a method and Baileys actually producing anything. Anything else — linked,
      // freshly logged out, or a transient drop — has nothing to link right now.
      const linkable =
        current === 'notLinked' || current === 'connecting' || current === 'awaitingPairing';
      if (!linkable) {
        if (builtAs !== null) {
          pairing.replaceChildren();
          method = null;
          builtAs = null;
          image = null;
          countdown = null;
          shownQr = null;
          deadline = 0;
        }
        return;
      }

      /*
       * With no method chosen, `connecting` gets the waiting message rather than the chooser.
       * Once a method *is* chosen the socket is expected to be connecting, so the QR frame or
       * the phone form stays put and this never fires.
       */
      const want = method ?? (current === 'connecting' ? 'connecting' : 'chooser');
      if (builtAs !== want) {
        if (want === 'qr') buildQr();
        else if (want === 'phone') buildPhone();
        else if (want === 'connecting') buildConnecting();
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

  if (config) {
    const markRead = checkbox(config.whatsapp.markPlayedAsRead);
    receipts.append(
      element('h3', undefined, 'Read receipts'),
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
  }

  // Confirmed, like the factory reset: it deletes the credentials on disk, and the way back is
  // a fresh QR scan on someone's phone — not something to hand out to a single stray tap.
  unlinkBlock.append(
    element('h3', undefined, 'Unlink WhatsApp'),
    element(
      'p',
      'field-hint',
      'Disconnects this box from the WhatsApp account and forgets the session. The buttons ' +
        'stop sending and receiving until it is linked again.',
    ),
    dangerConfirm({
      label: 'Unlink WhatsApp',
      question: 'Unlink this box? Linking again needs a fresh QR scan or pairing code.',
      confirmLabel: 'Unlink',
      busyLabel: 'Unlinking…',
      run: async () => {
        await fetch('/api/whatsapp/unlink', { method: 'POST' });
        /*
         * The route returns as soon as it has told the bridge to unlink, not once the bridge has
         * actually logged out, deleted credentials and settled into `notLinked` — that involves a
         * round trip to WhatsApp's servers. Polling immediately would likely still read the old
         * state.
         */
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
        await poll();
      },
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

/**
 * A destructive action behind two deliberate taps.
 *
 * The confirming tap is a *different* button in a different place, so a second stray tap on
 * the first one cannot land on it. No `window.confirm`: it is unstyled, it reads as a browser
 * warning rather than as this device's own, and it is suppressible.
 *
 * Shared by the factory reset and the WhatsApp unlink — the two controls here that a parent
 * cannot undo by pressing the thing again.
 */
function dangerConfirm(options: {
  readonly label: string;
  readonly question: string;
  readonly confirmLabel: string;
  readonly busyLabel: string;
  readonly run: () => Promise<void>;
  /** Replaces the control entirely when the action leaves nothing further to press. */
  readonly terminal?: () => readonly HTMLElement[];
}): HTMLElement {
  const zone = element('div', 'danger-zone');

  const start = element('button', 'danger', options.label);
  start.type = 'button';

  const confirmRow = element('div', 'danger-confirm');
  confirmRow.hidden = true;
  const confirm = element('button', 'danger', options.confirmLabel);
  confirm.type = 'button';
  const cancel = element('button', undefined, 'Cancel');
  cancel.type = 'button';
  confirmRow.append(element('p', 'field-hint', options.question), rowOf(confirm, cancel));

  zone.append(start, confirmRow);

  const rest = (): void => {
    confirmRow.hidden = true;
    start.hidden = false;
    confirm.disabled = false;
    cancel.disabled = false;
    confirm.textContent = options.confirmLabel;
  };

  start.addEventListener('click', () => {
    start.hidden = true;
    confirmRow.hidden = false;
    // Focus the confirming button so a keyboard user is not left hunting for what appeared,
    // but never auto-fire it: this is the tap that has to be meant.
    confirm.focus();
  });

  cancel.addEventListener('click', () => {
    rest();
    start.focus();
  });

  confirm.addEventListener('click', () => {
    void (async (): Promise<void> => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.textContent = options.busyLabel;
      try {
        await options.run();
      } catch (error: unknown) {
        reportError(error);
      }
      if (options.terminal) zone.replaceChildren(...options.terminal());
      else rest();
    })();
  });

  return zone;
}

/**
 * Wipes every piece of user configuration (PENDING.md, "A factory-reset control").
 *
 * Deliberately does not use `saveButton`/`noteRestarting` like every other control here. Those
 * poll for the device coming back, which after this it will not — not on this network. It
 * leaves the hotspot's name on screen instead, because that is the only way back in.
 */
function renderFactoryReset(): HTMLElement {
  const section = card('Factory reset');

  section.append(
    element(
      'p',
      'field-hint',
      'Erases everything this box knows: the contacts on the three buttons, its settings ' +
        'password, the WhatsApp link, and the Wi-Fi network it joins. It then restarts and ' +
        'offers its setup hotspot again, exactly as it did out of the box.',
    ),
    element(
      'p',
      'field-hint',
      'Recordings are not kept on the box, so there is nothing else to lose. This cannot be ' +
        'undone.',
    ),
    dangerConfirm({
      label: 'Recover from factory settings',
      question: 'Are you sure? The box will be empty and back at setup.',
      confirmLabel: 'Erase everything',
      busyLabel: 'Erasing…',
      run: async () => {
        try {
          const response = await fetch('/api/factory-reset', { method: 'POST' });
          if (!response.ok) throw new Error('the box would not accept that');
        } catch {
          /*
           * Ambiguous, and usually *good*: the reset drops the network this request arrived
           * over, so a dropped connection is what success looks like from here. Saying it
           * failed would send a parent hunting for a box that has in fact already reset.
           */
        }
      },
      terminal: () => [
        element('p', undefined, 'Erased. The box is restarting.'),
        element(
          'p',
          'field-hint',
          'It will leave this network, so this page will stop working — that is what success ' +
            'looks like. Look for its setup hotspot on your phone in a minute or so, the same ' +
            'one you used the first time.',
        ),
      ],
    }),
  );

  return section;
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

/**
 * Buttons side by side, with air between them.
 *
 * `append()` leaves no whitespace text node between siblings, so two inline-block buttons
 * render flush against each other. Every place this panel puts one button next to another
 * goes through here.
 */
function rowOf(...children: readonly HTMLElement[]): HTMLElement {
  const row = element('div', 'button-row');
  row.append(...children);
  return row;
}

/**
 * A group header for the settings a parent rarely needs, sitting below the everyday cards
 * rather than in its own card — it is a divider, not a thing to configure.
 */
function sectionDivider(title: string): HTMLElement {
  return element('h2', 'section-divider', title);
}

/**
 * A card that folds away, closed until asked for.
 *
 * `<details>` rather than a button and a class: the open/closed state, the keyboard handling
 * and the screen-reader announcement all come free and correct, and it keeps the component
 * layer CSS-only the way the rest of the design system is. Page-local because the admin panel
 * is the only page with settings worth hiding.
 */
function collapsibleCard(title: string): HTMLElement {
  const details = element('details', 'card card-collapsible');
  const summary = element('summary');
  summary.append(element('h2', undefined, title));
  details.append(summary);
  return details;
}

/**
 * States where WhatsApp still needs a parent's attention — nothing has ever been linked, a QR
 * or phone code is waiting to be used, or the last pairing was rejected and needs redoing.
 * `connecting` and `disconnected` are deliberately not here: those are an already-linked
 * session reconnecting or backing off, not something to act on.
 */
const WHATSAPP_NEEDS_ATTENTION = new Set(['notLinked', 'awaitingPairing', 'loggedOut']);

/** The live pairing state, for ordering the page — `null` when it cannot be read at all. */
async function fetchWhatsAppState(): Promise<string | null> {
  try {
    const payload = await getJson('/api/whatsapp');
    if (typeof payload === 'object' && payload !== null && 'state' in payload) {
      const state = asText(payload.state);
      return state.length > 0 ? state : null;
    }
    return null;
  } catch {
    return null;
  }
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

  // Needs-attention until proven otherwise: an unreachable bridge or a malformed reply is
  // treated the same as "not linked", the safer default when the real state is unknown.
  const whatsappState = status ? await fetchWhatsAppState() : null;
  const whatsappNeedsAttention =
    whatsappState === null || WHATSAPP_NEEDS_ATTENTION.has(whatsappState);

  const whatsappSection = status ? renderWhatsApp(status, config, onSave) : null;

  if (config && whatsappNeedsAttention) {
    // Nothing else is useful yet — contacts can't be assigned without a linked account, Wi-Fi
    // is already working or this page couldn't have loaded, and quiet hours has nothing to
    // guard. Advanced stays reachable on purpose: audio and button-timing checks don't need
    // WhatsApp at all, and are exactly what bring-up wants while pairing is still open.
    if (whatsappSection) sections.append(whatsappSection);
    sections.append(
      sectionDivider('Advanced'),
      renderAudio(config, onSave),
      renderButtonTimings(config, onSave),
      renderFactoryReset(),
    );
  } else if (config) {
    const groups = await fetchGroups();
    sections.append(
      renderContacts(config, groups, onSave),
      renderSending(config, onSave),
      renderQuietHours(config, onSave),
    );
    if (whatsappSection) sections.append(whatsappSection);
    sections.append(
      renderWifi(config, onSave),
      sectionDivider('Advanced'),
      renderAudio(config, onSave),
      renderButtonTimings(config, onSave),
      renderFactoryReset(),
    );
  } else if (whatsappSection) {
    sections.append(whatsappSection);
  }

  // Live status without polling.
  const socket: Socket = io({ transports: ['websocket', 'polling'] });
  socket.on('sim:status', (payload: unknown) => {
    if (isStatusView(payload) && statusLine) statusLine.textContent = describeStatus(payload);
  });
}

void main();
