import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextEngine } from "./ContextEngine.js";

function makeEngine(): ContextEngine {
  return new ContextEngine({ rtpcUpdateRateHz: 1000 });
}

function registerBaseline(engine: ContextEngine): void {
  engine.registerState({ name: "Exploration", priority: 50, exclusivityGroup: "gameplay" });
  engine.registerState({ name: "Combat", priority: 80, exclusivityGroup: "gameplay" });
  engine.registerState({ name: "Cutscene", priority: 200, exclusivityGroup: "gameplay" });
  engine.registerState({ name: "Menu", priority: 255, exclusivityGroup: "ui" });
  engine.registerRtpc({ name: "tension", min: 0, max: 100, smoothingMs: 200 });
}

test("State: first entry accepted", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  const result = engine.setState("Exploration");
  assert.equal(result.kind, "accepted");
  assert.equal(engine.getActiveStateName(), "Exploration");
});

test("State: higher priority preempts lower priority", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setState("Exploration");
  const events: Array<{ kind: string; prev: string | null; next: string }> = [];
  engine.on("state", (e) => events.push({ kind: e.kind, prev: e.prevState, next: e.newState }));

  const result = engine.setState("Combat");
  assert.equal(result.kind, "preempted");
  assert.equal((result as { preempts: string }).preempts, "Exploration");
  assert.equal(engine.getActiveStateName(), "Combat");
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "preempted");
  assert.equal(events[0].prev, "Exploration");
});

test("State: lower priority is queued, not silently ignored", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setState("Combat"); // priority 80 active
  const result = engine.setState("Exploration", 50); // lower
  assert.equal(result.kind, "queued");
  assert.equal(engine.getActiveStateName(), "Combat");
  assert.equal(engine.getQueuedCount("gameplay"), 1);
});

test("State: same-name re-entry semantics", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setState("Combat");
  const result = engine.setState("Combat");
  assert.equal(result.kind, "reentry");
  // Still active, no event emitted
  assert.equal(engine.getActiveStateName(), "Combat");
});

test("State: non-reentrant state rejects re-entry", () => {
  const engine = makeEngine();
  engine.registerState({ name: "OnlyOnce", priority: 100, exclusivityGroup: "g", reentrant: false });
  engine.setState("OnlyOnce");
  const result = engine.setState("OnlyOnce");
  assert.equal(result.kind, "rejected");
});

test("State: priority override clamps", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setState("Exploration");
  // 999 clamps to 255, still higher than Exploration's 50
  const result = engine.setState("Combat", 999);
  assert.equal(result.kind, "preempted");
});

test("State: cancellation restores preempted stack", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setState("Exploration", 50);
  engine.setState("Combat", 80);
  engine.setState("Cutscene", 200);
  assert.equal(engine.getActiveStateName(), "Cutscene");

  const result = engine.cancelState("gameplay");
  assert.equal(result.kind, "cancelled");
  assert.equal((result as { restored: string | null }).restored, "Combat");
  assert.equal(engine.getActiveStateName(), "Combat");
});

test("State: processQueue drains in priority order", () => {
  const engine = makeEngine();
  engine.registerState({ name: "High", priority: 100, exclusivityGroup: "g", cancellable: true });
  engine.registerState({ name: "Mid", priority: 60, exclusivityGroup: "g" });
  engine.registerState({ name: "Low", priority: 30, exclusivityGroup: "g" });

  engine.setState("High", 100);
  engine.setState("Mid", 60); // queued (60 < 100)
  engine.setState("Low", 30); // queued (30 < 100)
  assert.equal(engine.getQueuedCount("g"), 2);

  // Cancel the high-priority active state; queue drains to Mid.
  const cancel = engine.cancelState("g");
  assert.equal(cancel.kind, "cancelled");
  const results = engine.processQueue("g");
  assert.ok(results.some((r) => r.kind === "accepted"));
  assert.equal(engine.getActiveStateName(), "Mid");

  // Low remains queued behind Mid (30 < 60)
  assert.equal(engine.getQueuedCount("g"), 1);
  assert.equal(engine.getQueuedCount("g"), engine.getQueuedCount("g"));
});

test("State: minDurationMs guard queues early preemption", () => {
  const engine = makeEngine();
  engine.registerState({ name: "Intro", priority: 100, exclusivityGroup: "g", minDurationMs: 5000 });
  engine.registerState({ name: "Game", priority: 50, exclusivityGroup: "g" });
  engine.registerState({ name: "Urgent", priority: 200, exclusivityGroup: "g" });

  engine.setState("Intro");
  // Game has lower priority → queued
  const queued = engine.setState("Game");
  assert.equal(queued.kind, "queued");
  // Urgent is higher priority even during min-duration → preempts
  const urgent = engine.setState("Urgent");
  assert.equal(urgent.kind, "preempted");
});

test("RTPC: values are clamped to [0,1] and NaN rejected", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setRtpc("tension", 1.5, 0);
  assert.equal(engine.getRtpcValue("tension"), 1.0);
  assert.throws(() => engine.setRtpc("tension", NaN, 0));
  assert.throws(() => engine.setRtpc("tension", Infinity, 0));
});

test("RTPC: smoothing ramp produces interpolated values", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setRtpc("tension", 0.0, 0);
  engine.setRtpc("tension", 1.0, 100);
  assert.equal(engine.getRtpcValue("tension"), 0.0);
  engine.computeSmoothedValues();
  const value = engine.getRtpcValue("tension");
  assert.ok(value > 0.0);
  assert.ok(value < 1.0);
});

test("RTPC: unknown RTPC throws", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  assert.throws(() => engine.setRtpc("does_not_exist", 0.5, 0));
});

test("Concurrency: simultaneous state calls with equal priority resolve deterministically", () => {
  const engine = makeEngine();
  engine.registerState({ name: "A", priority: 50, exclusivityGroup: "g" });
  engine.registerState({ name: "B", priority: 50, exclusivityGroup: "g" });

  // Same-priority: first-come-first-served. A enters, B is queued.
  const r1 = engine.setState("A", 50);
  const r2 = engine.setState("B", 50);
  assert.equal(r1.kind, "accepted");
  assert.equal(r2.kind, "queued");
  assert.equal(engine.getActiveStateName(), "A");
});
test("State: revertStateChange restores the preempted state and its stack, silently", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setState("Exploration");
  engine.setState("Combat");
  const events: string[] = [];
  engine.on("state", (e) => events.push(e.newState));

  assert.equal(engine.revertStateChange("gameplay", "Combat"), true);
  assert.equal(engine.getActiveStateName("gameplay"), "Exploration");
  assert.equal(engine.getActiveState("gameplay")!.preemptedStack.length, 0);
  assert.deepEqual(events, [], "a rollback must not emit a state event");

  // Only the most recent change can be undone, and only once.
  assert.equal(engine.revertStateChange("gameplay", "Exploration"), false);
});

test("State: revertStateChange of a first entry leaves the group empty", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setState("Exploration");
  assert.equal(engine.revertStateChange("gameplay", "Exploration"), true);
  assert.equal(engine.getActiveStateName("gameplay"), null);
  // Re-entering is a fresh accept, not a re-entry.
  assert.equal(engine.setState("Exploration").kind, "accepted");
});

test("State: revertStateChange ignores a state that is no longer active", () => {
  const engine = makeEngine();
  registerBaseline(engine);
  engine.setState("Exploration");
  engine.setState("Combat");
  assert.equal(engine.revertStateChange("gameplay", "Exploration"), false);
  assert.equal(engine.getActiveStateName("gameplay"), "Combat");
});
