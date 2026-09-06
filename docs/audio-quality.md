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
signal window from the same take. Room drift moves both windows together and cancels out of the
difference.

Three stimuli, and the second and third exist because the first cannot answer everything:

1. **The HAT's own speaker**, playing a 150 Hz → 3.5 kHz sweep. Convenient, but it measures the
   round trip and cannot separate the speaker from the microphone.
2. **The MacBook beside the box**, playing the same sweep. A completely different transducer, so
   whatever survives the swap belongs to the microphone and enclosure. This is what settles
   Finding 3.
3. **The MacBook playing real speech** (macOS `say`), which is what settles whether a *voice*
   clips — a question no sweep can answer, because the sweep is louder than a person.

Window alignment is found by profiling the recording second by second rather than assumed from a
sleep: SSH start-up latency put the first attempt's "silence" window on top of the sweep, which
showed up as a silence window 24 dB louder than the signal.

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

This was first measured with the HAT's own speaker, which is louder than a child talking and so
could not settle whether a *voice* clips. It was then repeated with real speech — macOS `say`,
played from the MacBook beside the box, at a normal listening level:

| `Capture` | peak | RMS |
| --------- | ---- | --- |
| **63** (shipped) | **0.00 dBFS — clipping** | −16.5 dB |
| 49 | −10.7 dB | −26.7 dB |
| 39 | −18.1 dB | −33.9 dB |

A real voice at a realistic level clips at the shipped gain. This is no longer an inference from a
loud stimulus.

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

## Finding 3 — a mid peak, and it is the microphone side

*Originally recorded here as unattributable. Resolved the same day by using the MacBook beside the
box as a second, completely different source — the obvious control that the first round missed.*

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

Taken alone that curve proves nothing, because the sweep went out through the HAT's own small
speaker and came back through the microphone: it is the *round trip*, speaker and enclosure and
microphone multiplied together, and a child's voice never passes through the speaker at all.

So the sweep was repeated from a **different transducer entirely** — the MacBook sitting beside the
box — recorded on the box microphone, both at `Capture` 32. Normalising each curve to its own
800–1600 Hz band, so only the *shape* is compared:

| Band | via HAT speaker | via MacBook speaker |
| ---- | --------------- | ------------------- |
| 100–200 Hz | −25.9 | −5.9 |
| 200–400 Hz | −8.3 | +2.6 |
| **400–800 Hz** | **+2.6** | **+4.5** |
| 800–1600 Hz | 0 (ref) | 0 (ref) |
| 1600–3200 Hz | −1.9 | −7.3 |
| 3200–6400 Hz | −11.4 | −25.7 |

**The 400–800 Hz lift survives the change of source.** Two unrelated speakers, the same peak, so it
belongs to what they have in common: the microphone and the enclosure around it. That is the boxiness.

The bands that *disagree* are the ones that should. The HAT's speaker cannot reproduce 100–200 Hz
and the MacBook can, which is the 20 dB gap at the bottom; the top octave is past the sweep's
3.5 kHz end and differs by distance and air absorption. Those differences are the control working —
if every band had matched, the comparison would be measuring the microphone twice and saying nothing.

A corrective EQ is now justified in principle. It is still not specified here, because the depth and
Q of the notch should come from a measurement of the mounted microphone rather than from an octave
table this coarse.

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

## Finding 5 — the proposed chain, measured end to end on real speech

Same recording throughout: macOS `say` played from the MacBook, captured at `Capture` 49, with a
voice window and a silence window taken from the one take.

| Voice window | peak | RMS |
| ------------ | ---- | --- |
| raw — what would be sent today | −10.7 dB | −26.7 dB |
| `+ highpass=110` | −11.4 dB | −27.0 dB |
| `+ highpass + speechnorm` | −0.4 dB | **−14.4 dB** |
| `+ highpass + afftdn + speechnorm` | −0.4 dB | **−14.7 dB** |

| Silence window — this is the audible hiss | peak | RMS |
| ----------------------------------------- | ---- | --- |
| raw | −34.4 dB | −46.7 dB |
| `+ highpass=110` | −35.2 dB | **−50.4 dB** |
| `+ highpass + afftdn` | −47.2 dB | **−62.4 dB** |

Read together:

- The high-pass takes **3.7 dB off the noise and 0.3 dB off the voice**, which is Finding 2 holding
  up under a real signal rather than a sweep.
- `speechnorm` recovers **12 dB** of level, so backing the preamp off costs nothing in loudness.
  The processed voice ends up *louder* than the clipped recording at the shipped gain
  (−14.4 dB against −16.5 dB RMS) while peaking at −0.4 dBFS instead of hard against the rail.
- `afftdn` removes a further **12 dB** of noise and leaves the voice level alone
  (−14.7 against −14.4 dB), on top of making the encode faster.

Against what ships today, the whole chain is louder, undistorted, and roughly 16 dB quieter between
words.

Two cautions on those numbers. Measuring noise reduction on a silence window flatters a denoiser,
which behaves differently while someone is speaking — the 12 dB is not a perceptual SNR gain of
12 dB. And `speechnorm` at its default peak target lands at −0.4 dBFS, which is too close to the
rail to survive an Opus round trip cleanly; it should be given an explicit lower target
(`p=0.7`, about −3 dBFS) rather than shipped as measured here.

## What was implemented

Everything below became `CAPTURE_FILTER_CHAIN` and `PLAYBACK_FILTER_CHAIN` in
[`src/audio/ffmpeg.ts`](../box/software/src/audio/ffmpeg.ts) on 2026-09-06:

| | Chain |
| --- | ----- |
| outgoing | `highpass=f=110,afftdn=nf=-30,speechnorm=e=6.25:r=0.0001:l=1:p=0.7` |
| incoming | `loudnorm=I=-16:TP=-1.5:LRA=11` |

with `audio.micGainPercent` defaulting to **65** instead of 80, and two switches —
`audio.enhanceCapture` and `audio.normalisePlayback` — in the admin panel's Audio card so the
whole thing can be A/B'd on a real device without a rebuild.

The chains are constants rather than config strings on purpose: each term is a measured result,
not a preference, and a free-text ffmpeg filter in a config a parent can edit is a way to make the
box silently stop recording.

`micGainPercent` is the one number **not** settled by measurement, only bounded by it. 100 is
wrong. 65 leaves about 10 dB of headroom against a MacBook speaker at a normal level, and a child's
mouth is not a MacBook speaker — the value wants confirming by ear, which is what the switches and
the number field are for.

## The reasoning behind each, in order of value

1. **Stop clipping the input.** Lower `micGainPercent` from 100. It is already a config field and
   needs no code — the daemon applies it as `amixer -M sset Capture <n>% cap`. Measured mapping:

   | `micGainPercent` | raw | dB |
   | ---------------- | --- | -- |
   | 100 | 63 | +30.00 |
   | 80 | 57 | +25.50 |
   | 60 | 49 | +19.50 |
   | 40 | 39 | +12.00 |

   **Start at 60–70.** With real speech at a normal level, `Capture` 49 (= `micGainPercent` 60) put
   peaks at −10.7 dBFS, which is ample headroom for a child who leans in closer or shouts, and
   `speechnorm` makes the level back up afterwards. A child's mouth is not a MacBook speaker, so
   this is a starting point to confirm by ear, not a final answer — but 100 is settled as wrong: it
   clips on room tone alone and buys no SNR.

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

5. **`afftdn` on capture** — promoted from "consider" by Finding 5: a further 12 dB off the noise,
   no measurable cost to the voice, and it makes the encode faster rather than slower. Still applies
   only after 1–3, because a denoiser cannot help a signal that is already clipped. `nf` wants
   tuning against a real noise floor; −30 was used here without being optimised.

6. **A gentle cut around 400–800 Hz**, now that Finding 3 attributes the lift to the microphone and
   enclosure rather than to the HAT's speaker. Left unspecified deliberately: an octave table is too
   coarse to set the depth and Q of a notch, and this is the one change that can make things worse
   if fitted to the wrong curve.

Untested by any of this: whether the microphone is mechanically coupled to the enclosure. If it is
rigidly mounted rather than gasketed at a port, that is a mechanical fix no filter substitutes for,
and it belongs in [`hardware.md`](./hardware.md).
