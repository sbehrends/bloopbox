import { Router, type Request, type Response } from 'express';
import { basename, resolve } from 'node:path';
import { ALL_AUDIO_CUES } from '../audio/cues.ts';
import { ConfigValidationError, type ConfigManager } from '../config/configManager.ts';
import { configUpdateSchema, enabledContacts } from '../config/schema.ts';
import type { DeviceController } from '../core/deviceController.ts';
import type { DeviceStatusPayload, WhatsAppConnectionState } from '../ipc/events.ts';
import { readBoolean, readString } from '../ipc/payload.ts';
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
  /** Latest WhatsApp state, owned by the process layer. */
  readonly whatsapp: () => { state: WhatsAppConnectionState; qr: string | null };
  /** Whether Wi-Fi is currently up. */
  readonly wifiConnected: () => boolean;
  /** Drops WhatsApp credentials so the device can be re-paired. */
  readonly unlinkWhatsApp: () => void;
  /** Groups the linked account is in, so a parent can pick one instead of typing a JID. */
  readonly listGroups: () => Promise<{ id: string; subject: string }[]>;
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
    res.json({
      state: whatsapp.state,
      // The QR is a pairing secret; only expose it while it is actually needed.
      qr: whatsapp.state === 'awaitingPairing' ? whatsapp.qr : null,
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

  /* ---- device actions ---- */

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
