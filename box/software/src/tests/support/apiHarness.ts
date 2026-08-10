import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, DEFAULT_TEMPLATE_PATH } from '../../config/configManager.ts';
import { configSchema } from '../../config/schema.ts';
import { DeviceController } from '../../core/deviceController.ts';
import { DeviceStatus } from '../../core/deviceState.ts';
import { MockHal } from '../../hal/mockDriver.ts';
import type { WhatsAppConnectionState } from '../../ipc/events.ts';
import type { NetState } from '../../net/netState.ts';
import { hashAdminPassword } from '../../server/auth.ts';
import { createApiRouter, createAudioRouter, type RoutesContext } from '../../server/routes.ts';

/**
 * A real Express app on a real port, assembled the way `hardware-server.ts` assembles it.
 *
 * Not a mocked router: the things worth testing here are the guard order, the body parser and
 * the status codes, and all three live in the wiring rather than in a handler. Driven with
 * `fetch`, which keeps this dependency-free — the alternative was adding supertest to test
 * eight files.
 *
 * Everything the routes reach for that is not the config, the controller or the filesystem is
 * a plain function over a mutable field, so a test can say "now the hotspot is up" and make
 * the next request.
 */

/** bcrypt at 10 rounds costs ~100ms a call, which adds up over a suite. Hash each password once. */
const hashCache = new Map<string, Promise<string>>();

function cachedHash(password: string): Promise<string> {
  const existing = hashCache.get(password);
  if (existing) return existing;
  const created = hashAdminPassword(password);
  hashCache.set(password, created);
  return created;
}

export type Harness = {
  /** Absolute URL for a path like `/api/status`. */
  url: (path: string) => string;
  readonly config: ConfigManager;
  readonly controller: DeviceController;
  readonly hal: MockHal;
  /** Where recordings are served from, for the audio router's path tests. */
  readonly recordingDirectory: string;

  /* Stub state, writable mid-test. */
  whatsapp: { state: WhatsAppConnectionState; qr: string | null; qrAgeMs?: number | null };
  netState: NetState | null;
  joinAccepted: boolean;
  groups: { id: string; subject: string }[];
  pairing: { code?: string; error?: string };

  /* What the routes did. */
  readonly joins: { ssid: string; psk: string }[];
  readonly restarts: string[];
  readonly unlinks: { count: number };
  readonly beginLinkings: { count: number };

  /** Basic auth header value for a password. */
  basic: (password: string) => string;
  close: () => Promise<void>;
};

export type HarnessOptions = {
  /** Whether the device has finished onboarding. Defaults to true. */
  readonly configured?: boolean;
  /** Sets an admin password hash. Omit for a device with no password at all. */
  readonly adminPassword?: string;
};

export async function startApi(options: HarnessOptions = {}): Promise<Harness> {
  const workDir = await mkdtemp(join(tmpdir(), 'bloopbox-api-'));
  const configPath = join(workDir, 'config.json');
  const recordingDirectory = join(workDir, 'recordings');

  const template = configSchema.parse(
    JSON.parse(await readFile(DEFAULT_TEMPLATE_PATH, 'utf8')) as unknown,
  );
  const configured = options.configured ?? true;
  const adminPasswordHash =
    options.adminPassword === undefined ? '' : await cachedHash(options.adminPassword);

  await writeFile(
    configPath,
    JSON.stringify({
      ...template,
      system: { ...template.system, configured, adminPasswordHash },
      contacts: {
        button1: { name: 'Mom', target: '15551234567', enabled: true },
        button2: { name: 'Dad', target: '15559876543', enabled: true },
        button3: { name: 'Grandma', target: '', enabled: false },
      },
    }),
    'utf8',
  );

  const config = new ConfigManager({ configPath, templatePath: DEFAULT_TEMPLATE_PATH });
  await config.load();

  const hal = new MockHal();
  await hal.init();
  const controller = new DeviceController({ hal, config, send: () => Promise.resolve() });
  controller.setStatus(DeviceStatus.Ready);

  const state = {
    whatsapp: { state: 'connected', qr: null } as {
      state: WhatsAppConnectionState;
      qr: string | null;
      qrAgeMs?: number | null;
    },
    netState: null as NetState | null,
    joinAccepted: true,
    groups: [] as { id: string; subject: string }[],
    pairing: {} as { code?: string; error?: string },
  };
  const joins: { ssid: string; psk: string }[] = [];
  const restarts: string[] = [];
  const unlinks = { count: 0 };
  const beginLinkings = { count: 0 };

  const context: RoutesContext = {
    config,
    controller,
    recordingDirectory,
    whatsapp: () => state.whatsapp,
    wifiConnected: () => true,
    netState: () => state.netState,
    requestJoin: (credentials) => {
      joins.push(credentials);
      return Promise.resolve(state.joinAccepted);
    },
    unlinkWhatsApp: () => {
      unlinks.count += 1;
    },
    beginLinking: () => {
      beginLinkings.count += 1;
    },
    listGroups: () => Promise.resolve(state.groups),
    requestPairingCode: () => Promise.resolve(state.pairing),
    // Never actually restarts: the real one exits the process, which would end the test run.
    requestRestart: (reason) => {
      restarts.push(reason);
    },
  };

  const app = express();
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', createApiRouter(context));
  app.use('/audio', createAudioRouter(recordingDirectory));

  const server: Server = createServer(app);
  await new Promise<void>((resolveListening) => {
    server.listen(0, '127.0.0.1', resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not bind a port');
  }
  const base = `http://127.0.0.1:${String(address.port)}`;

  return {
    url: (path) => `${base}${path}`,
    config,
    controller,
    hal,
    recordingDirectory,
    get whatsapp() {
      return state.whatsapp;
    },
    set whatsapp(value) {
      state.whatsapp = value;
    },
    get netState() {
      return state.netState;
    },
    set netState(value) {
      state.netState = value;
    },
    get joinAccepted() {
      return state.joinAccepted;
    },
    set joinAccepted(value) {
      state.joinAccepted = value;
    },
    get groups() {
      return state.groups;
    },
    set groups(value) {
      state.groups = value;
    },
    get pairing() {
      return state.pairing;
    },
    set pairing(value) {
      state.pairing = value;
    },
    joins,
    restarts,
    unlinks,
    beginLinkings,
    basic: (password) => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
    close: async () => {
      await controller.stop();
      await new Promise<void>((closed, failed) => {
        server.close((error) => {
          if (error) failed(error);
          else closed();
        });
      });
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

/** A published net reading, fresh by default so `isWifiDown` treats it as current. */
export function netReading(overrides: Partial<NetState> = {}): NetState {
  return {
    updatedAtMs: Date.now(),
    available: true,
    online: true,
    ssid: 'Home',
    signal: 70,
    apActive: false,
    apSsid: null,
    scan: [],
    scanAgeSeconds: 0,
    lastError: null,
    ...overrides,
  };
}
