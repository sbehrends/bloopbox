import { io, type Socket } from 'socket.io-client';

/**
 * Admin panel (PRODUCT.md §3).
 *
 * Deliberately plain: forms plus fetch. Every write goes through PUT /api/config, which
 * validates against the same Zod schema the device uses, so the UI cannot persist anything
 * the daemon would reject.
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
    silentComboMs: number;
  };
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
 * Rendering helpers
 * ------------------------------------------------------------------ */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(labelText: string, input: HTMLElement, hint?: string): HTMLLabelElement {
  const label = element('label', 'field');
  label.append(element('span', 'field-label', labelText), input);
  if (hint) label.append(element('span', 'field-hint', hint));
  return label;
}

function textInput(value: string, attrs: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const input = element('input');
  input.type = 'text';
  input.value = value;
  Object.assign(input, attrs);
  return input;
}

function numberInput(value: number, min: number, max: number): HTMLInputElement {
  const input = element('input');
  input.type = 'number';
  input.valueAsNumber = value;
  input.min = String(min);
  input.max = String(max);
  return input;
}

function checkbox(checked: boolean): HTMLInputElement {
  const input = element('input');
  input.type = 'checkbox';
  input.checked = checked;
  return input;
}

function card(title: string): HTMLElement {
  const section = element('section', 'card');
  section.append(element('h2', undefined, title));
  return section;
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

  for (const key of BUTTON_KEYS) {
    const contact = config.contacts[key];
    const row = element('div', 'contact');
    row.append(element('h3', undefined, BUTTON_LABELS[key]));

    const name = textInput(contact.name, { maxLength: 24 });
    const target = textInput(contact.target, { placeholder: '15551234567' });
    const enabled = checkbox(contact.enabled);

    row.append(
      field('Name', name),
      field(
        'Phone number or group',
        target,
        'Phone: digits with country code, no + or spaces. Groups end in @g.us — use the picker.',
      ),
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
        // Adopt the group's name unless the parent has already written one.
        const chosen = groups.find((group) => group.id === picker.value);
        if (chosen && name.value.trim().length === 0) name.value = chosen.subject.slice(0, 24);
      });
      row.append(field('Or choose a group', picker));
    }

    row.append(field('Enabled', enabled));
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
    field('Enabled', enabled),
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

function renderButtonTimings(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = card('Button timings');

  const debounce = numberInput(config.buttons.debounceMs, 0, 2000);
  const threshold = numberInput(config.buttons.recordThresholdMs, 100, 10_000);
  const minRecording = numberInput(config.buttons.minRecordingMs, 0, 10_000);
  const combo = numberInput(config.buttons.silentComboMs, 500, 15_000);

  /** Shows the resulting press windows, so the numbers are not abstract. */
  const summary = element('p', 'field-hint');
  const refreshSummary = (): void => {
    const d = debounce.valueAsNumber;
    const t = threshold.valueAsNumber;
    summary.textContent =
      d < t
        ? `Under ${String(d)}ms: ignored · ${String(d)}–${String(t)}ms: tap to play · ` +
          `over ${String(t)}ms: record`
        : 'Debounce must be below the record threshold, or tapping to play is impossible.';
  };
  debounce.addEventListener('input', refreshSummary);
  threshold.addEventListener('input', refreshSummary);
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
    field('Silent-mode chord (ms)', combo, 'How long to hold Button 1 + Button 3 together.'),
    summary,
    saveButton('Save button timings', () =>
      onSave({
        buttons: {
          debounceMs: debounce.valueAsNumber,
          recordThresholdMs: threshold.valueAsNumber,
          minRecordingMs: minRecording.valueAsNumber,
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

function renderWhatsApp(status: StatusView): HTMLElement {
  const section = card('WhatsApp');
  const state = element('p', 'status', status.whatsappConnected ? 'Linked' : 'Not linked');
  const qrHolder = element('div', 'qr');

  section.append(state, qrHolder);

  const refresh = async (): Promise<void> => {
    try {
      const payload = await getJson('/api/whatsapp');
      const record: Record<string, unknown> =
        typeof payload === 'object' && payload !== null ? { ...payload } : {};
      const qr = record['qr'];
      state.textContent = `State: ${asText(record['state']) || 'unknown'}`;
      qrHolder.replaceChildren();
      if (typeof qr === 'string' && qr.length > 0) {
        // The bridge sends the raw pairing string; showing it as text is enough to
        // regenerate a QR with any tool, and avoids bundling a QR library.
        qrHolder.append(
          element('p', 'field-hint', 'Scan this pairing code from WhatsApp → Linked devices:'),
          element('pre', 'qr-code', qr),
        );
      }
    } catch {
      state.textContent = 'State: unavailable';
    }
  };

  void refresh();
  section.append(
    saveButton('Refresh pairing status', refresh),
    saveButton('Unlink WhatsApp', async () => {
      await fetch('/api/whatsapp/unlink', { method: 'POST' });
      await refresh();
    }),
  );

  return section;
}

type SaveFn = (patch: unknown) => Promise<void>;

function saveButton(label: string, run: () => Promise<void>): HTMLButtonElement {
  const button = element('button', 'primary', label);
  button.type = 'button';
  button.addEventListener('click', () => {
    void (async (): Promise<void> => {
      button.disabled = true;
      const original = button.textContent;
      try {
        await run();
        button.textContent = 'Saved';
      } catch (error: unknown) {
        button.textContent = 'Failed';
        reportError(error);
      } finally {
        setTimeout(() => {
          button.textContent = original;
          button.disabled = false;
        }, 1200);
      }
    })();
  });
  return button;
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
