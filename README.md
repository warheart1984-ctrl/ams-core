# ams-core

A TypeScript implementation of **RFC-AMS-001**, the Adaptive Music System
specification — an architecture, behavioral model, and API for adaptive music
in interactive media (games, XR, interactive film). The specification document
is included: [`docs/RFC-AMS-001-v1.1.docx`](docs/RFC-AMS-001-v1.1.docx).

**Status: 0.1.0, partial RFC-AMS-001 conformance** — see the adapter and
spec-coverage notes below before relying on MUST-level claims.

## What it is

An AMS responds to real-time contextual signals — discrete state changes and
continuous parameter streams (RTPCs) — and transitions between musical
material without perceptible seams. It is built of three layers, per the spec:

| Layer | Where | Role |
|---|---|---|
| Context Engine | `src/context/` | State/RTPC registration, preemption, RTPC smoothing |
| Music Logic Layer | `src/logic/` | Priority queue, Transition Matrix resolution, cue scheduling |
| Playback Engine | `src/playback/` + `src/clock/` | Beat Grid, sample-accurate scheduling, crossfades |

### Adapters (`src/adapters/`)

Only `WebAudioAdapter` drives real audio output. `FMODAdapter` and
`WwiseAdapter` are **documented stubs** — they define the integration
boundary and report honest capabilities but do not produce sound.
`NullAdapter` is for testing.

Conformance-oriented: all four quantization modes (`IMMEDIATE`, `BEAT`,
`BAR`, `SEGMENT_END`), exact→wildcard→fallback matrix precedence, stinger
conflict policies (`QUEUE`/`INTERRUPT`/`LAYER`), SHA-256 cue-bank manifest
validation (optional HMAC), priority clamping with warning events, memory
profiles (`DEFAULT`/`REDUCED`/`MINIMAL`) with pinned banks and 30 s
inactivity eviction. See RFC §15 for the requirement table; tests live in
`src/**/*.test.ts` and exercise the MUST-level behavior.

## Run it

```bash
npm ci
npm run build     # tsc -> dist/
npm run lint      # tsc --noEmit
npm test          # builds, then runs every dist/**/*.test.js
```

`demo/` contains generated audio (exploration / combat / intensity layers, a
stinger, a glitch check) and an `index.html` harness for the Web Audio adapter.

`integrations/` holds a separate Python lane pipeline (score, mix, voice,
render) that consumes cue plans produced by the core engine.

## Status

Independent project, MIT licensed. The spec is self-published and not
affiliated with the IETF, AES, FMOD, or Audiokinetic.
