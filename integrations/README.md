# Audio pipeline integrations

`beatbox-speakers/` is the vendored BeatBox + Speakers source found in the
Project Infinity workspace through NX search.

## Intended boundary

```text
AMS ContextEngine / MusicLogicLayer
        -> BeatBox cue plan (Python)
        -> music provider adapter (ACE-Step, deterministic fallback, etc.)
        -> Speakers voice stems + ducking + final mix
        -> WebAudioAdapter or exported WAV
```

The vendored code remains isolated from the TypeScript core until the bridge
contract is finalized. Its original `README.md` and subsystem contracts are
preserved for provenance.

## Runtime note

The BeatBox/Speakers source is Python and expects its `src` directory on
`PYTHONPATH`. The TypeScript bridge should invoke a small JSON-in/JSON-out
runner rather than importing Python internals directly.
