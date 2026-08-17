/**
 * Setup portal (PRODUCT.md §First Boot).
 *
 * Runs inside a captive-portal webview on a phone. That shapes everything here: no
 * Socket.io, no storage, no framework, and every state kept in this module rather than in
 * the URL, because the webview may not survive a navigation.
 *
 * The submit is one-way. Accepting the credentials tears down the hotspot this page arrived
 * over, so there is no response to render afterwards and no retry — which is why the final
 * screen explains what to expect rather than reporting what happened.
 */

type ScannedNetwork = { ssid: string; signal: number; secure: boolean };

/**
 * Everything from the network is `unknown` until proven otherwise — the same posture the
 * daemon takes with the agent's file, for the same reason: a shape mismatch across a version
 * skew should degrade the page, not blank it.
 */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!(key in value)) return undefined;
  return Reflect.get(value, key);
}

function toNetwork(value: unknown): ScannedNetwork | null {
  const ssid = asText(field(value, 'ssid'));
  if (ssid.length === 0) return null;
  const signal = field(value, 'signal');
  return {
    ssid,
    signal: typeof signal === 'number' ? signal : 0,
    // Unknown means treat it as secured: offering a passphrase box that turns out to be
    // unnecessary is a smaller failure than hiding one that was.
    secure: field(value, 'secure') !== false,
  };
}

/** Elements the page cannot work without. Missing one is a build mistake, not a runtime case. */
function required(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element: ${id}`);
  return found;
}

function requiredInput(id: string): HTMLInputElement {
  const found = required(id);
  if (!(found instanceof HTMLInputElement)) throw new Error(`not an input: ${id}`);
  return found;
}

const networksBox = required('networks');
const manualToggle = required('manual-toggle');
const manualField = required('manual-field');
const manualSsid = requiredInput('manual-ssid');
const passphraseStep = required('step-passphrase');
const passphrase = requiredInput('passphrase');
const passphraseLabel = required('passphrase-label');
const showPassphrase = requiredInput('show-passphrase');
const adminStep = required('step-admin');
const adminHeading = required('admin-heading');
const adminHint = required('admin-hint');
const adminLabel = required('admin-label');
const adminPassword = requiredInput('admin-password');
const showAdminPassword = requiredInput('show-admin-password');
const submit = required('submit');
const errorBox = required('error');
const doneStep = required('done');

/**
 * Whether the settings password being asked for is a *new* one.
 *
 * Both cases need the field, for opposite reasons. A fresh device is choosing a password, and
 * the box needs it to protect its settings afterwards. A device that has been set up already
 * is being asked to *prove* who is at the keyboard: it will only accept a network change with
 * the existing password, or anyone in range of a box whose router died could move it onto
 * their own network.
 */
let choosingPassword = true;
let selected: ScannedNetwork | null = null;
let manual = false;

function showError(message: string | null): void {
  if (message === null) {
    errorBox.hidden = true;
    return;
  }
  errorBox.textContent = message;
  errorBox.hidden = false;
}

/** Four bars, from a 0-100 signal. Enough to tell "mine" from "the neighbour's". */
function bars(signal: number): string {
  const filled = Math.max(1, Math.min(4, Math.ceil(signal / 25)));
  return '▮'.repeat(filled) + '▯'.repeat(4 - filled);
}

function currentSsid(): string {
  return manual ? manualSsid.value.trim() : (selected?.ssid ?? '');
}

/** A chosen network with a passphrase box only when the network actually needs one. */
function refresh(): void {
  const ssid = currentSsid();
  const secure = manual || (selected?.secure ?? true);

  passphraseStep.hidden = ssid.length === 0 || !secure;
  adminStep.hidden = ssid.length === 0;

  const passphraseOk = !secure || passphrase.value.length === 0 || passphrase.value.length >= 8;
  // A new password has a minimum; an existing one is whatever it is, and only the box can say.
  const adminOk = choosingPassword
    ? adminPassword.value.length >= 6
    : adminPassword.value.length > 0;
  const blocked = ssid.length === 0 || !passphraseOk || !adminOk;
  submit.toggleAttribute('disabled', blocked);
}

function selectNetwork(network: ScannedNetwork, button: HTMLElement): void {
  selected = network;
  manual = false;
  manualField.hidden = true;
  for (const other of networksBox.querySelectorAll('[role="radio"]')) {
    other.setAttribute('aria-checked', String(other === button));
  }
  passphraseLabel.textContent = `Password for ${network.ssid}`;
  refresh();
  if (network.secure) passphrase.focus();
}

function renderNetworks(networks: ScannedNetwork[]): void {
  networksBox.replaceChildren();

  if (networks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    // Not an error state: the device scans as a client, and it cannot scan while it is
    // hosting this hotspot. Typing the name always works.
    empty.textContent = 'No networks found from here. Type your network name below.';
    networksBox.append(empty);
    setManual(true, { focus: false });
    return;
  }

  for (const network of networks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', 'false');

    const name = document.createElement('span');
    name.className = 'choice-name';
    name.textContent = network.ssid;

    const meta = document.createElement('span');
    meta.className = 'choice-meta';
    meta.textContent = `${network.secure ? '🔒 ' : ''}${bars(network.signal)}`;

    button.append(name, meta);
    button.addEventListener('click', () => {
      selectNetwork(network, button);
    });
    networksBox.append(button);
  }
}

/**
 * `focus` defaults to true for the manual-toggle button click, which should pop the keyboard
 * straight away. The no-networks-found path on initial load also lands here, and must not steal
 * focus before the user has touched the page.
 */
function setManual(on: boolean, { focus = true }: { focus?: boolean } = {}): void {
  manual = on;
  manualField.hidden = !on;
  if (on) {
    selected = null;
    for (const other of networksBox.querySelectorAll('[role="radio"]')) {
      other.setAttribute('aria-checked', 'false');
    }
    passphraseLabel.textContent = 'Password for your network';
    if (focus) manualSsid.focus();
  }
  refresh();
}

async function loadScan(): Promise<void> {
  try {
    const response = await fetch('/api/wifi/scan');
    const body: unknown = await response.json();
    const raw = field(body, 'networks');
    const networks = Array.isArray(raw)
      ? raw.map(toNetwork).filter((network): network is ScannedNetwork => network !== null)
      : [];
    renderNetworks(networks);
    const lastError = asText(field(body, 'lastError'));
    if (lastError.length > 0) showError(lastError);
  } catch {
    renderNetworks([]);
  }
}

function applyPasswordMode(): void {
  if (choosingPassword) {
    adminHeading.textContent = 'Bloopbox password';
    adminHint.textContent =
      'Only you should be able to change who the buttons call. At least 6 characters — write it down somewhere.';
    adminLabel.textContent = 'Settings password';
    adminPassword.autocomplete = 'new-password';
  } else {
    adminHeading.textContent = 'Your settings password';
    adminHint.textContent =
      'This box has been set up before, so it will only change networks for someone who knows its password.';
    adminLabel.textContent = 'Settings password';
    adminPassword.autocomplete = 'current-password';
  }
}

async function loadStatus(): Promise<void> {
  try {
    const response = await fetch('/api/status');
    const body: unknown = await response.json();
    choosingPassword = field(body, 'configured') !== true;
  } catch {
    // Assume the fresh-device path. Asking someone to choose a password the box already has
    // fails loudly and recoverably; asking for an existing one on a box that has none cannot
    // succeed at all.
    choosingPassword = true;
  }
  applyPasswordMode();
  refresh();
}

async function connect(): Promise<void> {
  const ssid = currentSsid();
  if (ssid.length === 0) return;

  submit.setAttribute('disabled', '');
  submit.textContent = 'Connecting…';
  showError(null);

  const body: Record<string, string> = { ssid, psk: passphrase.value };
  if (choosingPassword) body['adminPassword'] = adminPassword.value;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!choosingPassword) {
    // HTTP Basic, which is what the device's admin guard speaks. The user part is ignored by
    // the daemon; only the password is checked.
    headers['Authorization'] = `Basic ${btoa(`admin:${adminPassword.value}`)}`;
  }

  try {
    const response = await fetch('/api/wifi/join', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Worth its own message: the generic one would send a parent looking at their Wi-Fi
        // passphrase, which is not the field that is wrong.
        showError('That settings password was not right.');
        adminPassword.value = '';
        adminPassword.focus();
        submit.removeAttribute('disabled');
        submit.textContent = 'Connect';
        return;
      }
      const failure: unknown = await response.json().catch(() => null);
      const message = asText(field(failure, 'error'));
      showError(message.length > 0 ? message : 'The box would not accept that.');
      submit.removeAttribute('disabled');
      submit.textContent = 'Connect';
      return;
    }

    required('done-ssid').textContent = ssid;
    doneStep.hidden = false;
    submit.hidden = true;
    for (const step of ['step-network', 'step-passphrase', 'step-admin']) {
      required(step).hidden = true;
    }
    doneStep.scrollIntoView({ behavior: 'smooth' });
  } catch {
    // A dropped connection here is ambiguous and usually *good*: the hotspot going away is
    // exactly what a successful join looks like from this page.
    required('done-ssid').textContent = ssid;
    doneStep.hidden = false;
    submit.hidden = true;
  }
}

manualToggle.addEventListener('click', () => {
  setManual(!manual);
});
manualSsid.addEventListener('input', refresh);
passphrase.addEventListener('input', refresh);
adminPassword.addEventListener('input', refresh);
showPassphrase.addEventListener('change', () => {
  passphrase.type = showPassphrase.checked ? 'text' : 'password';
});
showAdminPassword.addEventListener('change', () => {
  adminPassword.type = showAdminPassword.checked ? 'text' : 'password';
});
submit.addEventListener('click', () => {
  void connect();
});

void loadStatus();
void loadScan();
