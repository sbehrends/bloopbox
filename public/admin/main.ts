/**
 * Admin panel front-end.
 *
 * Phase 1: entry point only. Phase 2d adds the config form (Wi-Fi, contacts, volume,
 * quiet hours), WhatsApp QR pairing, and live status over Socket.io — all validated
 * against the same Zod schema the server uses.
 */

type DeviceStatus = {
  readonly state: string;
  readonly silentMode: boolean;
  readonly whatsappConnected: boolean;
};

/** Narrows an untrusted JSON payload — never assert a shape onto network data. */
function isDeviceStatus(value: unknown): value is DeviceStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    typeof value.state === 'string' &&
    'silentMode' in value &&
    typeof value.silentMode === 'boolean' &&
    'whatsappConnected' in value &&
    typeof value.whatsappConnected === 'boolean'
  );
}

async function fetchStatus(): Promise<DeviceStatus | null> {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    return isDeviceStatus(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const status = document.querySelector<HTMLParagraphElement>('#status');
  if (!status) return;

  const device = await fetchStatus();
  status.textContent = device
    ? `${device.state} · ${device.silentMode ? 'silent' : 'audible'}`
    : 'Hardware server unreachable — start it with `npm run dev:hw`';
}

void main();
