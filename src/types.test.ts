import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMapping } from "./types.js";

test("CURVE: Bezier endpoints are exact (RFC §7.1)", () => {
  const curve = {
    type: "CURVE" as const,
    points: [
      { x: 0, y: 0.2 },
      { x: 0.5, y: 1.0 },
      { x: 1, y: 0.8 },
    ],
  };
  assert.equal(evaluateMapping(curve, 0), 0.2);
  assert.equal(evaluateMapping(curve, 1), 0.8);
});

test("CURVE: interior follows Bezier, not piecewise linear", () => {
  // Control polygon [0, 1, 0]: Bernstein midpoint is 0.5, a linear join would be 1.0.
  const curve = {
    type: "CURVE" as const,
    points: [
      { x: 0, y: 0 },
      { x: 0.5, y: 1 },
      { x: 1, y: 0 },
    ],
  };
  assert.ok(Math.abs(evaluateMapping(curve, 0.5) - 0.5) < 1e-9);
});

test("CURVE: monotone control polygon gives a monotone curve", () => {
  const curve = {
    type: "CURVE" as const,
    points: [
      { x: 0, y: 0 },
      { x: 0.3, y: 0.4 },
      { x: 0.7, y: 0.6 },
      { x: 1, y: 1 },
    ],
  };
  let prev = -1;
  for (const x of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
    const y = evaluateMapping(curve, x);
    assert.ok(y >= prev, `curve not monotone at x=${x} (y=${y} < ${prev})`);
    prev = y;
  }
});

test("CURVE: single-point edge case is constant", () => {
  const curve = { type: "CURVE" as const, points: [{ x: 0.5, y: 0.7 }] };
  assert.equal(evaluateMapping(curve, 0), 0.7);
  assert.equal(evaluateMapping(curve, 0.5), 0.7);
  assert.equal(evaluateMapping(curve, 1), 0.7);
});

test("CURVE: input is clamped to [0,1] before evaluation", () => {
  const curve = {
    type: "CURVE" as const,
    points: [
      { x: 0, y: 0.1 },
      { x: 1, y: 0.9 },
    ],
  };
  assert.equal(evaluateMapping(curve, -0.5), 0.1);
  assert.equal(evaluateMapping(curve, 1.5), 0.9);
});
