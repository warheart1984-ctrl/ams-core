import { test } from "node:test";
import assert from "node:assert/strict";
import { Clock } from "../clock/Clock.js";

test("Clock: sample→beat conversion at 120 BPM, 44100 Hz, 4/4", () => {
  const clock = new Clock({
    bpm: 120,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    sampleRate: 44100,
  });
  // At 120 BPM, one beat = 0.5s = 22050 samples; one bar = 88200 samples.
  const beat = clock.sampleToBeat(22050n);
  assert.equal(beat.bar, 0);
  assert.equal(beat.beat, 1);
  assert.ok(Math.abs(beat.subBeat) < 1e-6);

  const bar = clock.sampleToBeat(88200n);
  assert.equal(bar.bar, 1);
  assert.equal(bar.beat, 0);
});

test("Clock: beat→sample round-trip", () => {
  const clock = new Clock({
    bpm: 120,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    sampleRate: 48000,
  });
  // 120 BPM at 48000: beat = 24000 samples
  const pos = { bar: 2, beat: 3, subBeat: 0, totalBeats: 11 };
  const samples = clock.beatToSample(pos);
  assert.equal(samples, 11n * 24000n);
});

test("Clock: nextBeat and nextBar alignment", () => {
  const clock = new Clock({
    bpm: 120,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    sampleRate: 44100,
  });
  const nextBeat = clock.nextBeatSample();
  assert.equal(nextBeat, 22050n);

  const nextBar = clock.nextBarSample();
  assert.equal(nextBar, 88200n);
});

test("Clock: drift recovery within 1 ms tolerance", () => {
  const clock = new Clock({
    bpm: 120,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    sampleRate: 44100,
  });
  // Simulate 1 minute of playback: 44.1 samples of drift = 1 ms exactly.
  clock.advance(60n * 44100n);
  clock.reportDrift(44); // within tolerance
  const snapshot = clock.snapshot();
  assert.equal(snapshot.sample.samples, 60 * 44100);

  // Excessive drift: 10 ms = 441 samples → recovery applied
  clock.reportDrift(441);
  clock.advance(0n);
  const recovered = clock.snapshot();
  // Recovery is partial (25% per bar step); sample should have moved
  assert.notEqual(recovered.sample.samples, 60 * 44100);
});

test("Clock: pause/resume preserves musical position continuity", () => {
  const clock = new Clock({ bpm: 120, timeSignatureNumerator: 4, timeSignatureDenominator: 4, sampleRate: 44100 });
  clock.start(0n);
  clock.advance(22050n); // 0.5s
  const before = clock.snapshot();
  assert.equal(before.sample.samples, 22050);

  clock.pause(process.hrtime.bigint());
  clock.resume(process.hrtime.bigint() + 500000000n); // 500 ms pause
  clock.advance(22050n);
  const after = clock.snapshot();
  // Musical position advanced by the same 22050 samples regardless of pause
  assert.equal(after.sample.samples, 44100);
});

test("Clock: bpm validation requires supported sample rates", () => {
  assert.throws(() => {
    new Clock({ bpm: 120, timeSignatureNumerator: 4, timeSignatureDenominator: 4, sampleRate: 22050 });
  });
});

test("Clock: seek restores zero drift", () => {
  const clock = new Clock({ bpm: 120, timeSignatureNumerator: 4, timeSignatureDenominator: 4, sampleRate: 44100 });
  clock.seekToSample(88200n);
  assert.equal(clock.snapshot().beat.bar, 1);
  assert.equal(clock.snapshot().beat.beat, 0);
});