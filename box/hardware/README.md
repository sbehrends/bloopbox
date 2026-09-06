# box/hardware

The physical half of the box: enclosure models, and eventually a PCB.

**Empty so far.** The device has been built entirely against the browser simulator, and the parts
are not on hand yet — so what exists today is the written reference, not the artefacts.

## The authoritative reference is `docs/hardware.md`, not this folder

Pin assignments, the bill of materials, the ULN2003 wiring, LED polarity and the ALSA device names
all live in [`../../docs/hardware.md`](../../docs/hardware.md), which is kept in step with
`box/software/src/hal/gpioDriver.ts` — the code that actually drives those pins.

**When a model or schematic lands here, it does not become a second source of truth.** A CAD file
with GPIO 17 silkscreened on it, or a drilling template sized for a different button, is exactly the
kind of drift that ends with a printed enclosure that does not fit the board. Anything here that
encodes a pin, a dimension or a part number should say where it came from and be regenerated when
`docs/hardware.md` changes.

## What belongs here

| Path             | For                                                                    |
| ---------------- | ---------------------------------------------------------------------- |
| `enclosure/`     | The case: source CAD (STEP or the tool's native format) **and** printable STL/3MF |
| `pcb/`           | Schematic and layout for the button/LED breakout, if it stops being hand-wired |
| `templates/`     | Drilling and cut templates as PDF at 1:1 scale                         |
| `reference/`     | Datasheets for the button, the ULN2003 and the USB audio adapter        |

Two things worth committing to from the start:

- **Ship source alongside export.** An STL alone cannot be modified. Commit the parametric source
  next to it, or the next person re-models the case from scratch.
- **Binary CAD does not diff.** Keep files reasonably sized and describe what changed in the commit
  message, because git will not be able to show it. If these grow large, this is the folder that
  eventually wants git-lfs — not the software.

## Constraints the enclosure has to respect

From `docs/hardware.md` and the product spec:

- Three 30 mm illuminated arcade buttons, **left / centre / right**, in that order — the caps are
  yellow, coral, teal to match the logo mark, and the software's `--ch-1/2/3` tokens assume it.
- No screen and no power button. The only openings are the three buttons, a speaker grille, a
  microphone hole and the power cable.
- A Pi Zero 2 W, a ULN2003 breakout, and a USB audio adapter with a cable that has to route
  somewhere.
- It sits in a child's bedroom and will be picked up, dropped, and leaned on. Strain relief on the
  power cable is not optional.
- Mains-adjacent heat: a sealed enclosure on a Zero 2 W can throttle. `bloopbox-debug on` samples
  temperature every 10 s, so this is measurable once there is a case to measure.
