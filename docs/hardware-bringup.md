# Hardware bring-up

Getting bloopbox onto a real Raspberry Pi for the first time, and finding out which of the
never-run-on-hardware parts actually work.

Everything in `PENDING.md` under "Verification gaps" is unproven: the GPIO driver, the ALSA
paths, the setup hotspot, WhatsApp end to end. This is the order to prove them in, and the split
between what a person has to do standing next to the device and what can be done over ssh.

**Bring one thing up at a time.** Every gap here can produce "the lights do nothing", and
debugging two unverified subsystems at once turns a morning into a week.

**Audio is the WM8960 HAT** (decided 2026-08-17), so gate 4a replaces gate 4 on every board. Take
gate 5 as written once the lamps are wired — the reference board has all three buttons and all three
lamps. On a bare HAT with nothing else wired, gate 4a alone gets you to gate 6: the HAT's own button
sits on GPIO17, which is already button 1. [`hardware.md`](./hardware.md) describes the board.

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

**Prefer the stock image for a new device.** A `release:image` card has booted on the 3B+
(2026-08-10), but the `--audio-hat wm8960 --no-leds` variant and the per-device ssh password never
have, and if a card does not boot you will not know whether the fault is the image, the install, or
the app. Prove a new image against a device you already trust, on a spare card.

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
`ProtectSystem=strict` and friends have only run against the 3B+'s GPIO and the WM8960 so far.

Then the restart and OOM policy (added 2026-09-24; checked with `systemd-analyze verify` on
Debian's systemd 257.13 in a container, never on the device):

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

And the journal settings (also 2026-09-24):

```bash
ssh bloop@bloopbox.local 'systemd-analyze cat-config systemd/journald.conf | grep -E "^# /|^Storage|^RuntimeMaxUse"'
```

**Pass:** `50-bloopbox.conf` is listed with `Storage=volatile` and `RuntimeMaxUse=8M`, and — once
`bloopbox-debug on` has run — `90-bloopbox-debug.conf` after it with `Storage=persistent`. Note
whether any vendor drop-in appears (Pi OS has been said to ship one; nobody has looked on Trixie).
If one sorts **after** `90-`, debug mode's persistent journal is silently overridden and has been all
along, and the names need moving again.

---

## Gate 2 — the network agent (new, and the foundation for everything below)

This is the first thing the recent work touches, and it needs no wiring, no speaker and no
WhatsApp account. Prove it before anything physical.

```bash
ssh bloop@bloopbox.local 'cat /run/bloopbox-net/net-state.json; echo; systemctl is-active bloopbox-net'
```

**Pass:** a JSON document with `"available":true`, `"online":true`, your SSID, and an
`updatedAtMs` within the last few seconds. Read it twice — the timestamp must move. It should also
carry `"timeSynced":true` within a minute or so of the box getting online; `false` right after boot
is normal. `null` for longer than that means the agent cannot reach `timedatectl` from inside its
sandbox — never observed either way yet, so note which you see, and check that `bloopbox-doctor`'s
"time sync service" line names `systemd-timesyncd`.

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

If the page does not appear on its own, the first thing to check is whether NetworkManager read
the wildcard DNS file at all:

```bash
ssh bloop@bloopbox.local 'ls -la /etc/NetworkManager/dnsmasq-shared.d/'
```

That directory is the one assumption in this design nobody has verified on Trixie. If it is
ignored, the fallback is `hostapd` + `dnsmasq` with `wlan0` unmanaged — a bigger change, and one
worth making only once this has actually been seen to fail.

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

## Gate 4a — audio on the WM8960 HAT

**This replaces gate 4**: the HAT is the audio hardware from 2026-08-17 on, not the USB
speakerphone. Continue to gate 5 for the lamps once they are wired; on a bare HAT with nothing else
attached, jump straight to gate 6 and drive channel 1 with the HAT's own button.
[`hardware.md`](./hardware.md) has what the HAT occupies and why each setting is what it is.

Install and reboot. **There is no sound card until the reboot** — the overlay is firmware:

```bash
sudo ./install.sh --audio-hat wm8960
sudo reboot
```

Add `--no-leds` only if no lamps are wired yet, which also means skipping gate 5.

Then, in the order that makes a failure readable:

```bash
ssh bloop@bloopbox.local 'sudo bloopbox-audio-test'
```

It walks the chain: card present → codec answering at `0x1a` on i2c-1 → the mixer has `Master` and
`Capture` → a real product cue out of the speaker → five seconds of you, with a live level meter →
that recording played back. Each step names its own failure, and the last section lists what to try.

If the card never appears, the split is: **nothing at `0x1a`** means the HAT is not seated or I²C is
off; **`0x1a` answers but no card** means the overlay did not load — check `dmesg | tail -40` and
that `dtoverlay=wm8960-soundcard` really is in `config.txt`.

Then the button, which needs no wiring at all — the HAT's own is on GPIO17, already button 1:

```bash
ssh bloop@bloopbox.local 'gpiomon gpiochip0 17'      # press it: falling then rising
ssh bloop@bloopbox.local 'journalctl -u bloopbox-hardware -f'
```

**Pass:** holding the HAT's button records and sends a voice note to contact 1; tapping it plays back
what arrived. Nothing lights up, and that is expected — with `LED_PINS=` empty the driver claims no
output lines and the audio cues carry all the feedback.

**The four claims this gate is really testing**, none of which we could verify from documentation
(see `PENDING.md`):

1. P17 is a populated switch, not just a broken-out pin.
2. The card is called `wm8960soundcard`, so the `plughw:CARD=…` names in the environment resolve. If
   not, `aplay -L` prints the truth and it is a one-line fix.
3. `Master` / `Capture` are the mixer control names. If the mic records silence at a plausible level,
   the WM8960's input **boost** switches are the next suspect: `amixer contents` shows them, and their
   names vary by kernel.
4. `CAPTURE_RATE=48000` is set, and **may no longer be needed** — the only cue that overlapped a
   capture was the bip, and since 2026-08-17 it finishes before the microphone opens. Worth testing
   both here: if 16 kHz records cleanly, it removes a resample and shrinks the intermediate WAV. The
   symptom of getting it wrong is capture dying or recording silence, so change it deliberately.

Also worth checking, because the speaker and the microphone are on the same small board this time:
whether the device records itself. Neither the bip nor the whoosh should now be audible in a message —
the bip plays before capture opens and `#commitCapture` finalises before the whoosh. **If either is
in there, the ordering is not doing what it claims** and the place to look is `#beginCapture`'s awaited
`playCue` and the ALSA stream lingering after `aplay` exits. The inbound chime can still land in a
recording, since a note can arrive while a child is talking; that one is accepted.

Two more things this gate is the first chance to measure:

- **How long ALSA takes to open a capture stream.** It sits directly in front of the child's first
  word now. `PENDING.md` has the watch item.
- **The bip on a tap.** A press over 150 ms bips and opens a microphone before turning out to be a
  tap. Confirm the queue still starts promptly afterwards — `#playQueue` waits for the capture to be
  torn down first, on purpose.

**And this is the first chance to actually hear the designed cues.** `boot` and `notify` are mastered
from recordings rather than synthesised, matched to the beeps by peak amplitude —
the honest measure, but not the one ears use. Power-cycle the board and listen to `boot`, then send
and receive one note each, and compare both against `pop` and `oops` for loudness. Their levels
are one `peak` value each in `scripts/generate-sounds.ts`; the tone gains are the ones to leave alone.
`PENDING.md` has the specific things to listen for.

---

## Gate 4 — buttons and LEDs

Now the wiring. `src/hal/gpioDriver.ts` has run on the 3B+, where button 1 (the HAT's switch)
registers presses; buttons 2–3 and the lamps below have never been wired, so this gate is still
mostly open.

GPIO 17, 27, 22 for the buttons, pulled up in firmware; the 3 V lamps straight off
GPIO 23, 24, 25, one leg on the pin and one on ground. [`hardware.md`](./hardware.md) has the wiring and the reason the pull-ups come
from `config.txt` rather than from the library. If
nothing lights, the first two suspects are both in `deploy/environment.example`, and both are
one-line changes on the device followed by `sudo systemctl restart bloopbox-hardware`:

```bash
ssh bloop@bloopbox.local 'sudo nano /etc/bloopbox/environment'
#   LED_ACTIVE_HIGH=false     # if a lamp went to 3V3 rather than ground; try both
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
and a wrong one means the configured volume is silently ignored — playback at whatever the adapter
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
- **the phone-number path**, not just the QR: unlink, choose "link with my phone number" in the
  panel, and confirm a code arrives and completes the pairing. This is the path `PENDING.md`'s
  pairing-race entry describes as fixed but not yet reverified — while there, also try switching
  between the two methods a couple of times, since that is exactly the sequence that used to
  break both.
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
| `sudo bloopbox-audio-test`   | Speaker out, microphone in, played back. Gates 4a and 5.          |

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

1. **A persistent journal.** This is the important one. Raspberry Pi OS keeps the journal in
   RAM, so **every log line is lost on reboot** — including the ones that explain the reboot.
   During bring-up that is exactly backwards. Capped at 128 MB so it cannot fill the card. If a
   device is doing something inexplicable on boot and you cannot reach it yet to turn this on
   first, that run's evidence is gone — see `PENDING.md`'s "went dark" entries, which is exactly
   that scenario and how it was worked around one specific time (a temporary drop-in in
   `install.sh`, removed again once it had answered the immediate question).
2. **`LOG_LEVEL=debug` on both daemons.** That turns on a full state timeline — every
   observable change, so the LED behaviour can be replayed line by line afterwards — and the
   **raw button edges, before debouncing**. A press the debouncer discards leaves no other
   trace, and "I pressed it and nothing happened" is the report you will actually get.
3. **A sampler**, every 10s, one JSON line per sample into `/var/log/bloopbox/trace.jsonl`:
   memory for each unit, temperature, throttling, the network reading, the device's own
   status, how many recordings are in the RAM disk.

The sampler is what answers the questions the journal cannot. `MemoryHigh`/`MemoryMax` in the
units are guesses (`PENDING.md` says so) — this measures them. Throttling in a sealed toy
enclosure is a real risk on a Zero 2 W, and nothing else would tell you. And across a hotspot
cycle it gives a minute-by-minute record of what the radio was doing.

**Check this before trusting any of those numbers, on a board this small:**
`grep -o cgroup_enable=memory /proc/cmdline`. Raspberry Pi's firmware disables the memory cgroup
controller by default on low-RAM boards to save the accounting overhead, and it does this outside
`cmdline.txt` itself, so the file looks fine while the running kernel silently has it off — found
on real hardware 2026-08-10, where it meant `MemoryHigh`/`MemoryMax` on all four units had never
been enforced at all. `install.sh` now appends `cgroup_enable=memory cgroup_memory=1` to fix this,
but it takes a reboot to apply, so check `/proc/cmdline` after one rather than assuming the install
step ran.

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
