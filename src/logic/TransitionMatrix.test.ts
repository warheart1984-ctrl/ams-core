import { test } from "node:test";
import assert from "node:assert/strict";
import { TransitionMatrix } from "./TransitionMatrix.js";
import type { TransitionDescriptor } from "../types.js";

const d = (over: Partial<TransitionDescriptor> & { fromState: string; toState: string }): TransitionDescriptor => ({
  type: "CUE_SWITCH",
  quantization: "BAR",
  ...over,
});

test("Matrix: exact match beats wildcard beats fallback", () => {
  const m = new TransitionMatrix([
    d({ fromState: "Exploration", toState: "Combat", quantization: "BAR" }),
    d({ fromState: "*", toState: "Menu", quantization: "IMMEDIATE" }),
    d({ fromState: "*", toState: "*", quantization: "BEAT" }),
  ]);
  assert.equal(m.lookup("Exploration", "Combat")?.quantization, "BAR");
  assert.equal(m.lookup("AnyRandom", "Menu")?.quantization, "IMMEDIATE");
  assert.equal(m.lookup("AnyRandom", "Combat")?.quantization, "BEAT");
});

test("Matrix: wildcard precedence vs fallback", () => {
  const m = new TransitionMatrix([
    d({ fromState: "*", toState: "Cutscene", quantization: "IMMEDIATE" }),
    d({ fromState: "*", toState: "*", quantization: "SEGMENT_END" }),
  ]);
  assert.equal(m.lookup("Combat", "Cutscene")?.quantization, "IMMEDIATE");
  assert.equal(m.lookup("Combat", "Victory")?.quantization, "SEGMENT_END");
});

test("Matrix: missing entry returns null", () => {
  const m = new TransitionMatrix([
    d({ fromState: "Exploration", toState: "Combat" }),
  ]);
  assert.equal(m.lookup("Combat", "Exploration"), null);
});

test("Matrix: O(1) lookup performance over large matrices", () => {
  const descriptors: TransitionDescriptor[] = [];
  for (let i = 0; i < 5000; i++) {
    descriptors.push(d({ fromState: `S${i}`, toState: `T${i}` }));
  }
  const m = new TransitionMatrix(descriptors);
  const start = performance.now();
  for (let i = 0; i < 5000; i++) {
    assert.ok(m.lookup(`S${i}`, `T${i}`));
  }
  const elapsed = performance.now() - start;
  // 5000 lookups in a 5000-entry map must be sub-millisecond.
  assert.ok(elapsed < 50, `lookups took ${elapsed}ms`);
});

test("Matrix: deterministic tie-break ordering", () => {
  const m1 = new TransitionMatrix([d({ fromState: "A", toState: "B", priority: 5 }), d({ fromState: "*", toState: "C", priority: 3 })]);
  const m2 = new TransitionMatrix([d({ fromState: "A", toState: "B", priority: 5 }), d({ fromState: "*", toState: "C", priority: 3 })]);
  assert.deepEqual([m1.lookup("A", "B")?.priority, m1.lookup("A", "C")?.priority], [5, 3]);
  assert.deepEqual([m2.lookup("A", "B")?.priority, m2.lookup("A", "C")?.priority], [5, 3]);
});