# Architecture

How the software is put together, and why. [`PRODUCT.md`](./PRODUCT.md) is the behavioural
specification — what the device does. This page is the shape of the code that does it, plus the
decisions the spec left open.

[`CLAUDE.md`](../CLAUDE.md) covers the same ground from the other direction: the toolchain traps,
the conventions and the rules you have to follow when changing this codebase. Where the two
overlap, CLAUDE.md is the operative one for making a change and this is the one for understanding
the system.

---

## Three processes, and what each is allowed to touch

```
┌─────────────────────────── Raspberry Pi Zero 2 W ────────────────────────────┐
│                                                                              │
│  ┌────────────────────────────┐                 ┌─────────────────────────┐  │
│  │ bloopbox-hardware          │  Socket.io      │ bloopbox-whatsapp       │  │
│  │ hardware-server.ts         │ ◄────────────►  │ whatsapp-bridge.ts      │  │
│  │ user: bloopbox             │  /bridge        │ user: bloopbox          │  │
│  │                            │  localhost only │                         │  │
│  │ • Express + Socket.io      │                 │ • Baileys socket        │  │
│  │ • HAL: buttons, LEDs, audio│                 │ • media up/download     │  │
│  │ • LED animation            │                 │ • contact whitelist     │  │
│  │ • record / play / purge    │                 │ • read receipts         │  │
│  │ • config, admin API, portal│                 │                         │  │
│  └───────────┬────────────────┘                 └─────────────────────────┘  │
│              │ reads                                                         │
│              ▼                                                               │
│      /run/bloopbox-net/net-state.json                                        │
│              ▲ writes                    ┌─────────────────────────┐         │
│              └──────────────────────────  │ bloopbox-net            │         │
│              ┌──────────────────────────► │ deploy/net-agent.sh     │         │
│              ▼ reads                     │ user: root              │         │
│      /run/bloopbox/net-request.json      │ • nmcli, AP up/down     │         │
│                                          │ • reboot / poweroff     │         │
│                                          └─────────────────────────┘         │
└──────────────────────────────────────────────────────────────────────────────┘
```

Each process exists because of something it is **not** allowed to do.

**Process 1 — hardware and web server** (`src/processes/hardware-server.ts`) owns everything
physical and everything a browser talks to. It never imports Baileys.

**Process 2 — the WhatsApp bridge** (`src/processes/whatsapp-bridge.ts`) owns the WhatsApp socket
and nothing else. It never touches GPIO or audio devices. It is deliberately **not** `BindsTo` the
hardware unit: WhatsApp is an unofficial API on a release candidate, and a crash there must not
take the buttons and lights with it.

The two talk over Socket.io on localhost — process 2 connects to process 1's server as a *client*,
on the `/bridge` namespace, authenticated with a shared `BRIDGE_TOKEN` compared in constant time.
The event contract is [`src/ipc/events.ts`](../box/software/src/ipc/events.ts) and is the single source of truth
for both sides: adding an event means editing that file first.

**Request ids carry a random per-boot prefix** (`send-<boot>-<n>`, `createRequestId`). The bridge
outlives the hardware server, which restarts on every config save and counts from 1 again, so
without it a result still in flight for the previous boot's `send-1` would resolve this boot's
`send-1` — a note reported delivered that never left the box.

**Networking sits outside both.** The daemons run unprivileged under `ProtectSystem=strict`, so
they cannot talk to NetworkManager and should not be able to. A third unit, `bloopbox-net.service`,
runs [`deploy/net-agent.sh`](../box/software/deploy/net-agent.sh) as root, polls `nmcli` every 5 s and publishes
one small JSON document. Requests go back the other way through a second file carrying a strictly
enum-validated action (`ap-up` | `ap-down` | `join {ssid, psk}` | `forget` | `reboot` | `poweroff`),
never evaluated as shell.

**The last two are not networking, and that is on purpose.** The box has no power button, and
pulling the plug is what lost an unread note (`PRODUCT.md` §8) — so shutting down cleanly has to be
possible from the admin panel, and this agent is the only process in the product running as root.
Adding a second request file beside the first would not add a boundary: **the allowlist in
`consume_request` is the boundary**, it always was, and it is now guarding an action that can power
the machine off. `src/system/power.ts` writes them, deliberately apart from `src/net/netState.ts` so
the module names stay honest about what each one is for.

`systemctl reboot` / `systemctl poweroff`, never `--force`: the ordinary path is what sends the
daemons a SIGTERM, and that is what flushes the activity counters and finalises anything mid-write.

| File                              | Written by | Read by |
| --------------------------------- | ---------- | ------- |
| `/run/bloopbox-net/net-state.json` | the agent (root) | the daemon |
| `/run/bloopbox/net-request.json`   | the daemon | the agent (root) |

**Two directories, exactly one writer each.** That is deliberate: the agent must never end up
owning `/run/bloopbox`, which is the recordings tmpfs the daemon has to be able to write. It is also
why **the agent acknowledges a request instead of deleting it**: the daemon's directory is
read-only to it under `ProtectSystem=strict`, so it publishes the id of the last request it acted
on (`handledRequestId`), and the daemon deletes its own file once it sees that id.
`docs/deployment.md` has the steps.

### Missing information is never an outage

[`src/net/netState.ts`](../box/software/src/net/netState.ts) is the **only** way the daemon learns whether Wi-Fi
is up. A missing file, an unparseable one, a reading older than 30 s, or an agent that found no
`nmcli` all mean *unknown*, and unknown is reported as **not down**. Only a fresh reading that
explicitly says the network is gone lights the error pattern.

Inventing an outage from silence would light all three LEDs on every dev machine and on any device
whose agent died. This is the first thing to know when debugging a device that "won't show the
error".

---

## The HAL

All physical I/O — buttons, LEDs, **and audio in and out** — sits behind one interface,
[`src/hal/types.ts`](../box/software/src/hal/types.ts). Three drivers:

| Driver             | Used for                                                                   |
| ------------------ | -------------------------------------------------------------------------- |
| `simulatorDriver`  | A virtual device in the browser, over Socket.io. How this was all developed |
| `gpioDriver`       | The real Pi: opengpio for pins, `arecord`/`aplay`/`amixer` for audio        |
| `mockDriver`       | Tests. Records every `setLed` call with a timestamp                        |

`SIMULATOR_MODE=true` selects the simulator; `HAL_DRIVER=mock` wins over it; otherwise `gpio`.

`opengpio` is an **optionalDependency** that does not build on macOS, so
[`src/hal/index.ts`](../box/software/src/hal/index.ts) loads the GPIO driver through a dynamic `import()`. Never
import it statically — importing the HAL factory has to stay safe on a dev machine.

`gpioDriver.ts` has run on the reference board — a Pi 3B+ with the WM8960 HAT, three buttons and
three lamps (`box/software/CLAUDE.md` § Hardware status). Only button 1 and audio are recorded as
proven; buttons 2–3, the lamps and the Zero 2 W are not yet, so do not add code paths that only
work with real GPIO.

### Domain logic is pure

Everything in `src/core/` is I/O-free. It consumes events and timings, and its only outward call is
`hal.setLed()`. **`src/tests/architecture.test.ts` enforces it:** nothing core reaches, directly or
through another module, may import a Node built-in other than `node:events`, a package other than
`zod`, or the server, network, system, stats, WhatsApp, real-HAL or `ConfigManager` modules.

Two things core needs from outside arrive as options rather than imports. The config is a
`ConfigSnapshot` — just `{ current }`, which `ConfigManager` satisfies — and deleting a note's file
is `deleteFile`, which the hardware server makes `rm(path, { force: true })`. Until 2026-10 the
controller imported `rm` itself; the architecture test is what found it.

| Module                | Owns                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| `buttonInterpreter`   | Raw button edges → intents: tap, record, carry on, refuse, the silent chord |
| `ledAnimator`         | Device state → LED frames, on a 50 ms tick                                  |
| `deviceState`         | The observable state, in one place, with change notification                |
| `networkSupervisor`   | When the setup hotspot goes up and when it steps aside                      |
| `quietHours`          | Whether now falls inside the window, read in the configured IANA zone       |
| `deviceController`    | The wiring: intents in, capture / playback / cues / LEDs out                |

**A failure core swallows is still reported.** The controller catches everything on the interaction
path — one failed microphone must never break the next press — and used to drop it, so on a real box
a failure produced an "oops" and nothing in the journal. Every such catch now calls the `onFault`
option with a `DeviceFaultKind` (`capture-start`, `capture-finalise`, `capture-empty`,
`capture-cancel`, `send`, `playback`, `cue`, `delete`), the button, the error and a little detail.
It is a structural callback like `StatsRecorder`, so core still does no I/O: the hardware server
logs each one at `warn` as `device fault`. The routes take the same approach with an optional
`log` in `RoutesContext`, so every 4xx/5xx that stands for a failure leaves its reason in the
journal. The rule for new code: **a catch that swallows must report**.

That purity is the whole reason the timing behaviour is testable on fake timers with no hardware
and no sleeping. Keep it that way — `deviceController` is where I/O is allowed to appear.

---

## The LED priority ladder

`PRODUCT.md` §6 lists the patterns independently, but they collide in practice: a send flash wants
LED 1 at the same moment an unread message does. `resolveLed()` in
[`src/core/ledAnimator.ts`](../box/software/src/core/ledAnimator.ts) is the single place that arbitrates, and it
resolves **per LED, first match wins**:

| # | Condition                                                                   | Result                       |
| - | --------------------------------------------------------------------------- | ---------------------------- |
| 1 | Recording on this button                                                    | Solid on                     |
| 2 | An active one-shot animation (sent flash, silent-mode transition chase)     | That animation's frame       |
| 3 | Lifecycle status: boot chase, connecting blink, hotspot double-pulse, errors | That pattern                 |
| 4 | An unread message on this button                                            | Blink 0.8 s on / 0.8 s off   |
| 5 | otherwise                                                                   | Off                          |

**Silent mode is not a rung.** It used to hold one — a 0.1 s pulse every 4 s on the outer pair, so a
parent could read the mode at a glance — and that was removed on 2026-09-08: a box that is being
quiet should look quiet too, and any lamp of its own is exactly the thing a dark bedroom does not
want. The only thing the mode ever shows is the moment it flips, as the rung-2 transition chase, and
that includes the scheduled 20:00 / 07:00 edges.

Within rung 3, the statuses are mutually exclusive — one `DeviceStatus` each — and their relative
order lives in `hardware-server.ts`. The **setup hotspot ranks above the Wi-Fi error**: with the
hotspot up, "the network is gone" is the cause and "setup is waiting for you" is the part a parent
can act on.

Physical presses are layered on top of all of it: `setPressed()` forces a held button solid, so a
child gets acknowledgement in the same instant they push. Pinned by
[`src/tests/ledPriority.test.ts`](../box/software/src/tests/ledPriority.test.ts).

Timing constants live in `LED_TIMINGS`, exported so the tests assert against the same numbers the
runtime uses. Only changed LEDs are written — a steady state costs one comparison per tick, which
matters on the GPIO driver where every write is a syscall.

### Solid means error; nothing in the ladder has a chime

The hotspot double-pulse is a **rhythm**, not another rate. Every other pattern here is a symmetric
square wave or a chase, and people tell a heartbeat from a blink across a room far more reliably
than they tell 0.5 s blinking from 1.5 s blinking. Solid-on stays the language of error.

There is deliberately no sound attached to any *status* here. The hotspot can come up at 3am because
the router died, and a chime in a child's bedroom is the worse failure. Status is a condition that
persists, so the light carries it and nothing has to be heard to learn it.

### The boot animation is held on purpose, and it has a sound

The daemon derives its status from Wi-Fi and WhatsApp health, which resolves instantly, so
`BOOTING` would never be visible even though §6 defines a chase for it. `BOOT_ANIMATION_MS`
(2.6 s) holds it, and the simulator has a **Reboot** injector to replay it, since a browser opened
after startup would otherwise never see it.

Coming up is the one lifecycle event that does make a noise (`boot.wav`, PRODUCT.md §7), and it is
the exception the paragraph above is worth reading against. A boot is a **transition, not a
condition**: it happens once, it is over in under a second, and the LED chase that expresses it is
only visible to someone already looking at the box. The thing a parent actually wants to know after a
power cut — *did it come back by itself?* — has no other channel on a device with no screen. The 3am
objection still applies, and is answered by suppression rather than by silence: the boot cue is
gated by `shouldPlayCue` like every other courtesy sound, so scheduled quiet hours and the silent
chord both mute it while the chase runs regardless.

`DeviceController.announceBoot()` owns the decision and the hardware server's `beginBoot()` is the
only caller, used for both the real boot and the simulator's replay — one function, so the sound and
the chase cannot drift into disagreeing about what booting is.

---

## Tap, hold, and the carry-on window

`PRODUCT.md` says a short press is the "oops" cancel *and* that a tap plays unread messages. That is
resolved by press duration and unread state:

Write `MESSAGE_MS` for `recordThresholdMs + minRecordingMs` — 1150 ms with the shipped defaults, and
the actual boundary between the two gestures:

| Press duration              | Unread present | Result                                                           |
| --------------------------- | -------------- | ---------------------------------------------------------------- |
| `< debounceMs`              | either         | Ignored entirely — a toddler brushing it                         |
| `debounceMs` – `MESSAGE_MS` | yes            | Play that contact's queue                                        |
| `debounceMs` – `MESSAGE_MS` | no             | "Oops" double-beep, nothing sent                                 |
| `≥ MESSAGE_MS`              | yes            | **Refused**: `recordBlocked`, and the "oops". Listening first is the rule |
| `≥ MESSAGE_MS`              | no             | Record; stays open for `resumeGraceMs` after release, then sends  |

`recordThresholdMs` sits *inside* the tap window at 150 ms, and crossing it is not what decides the
gesture — it is only where the bip plays and the microphone opens. A tap longer than that therefore
bips and opens a microphone that catches nothing; the take is discarded and the press falls through
to the tap rows above. That fallback is what keeps tap-to-play reachable, and without it lowering the
threshold to make the bip prompt would have made every press over 150 ms a recording.

`minRecordingMs` went from 500 ms to **1000 ms** on 2026-09-08, after a child playing with the
buttons sent a run of empty notes — the reasoning is in `PRODUCT.md` §1, step 6. It doubled the tap
window in the process, which is why the rows above matter more than they used to.

### A blinking button does not record

The fourth row is the whole of it: while notes are waiting on a button, that button only plays.
`ButtonInterpreter` already asks `hasUnread(index)` at release to choose between the queue and the
"oops"; the rule adds one more reading of the same question at `recordThresholdMs`, where a
positive answer **withholds the microphone** instead of opening it.

Withholding, rather than refusing on the spot, is the part worth keeping straight:

| | `readOnly` | `unread` |
| - | ---------- | -------- |
| Microphone | Never opens | Never opens |
| When the child is told | At `recordThresholdMs` | At release |
| Why then | The box can never send; nothing further is knowable, and the bip moment is where an answer is worth most | A press is not a hold until `MESSAGE_MS`; answering earlier would refuse every tap over 150 ms and make a blinking button unplayable |

Both arrive as `recordBlocked`, carrying a `reason`, and `deviceController` answers both with the
"oops" — with one exception it makes itself: while a note from that queue is *playing*, the refusal
is silent, because cues and playback share one output and an "oops" would talk across the message.

Two things the rule deliberately does not do. It does not play the queue as well — answering "that
did not send" and then handing over the message rewards the refused gesture and teaches that holding
plays, which is the one distinction the device rests on. And it is not re-read after the threshold,
so a note arriving mid-sentence cannot cancel a take already in progress.

Behaviour and the reasoning about what the child hears: [`PRODUCT.md`](PRODUCT.md) §1, "Listening
comes first". Locked by the unread blocks in
[`src/tests/button.test.ts`](../box/software/src/tests/button.test.ts) and
[`src/tests/deviceController.test.ts`](../box/software/src/tests/deviceController.test.ts).

**These are configuration, not constants.** They live in `config.buttons` and are editable from the
admin panel, because finding the right feel by editing source and rebuilding was far too slow.
`DEFAULT_BUTTON_TIMINGS` in [`src/config/schema.ts`](../box/software/src/config/schema.ts) is derived from the
schema's own field defaults, so nothing can drift.

Two rules, because both break the device in ways a parent could not diagnose:

- `debounceMs` **must** be below `recordThresholdMs`, enforced by the schema. Without a gap the bip
  could never precede a recording.
- Held time decides the gesture, but a committed take still has to *contain* something: below
  `MIN_USABLE_AUDIO_MS` (150 ms, in `deviceController`) it is a failed capture and answers "oops".
  That one is not configurable — it separates "the microphone produced audio" from "the microphone
  produced nothing", which is not a feel judgement a parent could have an opinion about.

### A released recording stays open for a moment

A toddler's grip slips. Committing on the release edge means half a sentence ships with no way to
continue it, so a **confirmed** recording is held open for `resumeGraceMs` (400 ms) after the button
comes up, and pressing the same button again inside that window resumes the *same* take.

The capture is never stopped across the gap — one handle, one file, no concatenation, and no
driver-side work at all. The gap's room noise lands in the message, which is what a paused speaker
actually sounds like and is bounded by the window. Stitching separate segments together was the
alternative and is disproportionate.

Rules, all locked by [`src/tests/button.test.ts`](../box/software/src/tests/button.test.ts):

- Only a press that already **carries a message** opens a window. A tap never does — including one
  held past `recordThresholdMs`, since there is nothing to carry on and waiting `resumeGraceMs`
  before playing the queue would be latency for its own sake.
- `maxRecordingSeconds` is **not** restarted by a resume — the ceiling is carried across, so
  pumping the button cannot grow a file in the RAM disk. If it fires mid-window, the take commits
  there.
- A **different** button going down during the window is ignored (the lockout, below); the take
  commits when the window expires, as if nothing had happened. That also keeps the silent-mode
  chord out of this path entirely.
- `reset()` drops an open window silently, exactly as it already dropped an in-flight press.
- `resumeGraceMs: 0` restores commit-on-release.
- The reported `durationMs` is time actually held, first press to final release. The trailing
  window is not speech and is not counted.
- The `durationMs` the **HAL** returns from `stopRecording` is a different number: how much audio
  the file holds. `GpioHal` computes it from the capture WAV's size, `(size − 44) / (rate × 2 ×
  channels)`, and the simulator probes the encoded file. The microphone stays open through the
  window, so it includes that tail. It used to be `Date.now() − startedAt` taken after the encode,
  which counted the stop and the encode as audio. A microphone that delivered nothing still
  reported seconds, `MIN_USABLE_AUDIO_MS` could never catch it, and the sent totals ran high.

No cue marks the resume and none is needed: the LED never goes out. `pressVisualOff` still fires on
release, but ladder rule 1 keeps the light solid, so **solid means "still listening"** and the
whoosh still means "gone".

### Cue timing: the box's own sounds must not end up inside the message

The speaker sits centimetres from the microphone, so **every cue that plays while a capture is open
is recorded into the message**. Both ends of a take are shaped by that, and neither was obvious until
a real device recorded itself:

- **The bip plays first, and the microphone opens behind it.** `#beginCapture` awaits `playCue(Pop)`
  before calling `startRecording`, both inside the promise stored in `#captures`. The pop used to
  fire over an already-open microphone 500 ms into the take, landing on the child's first word.
- **`#commitCapture` finalises the capture before playing the whoosh**, for the same reason at the
  other end — playing it first recorded it into the tail of every message.

The cost of the first is real and deliberate: nothing said before the bip exists, so the bip has to
be *prompt*, which is why `recordThresholdMs` is 150 ms and why the tap/hold boundary had to move off
it (above). The LED still goes solid at press, so acknowledgement is instant and unchanged.

A second consequence, worth naming because it looks like an accident: the bip is now the only cue
that can overlap a capture *opening*, so a release during those 90 ms cancels a capture that does not
exist yet. That is exactly the case `#captures` stores a promise for, and it is the reason the map
holds `Promise<RecordingHandle | null>` rather than the handle. Awaiting that promise was not enough
on its own: the discard waited for the bip, and the bip then opened a microphone for a press that was
already over — on top of the "oops" the release had just played, or after `stop()`. Each entry
therefore carries a **cancel token** beside the promise. `#discardCapture` sets it before it awaits,
the promise checks it between the bip and `startRecording`, and a cancelled capture resolves `null`
without opening anything. `stop()` discards every capture in flight the same way, because
`ButtonInterpreter.reset()` drops presses without emitting a cancel.

A send makes **one** sound. The whoosh means "sent"; delivery is the lamp flashing. A designed
"delivered" swoosh used to follow the whoosh and the two read as noise rather than as two facts, so
it was retired (`PRODUCT.md` §7). Only a failure adds a second sound.

### One button at a time: the lockout

A toddler holding one button grabs at the others. Before the lockout each button was tracked
independently, so a grab opened a second take beside the first, answered with an "oops" or a queue
mid-sentence, or — during the carry-on window — committed the first take early. Now one button
**owns** the box while it is held or its take is waiting out `resumeGraceMs`, and every other press
is ignored whole: down edge, release, everything between. Rules, locked by
[`src/tests/button.test.ts`](../box/software/src/tests/button.test.ts):

- **A press that began under the lock is never adopted.** It stays in `#ignored` until its own
  release, even if the owner finishes first — promoting it mid-hold would start a take whose first
  second the child never meant.
- **Its release is invisible**, including to the chord: an ignored release does not disarm it.
- **The chord partner is the only exception**, and only while the owner is short of a message
  (`recordThresholdMs + minRecordingMs`, the tap boundary). No new constant: a parent pressing the
  outer pair presses them together, and past that boundary the owner is a child talking. A resumed
  take carries its first press's start, so it is always past it.
- **Playback owns the box too.** While a queue plays, every other button is ignored the same way,
  the chord included — a parent waits for the note to end. Before this a hold on another button
  played the bip and opened a microphone beside the speaker, recording the incoming message into an
  outgoing one, and a tap played the "oops" over it. The interpreter asks through a
  `listeningTo()` query, like `hasUnread`, so `core/` stays pure. `DeviceController` answers from
  its own `#listeningTo`, set in the same tick as the tap and cleared in `#playQueue`'s `finally`,
  not from `state.playing` — that is only set when the first note starts, after the capture
  teardown `#playQueue` waits on, and a press in that gap would slip through. The playing button
  itself stays on its ordinary path, which is already inert while its queue plays.
- `reset()` clears the ignored set with everything else.
- **A press whose release never arrives is dropped** after `stuckPressMs()` —
  `maxRecordingSeconds` plus one `resumeGraceMs`, longer than any real press. Only a button-up
  ends a press that opened no microphone (refused, withheld or swallowed by the chord), and under
  the lockout that press also silences the other two buttons, so one lost edge would freeze the
  box. The drop is silent apart from `pressVisualOff`, because the child let go long ago. A
  recording never reaches it: the ceiling ends it first and sends it. An ignored button's lost
  release expires on the same clock, so it costs one press at most.

### The silent chord

Buttons 1 and 3 held together for `silentComboMs` toggles silent mode. Both presses are swallowed
the instant the chord forms, so a child mashing the outer buttons can never send two voice notes.
If the chord is released early, nothing at all happens — no send, no cancel beep.

The chord toggles the **effective** state, so during scheduled quiet hours it lets a parent force
audio back on without editing the schedule. The override is `DeviceState` clearing its scheduled
flag, and it holds only because `DeviceController` applies the schedule on an **edge**: it
remembers what the window said at the last evaluation and calls `setScheduledSilent` only when
that changes. The timer still wakes at least every 15 minutes (`QUIET_HOURS_MAX_SLEEP_MS`) to
catch clock and DST changes, but a wake inside the same window changes nothing, so the override
lasts until the next boundary. The sleep itself is `msUntilNextTransition`, to the millisecond —
counting whole minutes landed the boundary up to 59 s late.

---

## Configuration

`/data/config.json`, validated by a Zod schema that is also the single source of truth for the
TypeScript types. Never hand-write a parallel interface — add the field to
[`src/config/schema.ts`](../box/software/src/config/schema.ts) and the type follows.

The schema guards both directions: reading the file at boot (a corrupt file falls back to
`config.default.json` **in RAM** and boots into onboarding, never crashing the daemon) and writing
from the admin API or the portal (bad input is rejected, not persisted). A toddler's only interface
is three buttons, so a bad config cannot be diagnosed or corrected by the user. Validation is the
safety net.

Writes are **atomic**: a temp file named for that write alone → `fsync` → `rename` → `fsync` the
directory (`src/config/atomicWrite.ts`). A half-written config during power loss would brick the
device. The directory fsync makes the rename itself durable. Without it, a power cut can bring back
the old directory entry, and a save the panel reported as done is silently undone at the next boot.
A failed write removes its temp file.

Writes are also **serialised**. `save`, `update` and `factoryReset` run one at a time through a
`SerialQueue`, and `update` merges *inside* the queue. Two admin tabs saving at once used to merge
over the same `current`, so the second silently undid the first, and their temp files, which shared
one fixed name, truncated each other.

### Activity totals are a separate file, for a reason that is not tidiness

`/data/stats.json`, written by [`src/stats/statsStore.ts`](../box/software/src/stats/statsStore.ts). Sitting
beside `config.json` and never inside it, because the two properties above make a counter
impossible there:

- **Saving config restarts the daemon.** A counter kept in it would reboot the box every time a
  child pressed a button.
- **An unparseable config drops the device into onboarding**, costing a parent their contacts. An
  unparseable stats file must cost the totals and nothing else, so every field carries a Zod
  `.catch()` — the same two-tier treatment `netState.ts` uses, and for the same reason.

Writes are atomic like the config's, and **coalesced**: a change schedules one write two seconds
later, so a burst of arriving notes is one erase cycle on the card rather than ten. That delay is
exactly why `flush()` exists and why every path that ends the process calls it — a config save, a
SIGTERM, and the reboot and shutdown requests before they are handed to the root agent.

Writes chain one after another, and **every `flush()` waits for a write that covers what it asked
for**. Two flushes that overlapped used to let the second return before the first write had
landed, because it found `dirty` already cleared, and the process could exit mid-write. A failed
write marks the totals dirty again, so the next change or the shutdown `flush()` retries it instead
of treating the stale file as current.

**`src/core/` still does no I/O.** `DeviceController` takes a `StatsRecorder` — three synchronous
methods, structurally typed so nothing in `core/` imports the store — exactly as it already takes
`send` and `markRead`.

What counts, and what deliberately does not:

| Event | Counted | Why |
| ----- | ------- | --- |
| A send WhatsApp accepted | yes, with its duration | |
| A send that failed | **no** | The child already heard the "oops". A total that grew anyway would say the button works |
| A note arriving (`handleIncoming`) | yes | |
| A note the boot scan puts back (`restoreUnread`) | **no** | Every unheard note is restored on every restart, and this device restarts on every settings save |
| A redelivered note | once | The queue decides, not the arrival — `restoreUnread` returns false the second time |
| A queue draining | yes, by message count | Independent of `whatsapp.markPlayedAsRead`: whether the *sender* is told is a privacy decision, what this box counts for its own panel is not |

### Snapshot at boot; saving restarts the daemon

`DeviceController` reads configuration when it is constructed and never re-reads it. Writing
settings makes the hardware server exit cleanly (code 0) so a supervisor brings it back with the
new values — `requestRestart()` in `hardware-server.ts`.

There is deliberately **no live-reload path.** Applying some values live and others only on restart
produces states no test covers and no user can reason about: new button timings against a stale
speaker volume, say. A restart is a couple of seconds on this device and leaves exactly one code path.

| Context                | Supervisor                                                                        |
| ---------------------- | --------------------------------------------------------------------------------- |
| Device                 | systemd, `Restart=always` in `deploy/systemd/bloopbox-hardware.service`            |
| `npm run dev:hw`       | `scripts/dev-server.ts`, a ~60-line respawner                                     |
| `npm run dev:hw:watch` | **nothing** — `tsx watch` will not restart a process that exits cleanly, so a config save leaves the server down |

`Restart=always` is therefore load-bearing on the device. Without it, saving a setting would simply
switch the device off.

**Every exit goes through `Shutdown`** (`src/processes/shutdown.ts`), in both daemons: a config-save
restart, SIGINT/SIGTERM, an `unhandledRejection`, an `uncaughtException`, and a failed startup. It
arms a fallback exit (`SHUTDOWN_TIMEOUT_MS`, 5 s, inside the units' `TimeoutStopSec=10`) *before*
the first step, and runs each teardown step in its own try/catch, so a step that throws cannot leave
the lamps lit or the totals unwritten, and one that hangs cannot hold the process until systemd
kills it. The handlers are installed on the first line of `main()`. A clean exit is code 0 and a
crash is code 1: both restart under `Restart=always`, but only one reads as a crash in the journal,
and a crash during a clean restart still reports as one.

### Patches are partial all the way down

`PUT /api/config` accepts **any subset of any section, to any depth**. `configUpdateSchema` is
partial throughout, `mergeConfig` merges field by field, and the cross-field rules (debounce <
threshold, an enabled contact has a target) are enforced by `ConfigManager.save()` against the
**merged** config.

That last part is load-bearing: a patch raising `debounceMs` does not carry `recordThresholdMs`,
so the rule can only be checked after merging. Sections with a refinement are written as a plain `…Shape` object
plus a refined `…Schema`, because `.partial()` exists only on a `ZodObject`.

### Adding a section without breaking existing devices

A new **required** section fails validation on a device that already has a `config.json`, silently
falling back to defaults and wiping the parent's contacts. Use `.prefault({})` so an absent or
partial section fills in from the field defaults.

Note `.prefault({})`, **not** `.default({})`: Zod's `.default()` substitutes the literal value
*without* parsing it, so `{}` comes back empty and every field ends up `undefined`.

A section is wired up in **four** places, and missing the last one fails silently. Beyond
`configSchema` and `configUpdateSchema`, both `ConfigPatch` and `mergeConfig` in `configManager.ts`
name every section explicitly — deliberately, since a mapped type cannot express that `contacts` is
patchable two levels deep while `version` is not patchable at all. Forget `mergeConfig` and
`PUT /api/config` validates the patch, answers `200`, restarts the daemon, and **discards the
change**. `whatsapp.markPlayedAsRead` shipped that way for ten minutes; the test that caught it
asserted on behaviour rather than on the response, which is why it caught it.

Cover every migration with a test — see [`src/tests/config.test.ts`](../box/software/src/tests/config.test.ts).
`mode.readOnly` was the next section added after that, on 2026-09-06, and is covered at both ends:
the merge is asserted against the file on disk, and `routes.test.ts` asserts a `PUT` of it reaches
`config.current` — the half that catches a section missing from `configUpdateSchema`, where
`safeParse` silently strips the patch before `mergeConfig` ever sees it.

### Read-only mode refuses in the interpreter, not in the controller

`config.mode.readOnly` is read once at boot and handed to `ButtonInterpreter`, which stops emitting
`captureConfirmed` entirely: at `recordThresholdMs` it emits `recordBlocked` with reason
`readOnly`, and `deviceController` answers that with the "oops". None of the capture events —
confirmed, resumed, commit, cancel — fire at all on a read-only box, so nothing downstream has to
know the mode exists or defend against a capture that should not have been opened.

The unread rule above reuses this path with the other reason. It is the same refusal in every
respect except *when* it can be decided — see the table there.

A **button with no contact** takes the same path per button, with reason `unassigned`: the
controller hands the interpreter a `canSend(index)` query built once from `enabledContacts()` at
boot, and the interpreter checks it at `recordThresholdMs`, after the unread rule — so a button still
holding notes stays playable by a tap. Until 2026-09-30 nothing checked this before the bridge, which
refused the finished take with `no contact assigned to that button`.

Refusing in the controller instead would have meant opening the interpreter's capture path and then
declining it, which leaves the "is there a microphone open" question answered differently in two
places. It is also why the refusal lands at the threshold rather than at release: that is where the
decision is made, and it is where the child is waiting for the bip.

The behaviour and the reasoning about *what the child hears* are in
[`PRODUCT.md`](PRODUCT.md) §1, "Read-only mode".

### A button targets a person **or** a group

`contacts.*.target` accepts either a phone number (normalised to `<digits>@s.whatsapp.net`) or a
group JID ending in `@g.us`. `parseTarget()` is the only place that decides which, and everything
downstream just carries the resulting JID — Baileys addresses both identically.

Normalisation is deliberately strict, because a wrong-but-plausible target is the worst failure this
config has: it validates, it saves, the panel shows the button configured, and the button is
silently dead in both directions on a device with no screen. So separators and one leading `+` or
`00` are stripped, and a **surviving leading zero is rejected** rather than guessed at — a national
trunk prefix with no country code would otherwise be completed into a stranger's number.

Group JIDs are opaque, so nobody can type one. The admin panel offers a picker fed by
`GET /api/whatsapp/groups`, which asks the bridge, which calls `groupFetchAllParticipating()`.

For a group, **membership is the permission.** A parent assigning "the family chat" is accepting
everyone in it; the device cannot filter further without becoming unpredictable to a child. The
speaker is logged but not gated on.

**The field used to be `phone`.** A `z.preprocess` on the contact schema migrates it, because
devices already have a `config.json` using the old name and dropping it would fail validation and
silently reset the parent's contacts.

---

## The server surface

`/api` is the only mutable surface, mounted in `hardware-server.ts` alongside `/audio` (recordings,
for the simulator) and `/sounds` (the cue WAVs).

Everything under `/api` sits behind `requireAdmin` — HTTP Basic against a bcrypt hash in config —
**except** `GET /status`, `GET /whatsapp`, `GET /cues` and `POST /onboard`, plus `GET /wifi/scan`,
which is open only while the hotspot is up or before onboarding. That list is the `OPEN` table in
`adminAuth.test.ts`, each entry with its reason, and the test reads every other route off the
router's own stack and expects a `401` from it: **a new route is gated by default**, and making one
open means arguing for it in that table.

The guard also **stands aside entirely while `system.configured` is false**, or first-run onboarding
could never set a password. Don't "fix" that. It stands aside on an empty `adminPasswordHash` too,
which means a config with `configured: true` and no hash is wide open — a **decided, accepted
risk**, because the guard cannot tell that state from mid-onboarding, and refusing to serve would
make the device recoverable only by pulling the SD card. Both halves are pinned by
[`src/tests/adminAuth.test.ts`](../box/software/src/tests/adminAuth.test.ts); the watch item in `PENDING.md` has
the full reasoning.

**bcrypt runs once per browser, not once per request.** A check costs ~300 ms on a Zero 2 W, on
the same event loop that times the child's button presses, and the panel sends its saved
credentials with every request — several at once on a page load. `AdminAuthenticator` in
`src/server/auth.ts` remembers a success for `ADMIN_AUTH_CACHE_TTL_MS` (5 min), keyed on
SHA-256 of the `Authorization` header and the stored hash, so a new password invalidates every
entry without any explicit flush; identical headers in flight share one verification. Wrong
passwords draw on a **global** token bucket (`ADMIN_AUTH_FAILURE_BURST` = 5, one back every 12 s):
once it is spent an uncached header gets **429 with `Retry-After`** and no bcrypt at all. Global
rather than per address because the LAN offers no identity worth trusting; the cache is consulted
first, so a panel that is already signed in keeps working through somebody else's guessing.

**A password is not a defence against another website.** A browser attaches the parent's saved
Basic credentials to any request for the box, whichever page made it, and several routes take no
body — so a `<form method=post>` anywhere on the internet could factory-reset the device while a
parent browsed. `requireSameOrigin` (`src/server/csrf.ts`), mounted first in `createApiRouter` so
it covers `POST /onboard` too, refuses any non-GET/HEAD/OPTIONS request that carries
`Sec-Fetch-Site: cross-site` or an `Origin` whose host is not the `Host` it was sent to (403), and
any that is not labelled `application/json` (415) — the label a form cannot send and a cross-site
`fetch` cannot send without a CORS preflight this server never answers. That last rule is why the
panel's body-less actions post an empty `{}` as JSON. `same-site` is allowed, because `:80` and
`:3000` on one box are the same site; a missing `Origin` is allowed, because that is curl or a test,
not a browser. The Vite dev proxy keeps the browser's `Host`, so the check holds in development.
`denyFraming` adds `X-Frame-Options: DENY` and `frame-ancestors 'none'` to every response, the HTML
pages included, so nothing can lay the panel under a page of its own and click through it.

`GET /api/stats`, `POST /api/stats/reset`, `GET /api/system` and `POST /api/system/power` are all
admin-gated, and each for a concrete reason rather than by default: the totals name the family's
contacts, the health reading names the network the box sits on, and the last one can turn the device
off. `POST /api/system/power` validates the action against the same two names the root agent
enforces — the agent's allowlist is still the boundary, but a request that reaches the file at all
is one this daemon endorsed. Where no agent is listening the route answers **503 with a sentence
saying so**, not a 500: on a development machine nothing has gone wrong, and "this box cannot power
itself off" is actionable where a generic failure is not.

`GET /api/wifi/scan` uses a looser gate than either: open while the device is unconfigured **or**
while the hotspot is up, admin-gated otherwise. `POST /api/wifi/join` keeps the admin gate even
over the hotspot once the device is configured — a device that lost its router will offer a hotspot
to whoever is in range, and without a password that would be an invitation to move somebody else's
device onto your network.

### Two listeners

The app also listens on **:80** (`PORTAL_PORT`, via `AmbientCapabilities=CAP_NET_BIND_SERVICE`),
because a phone's captive-portal probe asks nowhere else. Off-device that bind fails with `EACCES`
and is logged and ignored.

It is the **same Express app on both ports**, not a second cut-down server — so everything the box
serves has always been reachable on `:80`, and the address a parent is given is simply
`http://bloopbox.local`. `:3000` stays because it is the primary listener, it is what the
development proxy and the smoke test use, and it is the fallback on a box where the privileged bind
did not happen.

**Socket.io answers on both.** It used to be attached to `:3000` only, so at `http://bloopbox.local/`
the panel's live status never connected. `serveSocketsOn` (`src/server/socketListeners.ts`) attaches
the one engine to the portal listener as well, rather than calling `io.attach()` a second time —
that builds a second engine and repoints `io.close()` at it, stranding the first listener's
clients. One engine is one set of namespaces and broadcasts, whichever port a client used; the
bridge still connects to `:3000`, and the captive portal page still uses none of it.

**`/` is the settings panel**, served (not redirected) from `dist/public/admin/index.html`; Vite
emits absolute asset paths, so one file works at both `/` and `/admin/`, and the older path keeps
answering. It used to be a plain 404 — there is no index.html at the static root — which is why the
only address that worked was `<host>:3000/admin/`, a port and a path nobody guesses.

The root route sits **after** the captive-portal middleware, and that order is the whole safety
property: `/` is not a passthrough prefix, so while the hotspot is up a probe for the root is still
302'd to the portal and never reaches the panel. Onboarding keeps the root; the panel only claims it
on a real network. `captivePortal.test.ts` asserts that directly.

The captive-portal catch-all 302s anything it does not own to the portal **while the hotspot is up
and never otherwise**, deliberately failing Android's `generate_204` and Apple's
`hotspot-detect.html` — answering those correctly is exactly what suppresses the sign-in popup.
Wildcard DNS comes from `/etc/NetworkManager/dnsmasq-shared.d/bloopbox.conf`, installed by
`install.sh`.

---

## The four browser UIs

`public/simulator/` (virtual device), `public/admin/` (parent settings), `public/portal/`
(first-boot setup over the hotspot) and `public/brand/` (the living brand kit) are plain TypeScript
on a shared design system. No framework. They live **outside `src/`** and are compiled by Vite, not
tsc.

Three tsconfigs, and the split is what catches mistakes:

| File                 | Checks                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| `tsconfig.json`      | `src/` + `scripts/` — node libs, **no DOM**                               |
| `tsconfig.web.json`  | `public/` — DOM libs, `types: []`, and a whitelist of the shared modules browser code may import (`src/ipc/`, `src/audio/cues.ts`, `src/config/schema.ts`) |
| `tsconfig.build.json`| The emit config                                                            |

`npm run typecheck` runs the first two, so a DOM global in `src/` or a node global in `public/`
fails there and nowhere else.

Vite 8 bundles with **Rolldown**: use `rolldownOptions`, not `rollupOptions`.

The simulator and admin panel speak the same typed contract as the daemons, via `src/ipc/events.ts`.

**The portal is deliberately not on that contract.** It runs in a captive-portal webview where
WebSocket is unreliable and storage is ephemeral, so it is plain `fetch` against
`GET /api/wifi/scan` and `POST /api/wifi/join`, narrowing every response by hand. Keep it that way:
a dependency on Socket.io there is a page that hangs on a phone. **The build enforces the other half
of that:** a plugin in `vite.config.ts` fails `vite build` if the portal's entry chunk imports any
other chunk. Rolldown hoists code two entries share into a common chunk unprompted, so importing
anything the panel imports would quietly add a request. The modulepreload polyfill used to be
exactly that, the one chunk all four pages shared; `build.modulePreload.polyfill` is off, since
every supported browser has native modulepreload.

### The design system

[`BRAND.md`](./BRAND.md) is the direction and the locked decisions; `/brand/` is the living kit,
rendered with the same two stylesheets the product pages use so it cannot drift.

| File                            | Holds                                                                     |
| ------------------------------- | ------------------------------------------------------------------------- |
| `shared/tokens.css`             | Palette, type scale, spacing, radii, motion. **The only file allowed to contain a colour literal** |
| `shared/base.css`               | Every shared component as a CSS class                                     |
| `shared/dom.ts`                 | The DOM those classes expect — `card()`, `field()`, `actionButton()`       |
| `shared/theme.ts`               | `readToken()` and the channel token names, for code that cannot use a class |
| `shared/bloopbox-mark.svg`      | The logo mark. Unreadable below ~24 px                                    |
| `shared/bloopbox-favicon.svg`   | A simpler drawing of the same mark, for `rel="icon"` only                  |

Rules that keep it honest:

- **Nothing enters `base.css` unless two or more pages use it.** Page-local styling lives beside
  its page.
- **Reference the semantic token, not the brand one** — `var(--accent)`, not `var(--brand-teal)`.
  Dark mode overrides only the semantic layer, which is why it is fifteen lines.
- **The component layer is CSS, not JS, on purpose.** It is the only kind of component the portal
  can share without a JS dependency a captive webview cannot be trusted with. `dom.ts` is therefore
  optional, and the portal imports none of it.
- **The simulator's canvas reads tokens through `theme.ts`** rather than holding its own hexes. A
  canvas cannot use a class, and this is the only sanctioned way around that.
- **`--ch-1/2/3` are yellow, coral, teal, in that order**, because that is the order the buttons
  are drawn in the logo mark. Reordering them means redrawing both SVGs, or the box in the child's
  room stops matching the picture of it.

---

## Audio

| Module              | Owns                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| `ffmpeg.ts`         | The Opus/ogg pipeline both ways, and the `libopus` preflight check           |
| `process.ts`        | `runProcess`: the one way a short-lived helper (ffmpeg, amixer) is run       |
| `cues.ts`           | The cue vocabulary, and which cues silent mode suppresses. No node imports — the browser shares it |
| `queueManager.ts`   | Sequential per-contact playback, with a soft chime between notes             |
| `purge.ts`          | The 48-hour TTL sweep, hourly                                               |
| `recovery.ts`       | Rebuilding the unread queue from the recordings directory after a restart    |
| `soundFiles.ts`     | Where the generated cue WAVs live                                           |
| `testNote.ts`       | Synthesised tones for the simulator's injectors                             |

**The two directions live in different places, and `src/audio/directories.ts` is the only module
that decides where.** Both daemons resolve the paths through it rather than each reading
`process.env`, because a mismatch is silent and total: the bridge writes an arriving note to one
path while the server scans another, nothing plays, nothing recovers, and no error appears anywhere.

*Outbound captures and every derived file* live in a **tmpfs** — `/run/bloopbox`, via
`RuntimeDirectory=` in both units, so no mount unit and no fstab entry. Nothing the child records is
ever at rest, and decoded `play-*.wav` files — regenerable and several times the size of their
source — never accumulate on the card. `RuntimeDirectoryPreserve=yes` keeps this across the
restart-on-save, and both units declare it because they hand each other file paths.

*Inbound notes* live on the card at **`/data/notes`**, so an unheard note survives being unplugged.
It needed no unit change: `ReadWritePaths=@DATA_DIR@` was already in both. `notesDirectory()`
deliberately has **no fallback to `RECORDING_DIR`** — `/etc/bloopbox/environment` sets that
variable and an upgrade keeps the file, so a fallback would resolve every already-installed box
straight back to the tmpfs, which is exactly the population the change was written for, and the
tests would stay green because a harness sets both.

Unread audio is purged after **48 hours** whether it has been heard or not. Playback deletes a
note's file immediately, so *present on disk* means *unread* and the directory is the ledger —
which is what makes recovery a scan rather than a second store to keep in step. Recovery has an
8-hour window (`RECOVERY_MAX_AGE_MS`): a note from this morning is worth hearing when the box comes
back, one from yesterday is a confusing thing to hand a small child.

Outbound audio needs `-avoid_negative_ts make_zero` and one channel, per Baileys' own docs, or some
clients show the voice bubble but refuse to play it.

### Every helper process has a deadline

ffmpeg and amixer go through `runProcess` in `src/audio/process.ts`, never a bare `spawn`. It gives
every call a deadline (SIGTERM, then SIGKILL `PROCESS_KILL_GRACE_MS` later, and it settles even if the
child never closes), keeps the **tail** of stderr in the error, because that is where both tools put
the reason, and turns a failure to start into a rejection rather than an unhandled `'error'` event.
Nothing is written to a child's stdin. The old `runFfmpeg(args, input)` stream path was never used,
and an EPIPE from a child that exited early had nowhere to go.

Before this, nothing had a timeout. `prepare()` decodes one note at a time, so one ffmpeg wedged on
a malformed file silently stopped every later note from being decoded.

- **ffmpeg's deadline scales with the audio**: `FFMPEG_BASE_TIMEOUT_MS` (30 s) plus twice the input's
  duration when it is known (a capture), and `FFMPEG_UNKNOWN_DURATION_TIMEOUT_MS` (5 min) when it is
  not (an arriving note, on decode).
- **amixer failures stay non-fatal but are logged at `warn`** with amixer's own stderr
  (`AMIXER_TIMEOUT_MS`, 5 s). The old `runQuiet` threw stderr away, so a wrong control name, such as
  `Master` on the WM8960, which has none, logged nothing while the volume stayed where the card
  powered up.

`arecord` and `aplay` are not run through it. A button stops them, not a clock, and each has its own
stop path with its own escalation. Both track their exit **from spawn**. `arecord` can exit by itself
(the device went away, or the codec refused the rate), and the `'close'` listener used to be attached
only at stop, after the event had already fired, so every commit after such an exit waited the full
`CAPTURE_FLUSH_TIMEOUT_MS`. The stop now checks `exitCode`/`signalCode` first and the early exit is
logged at `warn` with arecord's stderr.

### Nothing plays over a note

There is one speaker and one `plughw` device, so `playCue` cuts off whatever is playing. Until
2026-09-23 that included the note a child was listening to. A second note arriving played the
notify chime, the chime killed `aplay`, the killed note resolved as a success, and the queue
counted it as played, deleted it and reported it read. Then the drain zeroed the unread count, so
the new note's lamp went dark too. Four rules now, each locked by a test:

- **`hal.play()` says how it ended**: `'completed'` or `'interrupted'`. Only a completed note is
  heard. An interrupted one goes back to the front of the queue with everything after it, and
  `playbackAborted` carries the notes that *were* heard, so they are deleted and reported rather
  than restored as unread at the next restart. A note that fails outright is still skipped and
  counted, so a corrupt file cannot blink forever.
- **Courtesy cues wait for the note**. Notify, whoosh, oops and boot all go through
  `DeviceController.#courtesyCue`, which drops them while `#listeningTo` is set. The lamp says
  everything they would. The admin panel's speaker test is the one sound allowed through, and what
  it interrupts survives.
- **Unread follows the queue**: `setUnread(index, queue.count(index))` after a drain or an abort,
  never a clear.
- **A stop waits for the player to exit** (SIGKILL after `PLAYBACK_STOP_TIMEOUT_MS`), and a dying
  player clears only its *own* reference. The old handler nulled the field after the cue's `aplay`
  had been spawned, so the next stop killed nothing and the device stayed busy.

`MockHal.holdPlayback` keeps a note playing until something interrupts it, as the real speaker does.
Without it the controller tests could not see any of this, because the mock's cues never cut
anything off.

### Inbound notes are decoded on arrival, not on the tap

`aplay` reads WAV, AU and VOC and nothing else, and a WhatsApp voice note is Ogg/Opus — so playing
one always costs an ffmpeg decode somewhere. It used to be *between the tap and the first sound*,
which on a Pi Zero 2 W is a process spawn plus the decode itself, in the one place a child is least
able to wait.

`Hal.prepare(path)` moves it to arrival: `restoreUnread` calls it as the note is queued, for both a
fresh delivery and one restored at boot, and it is not awaited. `GpioHal` writes
`play-<stem>.wav` beside the note in the same RAM disk and remembers it, so the tap only has to spawn
`aplay`. Details that make it safe rather than clever:

- **Best effort by contract, both ways.** `prepare()` and `release()` never reject, and `play()`
  still decodes on demand when a prepared copy is missing — which the purge can make happen, since
  it sweeps `.wav` by age and the decode is exactly as old as its note. `play()` therefore checks the
  file on disk, not just its own map.
- **`release()` is called when the note's file is deleted**, from `#deletePlayed`, because the decode
  is derived data with nothing left to derive from. A release that lands while that note's decode is
  still running is remembered, and the decode deletes its own output when it finishes. Before this,
  the WAV of a note already heard stayed in the RAM disk.
- **One decode per note at a time.** `prepare()` and `play()` write the same `play-<stem>.wav`, so
  `GpioHal` keeps a map of which notes' files are in use (`#decoding`) and anyone who finds an entry
  waits for it. A tap during the arrival decode waits for that decode rather than starting a second
  ffmpeg over it, and an arrival decode waits for a tap's temporary copy to be played and deleted.
  Before this, two writers shared one file and one could delete it under the other's `aplay`.
- **Never beside an open microphone.** A queued arrival decode waits while a capture is open
  (it starts again when the capture is stopped, cancelled or dies by itself), and every arrival
  decode runs at niceness `BACKGROUND_DECODE_NICENESS` (10). `loudnorm` is the heaviest thing the box
  does, and on four slow cores it can starve `arecord` into an overrun, which is a gap in the child's
  message. A decode already running when the capture opens is not killed. It carries on at the
  lowered priority, since killing it would only mean doing it again. A tap's on-demand decode is not
  held back, because someone is waiting for it.
- **16 kHz mono** (`PLAYBACK_DECODING`), not Opus's internal 48 kHz: the note arrived at 16 kHz, and
  three times the RAM disk for the same speech is not a trade worth making in a tmpfs measured in
  tens of megabytes.
- The `play-` prefix keeps these out of `recovery.ts`'s `wa-<index>-<id>.ogg` pattern, so a leftover
  from a power cut is never mistaken for an unread message.

The simulator implements both as no-ops: the browser decodes through Web Audio and needs no help.

Silent mode suppresses the inbound notification chime and the record start/stop cues. It does
**not** suppress playback, which always plays at the configured volume (spec §7). That volume is
four multiplying stages — `speakerVolumePercent` into `ampVolumePercent` into `ampBoostDc` /
`ampBoostAc` — applied by `GpioHal` at init from control names the environment supplies. The former
`maxVolumeCapPercent` ceiling was removed on 2026-08-17; see `docs/PRODUCT.md` §7 for why.

`POST /api/audio/test` plays the boot cue on demand and is the **only** cue that ignores silent
mode, so the amplifier stages can be judged by ear at any hour.

---

## The WhatsApp connection

[`src/whatsapp/client.ts`](../box/software/src/whatsapp/client.ts) owns the Baileys socket, its
credentials and reconnection. Baileys reaches it through four injected functions — `socketFactory`,
`authStateFactory`, `download`, `versionProvider` — whose defaults are the real library calls, so
`src/tests/support/fakeWASocket.ts` can drive the whole lifecycle without an account.

### One socket, and only when a decision says so

Every call that decides which socket should exist — each connect, `stop()`, `unlink()` — bumps a
**generation**, and a connect re-checks it after each of its awaits (the auth directory, the auth
state, the version fetch). A connect that has been overtaken gives up instead of opening a second
socket onto the same `creds.json`. The state goes to `connecting` *before* the first await, which is
what makes `beginLinking()`'s `notLinked` guard hold against a double click. An existing socket is
ended before its replacement opens, `unlink()` cancels a pending reconnect, and a socket from before
an unlink may not write its credentials back into the directory the unlink deleted.

`fetchLatestBaileysVersion` has no timeout and takes no signal, so it is raced against
`VERSION_FETCH_TIMEOUT_MS`; past that, the socket opens with the version Baileys ships with.

### What a close means

| Reason | Paired? | Then |
| ------ | ------- | ---- |
| `restartRequired` (515) | either | reconnect at once — this is how a successful scan finishes |
| anything else | **no** | `notLinked`. Baileys ends an unscanned QR with `timedOut` (408), which is also `connectionLost`; retrying it started a new round of codes for ever |
| `loggedOut` (401) | yes | `notLinked`, credentials deleted |
| `connectionReplaced` (440), `forbidden` (403) | yes | `disconnected` with a detail saying why, **no retry** until the daemon restarts |
| anything else | yes | `disconnected`, reconnect on the ladder below |

440 on this device means the card was copied into a second box: the two replace each other for as
long as both keep retrying. 403 retried every minute is how a restricted account becomes a banned
one.

**The ladder** is `reconnectDelayMs`: 2 s doubling to a 60 s cap, ±20 % jitter so boxes behind one
router do not come back in step. The attempt count resets only once a connection has stayed up
`STABLE_CONNECTION_MS` (60 s) — resetting on `open` let an open-then-kicked loop run every 2 s.

### Which messages are voice notes

`voiceNoteContent` accepts a PTT `audioMessage`, at the top level or inside `ephemeralMessage` —
the wrapper a chat with disappearing messages puts round everything. It opens that one wrapper by
name and **never uses `normalizeMessageContent`**, which also opens view-once, edits and
document-with-caption: each is another shape a group member could put on a child's button, and
widening that is a decision, not a helper's side effect. View-once stays ignored until it is made.

### Downloads onto the card

[`src/whatsapp/mediaDownload.ts`](../box/software/src/whatsapp/mediaDownload.ts). The notes directory
is on the card that holds `config.json` and the credentials, and a note's size is whatever the
sender's client says. So: refused before download when the declared `fileLength` is over
`MAX_INBOUND_BYTES` (2 MB, about twice the longest note the 300 s cap admits); a byte-counting
`Transform` in the pipeline that fails it if the delivered bytes go over anyway;
`DOWNLOAD_TIMEOUT_MS` (60 s) per attempt, raced against Baileys' own request since it takes no
signal; and two retries on anything that is not a 4xx or an oversized note.

A download is written to `<name>.part`, fsynced, then renamed. Boot recovery treats every
`wa-<i>-<id>.ogg` as an unread note, so the final name must only ever point at a complete file;
recovery also skips a zero-length one, and the purge sweeps an abandoned `.ogg.part` by age.

### Sends answer before the hardware side gives up

The hardware server abandons a send after `SEND_TIMEOUT_MS` (60 s) and plays the "oops". An upload
still running then can deliver a note the child was told had failed, so the client passes Baileys
`mediaUploadTimeoutMs` = `MEDIA_UPLOAD_TIMEOUT_MS` (20 s). Baileys applies it **per media host**,
trying each in turn, and on Node it is the socket's idle timeout rather than a deadline — hence 20 s
and not 45: two stalled hosts still answer inside the minute.

### "Delete for everyone"

Baileys 7.0.0-rc14 reports it on `messages.update` as `{ key: { …the revoker's key, id: <deleted
id> }, update: { message: null, messageStubType: REVOKE } }` (`Utils/process-message.js`), and lets
it through from other users on purpose. The client turns that into a `revoked` event addressed like a
voice note; the bridge runs it through `whitelist.evaluate`, and only for an allowed chat sends
`wa:revoked { index, messageId }` — the button the whitelist resolved, not just an id. The hardware
server calls `DeviceController.revokeNote`, which removes the note only if **that button** holds
that id (`AudioQueueManager.remove`), resets unread to `queue.count()`, deletes the file and
`hal.release()`s its decode.

Two races are covered. A revoke that arrives while its note is still downloading finds nothing in
the queue, so the bridge also remembers revoked ids and throws the file away when the download
lands. And revokes wait behind the same `HoldUntilReady` as notes, in one queue, so one is never
judged before its own note. A note already playing is not interrupted; `remove` skips any later in
the run it belongs to.

## The whitelist is the safety boundary

[`src/whatsapp/whitelist.ts`](../box/software/src/whatsapp/whitelist.ts) is the most important file in the
product. Only the configured JIDs are accepted; unknown numbers, groups nobody assigned, status
broadcasts, newsletters and the device's own echoed sends are all dropped.

Filtering happens **before download**, so a stranger's audio never reaches the disk.

JIDs are normalised before comparison — `15551234567:12@s.whatsapp.net` is the same person as
`15551234567@s.whatsapp.net` — or the same contact would be accepted or rejected depending on which
of their linked devices they happened to send from. LID-addressed contacts are handled too.

[`src/tests/whitelist.test.ts`](../box/software/src/tests/whitelist.test.ts) is written from the position that
anything not explicitly assigned must not get through.

---

## Tests

`src/tests/*.test.ts`, node environment.

Timing-sensitive suites — LED patterns, debounce, purge TTL — run on **fake timers**. Never add a
real sleep. Where a code path awaits real filesystem work (`deviceController.test.ts` leaves
`setImmediate` real because commit awaits `rm`), assert with a `waitFor` condition rather than a
fixed number of yields: fixed flushes passed in isolation and failed intermittently under parallel
load.

Server-layer tests drive a **real Express app on an ephemeral port with `fetch`**, assembled the way
`hardware-server.ts` assembles it — see [`src/tests/support/apiHarness.ts`](../box/software/src/tests/support/apiHarness.ts),
which is a helper rather than a suite. No supertest; nothing was worth a dependency here.
`bridgeLink.test.ts` does the same with a real Socket.io server and client, because the token gate
is handshake middleware and only exists during a connection.

**Coverage is a ratchet, and the gate enforces it.** `npm run check` runs `vitest run --coverage`,
and the thresholds in `vitest.config.ts` are the figures on the day they were set, rounded down:
91% statements, 83% branches, 89% functions, 92% lines (2026-10-01). A change that lowers one fails
the gate; a change that raises one raises the number in the same commit. The threshold is not a
target. Its job is to make a quiet regression loud. Two things are excluded, each by name: the
composition roots in `src/processes/`, which the release smoke test exercises, and
`src/server/simulatorTransport.ts`, the browser end of a debugging tool. `gpioDriver.ts` used to be
excluded as unverifiable; `gpioButtons.test.ts` and `gpioPlayback.test.ts` now drive it on a mocked
opengpio, so it counts.

---

## Environment

Defaults are the **device's** absolute paths. `scripts/dev-server.ts` sets only `SIMULATOR_MODE`
and `PORTAL_PORT`, so on macOS `/data` does not exist: without `CONFIG_PATH=./data/config.json` the
server falls back to `config.default.json` in RAM and every settings save fails. Set it whenever you
are testing configuration at all.

| Variable                                     | Default                    | Notes                                                    |
| -------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| `SIMULATOR_MODE=true`                        | unset → `gpio`             | Selects the HAL. `HAL_DRIVER=mock` wins over it           |
| `CONFIG_PATH`                                | `/data/config.json`        | Point at `./data/config.json` locally                     |
| `RECORDING_DIR`                              | `/run/bloopbox`            | Outbound captures and derived WAVs. tmpfs, deliberately   |
| `NOTES_DIR`                                  | `/data/notes`              | Inbound notes, on the card so they survive a power cut. **No fallback to `RECORDING_DIR`** — see above |
| `WA_AUTH_DIR`                                | `/data/auth_info`          | Baileys credentials                                       |
| `BRIDGE_TOKEN`                               | `''`                       | Shared secret both processes must agree on                |
| `HARDWARE_URL`                               | `http://localhost:3000`    | Where the bridge dials                                    |
| `PORT`                                       | `3000`                     | Where the hardware server listens                         |
| `PORTAL_PORT`                                | `80` (dev: `8080`)         | Captive-portal listener; `0` disables it                  |
| `FFMPEG_PATH`                                | `ffmpeg`                   | `ffprobe` is derived from it                              |
| `LOG_LEVEL`                                  | `debug` in dev, else `info` | pino; `pino-pretty` in dev. On the device `bloopbox-debug on` flips it |
| `NET_STATE_PATH`                             | `/run/bloopbox-net/net-state.json` | What the root net agent publishes; absent in dev  |
| `NET_REQUEST_PATH`                           | `/run/bloopbox/net-request.json`   | What the daemon asks the agent for — network actions **and** reboot/poweroff |
| `STATS_PATH`                                 | `/data/stats.json`         | Activity totals. Beside the config, never inside it       |
| `SSH_PASSWORD_PATH`                          | `/data/ssh-password`       | The first-boot ssh login the admin panel shows. Root-written, read-only here |
| `THERMAL_ZONE_PATH`                          | `/sys/class/thermal/thermal_zone0/temp` | SoC temperature for the health card. Absent off Linux → reported as a dash |
| `DEVICE_MODEL_PATH`                          | `/sys/firmware/devicetree/base/model` | The board's own name, for the health card           |
| `LED_ACTIVE_HIGH`                            | `true`                     | Pi only. Correct on the reference board (2026-09-30) — a 3 V lamp between pin and ground lights on HIGH; flip if inverted |
| `BUTTON_ACTIVE_LOW`                          | `true`                     | Pi only. Correct on the reference board (2026-09-30) — pull-ups mean a press reads low |
| `BUTTON_SETTLE_MS`                           | `20`                       | Pi only. How long a button line must be quiet before its level counts (`hal/settledLine.ts`); 0–200. Raise it for switches that chatter longer |
| `ALSA_CAPTURE_DEVICE` / `ALSA_PLAYBACK_DEVICE` | `default`                | Pi only, unverified                                       |
| `ALSA_MIXER_CONTROL`                         | `PCM`                      | Pi only. Differs across USB adapters; a wrong name silently ignores the volume setting |
| `ALSA_AMP_MIXER_CONTROL`                     | *(unset)*                  | Pi only. The analogue output stage below the DAC — `Speaker` on the WM8960. Unset means the card has none |
| `ALSA_AMP_DC_MIXER_CONTROL`                  | *(unset)*                  | Pi only. Class-D DC boost — `Speaker DC` on the WM8960 |
| `ALSA_AMP_AC_MIXER_CONTROL`                  | *(unset)*                  | Pi only. Class-D AC boost — `Speaker AC` on the WM8960 |

---

## Conventions that are load-bearing

The full list is in [`CLAUDE.md`](../CLAUDE.md). The ones that shape the architecture:

- **ESM throughout**, and relative imports carry the `.ts` extension (`./foo.ts`) —
  `rewriteRelativeImportExtensions` rewrites them to `.js` on emit.
- **`erasableSyntaxOnly` is on**: no `enum`, no `namespace`, no parameter properties. Use `as const`
  objects plus union types.
- **Config types are inferred from the Zod schema.** Never hand-write a parallel interface.
- **Timing values live in exactly one place and are exported**, so tests assert against the same
  numbers the runtime uses. Anything a user might want to tune belongs in the schema, not in a
  module constant — `config.buttons` is the precedent.
- **Linting is oxlint, not ESLint**, and that is not a preference: TypeScript 7's npm package no
  longer exposes the classic JS compiler API, so `typescript-eslint` cannot work at all.
