import { io, type Socket } from 'socket.io-client';

/**
 * Admin panel (PRODUCT.md §3).
 *
 * Deliberately plain: forms plus fetch. Every write goes through PUT /api/config, which
 * validates against the same Zod schema the device uses, so the UI cannot persist anything
 * the daemon would reject.
 */

type ButtonKey = 'button1' | 'button2' | 'button3';

type ContactView = { name: string; phone: string; enabled: boolean };

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
  if (response.ok) return;

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

function renderContacts(config: ConfigView, onSave: SaveFn): HTMLElement {
  const section = card('Contacts');
  const inputs = new Map<
    ButtonKey,
    { name: HTMLInputElement; phone: HTMLInputElement; enabled: HTMLInputElement }
  >();

  for (const key of BUTTON_KEYS) {
    const contact = config.contacts[key];
    const group = element('div', 'contact');
    group.append(element('h3', undefined, BUTTON_LABELS[key]));

    const name = textInput(contact.name, { maxLength: 24 });
    const phone = textInput(contact.phone, { placeholder: '15551234567' });
    const enabled = checkbox(contact.enabled);

    group.append(
      field('Name', name),
      field('Phone number', phone, 'Digits only, with country code. No + or spaces.'),
      field('Enabled', enabled),
    );
    inputs.set(key, { name, phone, enabled });
    section.append(group);
  }

  section.append(
    saveButton('Save contacts', () => {
      const contacts: Partial<Record<ButtonKey, ContactView>> = {};
      for (const key of BUTTON_KEYS) {
        const group = inputs.get(key);
        if (!group) continue;
        contacts[key] = {
          name: group.name.value.trim(),
          phone: group.phone.value.trim(),
          enabled: group.enabled.checked,
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
  return 'contacts' in value && 'audio' in value && 'quietHours' in value && 'wifi' in value;
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
    sections.append(
      renderContacts(config, onSave),
      renderAudio(config, onSave),
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
