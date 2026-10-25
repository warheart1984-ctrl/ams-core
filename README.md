# ams-core

A TypeScript implementation of **RFC-AMS-001**, the Adaptive Music System
specification — an architecture, behavioral model, and API for adaptive music
in interactive media (games, XR, interactive film). The specification document
is included: `RFC - Adaptive Music System Specification.docx`.

## What it is

An AMS responds to real-time contextual signals — discrete state changes and
continuous parameter streams (RTPCs) — and transitions between musical
material without perceptible seams. It is built of three layers, per the spec:

| Layer | Where | Role |
|---|---|---|
| Context Engine | `src/context/` | State/RTPC registration, preemption, RTPC smoothing |
| Music Logic Layer | `src/logic/` | Priority queue, Transition Matrix resolution, cue scheduling |
| Playback Engine | `src/playback/` + `src/clock/` | Beat Grid, sample-accurate scheduling, crossfades |

Adapters (`src/adapters/`): `WebAudioAdapter` (working), `FMODAdapter`,
`WwiseAdapter`, `NullAdapter` (testing).

Conformance-oriented: all four quantization modes (`IMMEDIATE`, `BEAT`,
`BAR`, `SEGMENT_END`), exact→wildcard→fallback matrix precedence, stinger
conflict policies (`QUEUE`/`INTERRUPT`/`LAYER`), SHA-256 cue-bank manifest
validation (optional HMAC), priority clamping with warning events, memory
profiles (`DEFAULT`/`REDUCED`/`MINIMAL`) with pinned banks and 30 s
inactivity eviction. See RFC §15 for the requirement table; `test/` and
`src/*.test.ts` exercise the MUST-level behavior.

## Run it

```bash
npm install
npm test          # 39 tests
npm run build     # tsc -> dist/
```

`demo/` contains generated audio (exploration / combat / intensity layers, a
stinger, a glitch check) and an `index.html` harness for the Web Audio adapter.

`integrations/` holds a separate Python lane pipeline (score, mix, voice,
render) that consumes cue plans produced by the core engine.

## Status

Independent project, MIT licensed. The spec is self-published and not
affiliated with the IETF, AES, FMOD, or Audiokinetic.
