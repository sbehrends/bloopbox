# Hardware bring-up

Getting bloopbox onto a real Raspberry Pi for the first time, and finding out which of the
never-run-on-hardware parts actually work.

Everything in `PENDING.md` under "Verification gaps" is unproven: the GPIO driver, the ALSA
paths, the setup hotspot, WhatsApp end to end. This is the order to prove them in, and the split
between what a person has to do standing next to the device and what can be done over ssh.

**Bring one thing up at a time.** Every gap here can produce "the lights do nothing", and
debugging two unverified subsystems at once turns a morning into a week.

---

## Who does what

| Step                                       | Who      | Why                                              |
| ------------------------------------------ | -------- | ------------------------------------------------ |
| Flash the card, wire the buttons, power on | you      | physical                                         |
| Get the Pi onto the Wi-Fi the first time   | you      | chicken-and-egg: no network, no ssh              |
| Install the release, read logs, fix code   | either   | all over ssh once the device is reachable        |
| Look at the LEDs, press the buttons        | you      | nothing else can see them                        |
| Join the hotspot from a phone              | you      | needs a second radio in the room                 |
| Speak into the microphone, listen          | you      | same                                             |
| Scan the WhatsApp QR                       | you      | it is your account                               |

### If you want me driving it over ssh

I can run anything from this machine, so long as it reaches the Pi and needs no interactive
prompt — **I cannot type a password**, not into ssh and not into sudo. Set up:

```bash
ssh-keygen -t ed25519 -C bloopbox            # if you have no key
ssh-copy-id bloop@bloopbox.local             # once, with a password, by you
ssh bloop@bloopbox.local 'sudo -n true'      # must print nothing, not a password prompt
```

If that last command asks for a password, add a sudoers drop-in on the device:

```bash
echo 'bloop ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/010-bloopbox-bringup
```

Delete `/etc/sudoers.d/010-bloopbox-bringup` when bring-up is over. It is a bring-up
convenience on a device in your house, not something to leave on.

Then tell me the hostname and I will work from here. If `bloopbox.local` does not resolve from
this machine (mDNS across VLANs is unreliable), give me the IP instead.

If you would rather not open ssh to me: run the steps yourself and send me the diagnostics
bundle from each gate. It is designed for exactly that — see the bottom of this page.

---

## Gate 0 — a Pi you can reach

**Do not use `npm run release:image` for the first device.** The SD image builder has itself
never run against real hardware; if the card does not boot you will not know whether the fault
is the image, the install, or the app. Use the stock image for the first one and prove the
builder later, against a device you already trust.

1. Raspberry Pi Imager → **Raspberry Pi OS Lite (64-bit)**, which must be **Trixie** (see
   `docs/deployment.md` for why nothing older can work).
2. In the Imager's settings (the gear): hostname `bloopbox`, user **`bloop`**, your Wi-Fi
   with the right country, and **enable ssh with your public key**.

   The user must be `bloop`, not `bloopbox`: `install.sh` creates a system account called
   `bloopbox` for the daemons, and it cannot collide with your login account.

3. Boot it, then from this machine:

```bash
ssh bloop@bloopbox.local 'uname -a; cat /etc/os-release | head -2'
```

**Pass:** it answers, and says trixie.

---

## Gate 1 — the app installed and answering

```bash
npm run release                                        # on this machine
scp release/bloopbox-*-linux-arm64.tar.gz bloop@bloopbox.local:
ssh bloop@bloopbox.local 'tar xzf bloopbox-*-linux-arm64.tar.gz && sudo ./bloopbox-*-linux-arm64/install.sh'
```

The install reboots nothing but does need one: the GPIO pull-ups it writes into
`/boot/firmware/config.txt` only take effect after `sudo reboot`. Do that now — the buttons
will read garbage until you do.

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-doctor'
```

**Pass:** the runtime, the opengpio addon, ffmpeg's Opus encoder, `/data`, the tmpfs, the cues,
all three services active, the firmware pull-ups present, and `nmcli` + dnsmasq installed.

**Expect to fail here:** the audio devices, if nothing is plugged in yet. That is fine for now.

If something fails with a permission error rather than wrong behaviour, comment out the
hardening block in `deploy/systemd/bloopbox-hardware.service` before suspecting the code —
`ProtectSystem=strict` and friends have never run against real GPIO or ALSA either.

---

## Gate 2 — the network agent (new, and the foundation for everything below)

This is the first thing the recent work touches, and it needs no wiring, no speaker and no
WhatsApp account. Prove it before anything physical.

```bash
ssh bloop@bloopbox.local 'cat /run/bloopbox-net/net-state.json; echo; systemctl is-active bloopbox-net'
```

**Pass:** a JSON document with `"available":true`, `"online":true`, your SSID, and an
`updatedAtMs` within the last few seconds. Read it twice — the timestamp must move.

Then make the device lose the network and watch it notice. This kills your ssh session — one
radio — so the outage has to restore **itself**, or you will be walking over to the device with a
card reader:

```bash
ssh bloop@bloopbox.local \
  'sudo setsid nohup sh -c "nmcli radio wifi off; sleep 60; nmcli radio wifi on" >/tmp/blip.log 2>&1 &'
```

The session drops within a second or two. Watch the lights for the next minute, then reconnect.

Never run `nmcli radio wifi off` on its own over ssh. There is no ethernet on a Pi Zero 2 W and
no second way in; the only recovery is the boot partition.

**Pass:** **all three LEDs go solid** within a few seconds — the Wi-Fi Error pattern, which has
never been reachable on a real device before this work — and they go out again when the radio
comes back. Once you are back in:

```bash
ssh bloop@bloopbox.local 'journalctl -u bloopbox-hardware --since -3min | grep "wifi state"'
```

**Pass:** one `wifi state changed down=true` and one `down=false`. Two lines, not twenty: the
daemon reports transitions, not polls.

**Watch for:** the LEDs staying dark. That means the daemon still thinks Wi-Fi is fine, which
means it is not reading the file — check that the `bloopbox` user can read
`/run/bloopbox-net/net-state.json` (`bloopbox-doctor` checks this explicitly).

---

## Gate 3 — the setup hotspot

The one that needs a phone in the room, and the one most likely to fail: `mode ap` +
`ipv4.method shared` on `brcmfmac` is the least-verified line of the whole product.

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-hotspot-test'
```

**It will drop your ssh session on purpose** — one radio, and becoming an access point means
leaving your network. The script detaches itself first, so the test survives the disconnect.
Then, with a phone:

1. Look for an open network named `bloopbox-XXXX` (the last four of the Pi's serial).
2. Join it. You should get a `10.42.0.x` address with no passphrase.
3. The LEDs should be **double-pulsing** in unison: on-off-on, then dark for most of two
   seconds. Distinct from the Connecting blink, which is a steady half-second square wave.
4. After the window closes the device rejoins your Wi-Fi by itself.

The web server is **stopped** during the default run, so nothing answers on `10.42.0.1:3000` —
the script stops the daemon so its supervisor cannot step the hotspot aside mid-test. To prove
the whole stack from a phone instead, run it again with the daemon left up:

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-hotspot-test --keep-daemon --seconds 50'
```

Then `http://10.42.0.1:3000/admin/` should answer over the hotspot. Keep that window under ~55s:
on a configured device the supervisor steps aside at 60s to retry your Wi-Fi, which is correct
behaviour and would cut the test short. (An unconfigured device never steps aside — nothing to
rejoin — which is the real first-boot case.)

The captive-portal page, the one that pops up by itself, is milestone 3 and **is not built yet**.
Nothing appearing on its own is not a fault.

Reconnect and read the verdict:

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-hotspot-test --status'
```

The log grades itself: whether the interface reached AP mode, whether the shared-mode address
came up, whether dnsmasq handed out a lease, and whether the rejoin worked.

Known suspects if it fails:

| Symptom                              | First thing to check                                             |
| ------------------------------------ | ---------------------------------------------------------------- |
| interface type is not `AP`           | `journalctl -u NetworkManager -n 50` — the profile did not activate |
| no `10.42.0.1`                       | `dpkg -l dnsmasq-base` — shared mode needs it                    |
| AP up but the phone gets no address  | same, plus `/var/lib/NetworkManager/dnsmasq-wlan0.leases`        |
| AP will not start at all             | `iw reg get` — an unset Wi-Fi country can refuse the channel      |
| never rejoins afterwards             | the radio may need longer between teardown and the join attempt   |

That last one is a real possibility and would be a code change, not a configuration one: tell me
and I will put a settle delay in `ap_down`.

**Do not leave a device you cannot reach in AP mode.** The restore runs from an EXIT trap, so a
crash still ends with the radio back on your network — but if you ever do get stuck, the way
back is physical: pull the card and write `bloopbox-wifi.txt` on the boot partition
(`ssid=` / `psk=` / `country=`), which wins over everything on the next boot.

---

## Gate 4 — buttons and LEDs

Now the wiring. `src/hal/gpioDriver.ts` was written from datasheets and has never run.

GPIO 17, 27, 22 for the buttons, pulled up in firmware; the LEDs through the ULN2003. If
nothing lights, the first two suspects are both in `deploy/environment.example`, and both are
one-line changes on the device followed by `sudo systemctl restart bloopbox-hardware`:

```bash
ssh bloop@bloopbox.local 'sudo nano /etc/bloopbox/environment'
#   LED_ACTIVE_HIGH=false     # the ULN2003 inverts; try both
#   BUTTON_ACTIVE_LOW=false   # pull-ups mean a press reads low; try both
```

Watch the presses arrive while you make them:

```bash
ssh bloop@bloopbox.local 'journalctl -u bloopbox-hardware -f'
```

**Pass:** a hold lights that button solid and, on release, plays the whoosh; a tap with nothing
waiting gives the "oops" double-beep. Button 1 + button 3 held together for three seconds
toggles silent mode with a left-to-right chase.

**Worth timing here rather than guessing:** the tap-vs-hold threshold. Everything in
`config.buttons` is editable from the admin panel precisely so you can find the right feel with
a toddler present instead of rebuilding.

---

## Gate 5 — audio

```bash
ssh bloop@bloopbox.local 'arecord -l; aplay -l; amixer scontrols'
```

The mixer control name is the trap: it differs across USB adapters (`PCM`, `Speaker`, `Master`),
and a wrong one means the volume cap is silently ignored — playback at whatever the adapter
booted at, in a child's room. Set `ALSA_MIXER_CONTROL` to what `amixer scontrols` actually
prints, then prove it moves:

```bash
ssh bloop@bloopbox.local 'amixer sget PCM'   # before and after a volume change in the admin panel
```

Then record and play through the real path: hold a button, speak, release, and check a `.ogg`
lands in `/run/bloopbox`.

---

## Gate 6 — WhatsApp

Open the admin panel, scan the QR with the phone that will own the pairing, and then check the
things `PENDING.md` flags as unproven:

- a voice note **from a number nobody assigned** is dropped (it must not appear, and the bridge
  logs `dropped a voice note`)
- a note in an assigned **group** arrives on that button whoever sent it
- a sent note appears as a proper **PTT bubble**, not a file attachment, and plays

---

## The debugging kit

Three commands, all installed on PATH by `install.sh`:

| Command                      | What it is for                                                   |
| ---------------------------- | ----------------------------------------------------------------- |
| `sudo bloopbox-doctor`       | Is everything present and running? Run it at every gate.          |
| `sudo bloopbox-diagnostics`  | Bundle the whole picture into one file to send somewhere.         |
| `sudo bloopbox-hotspot-test` | Raise the hotspot on purpose, hold it, restore. Gate 3.           |

The diagnostics bundle is the one to reach for when something is wrong and the answer is not
obvious. It collects the doctor's output, all four units' journals, every `nmcli` view, the
published network reading, the ALSA and GPIO inventory, memory and tmpfs usage, and the config —
**with the Wi-Fi passphrase, the admin password hash and the phone numbers replaced**, because a
diagnostics bundle is the sort of thing that ends up pasted into a chat window. It never touches
`/data/auth_info`: those are live WhatsApp credentials.

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-diagnostics'
scp bloop@bloopbox.local:/tmp/bloopbox-diagnostics-*.tar.gz .
```

Send me that file — or, if I have ssh, I will collect it myself. Either way it is what turns
"the lights do nothing" into a fix.

### Reading the LEDs

The whole UI, when there is no screen. Full table in `PRODUCT.md` §6; the ones that matter
during bring-up:

| Pattern                                   | Means                                            |
| ----------------------------------------- | ------------------------------------------------ |
| Chase left to right, 0.2s a step          | Booting (2.6s, held on purpose so it is visible) |
| All three, 0.5s on / 0.5s off             | Connecting — Wi-Fi up, WhatsApp not linked yet   |
| All three **double-pulse** every 2s       | Setup hotspot is up                              |
| All three **solid**                       | Wi-Fi is down and no hotspot                     |
| LEDs 1 and 2 solid                        | Wi-Fi fine, WhatsApp unlinked or awaiting a scan |
| One button blinking 0.8s                  | Unread voice note on that contact                |
| All off                                   | Ready and idle                                   |

A device that boots straight to all-three-solid is telling you the network agent reports no
network — go back to gate 2.
