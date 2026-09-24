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
owning `/run/bloopbox`, which is the recordings tmpfs the daemon has to be able to write.

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

`gpioDriver.ts` has **never run on real hardware**. Treat it as unverified, and do not add code
paths that only work with real GPIO.

### Domain logic is pure

Everything in `src/core/` is I/O-free. It consumes events and timings, and its only outward call is
`hal.setLed()`.

| Module                | Owns                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| `buttonInterpreter`   | Raw button edges → intents: tap, record, carry on, refuse, the silent chord |
| `ledAnimator`         | Device state → LED frames, on a 50 ms tick                                  |
| `deviceState`         | The observable state, in one place, with change notification                |
| `networkSupervisor`   | When the setup hotspot goes up and when it steps aside                      |
| `quietHours`          | Whether now falls inside the window, read in the configured IANA zone       |
| `deviceController`    | The wiring: intents in, capture / playback / cues / LEDs out                |

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
holds `Promise<RecordingHandle | null>` rather than the handle.

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
audio back on without editing the schedule.

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

Writes are **atomic** — temp file → `fsync` → `rename`. A half-written config during power loss
would brick the device.

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

### Patches are partial all the way down

`PUT /api/config` accepts **any subset of any section, to any depth**. `configUpdateSchema` is
partial throughout, `mergeConfig` merges field by field, and the cross-field rules (volume ≤ cap,
debounce < threshold, an enabled contact has a target) are enforced by `ConfigManager.save()`
against the **merged** config.

That last part is load-bearing: a patch raising the volume does not carry the cap, so the rule can
only be checked after merging. Sections with a refinement are written as a plain `…Shape` object
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
**except** `GET /status`, `GET /whatsapp`, `GET /cues` and `POST /onboard`.

The guard also **stands aside entirely while `system.configured` is false**, or first-run onboarding
could never set a password. Don't "fix" that. It stands aside on an empty `adminPasswordHash` too,
which means a config with `configured: true` and no hash is wide open — a **decided, accepted
risk**, because the guard cannot tell that state from mid-onboarding, and refusing to serve would
make the device recoverable only by pulling the SD card. Both halves are pinned by
[`src/tests/adminAuth.test.ts`](../box/software/src/tests/adminAuth.test.ts); the watch item in `PENDING.md` has
the full reasoning.

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
a dependency on Socket.io there is a page that hangs on a phone. Verify after touching the build —
`dist/public/portal/index.html` must reference no shared JS chunk.

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
  is derived data with nothing left to derive from.
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

`vitest.config.ts` declares 80% coverage thresholds but **`npm run check` does not run them** — it
calls plain `vitest run`. Coverage currently sits at about **77% statements / 68% branches**, so the
thresholds still fail. `src/whatsapp/` (24%) is the large remaining hole and `src/audio/` sits at
75%. `src/server/simulatorTransport.ts` is untested on purpose: it is the browser end of a
debugging tool, not device code. Treat the number as known debt, not a passing gate — the detail is
in `PENDING.md`.

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
| `LED_ACTIVE_HIGH`                            | `true`                     | Pi only, unverified — a 3 V lamp between pin and ground lights on HIGH; flip if inverted |
| `BUTTON_ACTIVE_LOW`                          | `true`                     | Pi only, unverified — pull-ups mean a press reads low      |
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
