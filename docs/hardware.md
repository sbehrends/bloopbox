# Hardware

The physical device: what it is made of, how it is wired, and which of that has actually been
proven.

> **Nothing on this page has run on real hardware.** `src/hal/gpioDriver.ts` was written from
> opengpio's published API and the ULN2003 datasheet. Pin numbers, LED polarity and ALSA device
> names are all unverified. [`hardware-bringup.md`](./hardware-bringup.md) is the order to prove
> them in; the driver carries a `TODO(hardware)` banner saying the same thing.

---

## Bill of materials

| Component      | Selected part                            | Why this one                                                        |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| **Brain**      | Raspberry Pi Zero 2 W                    | Quad-core, Wi-Fi on board, small enough to seal into a toy enclosure |
| **Buttons**    | 3× 60 mm illuminated arcade buttons      | Big enough for a 2-year-old's whole hand, and the lamp is the UI     |
| **LED driver** | ULN2003 driver board or chip             | Amplifies 3.3 V GPIO to drive the 5 V arcade lamps brightly and safely |
| **Audio I/O**  | USB mini speakerphone, or USB soundcard + mic | One USB connection for both microphone and speaker                |
| **Power**      | 5 V 2.5 A micro-USB supply               | Steady wall power. No power button, no battery                       |
| **Storage**    | 8 GB+ microSD card                       | 4 GB is too tight once the bundled runtime and ffmpeg are on it      |
| **Enclosure**  | Wood or 3D print                         | Three 60 mm cut-outs, speaker grille, mic hole, cable strain relief   |

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
│      │   │ lamp            │   │ lamp            │   │ lamp           │
│      │   └─────────────────┼───┴─────────────────┼───┴──────┐         │
│      │ switch              │ switch              │ switch   │         │
│      ▼                     ▼                     ▼          │         │
│   ┌──────────────────────────────────────────────────┐      │         │
│   │              Raspberry Pi Zero 2 W               │      │         │
│   │   GPIO 17 / 27 / 22  in     23 / 24 / 25  out    │      │         │
│   └──────┬──────────────────────────┬────────────────┘      │         │
│          │ GPIO out                 │ USB                   │         │
│          ▼                          ▼                       │         │
│   ┌─────────────┐            ┌─────────────┐                │         │
│   │   ULN2003   │            │ USB audio   │                │         │
│   │   (sinks)   │            │ mic + spkr  │                │         │
│   └──────┬──────┘            └─────────────┘                │         │
│          │ 5 V lamp return                                  │         │
│          └──────────────────────────────────────────────────►│         │
│                                                       arcade lamps     │
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
| LED drive | `GPIO23`, `GPIO24`, `GPIO25` | out      | Into the ULN2003 inputs. The chip sinks current, so a HIGH input lights the lamp |

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
| `LED_ACTIVE_HIGH=false`   | The lamps are on when they should be off                |
| `BUTTON_ACTIVE_LOW=false` | Presses read backwards, or the switches went to 3V3     |

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
volume the adapter booted with, silently, **including the volume cap being ignored**. In a child's
room that is the one failure worth checking explicitly: set the volume in the admin panel, then read
it back with `amixer sget <control>`.

Run `amixer scontrols` on the device and set `ALSA_MIXER_CONTROL` to what it actually prints.

## The MVP board: a Pi 3B+ and a WM8960 HAT

The first real device is deliberately **not** the bill of materials above. It is a Pi 3B+ with a
[Waveshare WM8960 audio HAT](https://www.waveshare.com/wiki/WM8960_Audio_HAT), one button, and no
lamps — enough to answer the only question an MVP has to answer: *does this software work on real
hardware at all.* Arcade buttons, the ULN2003 and the enclosure come after.

| | Full device | MVP board |
| --- | --- | --- |
| Brain | Pi Zero 2 W | Pi 3B+ — same BCM numbering, verified on 2026-08-10 |
| Audio | USB speakerphone | WM8960 HAT over I²S, with its own mics |
| Buttons | 3 arcade, GPIO 17 / 27 / 22 | **1** — the HAT's own, on GPIO17 |
| LEDs | 3 lamps via ULN2003 | none |

**The HAT's button is on GPIO17, which is already button 1.** That is luck, not design, and it means
the whole hold-to-send / tap-to-play interaction runs with no pin change: hold the HAT's button to
record and send to contact 1, tap it to play what came back. Channels 2 and 3 still exist everywhere
above the HAL — they simply have no hardware, so nothing can press them.

Install it with:

```bash
sudo ./install.sh --audio-hat wm8960 --no-leds
```

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
   sits upstream of both amps, so the volume cap holds whichever output is wired. Both are
   env-settable (`ALSA_MIXER_CONTROL`, `ALSA_CAPTURE_MIXER_CONTROL`) and both failures are silent —
   see the trap above. This one had in fact been failing silently on the first real device.
   `Capture` also powers up **muted** on this codec, which a gain percentage does not clear; both the
   daemon and `bloopbox-audio-init.service` unmute it explicitly. That is one of three things the
   capture chain needs — see below.
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

A 2×20 stacking header is the better answer when lamps are wanted: the HAT's female header buries the
Pi's pins, and an extender exposes 22/23/24/25/27 — the pins the code already defaults to.

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
