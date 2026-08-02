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

The assignments are exported as `GPIO_PINS` in [`src/hal/gpioDriver.ts`](../src/hal/gpioDriver.ts).
They avoid the I2C, SPI and UART defaults so those buses stay available, and they are grouped for
tidy ribbon wiring.

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

Capture is 16 kHz mono S16_LE — the same shape as the encode target, so there is no resample on a
slow CPU.

**The mixer control name is the trap.** It differs across USB adapters (`PCM`, `Speaker`, `Master`),
and `GpioHal` treats a mixer failure as non-fatal — so a wrong name means playback at whatever
volume the adapter booted with, silently, **including the volume cap being ignored**. In a child's
room that is the one failure worth checking explicitly: set the volume in the admin panel, then read
it back with `amixer sget <control>`.

Run `amixer scontrols` on the device and set `ALSA_MIXER_CONTROL` to what it actually prints.

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
- ffmpeg has a working `libopus` encoder
- both daemons boot out of a mounted SD card image

Never run at all:

- any GPIO read or write on a real chip — pin numbers and polarity both
- `arecord`, `aplay` or `amixer` against a real sound card
- a real microphone in the capture path (the one end-to-end send used a stubbed `getUserMedia`)
- the setup hotspot on a real radio, or a phone joining it

[`hardware-bringup.md`](./hardware-bringup.md) sequences all of that so only one unverified
subsystem is in play at a time, and carries the debugging kit for when one of them does not work.
