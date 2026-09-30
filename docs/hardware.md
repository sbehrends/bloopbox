# Hardware

The physical device: what it is made of, how it is wired, and which of that has actually been
proven.

> **The audio is measured; the GPIO is not.** Everything about the WM8960 HAT below — its mixer
> control names, the 26 dB of amplifier stages, the three microphone settings — was measured on a
> real board on 2026-08-10 and 2026-08-17, and each figure says so. The GPIO is **partly proven**: on
> the same Pi 3B+ the driver claims all six lines and button 1 (GPIO17) registers presses. Buttons 2
> and 3 and the three lamps are wired but not yet recorded as working, so their switch polarity, LED
> polarity and colour order are still unverified, and `gpioDriver.ts` carries a `TODO(hardware)`
> banner saying so. [`hardware-bringup.md`](./hardware-bringup.md) is the order to
> prove the rest in. The section at the foot of this page is the current line between the two.

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
be pressed, and its `setLed` is a no-op. That is what lets the reduced MVP board below run this same
driver. A list longer than three throws at startup rather than dropping a channel silently.

Two environment overrides exist precisely because these are unverified, and both are one-line
changes in `/etc/bloopbox/environment` followed by a service restart:

| Variable                  | Try flipping when                                       |
| ------------------------- | ------------------------------------------------------- |
| `LED_ACTIVE_HIGH=false`   | The lamps are on when they should be off — a lamp wired between 3V3 and the pin sinks instead of sourcing |
| `BUTTON_ACTIVE_LOW=false` | Presses read backwards, or the switches went to 3V3     |

### The lamps run at 3 V, straight off the pin

The buttons carry **3 V lamps**, which is what removes a part from the board: 3.3 V logic is already
the right voltage, so each lamp goes between its GPIO pin and a ground pin and the pin switches it
directly. There is no ULN2003, no darlington array and no 5 V lamp rail — earlier revisions of this
page specified one, and a board built to them still works, but it is no longer the design.

Two things to respect, because the pin is now the driver:

- **Budget the current.** A BCM283x pin sources 16 mA comfortably and the whole header wants to stay
  under ~50 mA, so three lamps at 16 mA is the ceiling, not the target. Pick lamps in the 10–15 mA
  range and all three can be lit at once — which the LED matrix does routinely.
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
> that `watch()` call, read this first. Debounce is handled in software by
> `core/buttonInterpreter.ts`, which we need anyway for the tap-versus-hold distinction.

### The watchdog

`install.sh` also enables the BCM hardware watchdog (`dtparam=watchdog=on`) plus its userspace half
in `systemd/system.conf.d`, with a 15 s timeout — so a wedged device in a child's room reboots
itself rather than sitting dark. `--no-watchdog` skips it.

## Audio

One USB device does both directions. The GPIO driver shells out to ALSA:

| Job       | Command   | Env override                                          |
| --------- | --------- | ----------------------------------------------------- |
| Capture   | `arecord` | `ALSA_CAPTURE_DEVICE` (default `default`)              |
| Playback  | `aplay`   | `ALSA_PLAYBACK_DEVICE` (default `default`)             |
| Volume    | `amixer`  | `ALSA_MIXER_CONTROL` (default `PCM`)                   |
| Mic gain  | `amixer`  | `ALSA_CAPTURE_MIXER_CONTROL` (default `Mic`)            |
| Amp volume | `amixer` | `ALSA_AMP_MIXER_CONTROL` (unset — the card may have none) |
| Amp boost | `amixer`  | `ALSA_AMP_DC_MIXER_CONTROL`, `ALSA_AMP_AC_MIXER_CONTROL` (unset) |

Capture is 16 kHz mono S16_LE by default — the same shape as the encode target, so there is no
resample on a slow CPU. `CAPTURE_RATE` overrides the rate for codecs that cannot run capture and
playback at different rates simultaneously; the WM8960 HAT is one, see below.

**`aplay` is not a decoder.** It reads WAV, AU and VOC and hands PCM to ALSA; given anything else it
does not fail, it plays the bytes as raw PCM. An inbound WhatsApp voice note is Ogg/Opus, so
`GpioHal.play()` decodes to a `play-*.wav` beside it in the RAM disk first and deletes it after —
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

The board everything above was measured on. It carries the **WM8960 HAT** the bill of materials
selects (decided 2026-08-17), and everything else matches the full device: all three buttons and
all three lamps are wired. The one part that differs is the brain.

| | Bill of materials | Reference board |
| --- | --- | --- |
| Brain | Pi Zero 2 W | **Pi 3B+** — same BCM numbering, verified on 2026-08-10 |
| Audio | WM8960 HAT | same — over I²S, with its own mics |
| Buttons | 3 arcade, GPIO 17 / 27 / 22 | same — and GPIO17 is also the HAT's own button |
| LEDs | 3 lamps direct on GPIO 23 / 24 / 25 | same |

So every measurement on this page holds for the shipped part list, with the Pi 3B+ standing in for
the Zero 2 W. The two share BCM pin numbering, which is what makes the substitution safe; where it
is *not* safe is the onboard LEDs, for the reasons at the end of this section.

**The HAT's button is on GPIO17, which is already button 1.** That is luck, not design, and it is
why the HAT needs no wiring to work: the HAT's own button and an external button 1 both switch
GPIO17 to ground, so either one drives channel 1. Keep button 1 on GPIO17 when wiring a board.

Nothing the HAT occupies collides with the buttons or the lamps — see the section below — so this
is the full pin map, not a reduced one.

Install it with:

```bash
sudo ./install.sh --audio-hat wm8960
```

Add `--no-leds` only for a board with no lamps wired: it writes an empty `LED_PINS`, so the driver
claims no output lines and `setLed()` becomes a no-op above the HAL.

which writes `BUTTON_PINS` / `LED_PINS` and the ALSA settings into `/etc/bloopbox/environment` and
the overlay into `config.txt`. Then **reboot** — there is no sound card until you do — and run
`sudo bloopbox-audio-test`.

### What the HAT occupies, and the five things worth knowing

It takes **GPIO 2, 3** (I²C control, codec at `0x1a`) and **18–21** (I²S). Nothing it uses collides
with 22/23/24/25/27, so the full pin map stays available for later.

1. **Use the in-tree `wm8960-soundcard` overlay, not the vendor driver.** Waveshare's
   `WM8960-Audio-HAT` repository is an unmaintained DKMS module that breaks on new kernels; the
   overlay ships in the Raspberry Pi kernel and needs nothing installed. `install.sh --audio-hat
   wm8960` writes `dtparam=i2c_arm=on`, `dtoverlay=wm8960-soundcard` and `dtparam=audio=off` — the
   last so ALSA's `default` cannot land on the Pi's own headphone jack instead.
2. **The mixer controls are `Playback` and `Capture`** — measured on a real HAT, 2026-08-10. There
   is **no `Master` control on this codec**, which is what the docs and the installer claimed until
   that was checked; the playback side is `Playback` (the DAC volume), with `Speaker` and
   `Headphone` as the two output amps below it. `Playback` is what `install.sh` writes because it
   sits upstream of both amps, so the volume setting holds whichever output is wired. Both are
   env-settable (`ALSA_MIXER_CONTROL`, `ALSA_CAPTURE_MIXER_CONTROL`) and both failures are silent —
   see the trap above. This one had in fact been failing silently on the first real device.
   `Capture` also powers up **muted** on this codec, which a gain percentage does not clear; both the
   daemon and `bloopbox-audio-init.service` unmute it explicitly. That is one of three things the
   capture chain needs — see below.

   **Setting `Playback` alone leaves the box ~26 dB quiet.** Measured on the same HAT on
   2026-08-17, after a report that maximum volume was still underwhelming: `Playback` was already
   at its 0 dB ceiling while the stages *below* it had never been touched by anything in the
   codebase.

   | Control | Powers up at | Set to | Worth |
   | --- | --- | --- | --- |
   | `Playback` (DAC volume) | 255/255, 0 dB | unchanged — `speakerVolumePercent` drives it | — |
   | `Speaker` (output PGA) | **101/127, −20.00 dB** | 127 (+6.00 dB) | **26 dB** |
   | `Speaker DC` (class-D boost) | **0** | 5 | a few dB |
   | `Speaker AC` (class-D boost) | **0** | 5 | a few dB |

   `Speaker` is the one that matters; the boosts are trim on top. All three are now
   `config.audio.ampVolumePercent` / `ampBoostDc` / `ampBoostAc`, applied by `GpioHal` at init
   through `ALSA_AMP_MIXER_CONTROL`, `ALSA_AMP_DC_MIXER_CONTROL` and `ALSA_AMP_AC_MIXER_CONTROL`
   — written by `install.sh --audio-hat wm8960`, and **unset by default**, because a USB adapter
   has no such stages and naming a control that does not exist fails silently.

   They are configuration rather than constants because the boosts trade headroom for distortion
   on a small speaker, which is a judgement about a particular enclosure. The admin panel's
   **Test speaker** button plays the boot cue so the result can be heard; note the settings are
   read at boot, so a change is only audible after the save restarts the daemon.
3. **The microphone needs three settings, not one, and two of them are not gain.** Measured
   2026-08-10 by playing a full-scale 1 kHz tone through the HAT's own speaker (it sits centimetres
   from the mics) and reading the captured level back, so each figure is a real measurement:

   | Setting | Default | Needed | Tone reads |
   | --- | --- | --- | --- |
   | `Capture Switch` (LINMUTE/RINMUTE) | muted | unmuted | silence → signal |
   | `Left/Right Input Mixer Boost` (LMIC2B) | **off** | on | −62 dB → −20 dB |
   | `Left/Right Input Boost Mixer LINPUT1` | 0 dB | **3** (+29 dB) | −20 dB → −8.4 dB |
   | `Capture` (input PGA) | 49/63 from `micGainPercent` 60 | 57 via **80** | included above |

   The mics are on **LINPUT1/RINPUT1**: with only LINPUT2 or LINPUT3 selected the capture reads
   −80.8 dB, which is digital silence, so this is settled rather than inferred. `ADC PCM Capture
   Volume` stays at its 0 dB default — digital gain would lift the noise floor with the signal, and
   `amixer sset` cannot even address it (it is not a simple mixer element; use `cset name=…`).
   MICBIAS is **not** required — the mics work with `MICB=0`.

   The first three are applied by `bloopbox-audio-init.service` from `ALSA_ENABLE_SWITCHES`, whose
   entries are `Name` or `Name=Value`. The fourth is `config.audio.micGainPercent`, because a parent
   may need to tune it, and the daemon reapplies it at every start — which is why raising the PGA by
   hand does not survive a restart on its own. It defaults to **80**: 100 was audibly too hot on a
   real voice, and `amixer -M` is non-linear, so 85 is only −3.75 dB and not worth having. The
   measured map is 100→63, 90→60, 85→58, **80→57**, 75→55, 70→53, and the tone peaks at −15.3 dB at
   80 against −8.4 dB at 100.
4. **Capture runs at 48 kHz on this HAT, not 16.** The codec is the clock consumer on a shared I²S
   bit clock and cannot hold two rates at once, and the record cues are 48 kHz — the "pop" fires at
   `recordThresholdMs` *while capture is open*, which would be a second rate on the same clock.
   `CAPTURE_RATE=48000` makes them agree and lets ffmpeg resample during encode, which it already
   does. The cost is a larger intermediate WAV in tmpfs. **Half-confirmed on hardware 2026-08-10:**
   full duplex at a matched 48 kHz works — `aplay` played a tone to completion, exit 0, while
   `arecord` held the device, which is what the whole arrangement depends on. Whether a *mismatched*
   pair actually fails was never tested, so the premise for the variable is still unproven.
5. **The HAT's button is documented but unconfirmed by us.** Waveshare's pin table lists
   `BUTTON → P17` and its own test reads `1` released / `0` pressed — active-low, matching
   `BUTTON_ACTIVE_LOW`. Every waveshare.com page 403s from CI and from here, so it is not ruled out
   that P17 is broken out rather than populated with a switch. `gpiomon gpiochip0 17` settles it in
   seconds.

### The LEDs that were considered and rejected

The Pi 3B+ can drive its own ACT and PWR LEDs from `/sys/class/leds/led0` and `led1`, so a
two-channel light show was possible without parts. It was left out on purpose: on the 3B+ (unlike the
3B) both LEDs hang off a GPIO expander reachable only from the VPU, so every write is a firmware
mailbox round-trip against a `setLed` the animator calls at 20 Hz; `/sys` is read-only in
`bloopbox-hardware.service` (`ProtectKernelTunables=yes`) and the files are root-owned, so it needs a
udev rule and a hardening exception; and two fixed-colour LEDs in fixed positions cannot express the
matrix anyway. For an MVP the audio cues carry the feedback.

Lamps need no extra part either: the HAT passes the header through to its own top row, so
22/23/24/25/27 — the pins the code already defaults to — stay reachable with it seated. Earlier
revisions of this page called for a 2×20 stacking header; it is not needed.

## The OS target is Raspberry Pi OS Trixie, 64-bit

Not a preference — a constraint, and worth knowing before anyone tries to "support Bookworm too".

`opengpio@2.0.2` is written against the libgpiod **v2** C++ API. Bookworm ships libgpiod 1.6, where
`gpiod::line::value` and `line_request::release()` do not exist, so the addon fails to compile and
the device has no buttons and no lights. This is verified, not assumed. Trixie ships libgpiod 2.2 —
`libgpiod3` at runtime, `libgpiod-dev` to build.

Every current Pi OS Lite arm64 image is Trixie anyway.

32-bit is not a target either: Node publishes no official armv6 build, and the Pi Zero 2 W is a
Cortex-A53, so arm64 is both available and faster.

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

Verified in arm64 Trixie containers by `npm run release:smoke`:

- the `opengpio` addon **compiles and loads** on arm64 Trixie against `libgpiod3`
- `RaspberryPi_Zero2W` is a real export of opengpio 2.0.2
- pin and board resolution off-device — `src/tests/gpioPins.test.ts` locks what `BUTTON_PINS`,
  `LED_PINS` and `PI_BOARD` do, including that a too-long list throws
- ffmpeg has a working `libopus` encoder
- both daemons boot out of a mounted SD card image

Never run at all:

- any GPIO read or write on a real chip — pin numbers and polarity both
- `arecord`, `aplay` or `amixer` against a real sound card
- a real microphone in the capture path (the one end-to-end send used a stubbed `getUserMedia`)
- the setup hotspot on a real radio, or a phone joining it
- anything about the WM8960 HAT beyond what 2026-08-10 measured: the overlay does name the card
  `wm8960soundcard`, playback and capture devices both open, and the controls are `Playback`/`Capture`
  — **not** the `Master` the vendor tables implied. Still unmeasured: whether P17 is a populated
  switch, and whether the shared-clock rate conflict is real

[`hardware-bringup.md`](./hardware-bringup.md) sequences all of that so only one unverified
subsystem is in play at a time, and carries the debugging kit for when one of them does not work.
