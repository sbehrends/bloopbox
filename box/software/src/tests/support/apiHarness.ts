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
import { StatsStore } from '../../stats/statsStore.ts';
import type { PowerAction } from '../../system/power.ts';
import type { SshAccess } from '../../system/sshAccess.ts';
import { CpuUsageTracker, readSystemInfo } from '../../system/systemInfo.ts';

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
  /** The real store, on a temp path, so a test can record and then read the route back. */
  readonly stats: StatsStore;
  /** Where recordings are served from, for the audio router's path tests. */
  readonly recordingDirectory: string;

  /* Stub state, writable mid-test. */
  whatsapp: { state: WhatsAppConnectionState; qr: string | null; qrAgeMs?: number | null };
  netState: NetState | null;
  joinAccepted: boolean;
  /** Set false to make the agent call reject, as a missing request directory would. */
  forgetSucceeds: boolean;
  groups: { id: string; subject: string }[];
  pairing: { code?: string; error?: string };

  /* What the routes did. */
  readonly joins: { ssid: string; psk: string }[];
  readonly restarts: string[];
  readonly unlinks: { count: number };
  readonly beginLinkings: { count: number };
  readonly forgets: { count: number };
  /** Power requests the routes made, and whether the stub agent accepts them. */
  readonly powerRequests: PowerAction[];
  powerAccepted: boolean;
  /** The first-boot ssh login the route reports; null is a box that made none. */
  sshAccess: SshAccess | null;

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
  /*
   * The real StatsStore rather than a stub: the routes join it to the config, and the join is
   * the part worth testing. `flushDelayMs: 0` keeps every write immediate so a test never waits.
   */
  const stats = new StatsStore({ path: join(workDir, 'stats.json'), flushDelayMs: 0 });
  const controller = new DeviceController({
    hal,
    config,
    send: () => Promise.resolve(),
    stats,
  });
  controller.setStatus(DeviceStatus.Ready);
  const cpu = new CpuUsageTracker();

  const state = {
    whatsapp: { state: 'connected', qr: null } as {
      state: WhatsAppConnectionState;
      qr: string | null;
      qrAgeMs?: number | null;
    },
    netState: null as NetState | null,
    joinAccepted: true,
    forgetSucceeds: true,
    groups: [] as { id: string; subject: string }[],
    pairing: {} as { code?: string; error?: string },
    powerAccepted: true,
    sshAccess: null as SshAccess | null,
  };
  const joins: { ssid: string; psk: string }[] = [];
  const restarts: string[] = [];
  const unlinks = { count: 0 };
  const beginLinkings = { count: 0 };
  const forgets = { count: 0 };
  const powerRequests: PowerAction[] = [];

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
    requestForgetNetwork: () => {
      forgets.count += 1;
      return state.forgetSucceeds
        ? Promise.resolve(true)
        : Promise.reject(new Error('no network agent'));
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
    stats: () => stats.snapshot(),
    resetStats: () => stats.reset(),
    systemInfo: () =>
      readSystemInfo({
        cpu,
        // The temp directory, which definitely exists — the point is the shape of the reply,
        // not what a laptop's disk happens to be doing.
        storage: [{ label: 'Work', path: workDir }],
      }),
    // Never actually powers anything off, for the same reason requestRestart does not restart.
    requestPower: (action) => {
      powerRequests.push(action);
      return Promise.resolve(state.powerAccepted);
    },
    sshAccess: () => Promise.resolve(state.sshAccess),
  };

  const app = express();
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', createApiRouter(context));
  app.use('/audio', createAudioRouter([recordingDirectory]));

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
    stats,
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
    get forgetSucceeds() {
      return state.forgetSucceeds;
    },
    set forgetSucceeds(value) {
      state.forgetSucceeds = value;
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
    get powerAccepted() {
      return state.powerAccepted;
    },
    set powerAccepted(value) {
      state.powerAccepted = value;
    },
    get sshAccess() {
      return state.sshAccess;
    },
    set sshAccess(value) {
      state.sshAccess = value;
    },
    powerRequests,
    joins,
    restarts,
    unlinks,
    beginLinkings,
    forgets,
    basic: (password) => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
    close: async () => {
      stats.stop();
      /*
       * Waits for a write already under way. The store writes atomically, through a temp file
       * beside stats.json, and one landing while `rm` below is emptying the directory made it
       * fail with ENOTEMPTY now and then.
       */
      await stats.flush();
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
    handledRequestId: null,
    ...overrides,
  };
}
