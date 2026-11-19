# Hardware

The physical device: what it is made of, how it is wired, and which of that has actually been
proven.

> **Proven on the reference board, not yet on the target.** Everything below runs on one real
> board — a Pi 3B+ with the WM8960 HAT, three buttons and three lamps. The audio figures were
> measured on it on 2026-08-10, 2026-08-17 and 2026-09-06, and each one says when. The GPIO passed on
> it on 2026-09-30: all three buttons register and all three lamps light with the default polarity,
> yellow / coral / teal left to right. **The Pi Zero 2 W the product targets has run none of it**,
> and `gpioDriver.ts` carries a `TODO(hardware)` banner saying so.
> [`hardware-bringup.md`](./hardware-bringup.md) has the record and the order to prove the next
> board in. The section at the foot of this page is the current line between the two. A second
> board, a **Raspberry Pi 4 Model B (1 GB)**, was confirmed working on 2026-11-19; it is not yet
> recorded gate by gate, so the measurements here remain the 3B+'s.

---

## Bill of materials

| Component      | Selected part                            | Why this one                                                        |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| **Brain**      | Raspberry Pi Zero 2 W                    | Quad-core, Wi-Fi on board, small enough to seal into a toy enclosure |
| **Buttons**    | 3× 30 mm illuminated arcade buttons, **3 V lamps** | The standard arcade action-button size: a toddler hits one without aiming, and the lamp is the UI. A 3 V lamp runs straight off a GPIO pin, so there is no driver board |
| **Audio I/O**  | [Waveshare WM8960 audio HAT](https://www.waveshare.com/wiki/WM8960_Audio_HAT) | Codec, two mics and a speaker amp on one board, over I²S. The only audio path measured on real hardware |
| **Speakers**   | 1–2× small 8 Ω, 2–5 W                    | Into the HAT's screw terminals. **Often bundled with the HAT** — check the listing before ordering any. One is enough: the box is mono end to end |
| **Power**      | 5 V 2.5 A micro-USB supply               | Steady wall power. No power button, no battery                       |
| **Storage**    | 8 GB+ microSD card                       | 4 GB is too tight once the bundled runtime and ffmpeg are on it      |
| **Enclosure**  | Wood or 3D print                         | Three 30 mm cut-outs, speaker grille, mic hole, cable strain relief   |

**The audio HAT is the one part that changes the install command** — `--audio-hat wm8960`, and no
sound card exists until the reboot after it. See [the reference board](#the-reference-board-a-wm8960-hat-three-buttons-and-three-lamps)
below for what it occupies and the five things worth knowing before wiring one.

A **USB mini speakerphone** (or USB soundcard + mic) remains supported in the code as a one-cable
alternative, and the ALSA env overrides exist precisely so it can be swapped in. It is not the
selected part: nothing about that path has been run against a real sound card, and the mixer-control
name — the trap described below — has never been measured for any USB adapter.

There is deliberately **no screen and no power button.** The device is always on, and its entire
output vocabulary is three lamps.

## Layout

```
┌────────────────────────────────────────────────────────────────────────┐
│                     ENCLOSURE (WOOD / 3D PRINT)                        │
│                                                                        │
│   ┌─────────────┐       ┌─────────────┐       ┌─────────────┐          │
│   │ Button 1    │       │ Button 2    │       │ Button 3    │          │
│   │ LEFT        │       │ CENTRE      │       │ RIGHT       │          │
│   │ yellow      │       │ coral       │       │ teal        │          │
│   └──┬───┬──────┘       └──┬───┬──────┘       └──┬───┬──────┘          │
│      │   │ lamp 3 V        │   │ lamp 3 V        │   │ lamp 3 V        │
│      │   └─────┐           │   └─────┐           │   └─────┐           │
│      │ switch  │           │ switch  │           │ switch  │           │
│      ▼         ▼           ▼         ▼           ▼         ▼           │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │                  Raspberry Pi Zero 2 W                       │     │
│   │    GPIO 17 / 27 / 22  in       GPIO 23 / 24 / 25  out        │     │
│   └────────────────────────────┬─────────────────────────────────┘     │
│                                │ I²S + I²C                             │
│                                ▼                                       │
│                         ┌─────────────┐                                │
│                         │ WM8960 HAT  │                                │
│                         │ mic + spkr  │                                │
│                         └─────────────┘                                │
└────────────────────────────────────────────────────────────────────────┘
```

**Button 1 is left, button 2 is centre, button 3 is right**, and that order is fixed everywhere: in
the config schema, in the LED matrix, and in the logo mark's three buttons (yellow, coral, teal,
left to right). Reordering the channel colours means redrawing both SVGs, or the box in the child's
room stops matching the picture of it.

## GPIO

| Function  | BCM pins                    | Direction | Notes                                              |
| --------- | --------------------------- | --------- | -------------------------------------------------- |
| Buttons   | `GPIO17`, `GPIO27`, `GPIO22` | in       | Switch to ground; the line idles HIGH and reads LOW when pressed |
| LED drive | `GPIO23`, `GPIO24`, `GPIO25` | out      | Straight to the lamps: lamp between pin and ground, so a HIGH lights it |

The assignments are exported as `GPIO_PINS` in [`src/hal/gpioDriver.ts`](../box/software/src/hal/gpioDriver.ts).
They avoid the I2C, SPI and UART defaults so those buses stay available, and they are grouped for
tidy ribbon wiring.

Those are the **defaults**. `BUTTON_PINS` and `LED_PINS` override them per device, in channel order,
and a shorter list means fewer physical channels — an empty `LED_PINS=` claims no output lines at
all. The three logical channels exist above the HAL regardless; a channel with no pin simply cannot
be pressed, and its `setLed` is a no-op. That is what lets a partly wired board run this same
driver. A list longer than three throws at startup rather than dropping a channel silently.

`PI_BOARD` names the opengpio board map that pin names resolve through. It defaults to
`RaspberryPi_Zero2W`, which is also correct on a 3B+ — every BCM283x board maps a BCM name to the same
`gpiochip0` line, and the reference board runs on that default. A wrong name fails at startup and
lists the valid ones.

Three overrides for wiring that differs from the reference board. Each is a one-line change in
`/etc/bloopbox/environment` followed by `sudo systemctl restart bloopbox-hardware`. The defaults are
correct on the reference board:

| Variable                  | Try it when                                             |
| ------------------------- | ------------------------------------------------------- |
| `LED_ACTIVE_HIGH=false`   | The lamps are on when they should be off — a lamp wired between 3V3 and the pin sinks instead of sourcing |
| `BUTTON_ACTIVE_LOW=false` | Presses read backwards, or the switches went to 3V3     |
| `BUTTON_SETTLE_MS=40`     | One press registers as two, or a hold drops and resumes — the switch chatters longer than the 20 ms default (0–200) |

### The lamps run at 3 V, straight off the pin

The buttons carry **3 V lamps**, which is what removes a part from the board: 3.3 V logic is already
the right voltage, so each lamp goes between its GPIO pin and a ground pin and the pin switches it
directly. There is no ULN2003, no darlington array and no 5 V lamp rail.

Two things to respect, because the pin is now the driver:

- **Budget the current.** A BCM283x pin sources 16 mA comfortably and the whole header wants to stay
  under ~50 mA, so three lamps at 16 mA is the ceiling, not the target. Pick lamps in the 10–15 mA
  range and all three can be lit at once — which the LED matrix does routinely. Nobody has put an
  ammeter on the reference board's lamps yet (`PENDING.md`, watch items).
- **A bare 3 V LED still needs its resistor.** "3 V lamp" here means a lamp module with its own
  current limiting. If yours is a naked LED, put a series resistor in line with it; a pin driving an
  LED with nothing in between is a short across the diode's forward drop.

Polarity follows from the wiring: pin → lamp → ground means a HIGH lights it, which is
`LED_ACTIVE_HIGH=true`, the default. Wiring the lamp to 3V3 instead and sinking through the pin
inverts it, which is what the override is for.

### Pull-ups come from the firmware, not from the library

`install.sh` appends a marked block to `/boot/firmware/config.txt`:

```
gpio=17,27,22=ip,pu
```

**This only takes effect after a reboot**, and the buttons read garbage until it does. That is the
single most likely explanation for "the buttons do nothing" on a fresh install.

Doing it in firmware rather than in code is more robust — it is applied before userspace starts and
survives any library change — but there is also a specific reason it cannot be done in code here:

> **opengpio 2.0.2 has a transposed bias/debounce bug.** `Watch`'s constructor calls its native
> binding as `watch(chip, line, debounce, bias, cb)` while the binding's signature is
> `watch(chip, line, bias, debounce, cb)`. Asking for `{ bias: Bias.PullUp }` therefore sets a 4 ms
> debounce and leaves the line **floating**, which on a button input means garbage reads.
>
> `gpioDriver.ts` passes **no options at all**. If you find yourself adding an options object to
> that `watch()` call, read this first. Debouncing is done in software instead — see below.

### The switches bounce, and the HAL settles them

The reference board's arcade switches bounce hard. Measured at the bench on 2026-09-30: of 75 edge
bursts, 42 carried bounce — up to **12 edges within 15 ms** — and 17 bursts opened with the opposite
edge to the one the press ended on, simply because that is the order the contact chattered in.

So the driver never hands an edge straight on. [`src/hal/settledLine.ts`](../box/software/src/hal/settledLine.ts)
restarts a quiet window on every edge (`BUTTON_SETTLE_MS`, 20 ms by default), and when it expires
reads the line's level and reports only a change. One settled press is one down and one up, whatever
order the burst came in. Press *length* — tap against hold — is a separate judgement, made above the
HAL by `core/buttonInterpreter.ts` once the chatter is gone.

### The watchdog

`install.sh` also enables the BCM hardware watchdog (`dtparam=watchdog=on`) plus its userspace half
in `systemd/system.conf.d`, with a 15 s timeout — so a wedged device in a child's room reboots
itself rather than sitting dark. `--no-watchdog` skips it.

## Audio

One sound card does both directions. The GPIO driver shells out to ALSA:

| Job       | Command   | Env override                                          |
| --------- | --------- | ----------------------------------------------------- |
| Capture   | `arecord` | `ALSA_CAPTURE_DEVICE` (default `default`)              |
| Playback  | `aplay`   | `ALSA_PLAYBACK_DEVICE` (default `default`)             |
| Volume    | `amixer`  | `ALSA_MIXER_CONTROL` (default `PCM`)                   |
| Mic gain  | `amixer`  | `ALSA_CAPTURE_MIXER_CONTROL` (default `Mic`)            |
| Amp volume | `amixer` | `ALSA_AMP_MIXER_CONTROL` (unset — the card may have none) |
| Amp boost | `amixer`  | `ALSA_AMP_DC_MIXER_CONTROL`, `ALSA_AMP_AC_MIXER_CONTROL` (unset) |
| Routing at boot | `amixer` | `ALSA_ENABLE_SWITCHES` (unset), applied by `bloopbox-audio-init.service` |

`install.sh --audio-hat wm8960` writes the WM8960's values for all of these; the defaults suit a USB
adapter.

Capture is 16 kHz mono S16_LE by default — the same shape as the encode target, so there is no
resample on a slow CPU. `CAPTURE_RATE` overrides the rate for codecs that cannot run capture and
playback at different rates simultaneously; the WM8960 HAT is one, see below.

**`aplay` is not a decoder.** It reads WAV, AU and VOC and hands PCM to ALSA; given anything else it
does not fail, it plays the bytes as raw PCM. An inbound WhatsApp voice note is Ogg/Opus, so
`GpioHal` decodes it to a `play-*.wav` in the RAM disk first and deletes it after —
without that step every received message is full-volume noise while `aplay` exits 0. Cues are
generated as WAV and skip the decode.

**A capture element's mute is separate from its gain.** `amixer sset <control> 60% cap` moves the
volume register and leaves the mute bit where it was, so a codec whose input powers up muted records
exactly the right number of silent bytes. `GpioHal` unmutes in its own call (a parameter the adapter
does not have would otherwise fail the line and take the gain with it) and
`bloopbox-audio-init.service` does it once at boot, where `alsactl store` makes it stick for a bare
`arecord` too.

**The mixer control name is the trap.** It differs across USB adapters (`PCM`, `Speaker`, `Master`),
and `GpioHal` treats a mixer failure as non-fatal — so a wrong name means playback at whatever
volume the adapter booted with, silently, **ignoring `speakerVolumePercent` entirely**. In a child's
room that is the one failure worth checking explicitly: set the volume in the admin panel, then read
it back with `amixer sget <control>`.

Run `amixer scontrols` on the device and set `ALSA_MIXER_CONTROL` to what it actually prints.

## The reference board: a WM8960 HAT, three buttons and three lamps

The board everything on this page was proven on. It carries the **WM8960 HAT** the bill of materials
selects, and all three buttons and all three lamps are wired. The one part that differs is the
brain.

| | Bill of materials | Reference board |
| --- | --- | --- |
| Brain | Pi Zero 2 W | **Pi 3B+** — same BCM numbering |
| Audio | WM8960 HAT | same — over I²S, with its own mics |
| Buttons | 3 arcade, GPIO 17 / 27 / 22 | same — and GPIO17 is also the HAT's own button |
| LEDs | 3 lamps direct on GPIO 23 / 24 / 25 | same |

So every measurement on this page holds for the shipped part list, with the Pi 3B+ standing in for
the Zero 2 W. The two share BCM pin numbering, which is what makes the substitution safe; where it
is *not* safe is the onboard LEDs, for the reasons at the end of this section.

**The HAT's button is on GPIO17, which is already button 1.** That is luck, not design: the HAT's
own button and an external button 1 both switch GPIO17 to ground, so either one drives channel 1.
Keep button 1 on GPIO17 when wiring a board.

Install it with:

```bash
sudo ./install.sh --audio-hat wm8960
```

That adds the overlay to `config.txt` and writes the HAT's ALSA devices, mixer controls, routing
switches and `CAPTURE_RATE` into `/etc/bloopbox/environment`. The pin lists stay at their defaults.
The profile is recorded in `/etc/bloopbox/profile`, so an upgrade needs no flag again
([`deployment.md`](./deployment.md) has the installer's flags). Then **reboot** — there is no sound
card until you do — and run `sudo bloopbox-audio-test`.

Do not add `--no-leds` here. It writes an empty `LED_PINS=` and is only for a board with no lamps
wired at all; on this board it would leave all three lamps dark.

### What the HAT occupies, and the five things worth knowing

It takes **GPIO 2, 3** (I²C control, codec at `0x1a`) and **18–21** (I²S). Nothing it uses collides
with 17/22/23/24/25/27. The HAT passes the header through to its own top row, so the button and lamp
pins stay reachable with it seated and no stacking header is needed.

1. **Use the in-tree `wm8960-soundcard` overlay, not the vendor driver.** Waveshare's
   `WM8960-Audio-HAT` repository is an unmaintained DKMS module that breaks on new kernels; the
   overlay ships in the Raspberry Pi kernel and needs nothing installed. `install.sh --audio-hat
   wm8960` writes `dtparam=i2c_arm=on`, `dtoverlay=wm8960-soundcard` and `dtparam=audio=off` — the
   last meant to keep ALSA's `default` off the Pi's own headphone jack. Whether it does is open:
   written after the overlay, it is read as a parameter of the overlay rather than of the base tree
   (`PENDING.md`). It is harmless either way, because the daemon never uses `default` on this
   board: the overlay names the card `wm8960soundcard`, and the environment addresses it by that
   name (`plughw:CARD=wm8960soundcard,DEV=0`), so a changing card number cannot move the daemon onto
   the wrong device.
2. **The mixer controls are `Playback` and `Capture`, and the DAC starts wired to nothing.** Measured
   on a real HAT, 2026-08-10. There is **no `Master` control on this codec**; the playback side is
   `Playback` (the DAC volume), with `Speaker` and `Headphone` as the two output amps below it.
   `Playback` is what `install.sh` writes because it sits upstream of both amps, so the volume setting
   holds whichever output is wired. Both names are env-settable (`ALSA_MIXER_CONTROL`,
   `ALSA_CAPTURE_MIXER_CONTROL`) and both failures are silent — see the trap above.

   The two `Left/Right Output Mixer PCM` switches power up **off**, which leaves the DAC connected to
   nothing: total silence while the card enumerates, `aplay` exits 0 and every volume reads a
   sensible value. `bloopbox-audio-init.service` turns them on at boot from `ALSA_ENABLE_SWITCHES`.

   **Setting `Playback` alone leaves the box ~26 dB quiet.** Measured on the same HAT on
   2026-08-17: `Playback` was already at its 0 dB ceiling while the stages *below* it had never been
   touched.

   | Control | Powers up at | Set to | Worth |
   | --- | --- | --- | --- |
   | `Playback` (DAC volume) | 255/255, 0 dB | unchanged — `speakerVolumePercent` drives it | — |
   | `Speaker` (output PGA) | **101/127, −20.00 dB** | 127 (+6.00 dB) | **26 dB** |
   | `Speaker DC` (class-D boost) | **0** | 5 | a few dB |
   | `Speaker AC` (class-D boost) | **0** | 5 | a few dB |

   `Speaker` is the one that matters; the boosts are trim on top. All three are
   `config.audio.ampVolumePercent` / `ampBoostDc` / `ampBoostAc` (defaults 100 / 5 / 5), applied by
   `GpioHal` at init through `ALSA_AMP_MIXER_CONTROL`, `ALSA_AMP_DC_MIXER_CONTROL` and
   `ALSA_AMP_AC_MIXER_CONTROL` — written by `install.sh --audio-hat wm8960`, and **unset by default**,
   because a USB adapter has no such stages and naming a control that does not exist fails silently.

   They are configuration rather than constants because the boosts trade headroom for distortion
   on a small speaker, which is a judgement about a particular enclosure. The admin panel's
   **Test speaker** button plays the boot cue so the result can be heard; the settings are read at
   boot, so a change is only audible after the save restarts the daemon. The 2026-09-06 measurement
   found the distortion ratio flat across the whole range ([`audio-quality.md`](./audio-quality.md),
   Finding 6).
3. **The microphone needs three settings, not one, and two of them are not gain.** Measured
   2026-08-10 by playing a full-scale 1 kHz tone through the HAT's own speaker (it sits centimetres
   from the mics) and reading the captured level back:

   | Setting | Default | Needed | Tone reads |
   | --- | --- | --- | --- |
   | `Capture Switch` (LINMUTE/RINMUTE) | muted | unmuted | silence → signal |
   | `Left/Right Input Mixer Boost` (LMIC2B) | **off** | on | −62 dB → −20 dB |
   | `Left/Right Input Boost Mixer LINPUT1` | 0 dB | **3** (+29 dB) | −20 dB → −8.4 dB |
   | `Capture` (input PGA) | set by the daemon | `micGainPercent`, default 65 | see below |

   The mics are on **LINPUT1/RINPUT1**: with only LINPUT2 or LINPUT3 selected the capture reads
   −80.8 dB, which is digital silence, so this is settled rather than inferred. `ADC PCM Capture
   Volume` stays at its 0 dB default — digital gain would lift the noise floor with the signal, and
   `amixer sset` cannot even address it (it is not a simple mixer element; use `cset name=…`).
   MICBIAS is **not** required — the mics work with `MICB=0`.

   The two boost stages come from `ALSA_ENABLE_SWITCHES`, applied by `bloopbox-audio-init.service`;
   its entries are `Name` (switch it on) or `Name=Value`. The unmute is done by both that unit and
   the daemon, through `ALSA_CAPTURE_MIXER_CONTROL`. The input PGA is
   `config.audio.micGainPercent`, because a parent may need to tune it, and the daemon reapplies it at
   every start — which is why raising the PGA by hand does not survive a restart. It defaults to
   **65**: at 100 a real voice at a normal level clips, and analog gain buys no SNR at all
   ([`audio-quality.md`](./audio-quality.md), Finding 1). `amixer -M` is non-linear; the measured map
   is 100→63, 90→60, 85→58, 80→57, 75→55, 70→53, 60→49, 40→39.
4. **Capture runs at 48 kHz on this HAT, not 16.** The codec is the clock consumer on a shared I²S
   bit clock and cannot hold two rates at once, and the cues are 48 kHz. `CAPTURE_RATE=48000` makes
   them agree and lets ffmpeg resample during encode, which it already does; the cost is a larger
   intermediate WAV in tmpfs. Full duplex at a matched 48 kHz works — on 2026-08-10 `aplay` played a
   tone to completion while `arecord` held the device. Two things are still unproven: whether a
   *mismatched* pair actually fails, and whether the variable is needed at all now that the "pop"
   finishes before the microphone opens, so no cue shares the clock with a recording. It stays until
   a real device says otherwise, because getting it wrong records silence.
5. **The HAT's own button is documented but unconfirmed.** Waveshare's pin table lists
   `BUTTON → P17` and its own test reads `1` released / `0` pressed — active-low, matching
   `BUTTON_ACTIVE_LOW`. The reference board's button 1 is an external arcade switch on GPIO17, so it
   is still not ruled out that P17 is broken out rather than populated with a switch.
   `gpiomon gpiochip0 17` settles it in seconds.

### The LEDs that were considered and rejected

The Pi 3B+ can drive its own ACT and PWR LEDs from `/sys/class/leds/led0` and `led1`, so a
two-channel light show was possible without parts. It was left out on purpose: on the 3B+ (unlike the
3B) both LEDs hang off a GPIO expander reachable only from the VPU, so every write is a firmware
mailbox round-trip against a `setLed` the animator calls at 20 Hz; `/sys` is read-only in
`bloopbox-hardware.service` (`ProtectKernelTunables=yes`) and the files are root-owned, so it needs a
udev rule and a hardening exception; and two fixed-colour LEDs in fixed positions cannot express the
matrix anyway.

## The OS target is Raspberry Pi OS Trixie, 64-bit

A constraint, not a preference: `opengpio@2.0.2` needs the libgpiod **v2** API, which Bookworm does
not ship, so on Bookworm the device has no buttons and no lights. [`deployment.md`](./deployment.md)
owns the details.

## Storage and power safety

- **Audio never touches the card.** Recordings live in `/run/bloopbox`, which is already a tmpfs.
- **Config writes are atomic** — temp file → `fsync` → `rename` — so a power cut mid-save cannot
  corrupt the parent's settings.
- **The read-only root filesystem is specified but not built.** `PRODUCT.md` §8 wants overlayfs so
  an abrupt power cut cannot corrupt the OS. It is not enabled, because `/data` currently lives on
  the root filesystem: with the overlay active, every setting and the WhatsApp credentials would
  land in a RAM overlay and vanish on reboot. That is a worse failure, and a silent one. It needs
  `/data` on its own partition first — see `PENDING.md`.

## What is proven, and what is not

Verified in arm64 Trixie containers by `npm run release:smoke`: the `opengpio` addon compiles and
loads against `libgpiod3`, the installer runs, and both daemons boot. Pin and board resolution
off-device is locked by `src/tests/gpioPins.test.ts` — what `BUTTON_PINS`, `LED_PINS` and `PI_BOARD`
do, including that a too-long list throws — and the settling by `settledLine.test.ts` and
`gpioButtons.test.ts`.

**Proven on the reference board** (Pi 3B+, WM8960 HAT; the record is in
[`hardware-bringup.md`](./hardware-bringup.md#what-the-reference-board-has-proven)): the overlay,
card name and mixer controls above; capture and playback through the real path; all three buttons,
with the switch bounce settled; all three lamps at the default polarity; the setup hotspot on a real
radio with a phone joining it; a first boot from a flashed image.

**Confirmed working on a Raspberry Pi 4 Model B (1 GB)** on 2026-11-19, gate by gate not yet
recorded ([`hardware-bringup.md`](./hardware-bringup.md#what-the-reference-board-has-proven)).

**Not proven anywhere:**

- **any of it on a Pi Zero 2 W**, the part the bill of materials selects
- the USB-adapter audio path, against any real adapter
- whether P17 is a populated switch, and whether the shared-clock rate conflict is real
- the lamps' current draw against the header budget, with an ammeter
- how the microphone is mounted in an enclosure — gasketed at a port or rigidly coupled — which no
  filter can substitute for ([`audio-quality.md`](./audio-quality.md))
