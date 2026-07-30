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
import { cp } from 'node:fs/promises';
import { AudioPurger } from '../audio/purge.ts';
import { missingCues, SOUNDS_DIRECTORY } from '../audio/soundFiles.ts';
import { ConfigManager } from '../config/configManager.ts';
import { buttonIndexToKey, enabledContacts } from '../config/schema.ts';
import { DeviceController, type OutboundRequest } from '../core/deviceController.ts';
import { DeviceStatus } from '../core/deviceState.ts';
import { createHal, selectHalKind } from '../hal/index.ts';
import { SimulatorHal } from '../hal/simulatorDriver.ts';
import type { Hal } from '../hal/types.ts';
import { BRIDGE_NAMESPACE, type WhatsAppConnectionState } from '../ipc/events.ts';
import { childLogger } from '../logger.ts';
import { registerBridgeNamespace, type BridgeLink } from '../server/bridgeLink.ts';
import { createApiRouter, createAudioRouter, buildStatusPayload } from '../server/routes.ts';
import { SocketSimulatorTransport } from '../server/simulatorTransport.ts';

const log = childLogger('hardware');

const PORT = Number(process.env['PORT'] ?? 3000);
/** Audio lives in tmpfs on the device; override for dev. */
const RECORDING_DIRECTORY = process.env['RECORDING_DIR'] ?? '/tmp/kids-messenger';
/** Built UI assets. Absent in dev, where Vite serves them on :5174. */
const STATIC_ROOT = resolve(import.meta.dirname, '../../dist/public');

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
  let wifiDown = false;

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

  /** Recomputes the lifecycle status from Wi-Fi and WhatsApp health (spec §6). */
  const refreshStatus = (): void => {
    if (wifiDown) {
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

  /* ---- routes ---- */

  const routesContext = {
    config,
    controller,
    recordingDirectory: RECORDING_DIRECTORY,
    whatsapp: () => ({ state: whatsappState, qr: whatsappQr }),
    wifiConnected: () => !wifiDown,
    unlinkWhatsApp: () => {
      link.current?.unlink();
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
            const path = resolve(RECORDING_DIRECTORY, `${messageId}.wav`);
            /*
             * Stage a real file in the recordings directory rather than pointing at the
             * cue itself: playback is served from /audio, which only exposes recordings,
             * so a path into src/audio/sounds would 404 and inject silence.
             */
            await cp(resolve(SOUNDS_DIRECTORY, 'chime.wav'), path);
            controller.handleIncoming(index, {
              messageId,
              path,
              receivedAt: Date.now(),
              durationMs: 140,
            });
          }
          log.info({ index: buttonIndexToKey(index), count }, 'injected incoming notes');
        })();
      },
      injectWifiFailure: (down) => {
        wifiDown = down;
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
        wifiDown = false;
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

  /* ---- start ---- */

  await hal.init().catch((error: unknown) => {
    log.error({ err: error }, 'HAL initialisation failed');
    throw error;
  });
  await controller.start();
  purger.start();

  // Push status to any tab whenever the device changes.
  controller.state.on('change', () => {
    transport.broadcastStatus(buildStatusPayload(routesContext));
  });

  refreshStatus();

  await new Promise<void>((ready) => {
    httpServer.listen(PORT, () => {
      log.info({ port: PORT, driver: hal.name, recordings: RECORDING_DIRECTORY }, 'listening');
      ready();
    });
  });

  /* ---- shutdown ---- */

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    void (async (): Promise<void> => {
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
}

await main().catch((error: unknown) => {
  log.error({ err: error }, 'hardware server failed to start');
  process.exit(1);
});
