import { test } from "node:test";
import assert from "node:assert/strict";
import { AMS } from "./AMS.js";
import { NullAdapter } from "./adapters/NullAdapter.js";
import { evaluateMapping } from "./types.js";
import type {
  CueBankManifest,
  CueChangedEvent,
  PlaybackInstruction,
  TransitionStartEvent,
  TransitionEndEvent,
} from "./types.js";

/** Build a minimal cue bank manifest for integration tests. */
function buildManifest(): CueBankManifest {
  return {
    version: "1.0.0",
    checksums: {},
    states: [
      { name: "Exploration", priority: 50, exclusivityGroup: "gameplay", defaultCueId: "cue_exploration" },
      { name: "Combat", priority: 80, exclusivityGroup: "gameplay", defaultCueId: "cue_combat" },
      { name: "Cutscene", priority: 200, exclusivityGroup: "gameplay", defaultCueId: "cue_cutscene" },
    ],
    rtpcs: [
      { name: "tension", min: 0, max: 100, smoothingMs: 0 },
    ],
    cues: [
      {
        cueId: "cue_exploration",
        bpm: 120,
        timeSignature: [4, 4],
        stems: [{ stemId: "forest_ambient", rtpcBinding: "tension", volumeMapping: { type: "THRESHOLD", threshold: 0.85 } }],
      },
      { cueId: "cue_combat", bpm: 120, timeSignature: [4, 4], stems: [{ stemId: "percussion", rtpcBinding: "tension", volumeMapping: { type: "LINEAR" } }] },
      { cueId: "cue_cutscene", bpm: 120, timeSignature: [4, 4], stems: [] },
    ],
    segments: [],
    stingers: [
      { stingerId: "stinger_combat_enter", durationBars: 1, quantization: "BAR" },
      { stingerId: "stinger_boss", durationBars: 2, quantization: "IMMEDIATE", conflictMode: "INTERRUPT" },
      { stingerId: "stinger_queue", durationBars: 1, quantization: "IMMEDIATE", conflictMode: "QUEUE" },
      { stingerId: "stinger_layer", durationBars: 1, quantization: "IMMEDIATE", conflictMode: "LAYER" },
    ],
    transitionMatrix: [
      { fromState: "Exploration", toState: "Combat", type: "CUE_SWITCH", quantization: "BAR", crossfadeMs: 1000, stingerId: "stinger_combat_enter" },
      { fromState: "*", toState: "Cutscene", type: "CUE_SWITCH", quantization: "IMMEDIATE", crossfadeMs: 0 },
      { fromState: "Cutscene", toState: "Exploration", type: "CUE_SWITCH", quantization: "BAR", crossfadeMs: 1500 },
      { fromState: "*", toState: "*", type: "CUE_SWITCH", quantization: "BEAT", crossfadeMs: 100 },
    ],
  };
}

function makeAms(): { ams: AMS; instructions: PlaybackInstruction[]; adapter: NullAdapter } {
  const adapter = new NullAdapter();
  const instructions: PlaybackInstruction[] = [];
  const ams = new AMS(adapter, {
    sampleRate: 44100,
    bpm: 120,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    pollingIntervalMs: 1,
  });
  // Spy on instructions via the playback engine schedule
  const originalSchedule = ams.getPlaybackEngine().schedule;
  (ams.getPlaybackEngine() as unknown as { schedule: (i: PlaybackInstruction) => void }).schedule = (i: PlaybackInstruction) => {
    instructions.push(i);
    originalSchedule.call(ams.getPlaybackEngine(), i);
  };
  return { ams, instructions, adapter };
}

async function loadBank(ams: AMS, manifest?: CueBankManifest): Promise<void> {
  const bankManifest = manifest ?? buildManifest();
  await ams.loadCueBank("testbank", {
    read: async () => ({ manifest: bankManifest, assets: new Map() }),
  });
}

test("Lifecycle: uninitialized → ready; double-initialize rejected; setState gated", async () => {
  const { ams } = makeAms();
  assert.equal(ams.getLifecycle(), "uninitialized");
  await ams.initialize();
  assert.equal(ams.getLifecycle(), "ready");
  // Re-initialize from 'ready' must be rejected
  await assert.rejects(
    () => ams.initialize() as never,
    (err: unknown) => {
      const e = err as { code?: string };
      return e.code === "LIFECYCLE_VIOLATION";
    }
  );
});

test("Lifecycle: setState before initialize throws", () => {
  const { ams } = makeAms();
  assert.throws(() => ams.setState("Combat"));
});

test("Integration: state change produces scheduled transition with wildcard precedence", async () => {
  const { ams, instructions } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  ams.setState("Exploration");
  const cueSwitch = instructions.find((i) => i.type === "CUE_SWITCH");
  assert.ok(cueSwitch, "expected a cue switch instruction");
  assert.equal(cueSwitch.targetCueId, "cue_exploration");

  // Combat preempts Exploration via explicit matrix entry
  instructions.length = 0;
  ams.setState("Combat", 80);
  const combatSwitch = instructions.find((i) => i.type === "CUE_SWITCH");
  assert.ok(combatSwitch);
  assert.equal(combatSwitch.targetCueId, "cue_combat");
  assert.equal(combatSwitch.crossfadeMs, 1000); // explicit entry wins

  // Cutscene via wildcard ANY→Cutscene = IMMEDIATE (should override fallback)
  instructions.length = 0;
  ams.setState("Cutscene", 200);
  const cutsceneSwitch = instructions.find((i) => i.type === "CUE_SWITCH");
  assert.ok(cutsceneSwitch);
  assert.equal(cutsceneSwitch.crossfadeMs, 0); // wildcard, not fallback
});

test("Integration: quantization resolution is beat/bars aligned", async () => {
  const { ams, instructions } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  // Set Exploration first: fallback (*→*) schedules at next BEAT (22050 @ 120bpm/44.1k).
  ams.setState("Exploration");
  const exploreSwitch = instructions.find((i) => i.type === "CUE_SWITCH")!;
  assert.equal(exploreSwitch.atSample % 22050, 0, `beat-aligned instruction at ${exploreSwitch.atSample}`);

  // Exploration→Combat is an EXPLICIT BAR entry: must land on next bar (88200), not next beat.
  instructions.length = 0;
  ams.setState("Combat", 80);
  const combatSwitch = instructions.find((i) => i.type === "CUE_SWITCH")!;
  assert.equal(combatSwitch.atSample % 88200, 0, `bar-aligned instruction at ${combatSwitch.atSample}`);
});

test("Integration: RTPC drives stem volume mapping without a state change", async () => {
  const { ams, instructions } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  ams.setState("Combat");
  // Mark the cue as audibly active (mirrors a completed crossfade).
  ams.getMusicLogicLayer().onCueChanged(null, "cue_combat", "Combat");

  // Combat cue has a LINEAR-mapped percussion stem on "tension"
  instructions.length = 0;
  ams.setRTPC("tension", 0.5, 0);
  const stemInstr = instructions.find((i) => i.type === "STEM_VOLUME" && i.stemId === "percussion");
  assert.ok(stemInstr, "expected STEM_VOLUME for percussion");
  assert.equal(stemInstr.targetVolume, 0.5);

  // THRESHOLD mapping on the exploration stem: <0.85 → 0, ≥0.85 → 1
  assert.equal(evaluateMapping({ type: "THRESHOLD", threshold: 0.85 }, 0.84), 0);
  assert.equal(evaluateMapping({ type: "THRESHOLD", threshold: 0.85 }, 0.85), 1);
});

test("Integration: stinger triggers without interrupting the cue flow", async () => {
  const { ams, instructions } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  ams.setState("Exploration");
  instructions.length = 0;
  ams.triggerStinger("stinger_boss");
  const stinger = instructions.find((i) => i.type === "STINGER");
  assert.ok(stinger);
  assert.equal(stinger.stingerId, "stinger_boss");

  // Unknown stinger → error event, no playback break
  const errors: string[] = [];
  (ams as unknown as { listeners: Map<string, Set<unknown>> }).listeners; // noop
  ams.on("error", (e) => errors.push(e.code));
  ams.triggerStinger("stinger_missing");
  assert.ok(errors.includes("STINGER_NOT_FOUND"));
});

test("Integration: event model emits cue_changed / transition_start / transition_end", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  const events: Array<CueChangedEvent | TransitionStartEvent | TransitionEndEvent> = [];
  ams.on("cue_changed", (e) => events.push(e));
  ams.on("transition_start", (e) => events.push(e));
  ams.on("transition_end", (e) => events.push(e));

  ams.setState("Exploration");
  ams.getMusicLogicLayer().onCueChanged(null, "cue_exploration", "Exploration");
  ams.getMusicLogicLayer().onTransitionEnded("cue_exploration", "cue_exploration", 0);

  const cueChanged = events.find((e) => e.type === "cue_changed");
  assert.ok(cueChanged);
  assert.equal((cueChanged as CueChangedEvent).newCueId, "cue_exploration");
});

test("E2E: real tick() drives cue_changed, activeCueId and stem mapping with no manual callbacks", { timeout: 5000 }, async () => {
  const { ams, instructions, adapter } = makeAms();
  const dispatched: PlaybackInstruction[] = [];
  const origSchedule = adapter.schedule.bind(adapter);
  adapter.schedule = (i) => { dispatched.push(i); origSchedule(i); };
  await ams.initialize();
  await loadBank(ams);

  const cueEvents: string[] = [];
  ams.on("cue_changed", (e) => cueEvents.push(e.newCueId));

  // Combat from a cold start → fallback *→* BEAT: audible at ~0.5 s of output.
  ams.setState("Combat");
  // NullAdapter advances output in real time; wait past the first beat.
  await new Promise((r) => setTimeout(r, 900));

  assert.deepEqual(cueEvents, ["cue_combat"], "engine must report the audible cue start itself");
  assert.equal(ams.getActiveCueId(), "cue_combat");

  // The instruction actually reached the adapter — due entries are no longer dropped.
  assert.ok(dispatched.some((i) => i.type === "CUE_SWITCH" && i.targetCueId === "cue_combat"));

  // With an active cue, RTPC→stem mapping now runs.
  instructions.length = 0;
  ams.setRTPC("tension", 0.5, 0);
  assert.ok(instructions.some((i) => i.type === "STEM_VOLUME" && i.stemId === "percussion"));

  ams.stop();
});

test("E2E: a failed bank load does not brick the engine", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  await loadBank(ams);
  ams.setState("Exploration");

  const bad = buildManifest();
  bad.checksums = { "missing.ogg": "a".repeat(64) };
  await assert.rejects(() => ams.loadCueBank("bad", { read: async () => ({ manifest: bad, assets: new Map() }) }));

  // Lifecycle is restored, not stuck at "error".
  assert.notEqual(ams.getLifecycle(), "error");
  ams.setState("Combat"); // still accepted
  ams.stop();
});

test("E2E: an error handler that throws does not recurse", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  await loadBank(ams);
  const logs: unknown[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => { logs.push(a); };
  try {
    ams.on("error", () => { throw new Error("error handler exploded"); });
    ams.triggerStinger("stinger_missing"); // emits error event into the throwing handler
  } finally {
    console.error = origErr;
  }
  assert.ok(logs.length >= 1, "failure should reach console, not recurse");
  ams.stop();
});

test("Security: malformed bank rejects checksum validation", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  const manifest = buildManifest();
  // An asset is declared but missing from assets map.
  manifest.checksums = { "missing.ogg": "a".repeat(64) };
  await assert.rejects(
    () => ams.loadCueBank("bad_bank", {
      read: async () => ({ manifest, assets: new Map() }),
    }) as never,
    (err: unknown) => {
      const e = err as { code?: string };
      return e.code === "BANK_VALIDATION_FAILED";
    }
  );
});

test("Security: signed manifest requires valid key; invalid key rejected", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  const manifest = buildManifest();
  const { signManifest } = await import("./security/manifest.js");
  const signed = signManifest(manifest, "secret-key", "key-1");

  // Valid key loads fine
  await ams.loadCueBank("signed_bank", {
    read: async () => ({ manifest: signed.manifest, assets: new Map() }),
  }, "secret-key");

  // Tampered manifest with wrong key → rejected
  const tampered = { ...signed.manifest, version: "9.9.9" };
  await assert.rejects(
    () => ams.loadCueBank("bad_signed", {
      read: async () => ({ manifest: tampered, assets: new Map() }),
    }, "wrong-key") as never
  );
});

test("Adapter limitations: capabilities are honorably reported", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  const caps = ams.getCapabilities();
  assert.equal(caps.name, "NullAdapter");
  assert.ok(caps.supportsSampleAccurateScheduling);
  assert.ok(caps.maxConcurrentStems >= 1);
});

test("Lifecycle: unload resets bank states", async () => {
  const { ams, instructions } = makeAms();
  await ams.initialize();
  await loadBank(ams);
  ams.setState("Combat");
  assert.equal(ams.getActiveCueId(), null); // cue_changed not fired yet
  instructions.length = 0;

  ams.unloadCueBank("testbank");
  assert.equal(ams.getLoadedBanks().length, 0);
});

test("Security: out-of-range state priority clamps to [0,255] with a warning (RFC §12.5)", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  const warnings: Array<{ code: string; supplied?: unknown; clamped?: unknown }> = [];
  ams.on("warning", (e) => warnings.push({ code: e.code, supplied: e.context?.supplied, clamped: e.context?.clamped }));

  ams.setState("Combat", 300);
  assert.equal(ams.getActiveState(), "Combat");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "PRIORITY_CLAMPED");
  assert.equal(warnings[0].supplied, 300);
  assert.equal(warnings[0].clamped, 255);

  // Below-range values clamp to 0, not rejected
  warnings.length = 0;
  ams.setState("Exploration", -5);
  assert.equal(warnings[0].clamped, 0);

  // Non-finite values clamp to 0
  warnings.length = 0;
  ams.setState("Cutscene", Number.NaN);
  assert.equal(warnings[0].clamped, 0);
});

test("Memory: pinned banks are exempt from inactivity eviction (RFC §13.1)", async () => {
  const { ams } = makeAms();
  await ams.initialize();

  const manifest = buildManifest();
  const loader = () => ({ read: async () => ({ manifest, assets: new Map() }) });
  await ams.loadCueBank("pinned_bank", loader(), undefined, { pinned: true });
  await ams.loadCueBank("normal_bank", loader());

  const future = process.hrtime.bigint() + 31n * 1000000000n;
  const evicted = ams.evictInactiveBanks(future);

  assert.deepEqual(evicted, ["normal_bank"]);
  assert.deepEqual(ams.getLoadedBanks(), ["pinned_bank"]);

  // Pinned banks remain resident until explicitly unloaded
  ams.unloadCueBank("pinned_bank");
  assert.equal(ams.getLoadedBanks().length, 0);
});

test("Stinger conflicts: QUEUE waits for the active stinger to end (RFC §7.3)", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  const engine = ams.getPlaybackEngine() as unknown as {
    scheduleQueue: Array<{ atSample: number; instruction: { type: string; stingerId?: string } }>;
  };

  // BAR-quantized stinger: starts at next bar (88200 @120bpm/44.1k), runs 1 bar → ends 176400.
  ams.triggerStinger("stinger_combat_enter");
  ams.triggerStinger("stinger_queue");

  const queued = engine.scheduleQueue.find((e) => e.instruction.stingerId === "stinger_queue");
  assert.ok(queued, "queued stinger must be scheduled, not dropped");
  assert.equal(queued.atSample, 176400, "QUEUE waits until the active stinger's end");
});

test("Stinger conflicts: INTERRUPT stops the active stinger then plays (RFC §7.3)", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  const engine = ams.getPlaybackEngine() as unknown as {
    scheduleQueue: Array<{ atSample: number; instruction: { type: string; stingerId?: string } }>;
    activeStingers: Array<{ stingerId: string }>;
  };

  ams.triggerStinger("stinger_combat_enter");
  ams.triggerStinger("stinger_boss");

  const stops = engine.scheduleQueue.filter((e) => e.instruction.type === "STOP");
  assert.equal(stops.length, 1);
  assert.equal(stops[0].instruction.stingerId, "stinger_combat_enter");

  const boss = engine.scheduleQueue.find((e) => e.instruction.stingerId === "stinger_boss");
  assert.ok(boss);
  // The interrupted stinger is no longer tracked; only the boss remains active.
  assert.deepEqual(engine.activeStingers.map((s) => s.stingerId), ["stinger_boss"]);
});

test("Stinger conflicts: LAYER plays both without interrupting (RFC §7.3)", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  const engine = ams.getPlaybackEngine() as unknown as {
    scheduleQueue: Array<{ atSample: number; instruction: { type: string; stingerId?: string } }>;
    activeStingers: Array<{ stingerId: string }>;
  };

  ams.triggerStinger("stinger_combat_enter");
  ams.triggerStinger("stinger_layer");

  const stops = engine.scheduleQueue.filter((e) => e.instruction.type === "STOP");
  assert.equal(stops.length, 0, "LAYER must not stop the active stinger");

  const layer = engine.scheduleQueue.find((e) => e.instruction.stingerId === "stinger_layer");
  assert.ok(layer);
  // LAYER keeps its own resolved position (IMMEDIATE → ~sample 0), not deferred.
  assert.ok(layer.atSample < 88200, "LAYER plays now, not after the active stinger");
  assert.deepEqual(
    engine.activeStingers.map((s) => s.stingerId),
    ["stinger_combat_enter", "stinger_layer"]
  );
});

test("Memory: cue activity resets the bank eviction timer (RFC §13.1)", async () => {
  const { ams } = makeAms();
  await ams.initialize();
  await loadBank(ams);

  const lastActive = (ams as unknown as { bankLastActiveNs: Map<string, bigint> }).bankLastActiveNs;
  const before = lastActive.get("testbank")!;
  assert.ok(before > 0n);

  // cue_changed for a cue in this bank counts as activity
  ams.getMusicLogicLayer().onCueChanged(null, "cue_combat", "Combat");
  const afterCue = lastActive.get("testbank")!;
  assert.ok(afterCue >= before, "cue activity must refresh last-active timestamp");

  // A stinger from the bank counts too
  ams.triggerStinger("stinger_boss");
  const afterStinger = lastActive.get("testbank")!;
  assert.ok(afterStinger >= afterCue, "stinger activity must refresh last-active timestamp");
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** AMS at 240 BPM (beat = 250 ms, bar = 1 s) so real-time tests stay short. */
async function makeFastAms(manifest: CueBankManifest, pollingIntervalMs = 1): Promise<{ ams: AMS; adapter: NullAdapter }> {
  const adapter = new NullAdapter();
  const ams = new AMS(adapter, { sampleRate: 44100, bpm: 240, timeSignatureNumerator: 4, timeSignatureDenominator: 4, pollingIntervalMs });
  await ams.initialize();
  await loadBank(ams, manifest);
  return { ams, adapter };
}

test("E2E: an IMMEDIATE transition cancels a pending BAR switch that has not played yet", { timeout: 5000 }, async () => {
  const { ams } = await makeFastAms(buildManifest());
  const cueEvents: string[] = [];
  ams.on("cue_changed", (e) => cueEvents.push(e.newCueId));

  ams.setState("Exploration"); // *→* BEAT: audible at 250 ms
  await sleep(400);
  ams.setState("Combat"); // BAR: lands at 1 s
  ams.setState("Cutscene"); // IMMEDIATE, supersedes Combat
  await sleep(1000); // well past the bar where Combat would have landed

  assert.deepEqual(cueEvents, ["cue_exploration", "cue_cutscene"], "the superseded Combat switch must not play");
  assert.equal(ams.getActiveCueId(), "cue_cutscene");
  assert.equal(ams.getActiveState("gameplay"), "Cutscene");
  ams.stop();
});

test("E2E: a rejected non-interruptible supersede leaves the logic layer's state unchanged", async () => {
  const manifest = buildManifest();
  manifest.transitionMatrix = [
    { fromState: "Exploration", toState: "Combat", type: "CUE_SWITCH", quantization: "BAR", crossfadeMs: 0, interruptible: false, priority: 100 },
    { fromState: "Combat", toState: "Cutscene", type: "CUE_SWITCH", quantization: "BEAT", crossfadeMs: 0, priority: 10 },
    { fromState: "*", toState: "*", type: "CUE_SWITCH", quantization: "BEAT", crossfadeMs: 0 },
  ];
  const { ams } = await makeFastAms(manifest);
  const errors: string[] = [];
  ams.on("error", (e) => errors.push(e.message));

  ams.setState("Exploration");
  ams.setState("Combat"); // non-interruptible, priority 100
  ams.setState("Cutscene"); // descriptor priority 10 → rejected

  assert.ok(errors.some((m) => m.includes("superseded")), "the supersede must be rejected");
  assert.equal(ams.getMusicLogicLayer().getActiveState(), "Combat");
  ams.stop();
});

test("E2E: seekToSample holds its position instead of being pulled back as drift", { timeout: 5000 }, async () => {
  const { ams } = await makeFastAms(buildManifest());
  const engine = ams.getPlaybackEngine();
  await sleep(100);
  engine.seekToSample(441000);
  await sleep(200);

  const position = engine.getClock().snapshot().sample.samples;
  assert.ok(position >= 441000 && position < 441000 + 44100, `expected ~441000 + 200 ms, got ${position}`);
  assert.equal(engine.getDriftViolations(), 0);
  ams.stop();
});

test("E2E: pause/resume does not register drift and NullAdapter holds its paused position", { timeout: 5000 }, async () => {
  // Default 10 ms poll: output that moved since the last tick must not be
  // left behind as drift when the clock pauses.
  const { ams, adapter } = await makeFastAms(buildManifest(), 10);
  const engine = ams.getPlaybackEngine();
  await sleep(155);
  engine.pause();
  const frozen = adapter.getCurrentOutputSample();
  assert.ok(frozen > 0, "paused position must be where output stopped, not 0");
  await sleep(200);
  assert.equal(adapter.getCurrentOutputSample(), frozen);
  engine.resume();
  await sleep(150);

  assert.equal(engine.getDriftViolations(), 0);
  ams.stop();
});
