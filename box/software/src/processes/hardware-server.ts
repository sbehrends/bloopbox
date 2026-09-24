/**
 * Process 1 — hardware and web server daemon (PRODUCT.md §4).
 *
 * Owns the HAL, the device state machine, LED animation, the audio pipeline, config, and
 * the Socket.io server that both the browser and the WhatsApp bridge connect to.
 *
 * Never imports Baileys: WhatsApp lives entirely in Process 2, reached over the typed IPC
 * contract in src/ipc/events.ts.
 */
import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Server } from 'socket.io';
import { AudioPurger } from '../audio/purge.ts';
import { notesDirectory, recordingDirectory } from '../audio/directories.ts';
import { CAPTURE_FILTER_CHAIN, PLAYBACK_FILTER_CHAIN } from '../audio/ffmpeg.ts';
import { notePath, RECOVERY_MAX_AGE_MS, recoverUnplayedNotes } from '../audio/recovery.ts';
import { missingCues, SOUNDS_DIRECTORY } from '../audio/soundFiles.ts';
import { generateTestNote, TEST_NOTE_DURATION_MS } from '../audio/testNote.ts';
import { ConfigManager } from '../config/configManager.ts';
import { buttonIndexToKey, enabledContacts } from '../config/schema.ts';
import { DeviceController, type OutboundRequest } from '../core/deviceController.ts';
import { DeviceStatus } from '../core/deviceState.ts';
import { createHal, selectHalKind } from '../hal/index.ts';
import { SimulatorHal } from '../hal/simulatorDriver.ts';
import type { Hal } from '../hal/types.ts';
import { BRIDGE_NAMESPACE, type WhatsAppConnectionState } from '../ipc/events.ts';
import { childLogger } from '../logger.ts';
import {
  NetworkIntent,
  NetworkSupervisor,
  type NetworkObservation,
} from '../core/networkSupervisor.ts';
import {
  NetStateWatcher,
  requestNetAction,
  type NetAction,
  type NetState,
} from '../net/netState.ts';
import { StatsStore } from '../stats/statsStore.ts';
import { requestPowerAction, type PowerAction } from '../system/power.ts';
import { readSshAccess } from '../system/sshAccess.ts';
import { CpuUsageTracker, readSystemInfo, type StorageTarget } from '../system/systemInfo.ts';
import { portalRedirectTarget, shouldRedirectToPortal } from '../server/captivePortal.ts';
import { registerBridgeNamespace, type BridgeLink } from '../server/bridgeLink.ts';
import { createApiRouter, createAudioRouter, buildStatusPayload } from '../server/routes.ts';
import { SocketSimulatorTransport } from '../server/simulatorTransport.ts';

const log = childLogger('hardware');

/**
 * Set once the shutdown path is wired. Routes are constructed before it exists, so they call
 * through this rather than capturing it directly.
 */
let restartHandler: ((reason: string) => void) | null = null;

function requestRestart(reason: string): void {
  if (restartHandler) {
    restartHandler(reason);
    return;
  }
  // A config write before startup finished; nothing is serving yet, so this is unreachable
  // in practice, but exiting is still the correct response.
  log.warn({ reason }, 'restart requested before startup completed');
  process.exit(0);
}

const PORT = Number(process.env['PORT'] ?? 3000);
/**
 * Second listener, for the captive portal only.
 *
 * A phone's captive-portal probe goes to port 80 and nowhere else, so the setup page has to
 * answer there. The unit grants CAP_NET_BIND_SERVICE for it; in development the bind fails
 * with EACCES and is logged and shrugged off, because :3000 is all a laptop needs. Set to 0
 * to switch the listener off entirely.
 */
const PORTAL_PORT = Number(process.env['PORTAL_PORT'] ?? 80);
/** Audio lives in tmpfs on the device; override for dev. */
const RECORDING_DIRECTORY = recordingDirectory();
/**
 * Inbound notes, on the card rather than in RAM — see `audio/directories.ts`. Kept apart from
 * the captures above so a power cut costs nothing the child recorded and nothing derived.
 */
const NOTES_DIRECTORY = notesDirectory();
/** Built UI assets. Absent in dev, where Vite serves them on :5174. */
const STATIC_ROOT = resolve(import.meta.dirname, '../../dist/public');

/**
 * The volumes the diagnostics card reports on, named for what they hold rather than where they
 * are mounted — "/run" means nothing to a parent, and "in RAM, wiped by a power cut" is the
 * fact that matters about it.
 *
 * The notes directory is listed separately from the recordings one because on the device they
 * are on different media entirely, which is the whole point of the split
 * (`audio/directories.ts`). Off-device they routinely resolve to the same filesystem and the
 * two rows agree, which is harmless.
 */
const STORAGE_TARGETS: readonly StorageTarget[] = [
  { label: 'Card — settings and waiting messages', path: NOTES_DIRECTORY },
  { label: 'Memory disk — messages being sent', path: RECORDING_DIRECTORY },
];

/**
 * CPU busy time between one diagnostics reading and the next.
 *
 * Constructed here, once, so the first reading the panel asks for has a window to measure
 * against rather than reporting the average since boot.
 */
const cpuUsage = new CpuUsageTracker();

/**
 * Grace period between answering a config write and exiting, so the HTTP response and the
 * Socket.io notice reach the browser before the socket closes.
 */
const RESTART_DELAY_MS = 400;

/**
 * How long the boot chase runs before the device starts reporting real status.
 *
 * Without this the daemon derives status from Wi-Fi/WhatsApp immediately and BOOTING is
 * never visible, even though PRODUCT.md §6 defines a boot pattern. A real Pi takes seconds
 * to bring services up, so holding it here is honest as well as observable.
 */
const BOOT_ANIMATION_MS = 2600;

async function main(): Promise<void> {
  const kind = selectHalKind();

  /* ---- config ---- */

  const config = new ConfigManager();
  const loaded = await config.load();
  if (loaded.source === 'defaults') {
    log.warn({ reason: loaded.fallbackReason }, 'running on default config — onboarding required');
  }

  /*
   * Running totals, on the card beside config.json but deliberately not *in* it — a counter in
   * the config would restart the daemon every time a child pressed a button. Loaded before the
   * controller so the first send of this boot adds to the history rather than starting it.
   */
  const stats = new StatsStore();
  await stats.load();

  const absentCues = missingCues();
  if (absentCues.length > 0) {
    log.warn({ missing: absentCues }, 'audio cues missing — run `npm run sounds`');
  }

  /* ---- HTTP + Socket.io ---- */

  const app = express();
  app.use(express.json({ limit: '128kb' }));
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    // Audio chunks from the browser can be sizeable; allow headroom over the default 1MB.
    maxHttpBufferSize: 4 * 1024 * 1024,
  });

  /* ---- HAL ---- */

  const transport = new SocketSimulatorTransport(io);
  const halOptions = {
    recordingDirectory: RECORDING_DIRECTORY,
    micGainPercent: config.current.audio.micGainPercent,
    // Resolved here, so the HAL takes a chain and never a config flag.
    captureFilter: config.current.audio.enhanceCapture ? CAPTURE_FILTER_CHAIN : null,
    playbackFilter: config.current.audio.normalisePlayback ? PLAYBACK_FILTER_CHAIN : null,
    volumePercent: config.current.audio.speakerVolumePercent,
    amp: {
      volumePercent: config.current.audio.ampVolumePercent,
      boostDc: config.current.audio.ampBoostDc,
      boostAc: config.current.audio.ampBoostAc,
    },
  };

  /*
   * The simulator driver is built directly rather than through the factory, so its concrete
   * type is known here and `transport.attach` needs no downcast. Other drivers go through
   * the factory, which loads the GPIO module dynamically.
   */
  const simulatorHal = kind === 'simulator' ? new SimulatorHal(transport, halOptions) : null;
  const hal: Hal = simulatorHal ?? (await createHal({ kind, transport, ...halOptions }));

  /* ---- IPC to the WhatsApp bridge ---- */

  /* Boxed so the callbacks below, which run before the assignment completes, must
     null-check rather than relying on narrowing that does not hold at runtime. */
  const link: { current: BridgeLink | null } = { current: null };
  let whatsappState: WhatsAppConnectionState = 'connecting';
  let whatsappQr: string | null = null;
  /* When the current code arrived. The panel counts down from this, and the age is what it
     gets — not the timestamp — so a laptop whose clock disagrees with the device still
     shows the right number of seconds. */
  let whatsappQrAt = 0;

  /**
   * Wi-Fi health, from two sources that must not fight.
   *
   * `wifiObserved` is what `deploy/net-agent.sh` publishes; `wifiOverride` is the
   * simulator's injector. The override wins while it is set, so a browser can still stage
   * an outage on a machine where the real answer is "unknown", and clearing it hands
   * control back to the agent rather than pinning a stale value.
   */
  let wifiObserved = false;
  let wifiOverride: boolean | null = null;
  const isWifiDown = (): boolean => wifiOverride ?? wifiObserved;

  /** Same arrangement for the setup hotspot: what the agent reports, or what a tester staged. */
  let apObserved = false;
  let apOverride: boolean | null = null;
  const isApActive = (): boolean => apOverride ?? apObserved;

  const controller = new DeviceController({
    hal,
    config,
    send: async (request: OutboundRequest) => {
      const bridge = link.current;
      if (!bridge?.connected) throw new Error('WhatsApp bridge is not connected');
      await bridge.send(request);
    },
    markRead: (index, messageIds) => {
      link.current?.markRead(index, messageIds);
    },
    stats,
  });

  let booting = true;

  /** Recomputes the lifecycle status from Wi-Fi and WhatsApp health (spec §6). */
  const refreshStatus = (): void => {
    if (booting) {
      // Hold the boot chase; real status takes over when the boot window closes.
      controller.setStatus(DeviceStatus.Booting);
      transport.broadcastStatus(buildStatusPayload(routesContext));
      return;
    }
    if (isApActive()) {
      // Above WifiError deliberately: with the hotspot up, "the network is gone" is the
      // cause, and "setup is waiting for you" is the part a parent can act on.
      controller.setStatus(DeviceStatus.SetupPortal);
    } else if (isWifiDown()) {
      controller.setStatus(DeviceStatus.WifiError);
    } else if (whatsappState === 'connected') {
      controller.setStatus(DeviceStatus.Ready);
    } else if (whatsappState === 'connecting') {
      controller.setStatus(DeviceStatus.Connecting);
    } else {
      // Wi-Fi up but WhatsApp not linked yet — never paired, awaiting a QR scan, or just
      // logged out and waiting for a method to be chosen again.
      controller.setStatus(DeviceStatus.WhatsAppError);
    }
    transport.broadcastStatus(buildStatusPayload(routesContext));
  };

  link.current = registerBridgeNamespace({
    namespace: io.of(BRIDGE_NAMESPACE),
    token: process.env['BRIDGE_TOKEN'] ?? '',
    onStatus: ({ state, detail, qr }) => {
      whatsappState = state;
      const next = qr ?? null;
      // Only a genuinely new code restarts the clock: a status repeat is not a rotation.
      if (next !== null && next !== whatsappQr) whatsappQrAt = Date.now();
      whatsappQr = next;
      log.info({ state, detail }, 'whatsapp status');
      refreshStatus();
    },
    onIncoming: (payload) => {
      /*
       * The path is worked out here, not taken from the bridge: this daemon plays the file and
       * then deletes it, so a reported path taken on faith would let whatever holds the bridge
       * token delete anything it can write. A mismatch means the two daemons disagree about
       * NOTES_DIR, which is worth a warning rather than a silent drop.
       */
      const path = notePath(NOTES_DIRECTORY, payload.index, payload.messageId);
      if (path === null || resolve(payload.path) !== path) {
        log.warn(
          { index: payload.index, expected: path, reported: payload.path },
          'refused a voice note whose path is not where notes live',
        );
        return;
      }
      log.info({ index: payload.index, messageId: payload.messageId }, 'voice note received');
      controller.handleIncoming(payload.index, {
        messageId: payload.messageId,
        path,
        receivedAt: payload.receivedAt,
        durationMs: payload.durationMs,
      });
    },
    onRevoked: ({ index, messageId }) => {
      const removed = controller.revokeNote(index, messageId);
      log.info({ index, messageId, removed }, 'voice note deleted by its sender');
    },
    onConnectionChange: (connected) => {
      log.info({ connected }, 'bridge link');
      if (!connected) {
        whatsappState = 'disconnected';
        refreshStatus();
      } else {
        // Give the bridge the current whitelist straight away.
        link.current?.sendContacts(
          enabledContacts(config.current).map(({ index, jid }) => ({ index, jid })),
        );
      }
    },
  });

  /** Ends the boot window and lets real status through. */
  const finishBoot = (): void => {
    booting = false;
    refreshStatus();
  };

  /**
   * Opens the boot window: the LED chase, the boot sound, and the timer that ends both.
   *
   * One function for the real boot and the simulator's replay, so the two cannot drift into
   * disagreeing about what booting looks and sounds like.
   */
  const beginBoot = (): void => {
    booting = true;
    refreshStatus();
    controller.announceBoot();
    setTimeout(finishBoot, BOOT_ANIMATION_MS).unref();
  };

  /* ---- routes ---- */

  const routesContext = {
    config,
    controller,
    recordingDirectory: RECORDING_DIRECTORY,
    whatsapp: () => ({
      state: whatsappState,
      qr: whatsappQr,
      qrAgeMs: whatsappQr === null ? null : Date.now() - whatsappQrAt,
    }),
    wifiConnected: () => !isWifiDown(),
    unlinkWhatsApp: () => {
      link.current?.unlink();
    },
    beginLinking: () => {
      link.current?.beginLinking();
    },
    listGroups: async () => (await link.current?.listGroups()) ?? [],
    requestPairingCode: async (phone: string) =>
      (await link.current?.requestPairingCode(phone)) ?? {
        error: 'the WhatsApp bridge is not running',
      },
    requestRestart: (reason: string) => {
      requestRestart(reason);
    },
    netState: (): NetState | null => netWatcher.last,
    requestJoin: async (credentials: { ssid: string; psk: string }) =>
      requestNetAction('join', { credentials }),
    requestForgetNetwork: async () => requestNetAction('forget'),
    stats: () => stats.snapshot(),
    resetStats: async () => {
      await stats.reset();
    },
    systemInfo: async () => readSystemInfo({ cpu: cpuUsage, storage: STORAGE_TARGETS }),
    requestPower: async (action: PowerAction) => {
      /*
       * Flushed before the machine is asked to go away, not after: the store coalesces writes
       * for a couple of seconds, and a deliberate shutdown is precisely the moment those last
       * few seconds must already be on the card. systemd's SIGTERM would reach the shutdown
       * path below anyway, but only if the agent gets that far.
       */
      await stats.flush();
      return requestPowerAction(action);
    },
    sshAccess: () => readSshAccess(),
  };

  /*
   * Captive-portal interception, first in the chain and active only while the hotspot is up.
   *
   * Deliberately answers a phone's connectivity probe *wrongly* — a correct answer is what
   * makes the OS decide the network is fine and show nothing, which on a device with no
   * screen leaves the parent staring at a hotspot that appears to do nothing.
   */
  app.use((req, res, next) => {
    if (!shouldRedirectToPortal({ path: req.path, method: req.method }, isApActive())) {
      next();
      return;
    }
    res.redirect(302, portalRedirectTarget(PORTAL_PORT));
  });

  app.use('/api', createApiRouter(routesContext));
  /*
   * Recordings, served to the simulator's browser so it can play what the fake HAL "records".
   * Only there: on a device these are the child's own voice and the family's notes, the route
   * has no password, and the captive portal lets it through on the open setup hotspot — so a
   * device mounting it would hand them to anyone in radio range.
   */
  if (simulatorHal) {
    app.use('/audio', createAudioRouter([RECORDING_DIRECTORY, NOTES_DIRECTORY]));
  }
  app.use('/sounds', express.static(SOUNDS_DIRECTORY, { maxAge: '1h' }));

  if (existsSync(STATIC_ROOT)) {
    /*
     * `/` is the settings panel.
     *
     * There is no index.html at the static root, so this used to be a plain 404: a parent who
     * typed the box's name got nothing, and the address that actually worked was
     * `<host>:3000/admin/` — a port and a path nobody would guess and everybody had to be told.
     *
     * Served rather than redirected, so the address bar keeps saying `http://bloopbox.local`.
     * Vite emits absolute asset paths (`/assets/…`), so the very same file works at either
     * path; `/admin/` keeps answering for the links and bookmarks already out there.
     *
     * This deliberately sits *after* the captive-portal middleware. While the setup hotspot is
     * up, `/` is not a passthrough prefix, so a phone's probe is still redirected to the portal
     * and never reaches this line — onboarding keeps the root, and the panel only claims it
     * once the box is on a real network.
     */
    app.get('/', (_req, res) => {
      res.sendFile(resolve(STATIC_ROOT, 'admin/index.html'));
    });
    app.use(express.static(STATIC_ROOT));
  } else {
    log.warn('built UI not found — run `npm run dev:web` for the Vite dev server on :5174');
  }

  /* ---- simulator wiring ---- */

  if (simulatorHal) {
    transport.attach(simulatorHal, {
      injectIncoming: (index, count) => {
        void (async (): Promise<void> => {
          for (let n = 0; n < count; n++) {
            const messageId = `injected-${Date.now().toString(36)}-${n}`;
            /*
             * Written into the recordings directory, because playback is served from /audio
             * which only exposes recordings — a path into src/audio/sounds would 404.
             * Synthesised rather than copied from a cue so it is long and loud enough to
             * actually hear, with a per-button pitch.
             */
            const path = resolve(NOTES_DIRECTORY, `${messageId}.wav`);
            await generateTestNote(path, index);
            controller.handleIncoming(index, {
              messageId,
              path,
              receivedAt: Date.now(),
              durationMs: TEST_NOTE_DURATION_MS,
            });
          }
          log.info({ index: buttonIndexToKey(index), count }, 'injected incoming notes');
        })();
      },
      reboot: () => {
        log.info('replaying boot sequence');
        beginBoot();
      },
      injectWifiFailure: (down) => {
        // Latched until something clears it: the agent's own reading must not silently
        // undo what a tester just staged.
        wifiOverride = down;
        log.info({ down }, 'injected wifi state');
        refreshStatus();
      },
      injectApMode: (active) => {
        // Latched like the Wi-Fi injector, and left latched: the real reading would flip it
        // straight back on any device that does have an agent.
        apOverride = active;
        log.info({ active }, 'injected setup hotspot state');
        refreshStatus();
      },
      injectSessionExpiry: () => {
        whatsappState = 'loggedOut';
        log.info('injected whatsapp session expiry');
        refreshStatus();
      },
      injectWhatsAppConnected: () => {
        whatsappState = 'connected';
        // Hands the network back to the agent rather than pinning it up.
        wifiOverride = null;
        apOverride = null;
        log.info('injected whatsapp connected');
        refreshStatus();
      },
    });
  }

  /* ---- housekeeping ---- */

  const purger = new AudioPurger({
    directory: RECORDING_DIRECTORY,
    // Notes still waiting to be played must survive their own TTL. A function, so each sweep
    // sees the queue as it is then rather than as it was at boot.
    keep: () => controller.protectedFiles(),
    onResult: (result) => {
      log.info({ deleted: result.deleted.length, freedBytes: result.freedBytes }, 'audio purged');
    },
  });

  /*
   * The same sweep over the notes on the card. Not optional housekeeping now that they outlive
   * a reboot: the tmpfs used to bound itself by being wiped, and nothing bounds `/data` except
   * this. The 48 h TTL is what keeps a child's voice notes from accumulating on removable
   * storage indefinitely, so it is as much a privacy control here as a disk-space one.
   */
  const notesPurger = new AudioPurger({
    directory: NOTES_DIRECTORY,
    keep: () => controller.protectedFiles(),
    onResult: (result) => {
      log.info({ deleted: result.deleted.length, freedBytes: result.freedBytes }, 'notes purged');
    },
  });

  /* ---- network observation ---- */

  /**
   * Reads what the root agent publishes about the Wi-Fi (see `deploy/net-agent.sh`).
   *
   * Absent on a dev machine, and that is the point: no reading means *unknown*, which the
   * watcher reports as "not down". The error pattern only ever comes from a fresh reading
   * that explicitly says the network is gone.
   */
  /**
   * Decides when the setup hotspot goes up (PENDING.md). Pure; the privileged half is the
   * root agent, reached by writing a request file it consumes.
   */
  const supervisor = new NetworkSupervisor({
    configured: config.current.system.configured,
    hasTargetNetwork: config.current.wifi.ssid.length > 0,
  });

  const ask = (action: NetAction): void => {
    void (async (): Promise<void> => {
      const written = await requestNetAction(action);
      if (written) {
        log.info({ action }, 'asked the network agent');
      } else {
        // The supervisor will ask again on a later tick; on a dev machine there is no agent
        // and no request directory, which is exactly this path and is not a problem.
        log.debug({ action }, 'could not write a network request');
      }
    })();
  };

  const netWatcher = new NetStateWatcher({
    onWifiDownChange: (down) => {
      wifiObserved = down;
      log.info({ down, ssid: netWatcher.last?.ssid ?? null }, 'wifi state changed');
      refreshStatus();
    },
    onReading: (state) => {
      const observation: NetworkObservation = {
        available: state?.available ?? false,
        online: state?.online ?? false,
        apActive: state?.apActive ?? false,
      };

      if (observation.apActive !== apObserved) {
        apObserved = observation.apActive;
        log.info({ apActive: apObserved }, 'setup hotspot state changed');
        refreshStatus();
      }

      const intent = supervisor.observe(observation, Date.now());
      if (intent !== NetworkIntent.None) ask(intent);
    },
    onAgentHealthChange: (healthy) => {
      if (healthy) {
        log.info('network agent is publishing');
      } else {
        // Not an outage: we simply stop knowing. Logged because on the device it means the
        // net agent unit is down, which doctor.sh also checks for.
        log.warn('no fresh reading from the network agent — wifi state is unknown');
      }
    },
  });

  /* ---- start ---- */

  await hal.init().catch((error: unknown) => {
    log.error({ err: error }, 'HAL initialisation failed');
    throw error;
  });
  await controller.start();

  /*
   * Put back whatever a restart would otherwise have thrown away.
   *
   * Before the purger starts, so a note recovered into a queue is already protected by
   * `protectedFiles()` when the first sweep runs. Awaited rather than fired off, so the boot
   * window closes on a device whose unread lights already tell the truth.
   */
  const recovered = await recoverUnplayedNotes({ directory: NOTES_DIRECTORY });
  for (const { index, note } of recovered.notes) controller.restoreUnread(index, note);
  if (recovered.notes.length > 0 || recovered.expired > 0 || recovered.unattributable > 0) {
    log.info(
      {
        restored: recovered.notes.length,
        expired: recovered.expired,
        unattributable: recovered.unattributable,
        maxAgeMs: RECOVERY_MAX_AGE_MS,
      },
      'unread notes recovered',
    );
  }

  purger.start();
  if (NOTES_DIRECTORY !== RECORDING_DIRECTORY) notesPurger.start();
  await netWatcher.start();

  // Push status to any tab whenever the device changes.
  controller.state.on('change', () => {
    transport.broadcastStatus(buildStatusPayload(routesContext));
    // The whole observable state, on every change, at debug level. This is what
    // `bloopbox-debug on` turns into a readable timeline of what the lights did and when —
    // `src/core/` is I/O-free by design and will never log for itself, and on a device with
    // no screen a reconstruction after the fact is the only way to see a timing bug.
    log.debug(controller.state.snapshot(), 'state');
  });

  // The raw edges, before debouncing. A press the interpreter discards leaves no other
  // trace, and "the button did nothing" is the report we will actually get.
  hal.on('buttonDown', ({ index }) => {
    log.debug({ index, edge: 'down' }, 'button');
  });
  hal.on('buttonUp', ({ index }) => {
    log.debug({ index, edge: 'up' }, 'button');
  });

  // Show the boot chase and play the boot sound, then let real status through.
  beginBoot();

  await new Promise<void>((ready) => {
    httpServer.listen(PORT, () => {
      log.info({ port: PORT, driver: hal.name, recordings: RECORDING_DIRECTORY }, 'listening');
      ready();
    });
  });

  /*
   * The portal listener. Same Express app, second socket — a phone probing a captive network
   * asks port 80 and will not be told otherwise, and an nftables redirect would have to be
   * torn down again by something running as root.
   */
  const portalServer = PORTAL_PORT > 0 ? createServer(app) : null;
  if (portalServer) {
    portalServer.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EACCES' || error.code === 'EADDRINUSE') {
        // Expected off-device: binding 80 needs CAP_NET_BIND_SERVICE, which the systemd unit
        // grants and a laptop does not. The captive portal is the only thing that needs it.
        log.warn(
          { port: PORTAL_PORT, code: error.code },
          'no portal listener — captive portal will not work here',
        );
        return;
      }
      log.error({ err: error }, 'portal listener failed');
    });
    portalServer.listen(PORTAL_PORT, () => {
      log.info({ port: PORTAL_PORT }, 'portal listening');
    });
  }

  /* ---- shutdown ---- */

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, 'shutting down');

    void (async (): Promise<void> => {
      netWatcher.stop();
      portalServer?.close();
      purger.stop();
      notesPurger.stop();
      // Before anything slow: this is the only moment the last few counted presses reach the
      // card, and both a config save and a `poweroff` arrive here.
      await stats.flush();
      await purger.whenIdle();
      await notesPurger.whenIdle();
      await controller.stop();
      // Leaves every LED off, per the HAL contract.
      await hal.dispose();
      void io.close();
      httpServer.close(() => process.exit(0));
      // Do not wait forever for lingering keep-alive sockets.
      setTimeout(() => process.exit(0), 3000).unref();
    })();
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown(signal));
  }

  /**
   * Exits so the supervisor restarts us with the new config.
   *
   * Config is read once at boot rather than watched, so this is what makes a saved setting
   * take effect. Exit code 0 — this is a clean, intentional restart, not a failure. systemd
   * (`Restart=always`) handles it on the device; `npm run dev:hw` uses scripts/dev-server.ts.
   */
  restartHandler = (reason: string): void => {
    if (shuttingDown) return;
    log.info({ reason }, 'restarting to apply configuration');
    setTimeout(() => shutdown(`restart: ${reason}`), RESTART_DELAY_MS).unref();
  };
}

await main().catch((error: unknown) => {
  log.error({ err: error }, 'hardware server failed to start');
  process.exit(1);
});
