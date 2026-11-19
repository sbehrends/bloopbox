# Hardware bring-up

Getting bloopbox onto a new Raspberry Pi gate by gate, the record of what has already passed, and
the debugging kit for when something does not work.

One board has passed every gate: the **reference board**, a Pi 3B+ with the WM8960 HAT, three
buttons and three lamps ([`hardware.md`](./hardware.md) describes it). For now it is the official,
verified hardware, and the one board releases are built for. The **Pi Zero 2 W** is a later target
and has run none of this; the gates below are written so that it can follow them.

**Bring one thing up at a time.** Every gap here can produce "the lights do nothing", and
debugging two unproven subsystems at once turns a morning into a week.

---

## What the reference board has proven

Bench session of **2026-09-30**, from a freshly flashed `--audio-hat wm8960` card: onboarded through
the setup hotspot, WhatsApp linked, button 3 assigned to a group. The full record is in the commits
that closed it, `f0df8c5` and `efd9872`.

Repeated on **2026-10-02** with a `1.0.0-rc.1` card (`9e78d0f`): flash and first boot, hotspot
onboarding onto home Wi-Fi, the admin password, WhatsApp linking, hold-to-send and tap-to-play on
the blue button (the only one assigned), and a note from an unassigned number never reaching the
box. Doctor fully green with `f1d9981`.

**A Raspberry Pi 4 Model B (1 GB)** was confirmed working on **2026-11-19**. Which gates it was
taken through was not recorded; until it is, the table below is the 3B+'s alone, and the Pi 4 is
the next board to walk through it.

| Gate | What passed |
| ---- | ----------- |
| 0 — image | The flashed image boots, and the first-boot ssh password is made before sshd starts, shows in the admin panel, and logs in |
| 1 — install | `bloopbox-doctor` green — fully since 2026-10-02, when its two mic-boost false failures were fixed. Restart policy, OOM scores and the journal drop-ins exactly as specified |
| 2 — network agent | `timeSynced: true` within a minute of getting online |
| 3 — hotspot | Onboarding through the hotspot and portal from a phone. First closed end to end on 2026-08-10, from a blank image |
| 4a — audio | Both directions through the real path: a ~5 s hold arrives as a ~4 s note, a short hold is refused with the "oops", and a received note plays. A second arrival or **Test speaker** mid-note does not cut in over it |
| 5 — buttons and lamps | All three buttons; all three lamps at the default polarity, yellow / coral / teal left to right, through every pattern the session reached; the lockout; the silent chord both ways |
| 6 — WhatsApp | Linking; a send to the group on button 3; a note from a number nobody assigned is dropped (2026-10-02) |

Two findings were fixed the same day and confirmed on the box:

- **The switches bounce hard** — up to 12 edges within 15 ms. Now settled in the HAL
  ([`hardware.md`](./hardware.md) § GPIO has the measurement). After the fix a 3 s hold settled as one
  down and one up 2904 ms apart, and three taps as three presses.
- **A button with no contact recorded anyway**, then failed in the bridge. It now refuses at
  `recordThresholdMs` without opening the microphone (`PRODUCT.md` § A button with no contact).

## What is still to prove

**On the Pi Zero 2 W, when it becomes a target: everything.** Work through every gate below. Three
differences from the 3B+ matter:

- **No ethernet.** Wi-Fi is the only way in, so an outage that does not restore itself means walking
  over with a card reader.
- **512 MB of RAM.** The units' `MemoryHigh`/`MemoryMax` are estimates, and their maxima add up to
  more than the board has (`PENDING.md`). Debug mode's sampler is what measures them, and only once
  the memory cgroup is really on.
- **A sealed enclosure.** Throttling is a real risk, and only the sampler will show it.

**Still open on the reference board:**

- Gate 1: six settings saves in a row, to see the restart backoff reach its 5 s cap.
- Gate 2: the deliberate radio outage — not part of the 2026-09-30 record — and a restart from
  the admin panel, which goes through the root agent's sandbox.
- Gate 4a: all eight of its open questions, starting with the note's counted duration against
  `ffprobe`.
- Gate 6: everything in its list except linking, a group send and the unassigned-number drop.
- The capture and helper-process hardening, which has only run against fake child processes
  (`PENDING.md` has the list).
- That card's ssh password was pasted into a chat during the session. Rotate it once a rotation
  action exists (`PENDING.md`).

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

On a card flashed from the image, the password for `ssh-copy-id` is the one the admin panel shows
under **Advanced → Device health → SSH access**.

If that last command asks for a password, add a sudoers drop-in on the device:

```bash
echo 'bloop ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/010-bloopbox-bringup
```

Delete `/etc/sudoers.d/010-bloopbox-bringup` when bring-up is over. It is a bring-up
convenience on a device in your house, not something to leave on.

Then tell me the hostname and I will work from here. If `bloopbox.local` does not resolve from
this machine (mDNS across VLANs is unreliable), give me the IP instead.

If you would rather not open ssh to me: run the steps yourself and send me the diagnostics
bundle from each gate. It is designed for exactly that — see the debugging kit below.

---

## Gate 0 — a Pi you can reach

There are two ways onto a card, and for a board that has never run bloopbox the first is the safer:

- **The stock image, then the tarball (gates 0 and 1 as written).** If a card does not boot, it is
  not ours. This is the route for the Zero 2 W's first card.
- **A flashed bloopbox image** (`build-sd-image.sh --audio-hat wm8960`, see
  [`deployment.md`](./deployment.md)). Proven on the reference board on 2026-09-30. It boots with
  everything installed, so it skips gate 1's install; onboard through the hotspot (gate 3), then
  ssh in with the password the admin panel shows. Use it once the board is known to boot, and never
  pass `--no-leds` to it for a board with lamps.

For the stock route:

1. Raspberry Pi Imager → **Raspberry Pi OS Lite (64-bit)**, which must be **Trixie** (see
   [`deployment.md`](./deployment.md) for why nothing older can work).
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

Install with the board's profile **on the first run**. `--audio-hat` writes the HAT's ALSA settings
into `/etc/bloopbox/environment`, and that file is written once and kept by every later install — so
a plain install followed by `--audio-hat wm8960` gets the overlay but not the ALSA settings.

```bash
npm run release                                        # on this machine
scp release/bloopbox-*-linux-arm64.tar.gz bloop@bloopbox.local:
ssh bloop@bloopbox.local 'tar xzf bloopbox-*-linux-arm64.tar.gz && sudo ./bloopbox-*-linux-arm64/install.sh --audio-hat wm8960'
ssh bloop@bloopbox.local 'sudo reboot'
```

The reboot is not optional: the GPIO pull-ups, the HAT's overlay and the memory cgroup all live in
the boot partition. The buttons read garbage and there is no sound card until it has happened.

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-doctor'
```

**Pass:** the runtime, the opengpio addon, ffmpeg's Opus encoder, `/data`, the tmpfs, the cues,
all three services active, the firmware pull-ups present, and `nmcli` + dnsmasq installed.

The mic-boost entries read as levels, `routing: … Input Boost Mixer LINPUT1  3`. A card built before
2026-10-02 instead fails them as `…INPUT1=3 not a switch on this card`: that was doctor unable to read
a `Name=Value` entry, not the stage, which was set correctly all along.

If something fails with a permission error rather than wrong behaviour, comment out the
hardening block in `deploy/systemd/bloopbox-hardware.service` before suspecting the code —
`ProtectSystem=strict` and friends have only run against the 3B+'s GPIO and the WM8960 so far.

Then the restart and OOM policy:

```bash
ssh bloop@bloopbox.local 'systemctl show bloopbox-hardware bloopbox-whatsapp bloopbox-net \
  -p Id -p StartLimitIntervalUSec -p RestartSteps -p RestartMaxDelayUSec -p NRestarts'
ssh bloop@bloopbox.local 'for p in $(pgrep -f dist/processes); do echo "$(cat /proc/$p/oom_score_adj) $(tr "\0" " " < /proc/$p/cmdline)"; done'
```

**Pass:** `StartLimitIntervalUSec=0` on all three; `RestartSteps` 5/5/3 and
`RestartMaxDelayUSec` 5s/1min/15s; `oom_score_adj` `-500` for `hardware-server.js` and `300` for
`whatsapp-bridge.js`. Then save any setting six times in a row from the admin panel: the unit
must come back every time (`NRestarts` climbs, the state never reads `failed`), and from the
sixth save on it should take about 5 s longer to return than the first — that is the backoff cap,
and the counter only resets at boot.

And the journal settings:

```bash
ssh bloop@bloopbox.local 'systemd-analyze cat-config systemd/journald.conf | grep -E "^# /|^Storage|^RuntimeMaxUse"'
```

**Pass:** `50-bloopbox.conf` is listed with `Storage=volatile` and `RuntimeMaxUse=8M`, and — once
`bloopbox-debug on` has run — `90-bloopbox-debug.conf` after it with `Storage=persistent`. Pi OS
ships `/usr/lib/systemd/journald.conf.d/40-rpi-volatile-storage.conf`, which sorts before both, so
it is expected in the list. A vendor drop-in sorting **after** `90-` would silently override debug
mode's persistent journal.

---

## Gate 2 — the network agent

It needs no wiring, no speaker and no WhatsApp account, and everything below depends on it. Prove it
before anything physical.

```bash
ssh bloop@bloopbox.local 'cat /run/bloopbox-net/net-state.json; echo; systemctl is-active bloopbox-net'
```

**Pass:** a JSON document with `"available":true`, `"online":true`, your SSID, and an
`updatedAtMs` within the last few seconds. Read it twice — the timestamp must move. It should also
carry `"timeSynced":true` within a minute or so of the box getting online; `false` right after boot
is normal. `null` for longer than that means the agent cannot reach `timedatectl` from inside its
sandbox; check that `bloopbox-doctor`'s "time sync service" line names `systemd-timesyncd`.

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

**Pass:** **all three LEDs go solid** within a few seconds — the Wi-Fi error pattern — and they go
out again when the radio comes back. Once you are back in:

```bash
ssh bloop@bloopbox.local 'journalctl -u bloopbox-hardware --since -3min | grep "wifi state"'
```

**Pass:** one `wifi state changed` line with `"down":true` and one with `"down":false`. Two lines, not twenty: the
daemon reports transitions, not polls.

**Watch for:** the LEDs staying dark. That means the daemon still thinks Wi-Fi is fine, which
means it is not reading the file — check that the `bloopbox` user can read
`/run/bloopbox-net/net-state.json` (`bloopbox-doctor` checks this explicitly).

Last, the one action the agent takes for the panel that is not a network one: **Advanced → Device
health → Restart the box**. The agent runs `systemctl reboot` from inside its own sandbox
(`NoNewPrivileges=yes`, `ProtectSystem=strict`), which has never been tried on a device.

**Pass:** the box reboots and is back in about a minute, with the boot chase on the lamps.

---

## Gate 3 — the setup hotspot

The one that needs a phone in the room. `mode ap` + `ipv4.method shared` on the Pi's `brcmfmac`
radio works on the 3B+; the Zero 2 W has a different radio chip and has not been tried.

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

The web server is **stopped** during the default run, so nothing answers on `10.42.0.1` — the
script stops the daemon so its supervisor cannot step the hotspot aside mid-test.

### Gate 3b — the portal, which is the part a parent actually sees

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-hotspot-test --keep-daemon --seconds 50'
```

Join the hotspot from a phone and **wait**. The setup page should appear **by itself**, in the
notification-style webview the OS opens for captive networks. That is the whole mechanism
working: wildcard DNS sends every lookup to the device, the device answers the phone's
connectivity probe wrongly on purpose, and the OS concludes there is a sign-in page.

Pass, in order of how much each one tells you:

1. The page appears **unprompted**. If it does not, open `http://10.42.0.1` by hand — if that
   works, the fault is DNS (`dnsmasq-shared.d`), not the portal.
2. It lists networks in range with signal bars, your own among them.
3. Picking a secured one asks for a passphrase; picking an open one does not.
4. On an unconfigured device it also asks for a settings password, and refuses to submit until
   it is at least 6 characters.

Do not complete the join on this run unless you mean it — accepting credentials writes the
config, marks the device configured and restarts it.

Keep the window under ~55s: on a **configured** device the supervisor steps aside at 60s to retry
your Wi-Fi, which is correct behaviour and would cut the test short. An unconfigured device never
steps aside, which is the real first-boot case and gives you as long as you like.

If the page does not appear on its own, check first that NetworkManager has the wildcard DNS file:

```bash
ssh bloop@bloopbox.local 'ls -la /etc/NetworkManager/dnsmasq-shared.d/'
```

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

That last one would be a code change, not a configuration one: a settle delay in the agent's
`ap_down`.

**Do not leave a device you cannot reach in AP mode.** The restore runs from an EXIT trap, so a
crash still ends with the radio back on your network — but if you ever do get stuck, the way
back is physical: pull the card and write `bloopbox-wifi.txt` on the boot partition
(`ssid=` / `psk=` / `country=`), which wins over everything on the next boot.

---

## Gate 4a — audio on the WM8960 HAT

The HAT is the selected audio hardware. [`hardware.md`](./hardware.md) has what it occupies and why
each setting is what it is. Gate 1 already installed with `--audio-hat wm8960` and rebooted; **there
is no sound card until that reboot**, because the overlay is firmware.

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-audio-test'
```

It walks the chain in the order that makes a failure readable: card present → codec answering at
`0x1a` on i2c-1 → the mixer has the controls the environment names (`Playback` and `Capture` on this
HAT) → a real product cue out of the speaker → five seconds of you, with a live level meter → that
recording played back. Each step names its own failure, and the last section lists what to try.

If the card never appears, the split is: **nothing at `0x1a`** means the HAT is not seated or I²C is
off; **`0x1a` answers but no card** means the overlay did not load — check `dmesg | tail -40` and
that `dtoverlay=wm8960-soundcard` really is in `config.txt`. If the speaker is silent while
everything reads healthy, check `systemctl status bloopbox-audio-init`: the DAC starts wired to
nothing, and that unit is what connects it.

Then through the product: hold a button, speak, release, and tap to play it back once a note has
come in. `journalctl -u bloopbox-hardware -f` shows the take and the send.

**Pass:** the note arrives on the phone and is audible; a received note plays back cleanly.

Questions this gate is the first chance to answer, all open on the reference board too:

1. **Does the note's length match?** Compare what the device counts (`sentMs` in the activity
   totals) with `ffprobe` on the capture. The daemon derives the duration from the WAV size, which assumes a canonical 44-byte
   header.
2. **Is `CAPTURE_RATE=48000` still needed?** No cue overlaps a capture any more — the bip finishes
   before the microphone opens. If 16 kHz records cleanly, it removes a resample and shrinks the
   intermediate WAV. The symptom of getting it wrong is capture dying or recording silence, so change
   it deliberately.
3. **Does the device record itself?** Speaker and microphone are centimetres apart. Neither the bip
   nor the whoosh should be audible in a message: the bip plays before capture opens and
   `#commitCapture` finalises before the whoosh. **If either is in there, the ordering is not doing
   what it claims** — look at `#beginCapture`'s awaited `playCue` and the ALSA stream lingering after
   `aplay` exits. The inbound chime can still land in a recording, since a note can arrive while a
   child is talking; that one is accepted.
4. **How long ALSA takes to open a capture stream.** It sits directly in front of the child's first
   word. `PENDING.md` has the watch item.
5. **The bip on a tap.** A press over 150 ms bips and opens a microphone before turning out to be a
   tap. Confirm the queue still starts promptly afterwards — `#playQueue` waits for the capture to be
   torn down first, on purpose.
6. **How the designed cues sound.** `boot` and `notify` are mastered from recordings, matched to the
   beeps by peak amplitude — the honest measure, but not the one ears use. Power-cycle the board and
   listen to `boot`, then send and receive one note each, and compare both against `pop` and `oops`
   for loudness. Their levels are one `peak` value each in `scripts/generate-sounds.ts`; the tone
   gains are the ones to leave alone. `PENDING.md` has the specific things to listen for.
7. **Does `dtparam=audio=off` do anything?** `aplay -l` should list the WM8960 alone. If the Pi's
   own headphone output is there too, the line is not doing what its comment says (`PENDING.md`).
   Harmless while ALSA is addressed by card name, but worth knowing.
8. **Is the HAT's own button real?** `gpiomon gpiochip0 17` and press it: falling then rising. Stop
   `bloopbox-hardware` first, since it holds the line.

### A USB adapter instead of the HAT

Not the selected part, and never run against a real adapter. Install without `--audio-hat`, then:

```bash
ssh bloop@bloopbox.local 'arecord -l; aplay -l; amixer scontrols'
```

The mixer control name is the trap: it differs across USB adapters (`PCM`, `Speaker`, `Master`),
and a wrong one means the configured volume is silently ignored — playback at whatever the adapter
booted at, in a child's room. Set `ALSA_MIXER_CONTROL` and `ALSA_CAPTURE_MIXER_CONTROL` to what
`amixer scontrols` actually prints, then prove the volume moves:

```bash
ssh bloop@bloopbox.local 'amixer sget PCM'   # before and after a volume change in the admin panel
```

---

## Gate 5 — buttons and lamps

GPIO 17, 27, 22 for the buttons, pulled up in firmware; the 3 V lamps straight off GPIO 23, 24, 25,
one leg on the pin and one on ground. [`hardware.md`](./hardware.md) has the wiring and the reason
the pull-ups come from `config.txt` rather than from the library. If nothing lights or presses read
backwards, the suspects are in `deploy/environment.example`, each a one-line change on the device
followed by `sudo systemctl restart bloopbox-hardware`:

```bash
ssh bloop@bloopbox.local 'sudo nano /etc/bloopbox/environment'
#   LED_ACTIVE_HIGH=false     # if a lamp went to 3V3 rather than ground
#   BUTTON_ACTIVE_LOW=false   # if the switches went to 3V3 rather than ground
#   BUTTON_SETTLE_MS=40       # if one press registers as two
#   PI_BOARD=…                # if pin names resolve to the wrong lines
```

Watch the presses arrive while you make them — with debug mode on, every settled edge is a `button`
line:

```bash
ssh bloop@bloopbox.local 'journalctl -u bloopbox-hardware -f'
```

**Pass:**

- Each button gives exactly one down and one up per press — no doubles, nothing unpaired. A 3 s
  hold settles as one down and one up about 3 s apart.
- A hold lights that button solid and, on release, plays the whoosh; a tap with nothing waiting
  gives the "oops" double-beep.
- A hold on a button with no contact gives the "oops" at the bip moment, with no bip before it.
- While one button records, the others do nothing.
- Button 1 + button 3 held together for three seconds toggles silent mode with a left-to-right
  chase.
- The lamps are yellow / coral / teal left to right, matching the caps.

**Worth an ammeter here:** the lamps draw from the header itself, and the margin against its budget
depends on which lamps are fitted. Dim lamps, a lamp that dims when its neighbours light, or a
brownout under a marginal supply all point here first.

**Worth timing here rather than guessing:** the tap-vs-hold threshold. Everything in
`config.buttons` is editable from the admin panel precisely so you can find the right feel with
a toddler present instead of rebuilding.

---

## Gate 6 — WhatsApp

Open the admin panel, link the phone that will own the pairing, and then check the things
`PENDING.md` flags as unproven:

- a voice note **from a number nobody assigned** is dropped (it must not appear, and the bridge
  logs `dropped a voice note`) — the negative case, which is the one the safety boundary exists for
- a note in an assigned **group** arrives on that button **when a third party sends it**, not only
  the account that owns the device
- a sent note appears as a proper **PTT bubble**, not a file attachment, and plays
- **the phone-number path**, not just the QR: unlink, choose "link with my phone number" in the
  panel, and confirm a code arrives and completes the pairing. Also switch between the two methods
  a couple of times — that sequence is what the pairing-race fix in `PENDING.md` addresses, and it
  has not been reverified on hardware.
- **read receipts across a bridge restart**: with a note waiting, `sudo systemctl restart
  bloopbox-whatsapp`, then play the note; the sender must get both ticks
- **the device does not talk to WhatsApp before you tell it to.** On a factory-reset device
  (`journalctl -u bloopbox-whatsapp -f` open), boot it and confirm `GET /api/whatsapp` reads
  `notLinked` with no Baileys log lines at all, until you click a method in the panel. Then unlink
  a paired account and confirm it settles back into `notLinked` — no fresh QR appears on its own —
  and stays there until you click a method again.

---

## The debugging kit

Five commands, all installed on PATH by `install.sh`:

| Command                      | What it is for                                                   |
| ---------------------------- | ----------------------------------------------------------------- |
| `sudo bloopbox-doctor`       | Is everything present and running? Run it at every gate.          |
| `sudo bloopbox-debug on`     | Record enough to reconstruct what happened. Turn it on *first*.   |
| `sudo bloopbox-diagnostics`  | Bundle the whole picture into one file to send somewhere.         |
| `sudo bloopbox-hotspot-test` | Raise the hotspot on purpose, hold it, restore. Gate 3.           |
| `sudo bloopbox-audio-test`   | Speaker out, microphone in, played back. Gate 4a.                 |

**When the box answers "oops" or does nothing, look here first:**

```bash
journalctl -u bloopbox-hardware -b | grep 'device fault'
```

Every failure the daemon swallows so the next press still works is logged there with a `fault`
field — `capture-start` (the microphone would not open), `capture-finalise` (the take could not be
encoded), `capture-empty` (a take with no audio, with its `durationMs`), `capture-cancel`, `send`,
`playback` (with the note's `path`), `cue` (with its name) or `delete` — plus the button and the
error. A panel action that fails logs under `mod: "routes"` with the route it came from.

`bloopbox-audio-test` opens the same card the daemon does, so **stop the services first** if a
recording could be in progress. It reads the devices out of `/etc/bloopbox/environment` rather than
using ALSA's default, which is the point: it tests what the daemon will open.

### Debug mode — turn this on before gate 1

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-debug on'          # 24h, then it turns itself off
ssh bloop@bloopbox.local 'sudo bloopbox-debug on --hours 4'
ssh bloop@bloopbox.local 'sudo bloopbox-debug status'
```

Three things, none of them on by default:

1. **A persistent journal.** This is the important one. The journal normally lives in RAM, so
   **every log line is lost on reboot** — including the ones that explain the reboot. During
   bring-up that is exactly backwards. Capped at 128 MB so it cannot fill the card. If a device is
   doing something inexplicable on boot and you cannot reach it to turn this on first, that run's
   evidence is gone.
2. **`LOG_LEVEL=debug` on both daemons.** That turns on a full state timeline — every
   observable change, so the LED behaviour can be replayed line by line afterwards — and **every
   settled button edge**, before the interpreter decides tap or hold. A press the interpreter
   discards leaves no other trace, and "I pressed it and nothing happened" is the report you will
   actually get. Contact chatter itself is absorbed in the HAL and not logged.
3. **A sampler**, every 10s, one JSON line per sample into `/var/log/bloopbox/trace.jsonl`:
   memory for each unit, temperature, throttling, the network reading, the device's own
   status, how many recordings are in the RAM disk.

The sampler is what answers the questions the journal cannot. `MemoryHigh`/`MemoryMax` in the
units are estimates (`PENDING.md` says so) — this measures them. Throttling in a sealed toy
enclosure is a real risk on a Zero 2 W, and nothing else would tell you. And across a hotspot
cycle it gives a minute-by-minute record of what the radio was doing.

**Check this before trusting any of those numbers:** `grep -o cgroup_enable=memory /proc/cmdline`.
Raspberry Pi's firmware disables the memory cgroup controller on its own, outside `cmdline.txt`, so
the file looks fine while the running kernel has it off — and then `MemoryHigh`/`MemoryMax` are not
enforced at all. Found on the reference board on 2026-08-10. `install.sh` appends
`cgroup_enable=memory cgroup_memory=1`, but it takes a reboot to apply, so check `/proc/cmdline`
after one rather than assuming.

```bash
# What the device thought it was doing, over time
jq -r '[.ts, .status.state, .net.ssid // "-", .memHardware] | @tsv' /var/log/bloopbox/trace.jsonl

# Peak memory of the hardware daemon, in MB — against MemoryMax=192M
jq -s 'map(.memHardware // 0) | max / 1048576' /var/log/bloopbox/trace.jsonl
```

It expires on its own because it writes to the SD card, and `bloopbox-doctor` warns while it is
on. Turning it **off keeps everything collected** — reading it is the point — and only
`sudo bloopbox-debug off --purge` deletes the history and puts the journal back in RAM.

Collect it before purging: `bloopbox-diagnostics` picks up the trace (last 4000 samples) and the
previous boot's journal automatically.

The diagnostics bundle is the one to reach for when something is wrong and the answer is not
obvious. It collects the doctor's output, the units' status and journals, every `nmcli` view, the
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
| All three, 0.5s on / 0.5s off             | Connecting — joining Wi-Fi or the WhatsApp socket |
| All three **double-pulse** every 2s       | Setup hotspot is up                              |
| All three **solid**                       | Wi-Fi is down and no hotspot                     |
| LEDs 1 and 2 solid                        | Wi-Fi fine, WhatsApp unlinked or awaiting a scan |
| One button solid                          | Recording on that button                         |
| One button, three fast flashes            | Sent                                             |
| One button blinking 0.8s                  | Unread voice note on that contact                |
| One slow pass left to right, 0.5s a step  | Silent mode toggled                              |
| All off                                   | Ready and idle                                   |

A device that boots straight to all-three-solid is telling you the network agent reports no
network — go back to gate 2.
