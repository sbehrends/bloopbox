# Audio quality: what was measured, and what to change

Measured on the real device (WM8960 HAT, Pi in its enclosure) on **2026-09-06**, prompted by a
report of noise and a boxy, echoey quality on outgoing messages.

Everything below is a measurement, not an inference from a datasheet. Where a number is
contaminated or a conclusion is not supported, it says so — this file is only useful if it can be
trusted on the parts that *are* settled.

## Method, and why it is fussy

`box/software/CLAUDE.md` already warns that **ambient room noise moved 18 dB between identical
passes**, which invalidates any before/after built from two separate recordings. That warning
earned itself again here: two passes at identical settings gave RMS −23.1 dB and −35.6 dB, a
12.5 dB spread with nothing changed.

So every comparison below comes from **windows inside one recording** — a silent window and a
signal window from the same take, with the HAT's own speaker as the stimulus. Room drift moves
both windows together and cancels out of the difference.

The stimulus is a 150 Hz → 3.5 kHz sweep, which gives SNR and a rough response curve from one pass.

## Finding 1 — the input clips, and analog gain buys no SNR at all

The shipped device runs every analog stage at maximum: `Capture` at 63/63 (+30 dB), the
`LINPUT1` boost at 3/3 (+29 dB), and the +42 dB `Input Mixer Boost` path enabled. On the box
measured here `micGainPercent` was **100**, which is what puts `Capture` at 63.

One recording per setting, silence window vs sweep window:

| `Capture` | noise RMS | signal RMS | signal peak | SNR |
| --------- | --------- | ---------- | ----------- | ---- |
| **63** (shipped) | −19.9 dB | −3.6 dB | **0.00 dBFS — clipping** | 16.3 dB |
| 48 | −22.9 dB | −9.1 dB | **0.00 dBFS — clipping** | 13.8 dB |
| 40 | −27.7 dB | −13.6 dB | **0.00 dBFS — clipping** | 14.1 dB |
| 32 | −34.0 dB | −19.6 dB | −3.0 dBFS — clean | 14.4 dB |

Two things fall out, and the second is the important one:

1. The signal hits **full scale** at three of the four settings. Independently, a plain
   *ambient* recording — nobody speaking — peaked at **−0.38 dBFS** at the shipped gain. There is
   no headroom at all before anyone opens their mouth.
2. **SNR is flat, ~14–16 dB, across a 24 dB range of analog gain.** Turning the preamp up does not
   improve the signal-to-noise ratio. It amplifies the noise by exactly as much as the signal and
   spends the headroom doing it.

That is the signature of noise that is acoustic or preamp-borne rather than ADC-borne, and it
makes the shipped setting a pure loss: same SNR as a quiet setting, plus clipping.

**Clipping is very likely what the report described as "echo".** Hard-clipped speech is harsh and
smeared, and does not sound like simple distortion to most listeners — "fuzzy", "doubled" and
"echoey" are the usual descriptions.

> **Caveat, stated plainly.** The stimulus is the HAT's own speaker firing into its own microphone
> at a few centimetres, which is louder than a child talking. That the *sweep* clips does not prove
> a child's voice clips. The ambient measurement peaking at −0.38 dBFS is the stronger evidence and
> does not depend on the stimulus at all.

## Finding 2 — the noise is low-frequency, not hiss

Noise-only window, by band:

| Band | RMS |
| ---- | --- |
| **20–100 Hz** | **−38.4 dB** |
| 100–300 Hz | −46.6 dB |
| 300–1000 Hz | −50.9 dB |
| 1000–3000 Hz | −56.5 dB |
| 3000–8000 Hz | −61.4 dB |

The 20–100 Hz band is **12 dB louder than 300–1000 Hz and 23 dB louder than 1–3 kHz**. Whatever
this is — mains hum, the enclosure conducting, the Pi's own supply, handling — the dominant noise
sits entirely below the range a voice needs.

A child's voice has a fundamental around 250–400 Hz. **A high-pass at 100–120 Hz removes the single
largest noise component at no cost to speech**, and it is one filter argument.

## Finding 3 — a mid peak, but the measurement cannot attribute it

Sweep window, by octave:

| Band | RMS |
| ---- | --- |
| 100–200 Hz | −54.4 dB |
| 200–400 Hz | −36.8 dB |
| **400–800 Hz** | **−25.9 dB ← peak** |
| 800–1600 Hz | −28.5 dB |
| 1600–3200 Hz | −30.4 dB |
| 3200–6400 Hz | −39.9 dB |

There is a broad lift around 400–800 Hz and a steep fall above 3.2 kHz, which would read as boxy
and dull — consonants live at 2–6 kHz.

**This does not justify an EQ curve yet.** The sweep went out through the HAT's small speaker and
came back through the microphone, so the curve is the *round trip*: speaker, enclosure and
microphone multiplied together. A child's voice reaches the microphone directly and never passes
through the speaker, so this measurement over-attributes to the enclosure whatever the speaker is
doing. Separating them needs an external reference source. Until then, a corrective EQ would be
fitting a curve that partly is not there.

## Finding 4 — encoding is on the critical path, and cleaning the signal makes it faster

`toVoiceNote()` runs inside `GpioHal.stopRecording()`, which `#commitCapture` awaits **before**
playing the whoosh. So the child waits out the encode before hearing that anything was sent.

10 s of real microphone audio, best of three, on the device:

| Chain | Time |
| ----- | ---- |
| baseline (what ships today) | 2770 ms |
| + `highpass=f=110` | 2558 ms |
| + highpass + `speechnorm` | 2504 ms |
| + highpass + `afftdn` + `speechnorm` | **1627 ms** |
| + highpass + `loudnorm` | 4267 ms |

Two results worth keeping:

- **A 10 s note already costs ~2.8 s before the whoosh**, plus `resumeGraceMs`. That is a long
  silence for a small child who has just let go of a button, and it exists today with no filtering
  at all.
- **Noise reduction is not a cost, it is a saving.** Cleaning the signal makes Opus 41 % *faster*,
  because the encoder stops spending effort and bits on noise. This was verified twice: an earlier
  run using synthetic white noise showed the same inversion, and white noise is the worst case for
  a speech codec, so the effect was re-measured against real captured audio to be sure it was not
  an artefact.
- `loudnorm` is the one filter that genuinely costs — it is an analysis filter. It belongs on the
  **inbound** path, where nothing is waiting.

## What to change, in order of value

1. **Stop clipping the input.** Lower `micGainPercent` from 100. It is already a config field and
   needs no code — the daemon applies it as `amixer -M sset Capture <n>% cap`. Measured mapping:

   | `micGainPercent` | raw | dB |
   | ---------------- | --- | -- |
   | 100 | 63 | +30.00 |
   | 80 | 57 | +25.50 |
   | 60 | 49 | +19.50 |
   | 40 | 39 | +12.00 |

   Nothing above is a recommendation of a specific value, because the right one depends on how
   loudly a particular child speaks at a particular distance — and that needs a listening test,
   not a sweep. What *is* settled is that 100 is wrong: it clips on room tone alone and buys no SNR.

2. **High-pass the capture at 100–120 Hz** (Finding 2). Largest measured noise component, no cost
   to speech, ~free.

3. **Normalise digitally instead of in the preamp.** This is the point of 1–2 rather than a
   separate idea: back the analog gain off until nothing clips, strip the low-frequency noise, then
   bring the level up in software where it can be done after the noise is gone rather than before.
   `speechnorm` is purpose-built for this and measured cheap.

4. **Normalise inbound notes on decode.** Already an open item in `PENDING.md`, raised 2026-08-16
   from a live device. The decode happens at *arrival*, where nobody is waiting, so `loudnorm`'s
   cost is affordable exactly here and nowhere else. This is what stops one relative arriving at a
   whisper and the next at a shout.

5. **Consider `afftdn` on capture** — measured to pay for itself in encode time. Worth trying only
   after 1–3, because much of what it would be removing is what the gain fix and the high-pass
   already take out, and a denoiser working on a clipped signal cannot help.

Not recommended yet: **corrective EQ for the 400–800 Hz lift** (Finding 3), until a measurement
exists that separates the microphone from the speaker.

Untested by any of this: whether the microphone is mechanically coupled to the enclosure. If it is
rigidly mounted rather than gasketed at a port, that is a mechanical fix no filter substitutes for,
and it belongs in [`hardware.md`](./hardware.md).
