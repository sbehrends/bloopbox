import { Router, type Request, type RequestHandler, type Response } from 'express';
import { basename, resolve } from 'node:path';
import { toString as qrToString } from 'qrcode';
import { ALL_AUDIO_CUES } from '../audio/cues.ts';
import { ConfigValidationError, type ConfigManager } from '../config/configManager.ts';
import { configUpdateSchema, enabledContacts } from '../config/schema.ts';
import type { DeviceController } from '../core/deviceController.ts';
import {
  QR_LIFETIME_MS,
  type DeviceStatusPayload,
  type WhatsAppConnectionState,
} from '../ipc/events.ts';
import { readBoolean, readField, readString } from '../ipc/payload.ts';
import type { NetState } from '../net/netState.ts';
import { hashAdminPassword, requireAdmin } from './auth.ts';

/**
 * REST API for the admin panel and captive portal.
 *
 * Every mutating route validates its body against the same Zod schema the config manager
 * uses, so a malformed request is rejected before it can reach disk.
 */

export type RoutesContext = {
  readonly config: ConfigManager;
  readonly controller: DeviceController;
  /** Directory recordings live in; served read-only to the simulator. */
  readonly recordingDirectory: string;
  /**
   * Latest WhatsApp state, owned by the process layer. `qrAgeMs` is how long ago the current
   * code arrived — an age rather than a timestamp, so the panel's countdown does not depend on
   * the browser's clock agreeing with the device's.
   */
  readonly whatsapp: () => {
    state: WhatsAppConnectionState;
    qr: string | null;
    qrAgeMs?: number | null;
  };
  /** Whether Wi-Fi is currently up. */
  readonly wifiConnected: () => boolean;
  /** The latest reading from the root network agent, or null if there is none. */
  readonly netState: () => NetState | null;
  /**
   * Hands Wi-Fi credentials to the root agent, which owns every privileged network call.
   * Resolves once the request is written, not once the radio has done anything.
   */
  readonly requestJoin: (credentials: { ssid: string; psk: string }) => Promise<boolean>;
  /** Drops WhatsApp credentials so the device can be re-paired. */
  readonly unlinkWhatsApp: () => void;
  /** Opens the socket for a first-time link. A no-op unless WhatsApp is `notLinked`. */
  readonly beginLinking: () => void;
  /** Groups the linked account is in, so a parent can pick one instead of typing a JID. */
  readonly listGroups: () => Promise<{ id: string; subject: string }[]>;
  /** Starts phone-number pairing, the alternative to scanning a QR. */
  readonly requestPairingCode: (phone: string) => Promise<{ code?: string; error?: string }>;
  /**
   * Restarts the daemon so a saved config takes effect.
   *
   * Config is snapshot at boot rather than watched, so a write is not live until the process
   * comes back. Called after the response is sent.
   */
  readonly requestRestart: (reason: string) => void;
};

export function buildStatusPayload(context: RoutesContext): DeviceStatusPayload {
  const snapshot = context.controller.state.snapshot();
  const whatsapp = context.whatsapp();
  return {
    state: snapshot.status,
    silentMode: snapshot.silentMode,
    silentFromSchedule: snapshot.silentFromSchedule,
    whatsappConnected: whatsapp.state === 'connected',
    wifiConnected: context.wifiConnected(),
    configured: context.config.current.system.configured,
    unreadCounts: snapshot.unreadCounts,
    recording: snapshot.recording,
    playing: snapshot.playing,
    driver: context.controller.driverName,
  };
}

export function createApiRouter(context: RoutesContext): Router {
  const router = Router();
  const admin = requireAdmin(context.config);

  /* ---- status, readable without credentials ---- */

  router.get('/status', (_req, res) => {
    res.json(buildStatusPayload(context));
  });

  router.get('/whatsapp', (_req, res) => {
    const whatsapp = context.whatsapp();
    const awaiting = whatsapp.state === 'awaitingPairing';
    res.json({
      state: whatsapp.state,
      // The QR is a pairing secret; only expose it while it is actually needed.
      qr: awaiting ? whatsapp.qr : null,
      /*
       * How old the code is and how long one lives, so the panel can run a countdown and
       * swap in the next image the moment Baileys rotates. Both are needed: the panel polls
       * on its own schedule and would otherwise be guessing at both ends.
       */
      qrAgeMs: awaiting ? (whatsapp.qrAgeMs ?? null) : null,
      qrLifetimeMs: QR_LIFETIME_MS,
    });
  });

  /* ---- config ---- */

  router.get('/config', admin, (_req, res) => {
    const config = context.config.current;
    res.json({
      ...config,
      // Never leak secrets to the browser, even over the LAN.
      system: { ...config.system, adminPasswordHash: undefined },
      wifi: { ssid: config.wifi.ssid, password: config.wifi.password.length > 0 ? '••••' : '' },
    });
  });

  router.put('/config', admin, async (req: Request, res: Response) => {
    const parsed = configUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid configuration',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    try {
      const updated = await context.config.update(parsed.data);
      // Tell the client before going down, so it can show "restarting" and reconnect.
      res.json({ ok: true, version: updated.version, restarting: true });
      context.requestRestart('configuration saved');
    } catch (error: unknown) {
      if (error instanceof ConfigValidationError) {
        res.status(400).json({ error: error.message, issues: error.issues });
        return;
      }
      res.status(500).json({ error: 'failed to save configuration' });
    }
  });

  /**
   * Completes onboarding: sets the admin password and marks the device configured.
   * Only usable while unconfigured, so it cannot be used to reset a live device.
   */
  router.post('/onboard', async (req: Request, res: Response) => {
    if (context.config.current.system.configured) {
      res.status(409).json({ error: 'device is already configured' });
      return;
    }

    const password = readString(req.body, 'password');
    if (password === null) {
      res.status(400).json({ error: 'password is required' });
      return;
    }

    try {
      const adminPasswordHash = await hashAdminPassword(password);
      await context.config.update({ system: { adminPasswordHash, configured: true } });
      res.json({ ok: true, restarting: true });
      context.requestRestart('onboarding completed');
    } catch (error: unknown) {
      res.status(400).json({ error: error instanceof Error ? error.message : 'onboarding failed' });
    }
  });

  /* ---- setup portal ---- */

  /**
   * Open while the device is being set up, admin-gated the rest of the time.
   *
   * Setup has two shapes, not one: a device that has never been configured, and a configured
   * device that has lost its network and is offering the hotspot as a way back in. In both,
   * the portal needs to work before any password has been typed. On a home network, with no
   * hotspot up, there is no reason for anyone to be asking.
   */
  const duringSetup: RequestHandler = (req, res, next) => {
    const unconfigured = !context.config.current.system.configured;
    if (unconfigured || context.netState()?.apActive === true) {
      next();
      return;
    }
    void admin(req, res, next);
  };

  /**
   * Networks the device can see, for the portal's picker.
   *
   * It names the networks around the family's home, which is why it is not simply public —
   * though anyone standing close enough to join the hotspot is already seeing that list on
   * their own phone.
   */
  router.get('/wifi/scan', duringSetup, (_req, res) => {
    const state = context.netState();
    if (state === null) {
      // No agent, which on a dev machine is normal. An empty list plus a flag beats a 500:
      // the portal can offer the manual entry box instead of looking broken.
      res.json({ available: false, networks: [], ageSeconds: null, apActive: false });
      return;
    }
    res.json({
      available: state.available,
      networks: state.scan,
      ageSeconds: state.scanAgeSeconds,
      apActive: state.apActive,
      apSsid: state.apSsid,
      lastError: state.lastError,
    });
  });

  /**
   * Joins a network, and on an unconfigured device completes onboarding in the same call.
   *
   * One call rather than two because of what happens next: accepting these credentials tears
   * the hotspot down, and the page that posted them dies with it. A second request would
   * never arrive.
   *
   * `admin` stands aside while unconfigured (see auth.ts), which is exactly the first-boot
   * case. Afterwards it is enforced **even over the hotspot**, and deliberately: a configured
   * device that lost its router will offer a hotspot to whoever is in range, and without the
   * password that would be an invitation to move somebody else's device onto your network.
   * The portal collects the settings password for this case and sends it as Basic auth.
   */
  router.post('/wifi/join', admin, async (req: Request, res: Response) => {
    const ssid = readString(req.body, 'ssid', 32);
    if (ssid === null) {
      res.status(400).json({ error: 'ssid is required' });
      return;
    }

    // Optional and empty-able: an open network has no passphrase, so "" is a real answer and
    // readString's non-empty rule is the wrong one here.
    const rawPsk = readField(req.body, 'psk');
    const psk = typeof rawPsk === 'string' ? rawPsk : '';
    if (psk.length > 63) {
      res.status(400).json({ error: 'passphrase is too long' });
      return;
    }
    if (psk.length > 0 && psk.length < 8) {
      // WPA2's own minimum. Rejecting it here turns a silent association failure a parent
      // cannot diagnose into a message on the page they are looking at.
      res.status(400).json({ error: 'a Wi-Fi passphrase is at least 8 characters' });
      return;
    }

    const configured = context.config.current.system.configured;
    const adminPassword = readString(req.body, 'adminPassword', 128);
    if (!configured && adminPassword === null) {
      res.status(400).json({ error: 'an admin password is required to finish setup' });
      return;
    }

    try {
      // Persisted first. The agent joins the network live, but the profile it builds is not
      // the record: config.json is, and wifi-apply.sh reapplies it on every boot.
      const update = configured
        ? { wifi: { ssid, password: psk } }
        : {
            wifi: { ssid, password: psk },
            system: {
              adminPasswordHash: await hashAdminPassword(adminPassword ?? ''),
              configured: true,
            },
          };
      await context.config.update(update);

      const asked = await context.requestJoin({ ssid, psk });

      // Answered before anything happens to the radio, because the answer cannot survive it.
      res.json({ ok: true, ssid, handedToAgent: asked, restarting: true });

      // The restart applies the saved config the ordinary way. The request file lives in the
      // runtime directory, which systemd preserves across it, so a join in flight is not lost.
      context.requestRestart('wifi credentials accepted');
    } catch (error: unknown) {
      if (error instanceof ConfigValidationError) {
        res.status(400).json({ error: error.message, issues: error.issues });
        return;
      }
      res.status(400).json({ error: error instanceof Error ? error.message : 'could not join' });
    }
  });

  /* ---- device actions ---- */

  /**
   * Plays the boot cue through the speaker, so the amplifier settings can be judged by ear.
   *
   * Awaited rather than fire-and-forget: the point of the button is to answer "did that
   * change anything", and a 200 that arrives before the sound does invites a second press on
   * top of the first. A failure here is a real one — unlike a cue during an interaction, this
   * request has nothing else to report.
   */
  router.post('/audio/test', admin, async (_req: Request, res: Response) => {
    try {
      await context.controller.playTestCue();
      res.json({ played: true });
    } catch (error: unknown) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'could not play the test sound',
      });
    }
  });

  router.post('/silent', admin, (req: Request, res: Response) => {
    const desired = readBoolean(req.body, 'silent');
    if (desired === null) {
      context.controller.state.toggleSilent();
    } else {
      context.controller.state.setManualSilent(desired);
    }
    res.json({ silentMode: context.controller.state.silentMode });
  });

  /**
   * The pairing QR as a scannable SVG.
   *
   * The raw payload is a long string; WhatsApp's "Link a device" flow scans an image, so
   * rendering it here is what makes pairing possible at all. Admin-gated because whoever scans
   * it becomes the account this device speaks as.
   */
  router.get('/whatsapp/qr.svg', admin, async (_req, res) => {
    const { state, qr } = context.whatsapp();
    if (state !== 'awaitingPairing' || qr === null) {
      res.status(404).json({ error: 'no pairing code is pending' });
      return;
    }
    try {
      /*
       * margin 4 is the quiet zone the QR spec requires; scanners can fail to lock on
       * without it. errorCorrectionLevel M tolerates a little screen glare and moire.
       *
       * The colours are stated rather than left to default because this SVG inherits nothing
       * from the page: a dark-mode panel that let the "light" modules go transparent would
       * render a white-on-dark code, which many phone scanners refuse outright.
       */
      const svg = await qrToString(qr, {
        type: 'svg',
        margin: 4,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000ff', light: '#ffffffff' },
      });
      res.type('image/svg+xml').set('cache-control', 'no-store').send(svg);
    } catch {
      res.status(500).json({ error: 'could not render the pairing code' });
    }
  });

  /** Phone-number pairing: returns a code to type into WhatsApp instead of scanning. */
  router.post('/whatsapp/pair', admin, async (req: Request, res: Response) => {
    const phone = readString(req.body, 'phone');
    if (phone === null) {
      res.status(400).json({ error: 'a phone number is required' });
      return;
    }
    const result = await context.requestPairingCode(phone);
    if (result.code === undefined) {
      res.status(409).json({ error: result.error ?? 'pairing failed' });
      return;
    }
    res.json({ code: result.code });
  });

  /**
   * Groups available as button targets.
   *
   * Behind the admin gate: the list names the family's group chats, which is not something to
   * hand out to anything that can reach port 3000.
   */
  router.get('/whatsapp/groups', admin, async (_req, res) => {
    res.json({ groups: await context.listGroups() });
  });

  router.post('/whatsapp/unlink', admin, (_req, res) => {
    context.unlinkWhatsApp();
    res.json({ ok: true });
  });

  /** Opens the socket for a first-time link — the trigger for choosing a method in the panel. */
  router.post('/whatsapp/link', admin, (_req, res) => {
    context.beginLinking();
    res.json({ ok: true });
  });

  router.post('/factory-reset', admin, async (_req, res) => {
    try {
      await context.config.factoryReset();
      res.json({ ok: true, restarting: true });
      context.requestRestart('factory reset');
    } catch {
      res.status(500).json({ error: 'factory reset failed' });
    }
  });

  /* ---- diagnostics ---- */

  router.get('/contacts', admin, (_req, res) => {
    res.json({
      contacts: enabledContacts(context.config.current).map(({ key, index, contact }) => ({
        key,
        index,
        name: contact.name,
        unread: context.controller.state.unreadCount(index),
      })),
    });
  });

  router.get('/cues', (_req, res) => {
    res.json({ cues: ALL_AUDIO_CUES });
  });

  return router;
}

/**
 * Serves recorded audio to the simulator.
 *
 * Filenames are taken from the request, so `basename` plus a prefix check keeps a crafted
 * path from escaping the recordings directory.
 */
export function createAudioRouter(recordingDirectory: string): Router {
  const router = Router();
  const root = resolve(recordingDirectory);

  router.get('/:name', (req, res) => {
    const name = basename(req.params.name);
    const path = resolve(root, name);

    if (!path.startsWith(`${root}/`)) {
      res.status(400).json({ error: 'invalid path' });
      return;
    }

    res.sendFile(path, (error: unknown) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'not found' });
    });
  });

  return router;
}
