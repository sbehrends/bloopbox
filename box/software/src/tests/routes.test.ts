import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AudioCue } from '../audio/cues.ts';
import { QR_LIFETIME_MS } from '../ipc/events.ts';
import { readField, readString } from '../ipc/payload.ts';
import { startApi, type Harness } from './support/apiHarness.ts';

/**
 * `/api`, the only mutable surface on the device.
 *
 * The cases here are the ones with a consequence a parent would meet: a secret leaking into
 * the browser, a save that silently does not apply, a join that never reaches the agent, and
 * the audio route being asked for a file outside the recordings directory. Guard behaviour
 * lives in `adminAuth.test.ts`; most harnesses below are unconfigured so the guard stands
 * aside and no bcrypt work is done.
 */

let api: Harness | null = null;

afterEach(async () => {
  await api?.close();
  api = null;
});

/**
 * Waits for something a route deferred until after its response.
 *
 * A condition rather than a fixed number of yields: the factory reset awaits a real promise
 * before restarting, and a fixed flush passes in isolation and fails under parallel load.
 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** POST/PUT JSON to a path. */
async function send(harness: Harness, method: string, path: string, body: unknown) {
  return fetch(harness.url(path), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /status', () => {
  it('reports the fields the two UIs actually render', async () => {
    api = await startApi({ configured: false });
    const response = await fetch(api.url('/api/status'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: 'READY',
      silentMode: false,
      whatsappConnected: true,
      wifiConnected: true,
      configured: false,
      unreadCounts: [0, 0, 0],
      driver: 'mock',
    });
  });
});

describe('GET /whatsapp', () => {
  it('withholds the QR unless pairing is actually pending', async () => {
    // The QR is a pairing secret: whoever scans it owns the account this device speaks as,
    // and this endpoint is deliberately open so the portal can read the state.
    api = await startApi({ configured: false });
    api.whatsapp = { state: 'connected', qr: 'secret-payload' };
    expect(await (await fetch(api.url('/api/whatsapp'))).json()).toEqual({
      state: 'connected',
      qr: null,
      qrAgeMs: null,
      qrLifetimeMs: QR_LIFETIME_MS,
    });
  });

  it('hands over the QR while pairing is pending', async () => {
    api = await startApi({ configured: false });
    api.whatsapp = { state: 'awaitingPairing', qr: 'secret-payload', qrAgeMs: 3_000 };
    expect(await (await fetch(api.url('/api/whatsapp'))).json()).toEqual({
      state: 'awaitingPairing',
      qr: 'secret-payload',
      qrAgeMs: 3_000,
      qrLifetimeMs: QR_LIFETIME_MS,
    });
  });

  it('reports the age of the code, so the panel can count down without a shared clock', async () => {
    // The panel shows "expires in Ns". A timestamp would need the browser's clock to agree
    // with the device's; an age does not, and this device has no RTC.
    api = await startApi({ configured: false });
    api.whatsapp = { state: 'awaitingPairing', qr: 'secret-payload', qrAgeMs: 19_000 };
    const body: unknown = await (await fetch(api.url('/api/whatsapp'))).json();
    const age = readField(body, 'qrAgeMs');
    const lifetime = readField(body, 'qrLifetimeMs');
    expect(typeof age === 'number' && typeof lifetime === 'number' ? lifetime - age : null).toBe(
      1_000,
    );
  });
});

describe('GET /config', () => {
  it('never sends the password hash or the Wi-Fi passphrase to the browser', async () => {
    api = await startApi({ configured: false });
    await api.config.update({ wifi: { ssid: 'Home', password: 'super-secret-psk' } });

    const body: unknown = await (await fetch(api.url('/api/config'))).json();
    const text = JSON.stringify(body);
    expect(text).not.toContain('super-secret-psk');
    expect(text).not.toContain('adminPasswordHash');
    expect(body).toMatchObject({ wifi: { ssid: 'Home', password: '••••' } });
  });

  it('reports an empty passphrase as empty rather than as dots', async () => {
    // The panel decides whether to show "unchanged" as a placeholder from this.
    api = await startApi({ configured: false });
    const body: unknown = await (await fetch(api.url('/api/config'))).json();
    expect(body).toMatchObject({ wifi: { password: '' } });
  });
});

describe('PUT /config', () => {
  it('saves a valid patch and asks for the restart that applies it', async () => {
    // Config is snapshot at boot, so a save that does not restart is a save that does nothing.
    api = await startApi({ configured: false });
    const response = await send(api, 'PUT', '/api/config', {
      audio: { ...api.config.current.audio, speakerVolumePercent: 55 },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, restarting: true });
    expect(api.config.current.audio.speakerVolumePercent).toBe(55);
    expect(api.restarts).toEqual(['configuration saved']);
  });

  it('rejects an invalid patch with the field that was wrong', async () => {
    // The panel prints these straight through, so they are the only explanation a parent gets.
    api = await startApi({ configured: false });
    const response = await send(api, 'PUT', '/api/config', {
      audio: { ...api.config.current.audio, speakerVolumePercent: 500 },
    });

    expect(response.status).toBe(400);
    const body: unknown = await response.json();
    expect(readString(body, 'error')).toBe('invalid configuration');
    expect(JSON.stringify(readField(body, 'issues'))).toContain('audio.speakerVolumePercent');
    expect(api.restarts).toEqual([]);
  });

  it('rejects a debounce at or above the record threshold', async () => {
    // Without a gap there is no tap, so playing a received message becomes impossible — the
    // schema refuses it and this is the route that has to surface that.
    api = await startApi({ configured: false });
    const response = await send(api, 'PUT', '/api/config', {
      buttons: { ...api.config.current.buttons, debounceMs: 600, recordThresholdMs: 500 },
    });
    expect(response.status).toBe(400);
    expect(api.restarts).toEqual([]);
  });

  it('takes a patch of any depth, and leaves the fields it did not mention alone', async () => {
    /*
     * Uniform by design: every section takes a subset. It used to be uneven, and a form that
     * sent one timing got a 400 listing everything it forgot.
     *
     * The assertion that matters is the second half. `mergeConfig` merges field by field, so a
     * one-field patch must not blank its siblings — a patch of the volume that reset the mic
     * gain would leave every recording silent, with nothing in the response to say so.
     */
    api = await startApi({ configured: false });
    await send(api, 'PUT', '/api/config', {
      audio: {
        speakerVolumePercent: 40,
        micGainPercent: 50,
        maxRecordingSeconds: 30,
      },
    });

    const response = await send(api, 'PUT', '/api/config', {
      audio: { speakerVolumePercent: 55 },
    });
    expect(response.status).toBe(200);
    expect(api.config.current.audio).toEqual({
      speakerVolumePercent: 55,
      // Untouched by the patch, and filled in from the schema defaults by the first PUT.
      ampVolumePercent: 100,
      ampBoostDc: 5,
      ampBoostAc: 5,
      micGainPercent: 50,
      maxRecordingSeconds: 30,
    });
  });

  it('patches one field of one contact without disturbing the others', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'PUT', '/api/config', {
      contacts: { button1: { name: 'Mamá' } },
    });

    expect(response.status).toBe(200);
    expect(api.config.current.contacts.button1).toEqual({
      name: 'Mamá',
      target: '15551234567',
      enabled: true,
    });
    expect(api.config.current.contacts.button2.name).toBe('Dad');
  });

  it('still migrates the legacy phone field inside a patch', async () => {
    // Devices in the field have a config.json using `phone`, and a client written against that
    // shape may still be sending it. The preprocess has to survive being made partial.
    api = await startApi({ configured: false });
    const response = await send(api, 'PUT', '/api/config', {
      contacts: { button2: { phone: '15550000000' } },
    });

    expect(response.status).toBe(200);
    expect(api.config.current.contacts.button2).toMatchObject({
      name: 'Dad',
      target: '15550000000',
    });
  });

  it('still enforces a cross-field rule the patch cannot see on its own', async () => {
    /*
     * The point of validating the *merged* config rather than the patch. A patch that only
     * flips `enabled` carries no target to compare against, so the rule can only be checked
     * after the merge — and it is, in ConfigManager.save(). Losing this would leave a button
     * lit and assigned to nobody, which on a screenless device is undiagnosable.
     */
    api = await startApi({ configured: false });
    await send(api, 'PUT', '/api/config', {
      contacts: { button3: { name: 'Grandma', target: '', enabled: false } },
    });

    const response = await send(api, 'PUT', '/api/config', {
      contacts: { button3: { enabled: true } },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('target');
    expect(api.config.current.contacts.button3.enabled).toBe(false);
  });

  it('rejects a lone debounce that would swallow the threshold', async () => {
    // Same shape of rule, on the timings: the stored threshold is 150, so 600 alone is invalid
    // even though nothing in the patch says so.
    api = await startApi({ configured: false });
    const response = await send(api, 'PUT', '/api/config', { buttons: { debounceMs: 600 } });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('recordThresholdMs');
    expect(api.config.current.buttons.debounceMs).toBe(60);
  });

  it('will not enable a button that has nobody behind it', async () => {
    // The third button is unassigned in the harness. Enabling it with a one-field patch has to
    // fail on the merged config, or a button would light up and send into the void — and this
    // is the rule closest to the whitelist, which is the product's safety boundary.
    api = await startApi({ configured: false });
    const response = await send(api, 'PUT', '/api/config', {
      contacts: { button3: { enabled: true } },
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('phone number or group');
    expect(api.config.current.contacts.button3.enabled).toBe(false);
  });

  it('accepts an empty patch as a no-op save', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'PUT', '/api/config', {});
    expect(response.status).toBe(200);
    expect(api.restarts).toEqual(['configuration saved']);
  });

  it('does not restart when nothing could be saved', async () => {
    api = await startApi({ configured: false });
    await send(api, 'PUT', '/api/config', { contacts: { button1: { target: 'not a number' } } });
    expect(api.restarts).toEqual([]);
  });
});

describe('POST /onboard', () => {
  it('sets the password, marks the device configured and restarts', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/onboard', { password: 'a good password' });

    expect(response.status).toBe(200);
    expect(api.config.current.system.configured).toBe(true);
    expect(api.config.current.system.adminPasswordHash).toMatch(/^\$2[aby]\$/);
    expect(api.restarts).toEqual(['onboarding completed']);
  });

  it('requires a password', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/onboard', {});
    expect(response.status).toBe(400);
    expect(api.config.current.system.configured).toBe(false);
  });

  it('refuses a password too short to be worth having', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/onboard', { password: '12345' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/at least 6/) });
    // The important half: a rejected password must not leave the device marked configured,
    // or onboarding becomes impossible and the panel is locked with no password to type.
    expect(api.config.current.system.configured).toBe(false);
  });
});

describe('POST /wifi/join', () => {
  it('persists the credentials, hands them to the agent and restarts', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/wifi/join', {
      ssid: 'Casa',
      psk: 'a-good-passphrase',
      adminPassword: 'a good password',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ssid: 'Casa', handedToAgent: true });
    // Persisted first: the profile the agent builds is not the record, config.json is.
    expect(api.config.current.wifi).toMatchObject({ ssid: 'Casa', password: 'a-good-passphrase' });
    expect(api.joins).toEqual([{ ssid: 'Casa', psk: 'a-good-passphrase' }]);
    expect(api.restarts).toEqual(['wifi credentials accepted']);
  });

  it('finishes onboarding in the same call', async () => {
    // One call rather than two, because accepting these tears down the hotspot the page came
    // over — a second request would never arrive.
    api = await startApi({ configured: false });
    await send(api, 'POST', '/api/wifi/join', {
      ssid: 'Casa',
      psk: 'a-good-passphrase',
      adminPassword: 'a good password',
    });
    expect(api.config.current.system.configured).toBe(true);
    expect(api.config.current.system.adminPasswordHash).toMatch(/^\$2[aby]\$/);
  });

  it('will not finish setup without an admin password', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/wifi/join', { ssid: 'Casa', psk: 'psk12345' });
    expect(response.status).toBe(400);
    expect(api.joins).toEqual([]);
  });

  it('accepts an open network, where an empty passphrase is a real answer', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/wifi/join', {
      ssid: 'Cafe Wifi',
      psk: '',
      adminPassword: 'a good password',
    });
    expect(response.status).toBe(200);
    expect(api.joins).toEqual([{ ssid: 'Cafe Wifi', psk: '' }]);
  });

  it('rejects a passphrase WPA2 itself would reject', async () => {
    // Caught here so a parent reads it on the page, instead of watching the box fail to
    // associate with no way to tell why.
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/wifi/join', {
      ssid: 'Casa',
      psk: 'short',
      adminPassword: 'a good password',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/8 characters/) });
    expect(api.joins).toEqual([]);
  });

  it('rejects a passphrase over 63 characters', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/wifi/join', {
      ssid: 'Casa',
      psk: 'x'.repeat(64),
      adminPassword: 'a good password',
    });
    expect(response.status).toBe(400);
    expect(api.joins).toEqual([]);
  });

  it('requires an ssid', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/wifi/join', { psk: 'psk12345' });
    expect(response.status).toBe(400);
    expect(api.joins).toEqual([]);
  });

  it('still answers when the agent could not be reached', async () => {
    // The page has to be told something; the credentials are saved either way and
    // wifi-apply.sh reapplies them on the next boot.
    api = await startApi({ configured: false });
    api.joinAccepted = false;
    const response = await send(api, 'POST', '/api/wifi/join', {
      ssid: 'Casa',
      psk: 'a-good-passphrase',
      adminPassword: 'a good password',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ handedToAgent: false });
  });
});

describe('POST /audio/test', () => {
  it('plays the boot cue so the speaker can be judged by ear', async () => {
    api = await startApi({ configured: false });

    const response = await send(api, 'POST', '/api/audio/test', {});

    expect(response.status).toBe(200);
    expect(api.hal.cueSequence()).toEqual([AudioCue.Boot]);
  });

  it('plays it even in silent mode', async () => {
    /*
     * The one cue that ignores the silent gate, and the reason the route exists. Someone
     * tuning the amplifier is standing at the box asking a direct question; answering it with
     * silence because quiet hours started an hour ago is worse than not having the button.
     */
    api = await startApi({ configured: false });
    await send(api, 'POST', '/api/silent', { silent: true });

    await send(api, 'POST', '/api/audio/test', {});

    expect(api.hal.cueSequence()).toEqual([AudioCue.Boot]);
  });

  it('reports a speaker that cannot play, rather than claiming success', async () => {
    api = await startApi({ configured: false });
    api.hal.failPlayback = true;

    const response = await send(api, 'POST', '/api/audio/test', {});

    expect(response.status).toBe(500);
  });
});

describe('POST /silent', () => {
  it('toggles when asked for nothing in particular', async () => {
    api = await startApi({ configured: false });
    expect(await (await send(api, 'POST', '/api/silent', {})).json()).toEqual({ silentMode: true });
    expect(await (await send(api, 'POST', '/api/silent', {})).json()).toEqual({
      silentMode: false,
    });
  });

  it('sets an explicit state, and setting it twice is not a toggle', async () => {
    api = await startApi({ configured: false });
    await send(api, 'POST', '/api/silent', { silent: true });
    const second = await send(api, 'POST', '/api/silent', { silent: true });
    expect(await second.json()).toEqual({ silentMode: true });
  });

  it('ignores a non-boolean and falls back to toggling', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/silent', { silent: 'yes please' });
    expect(await response.json()).toEqual({ silentMode: true });
  });
});

describe('WhatsApp pairing routes', () => {
  it('renders the QR as a scannable SVG while pairing', async () => {
    api = await startApi({ configured: false });
    api.whatsapp = { state: 'awaitingPairing', qr: '2@abcdef,ghijkl,==' };
    const response = await fetch(api.url('/api/whatsapp/qr.svg'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    // Never cached: a stale code is unscannable and looks like a broken device.
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toContain('<svg');
  });

  it('404s when no code is pending, rather than rendering an empty image', async () => {
    api = await startApi({ configured: false });
    api.whatsapp = { state: 'connected', qr: null };
    expect((await fetch(api.url('/api/whatsapp/qr.svg'))).status).toBe(404);
  });

  it('returns a pairing code', async () => {
    api = await startApi({ configured: false });
    api.pairing = { code: 'ABCD-EFGH' };
    const response = await send(api, 'POST', '/api/whatsapp/pair', { phone: '15551234567' });
    expect(await response.json()).toEqual({ code: 'ABCD-EFGH' });
  });

  it('passes the bridge failure through instead of inventing one', async () => {
    api = await startApi({ configured: false });
    api.pairing = { error: 'not connected' };
    const response = await send(api, 'POST', '/api/whatsapp/pair', { phone: '15551234567' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not connected' });
  });

  it('requires a phone number', async () => {
    api = await startApi({ configured: false });
    const response = await send(api, 'POST', '/api/whatsapp/pair', {});
    expect(response.status).toBe(400);
  });

  it('lists the groups the account is in', async () => {
    api = await startApi({ configured: false });
    api.groups = [{ id: '123@g.us', subject: 'Familia' }];
    expect(await (await fetch(api.url('/api/whatsapp/groups'))).json()).toEqual({
      groups: [{ id: '123@g.us', subject: 'Familia' }],
    });
  });

  it('unlinks', async () => {
    api = await startApi({ configured: false });
    await send(api, 'POST', '/api/whatsapp/unlink', {});
    expect(api.unlinks.count).toBe(1);
  });

  it('begins linking', async () => {
    api = await startApi({ configured: false });
    await send(api, 'POST', '/api/whatsapp/link', {});
    expect(api.beginLinkings.count).toBe(1);
  });
});

describe('POST /factory-reset', () => {
  it('drops the config back to the template and restarts', async () => {
    api = await startApi({ configured: false });
    await api.config.update({
      contacts: { button1: { name: 'Mom', target: '15551234567', enabled: true } },
    });

    const response = await send(api, 'POST', '/api/factory-reset', {});
    expect(response.status).toBe(200);
    expect(api.config.current.system.configured).toBe(false);
    expect(api.config.current.contacts.button1.target).toBe('');
    // The restart is deferred behind the forget, so it lands after the response rather than
    // with it — see the route. Everything else above is already true by the time we get here.
    await waitFor(() => api?.restarts.length === 1, 'the deferred restart');
    expect(api.restarts).toEqual(['factory reset']);
  });

  /*
   * The three places a device remembers who it belongs to. A reset that clears the config but
   * leaves either of the other two hands over a box that is still logged into the previous
   * owner's WhatsApp, or still sitting on their network with no hotspot to re-onboard through.
   */
  it('also unlinks WhatsApp and forgets the network, so the hotspot can come back', async () => {
    api = await startApi({ configured: true, adminPassword: 'hunter2' });

    const response = await fetch(api.url('/api/factory-reset'), {
      method: 'POST',
      headers: { authorization: api.basic('hunter2') },
    });

    expect(response.status).toBe(200);
    expect(api.unlinks.count).toBe(1);
    await waitFor(() => api?.forgets.count === 1, 'the network to be forgotten');
    await waitFor(() => api?.restarts.length === 1, 'the deferred restart');
  });

  it('restarts even when the network agent cannot be reached', async () => {
    // A dev machine has no agent at all, and a device that cannot forget its network is still
    // reset in every other respect — the reset must not be abandoned half-done.
    api = await startApi({ configured: false });
    api.forgetSucceeds = false;

    await send(api, 'POST', '/api/factory-reset', {});

    await waitFor(() => api?.restarts.length === 1, 'the restart despite the failed forget');
    expect(api.restarts).toEqual(['factory reset']);
  });
});

describe('GET /contacts', () => {
  it('lists only the enabled buttons, with their unread counts', async () => {
    // The third button in the harness is disabled: an unassigned button is not a contact, and
    // the diagnostics view should not imply it is one.
    api = await startApi({ configured: false });
    const body: unknown = await (await fetch(api.url('/api/contacts'))).json();
    expect(readField(body, 'contacts')).toEqual([
      { key: 'button1', index: 0, name: 'Mom', unread: 0 },
      { key: 'button2', index: 1, name: 'Dad', unread: 0 },
    ]);
  });
});

describe('GET /cues', () => {
  it('names every cue, so the simulator can preload them', async () => {
    api = await startApi({ configured: false });
    const cues = readField(await (await fetch(api.url('/api/cues'))).json(), 'cues');
    expect(cues).toContain('notify');
    expect(Array.isArray(cues) ? cues.length : 0).toBeGreaterThan(3);
  });
});

describe('/audio', () => {
  it('serves a recording', async () => {
    api = await startApi({ configured: false });
    await mkdir(api.recordingDirectory, { recursive: true });
    await writeFile(join(api.recordingDirectory, 'note.ogg'), 'audio-bytes', 'utf8');

    const response = await fetch(api.url('/audio/note.ogg'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('audio-bytes');
  });

  it('404s for a recording that has been purged', async () => {
    api = await startApi({ configured: false });
    await mkdir(api.recordingDirectory, { recursive: true });
    expect((await fetch(api.url('/audio/gone.ogg'))).status).toBe(404);
  });

  it('cannot be walked out of the recordings directory', async () => {
    // The filename comes from the request. `basename` plus the prefix check is what stops
    // `/audio/..%2f..%2fdata/config.json` from reading the admin password hash.
    api = await startApi({ configured: false });
    await mkdir(api.recordingDirectory, { recursive: true });

    const attempts = [
      '/audio/..%2f..%2fconfig.json',
      '/audio/%2e%2e%2f%2e%2e%2fconfig.json',
      '/audio/....%2f%2e%2e%2fetc%2fpasswd',
      '/audio/%2fetc%2fpasswd',
    ];
    const results = await Promise.all(
      attempts.map(async (path) => {
        const response = await fetch(api?.url(path) ?? '');
        const text = await response.text();
        return [path, response.status, text.includes('adminPasswordHash')];
      }),
    );
    // Whatever the status, the one thing that must never happen is a file from outside.
    expect(results.map(([path, , leaked]) => [path, leaked])).toEqual(
      attempts.map((path) => [path, false]),
    );
    expect(results.every(([, status]) => status === 400 || status === 404)).toBe(true);
  });
});
