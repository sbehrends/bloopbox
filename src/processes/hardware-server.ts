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
import { NetStateWatcher } from '../net/netState.ts';
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
/** Audio lives in tmpfs on the device; override for dev. */
const RECORDING_DIRECTORY = process.env['RECORDING_DIR'] ?? '/tmp/bloopbox';
/** Built UI assets. Absent in dev, where Vite serves them on :5174. */
const STATIC_ROOT = resolve(import.meta.dirname, '../../dist/public');

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
    volumePercent: config.current.audio.speakerVolumePercent,
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
    if (isWifiDown()) {
      controller.setStatus(DeviceStatus.WifiError);
    } else if (whatsappState === 'connected') {
      controller.setStatus(DeviceStatus.Ready);
    } else if (whatsappState === 'connecting') {
      controller.setStatus(DeviceStatus.Connecting);
    } else {
      // Wi-Fi up but WhatsApp unlinked or awaiting a QR scan.
      controller.setStatus(DeviceStatus.WhatsAppError);
    }
    transport.broadcastStatus(buildStatusPayload(routesContext));
  };

  link.current = registerBridgeNamespace({
    namespace: io.of(BRIDGE_NAMESPACE),
    token: process.env['BRIDGE_TOKEN'] ?? '',
    onStatus: ({ state, qr }) => {
      whatsappState = state;
      whatsappQr = qr ?? null;
      log.info({ state }, 'whatsapp status');
      refreshStatus();
    },
    onIncoming: (payload) => {
      log.info({ index: payload.index, messageId: payload.messageId }, 'voice note received');
      controller.handleIncoming(payload.index, {
        messageId: payload.messageId,
        path: payload.path,
        receivedAt: payload.receivedAt,
        durationMs: payload.durationMs,
      });
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

  /** Replays the boot sequence, so it can be observed on demand rather than only at start. */
  const rebootDevice = (): void => {
    booting = true;
    refreshStatus();
    setTimeout(finishBoot, BOOT_ANIMATION_MS).unref();
  };

  /* ---- routes ---- */

  const routesContext = {
    config,
    controller,
    recordingDirectory: RECORDING_DIRECTORY,
    whatsapp: () => ({ state: whatsappState, qr: whatsappQr }),
    wifiConnected: () => !isWifiDown(),
    unlinkWhatsApp: () => {
      link.current?.unlink();
    },
    listGroups: async () => (await link.current?.listGroups()) ?? [],
    requestPairingCode: async (phone: string) =>
      (await link.current?.requestPairingCode(phone)) ?? {
        error: 'the WhatsApp bridge is not running',
      },
    requestRestart: (reason: string) => {
      requestRestart(reason);
    },
  };

  app.use('/api', createApiRouter(routesContext));
  app.use('/audio', createAudioRouter(RECORDING_DIRECTORY));
  app.use('/sounds', express.static(SOUNDS_DIRECTORY, { maxAge: '1h' }));

  if (existsSync(STATIC_ROOT)) {
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
            const path = resolve(RECORDING_DIRECTORY, `${messageId}.wav`);
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
        rebootDevice();
      },
      injectWifiFailure: (down) => {
        // Latched until something clears it: the agent's own reading must not silently
        // undo what a tester just staged.
        wifiOverride = down;
        log.info({ down }, 'injected wifi state');
        refreshStatus();
      },
      injectSessionExpiry: () => {
        whatsappState = 'loggedOut';
        log.info('injected whatsapp session expiry');
        refreshStatus();
      },
      injectWhatsAppConnected: () => {
        whatsappState = 'connected';
        // Hands Wi-Fi back to the agent rather than pinning it up.
        wifiOverride = null;
        log.info('injected whatsapp connected');
        refreshStatus();
      },
    });
  }

  /* ---- housekeeping ---- */

  const purger = new AudioPurger({
    directory: RECORDING_DIRECTORY,
    // Notes still waiting to be played must survive their own TTL.
    keep: controller.protectedFiles(),
    onResult: (result) => {
      log.info({ deleted: result.deleted.length, freedBytes: result.freedBytes }, 'audio purged');
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
  const netWatcher = new NetStateWatcher({
    onWifiDownChange: (down) => {
      wifiObserved = down;
      log.info({ down, ssid: netWatcher.last?.ssid ?? null }, 'wifi state changed');
      refreshStatus();
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
  purger.start();
  await netWatcher.start();

  // Push status to any tab whenever the device changes.
  controller.state.on('change', () => {
    transport.broadcastStatus(buildStatusPayload(routesContext));
  });

  // Show the boot chase, then let real status through.
  refreshStatus();
  setTimeout(finishBoot, BOOT_ANIMATION_MS).unref();

  await new Promise<void>((ready) => {
    httpServer.listen(PORT, () => {
      log.info({ port: PORT, driver: hal.name, recordings: RECORDING_DIRECTORY }, 'listening');
      ready();
    });
  });

  /* ---- shutdown ---- */

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, 'shutting down');

    void (async (): Promise<void> => {
      netWatcher.stop();
      purger.stop();
      await purger.whenIdle();
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
