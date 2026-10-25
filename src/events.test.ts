import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "./events.js";

test("Events: handler failure reaches the error channel when a listener exists", () => {
  const errors: string[] = [];
  const emitter = new EventEmitter<{ type: string }>();
  emitter.on("error", (e) => errors.push((e as { code?: string }).code ?? ""));
  emitter.on("beat", () => {
    throw new Error("boom");
  });

  emitter.emit({ type: "beat" });
  assert.deepEqual(errors, ["CALLBACK_ERROR"]);
});

test("Events: handler failure falls back to the logger when no error listener exists", () => {
  const logged: string[] = [];
  const logger = { error: (msg: string, ..._args: unknown[]) => { logged.push(msg); } };
  const emitter = new EventEmitter<{ type: string }>(logger);
  emitter.on("beat", () => {
    throw new Error("boom");
  });

  emitter.emit({ type: "beat" });
  assert.equal(logged.length, 1, "failure must reach the logger, not be dropped");
  assert.match(logged[0], /beat/);
});

test("Events: a throwing logger still does not break emit", () => {
  const logger = { error: () => { throw new Error("logger down"); } };
  const emitter = new EventEmitter<{ type: string }>(logger);
  emitter.on("beat", () => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() => emitter.emit({ type: "beat" }));
});
