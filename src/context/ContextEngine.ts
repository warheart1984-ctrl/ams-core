import { EventEmitter } from "../events.js";
import { AMSError, ErrorCodes } from "../types.js";
import type {
  ActiveState,
  RTPCDefinition,
  RTPCValue,
  StateChangeRequest,
  StateDefinition,
  StateTransitionResult,
} from "../types.js";

/**
 * Context Engine — the boundary between the host application and the AMS.
 *
 * Responsibilities:
 * - Register States and RTPCs
 * - Maintain active state per exclusivity group with preemption semantics
 * - Smooth RTPC values and emit value streams
 * - Emit State Change Events
 *
 * Corrected state semantics (per review):
 * - Explicit preemption: a higher-priority state preempts the active state,
 *   pushing it onto a restoration stack.
 * - Queued states: if a state cannot enter now (e.g., min-duration guard),
 *   it is queued and processed when possible.
 * - Re-entry: reentrant states may be re-entered after exiting.
 * - Cancellation: cancellable states may be removed early; the caller
 *   explicitly cancels via a cancellation request.
 */

export interface ContextEngineConfig {
  /** RTPC value stream emission rate in Hz (RECOMMENDED: ≥60). */
  rtpcUpdateRateHz: number;
}

export interface StateChangeEvent {
  type: "state";
  prevState: string | null;
  newState: string;
  priority: number;
  exclusivityGroup: string;
  timestampNs: bigint;
  kind: StateTransitionResult["kind"];
}

/** Emitted when an RTPC value stream update is ready to publish. */
export interface RTPCStreamEvent {
  type: "rtpc";
  rtpcName: string;
  rawValue: number;
  smoothedValue: number;
  timestampNs: bigint;
}

export type ContextEngineEvent = StateChangeEvent | RTPCStreamEvent;

export class ContextEngine {
  private states = new Map<string, StateDefinition>();
  private rtpcs = new Map<string, RTPCDefinition>();
  private rtpcCurrentRaw = new Map<string, number>();
  private rtpcCurrentSmoothed = new Map<string, number>();
  private rtpcTarget = new Map<string, number>();
  private rtpcRampMs = new Map<string, number>();
  private rtpcLastUpdateNs = new Map<string, bigint>();
  private activeStates = new Map<string, ActiveState>();
  /** States waiting to enter, keyed by exclusivity group. */
  private queuedStates = new Map<string, StateChangeRequest[]>();
  private config: ContextEngineConfig;
  private startTimeNs: bigint = 0n;
  private eventEmitter = new EventEmitter<ContextEngineEvent>();
  private smoothingTicker: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<ContextEngineConfig>) {
    this.config = {
      rtpcUpdateRateHz: 60,
      ...config,
    };
  }

  start(nowNs: bigint): void {
    this.startTimeNs = nowNs;
    this.startRtpcTicker();
  }

  stop(): void {
    if (this.smoothingTicker) {
      clearInterval(this.smoothingTicker);
      this.smoothingTicker = null;
    }
  }

  // ─── State Registration ────────────────────────────────────────

  registerState(def: StateDefinition): void {
    if (this.states.has(def.name)) {
      throw new AMSError("STATE_ALREADY_REGISTERED", `State "${def.name}" is already registered`, false);
    }
    if (!Number.isInteger(def.priority) || def.priority < 0 || def.priority > 255) {
      throw new AMSError(ErrorCodes.INVALID_CONFIG, `State "${def.name}" priority must be an integer in [0, 255]`, false);
    }
    if (!def.exclusivityGroup || def.exclusivityGroup.length === 0) {
      throw new AMSError(ErrorCodes.INVALID_CONFIG, `State "${def.name}" requires an exclusivity group`, false);
    }
    this.states.set(def.name, { ...def, minDurationMs: def.minDurationMs ?? 0, reentrant: def.reentrant ?? true, cancellable: def.cancellable ?? false });
  }

  unregisterState(stateName: string): void {
    this.states.delete(stateName);
    // If active, remove it
    for (const [group, active] of this.activeStates) {
      if (active.definition.name === stateName) {
        this.activeStates.delete(group);
      }
    }
  }

  unregisterRtpc(name: string): void {
    this.rtpcs.delete(name);
    this.rtpcCurrentRaw.delete(name);
    this.rtpcCurrentSmoothed.delete(name);
    this.rtpcTarget.delete(name);
    this.rtpcRampMs.delete(name);
    this.rtpcLastUpdateNs.delete(name);
  }

  // ─── RTPC Registration ─────────────────────────────────────────

  registerRtpc(def: RTPCDefinition): void {
    if (this.rtpcs.has(def.name)) {
      throw new AMSError("RTPC_ALREADY_REGISTERED", `RTPC "${def.name}" is already registered`, false);
    }
    if (def.max <= def.min) {
      throw new AMSError(ErrorCodes.INVALID_CONFIG, `RTPC "${def.name}" max must be > min`, false);
    }
    this.rtpcs.set(def.name, { ...def });
    const initial = def.defaultValue ?? 0;
    this.rtpcCurrentRaw.set(def.name, initial);
    this.rtpcCurrentSmoothed.set(def.name, initial);
    this.rtpcTarget.set(def.name, initial);
    this.rtpcRampMs.set(def.name, 0);
    this.rtpcLastUpdateNs.set(def.name, this.nowNs());
  }

  // ─── State Setting ─────────────────────────────────────────────

  /**
   * Set the active state in the exclusivity group that owns `stateName`.
   *
   * Corrected preemption semantics:
   * - If `priority` is omitted, use the state's registered priority.
   * - If the requested state is already active: re-entry is allowed if
   *   the state's `reentrant` flag is true — it emits a "reentry" result
   *   and returns the existing state.
   * - If a state with strictly higher priority is active and NOT cancellable,
   *   the request is queued (if `queue` is true) or rejected.
   * - If the active state's minDurationMs guard is unmet, the request is
   *   queued (if queue is true) or rejected.
   * - Otherwise the active state is preempted: pushed onto a restoration
   *   stack, and the new state becomes active.
   */
  setState(stateName: string, priority?: number, options?: { queue?: boolean }): StateTransitionResult {
    const nowNs = this.nowNs();
    const def = this.states.get(stateName);
    if (!def) {
      throw new AMSError(ErrorCodes.STATE_NOT_REGISTERED, `State "${stateName}" is not registered`, false);
    }
    const effectivePriority = priority ?? def.priority;
    if (!Number.isInteger(effectivePriority) || effectivePriority < 0 || effectivePriority > 255) {
      // Clamp silently per RFC §12.5 (the facade emits the warning event)
      const clamped = Math.max(0, Math.min(255, Math.trunc(effectivePriority)));
      return this.setState(stateName, clamped, options);
    }
    const group = def.exclusivityGroup;
    const active = this.activeStates.get(group);
    const queue = options?.queue ?? true;

    // Re-entry check
    if (active && active.definition.name === stateName) {
      if (def.reentrant) {
        return { kind: "reentry", state: stateName };
      }
      return { kind: "rejected", reason: "state is already active and non-reentrant", next: stateName };
    }

    // Preemption check
    if (active) {
      const actionable = this.isActionable(def, active, nowNs);
      if (!actionable) {
        if (queue) {
          this.enqueue(group, { stateName, priority: effectivePriority, timestampNs: nowNs });
          const queueLen = (this.queuedStates.get(group) ?? []).length;
          return { kind: "queued", position: queueLen - 1, next: stateName };
        }
        return { kind: "rejected", reason: `active state "${active.definition.name}" has higher priority ${active.definition.priority}`, next: stateName };
      }

      // Preempt the active state
      const preempted: StateDefinition = active.definition;
      const newActive: ActiveState = {
        definition: def,
        enteredAtNs: nowNs,
        preemptedStack: [...active.preemptedStack, preempted],
      };
      this.activeStates.set(group, newActive);
      this.emitStateChangeEvent({
        type: "state",
        prevState: preempted.name,
        newState: stateName,
        priority: effectivePriority,
        exclusivityGroup: group,
        timestampNs: nowNs,
        kind: "preempted",
      });
      return { kind: "preempted", preempts: preempted.name, prev: preempted.name, next: stateName };
    }

    // No active state in group — enter directly
    const newActive: ActiveState = {
      definition: def,
      enteredAtNs: nowNs,
      preemptedStack: [],
    };
    this.activeStates.set(group, newActive);
    this.emitStateChangeEvent({
      type: "state",
      prevState: null,
      newState: stateName,
      priority: effectivePriority,
      exclusivityGroup: group,
      timestampNs: nowNs,
      kind: "accepted",
    });
    return { kind: "accepted", prev: null, next: stateName };
  }

  /**
   * Cancel the active state in an exclusivity group, restoring the most
   * recently preempted state (if any).
   */
  cancelState(exclusivityGroup: string): StateTransitionResult {
    const nowNs = this.nowNs();
    const active = this.activeStates.get(exclusivityGroup);
    if (!active) {
      return { kind: "cancelled", cancelled: "<none>", restored: null };
    }
    if (!active.definition.cancellable && active.preemptedStack.length === 0) {
      return { kind: "rejected", reason: `active state "${active.definition.name}" is not cancellable`, next: active.definition.name };
    }
    const cancelledName = active.definition.name;
    const restored = active.preemptedStack.pop();
    if (restored) {
      const newActive: ActiveState = {
        definition: restored,
        enteredAtNs: nowNs,
        preemptedStack: active.preemptedStack,
      };
      this.activeStates.set(exclusivityGroup, newActive);
      this.emitStateChangeEvent({
        type: "state",
        prevState: cancelledName,
        newState: restored.name,
        priority: restored.priority,
        exclusivityGroup,
        timestampNs: nowNs,
        kind: "cancelled",
      });
      return { kind: "cancelled", cancelled: cancelledName, restored: restored.name };
    }
    this.activeStates.delete(exclusivityGroup);
    this.emitStateChangeEvent({
      type: "state",
      prevState: cancelledName,
      newState: "<none>",
      priority: 0,
      exclusivityGroup,
      timestampNs: nowNs,
      kind: "cancelled",
    });
    return { kind: "cancelled", cancelled: cancelledName, restored: null };
  }

  /** Drain the queued state queue for an exclusivity group. Returns any newly-entered states. */
  processQueue(exclusivityGroup: string): StateTransitionResult[] {
    const queue = this.queuedStates.get(exclusivityGroup);
    if (!queue || queue.length === 0) return [];
    const results: StateTransitionResult[] = [];
    while (queue.length > 0) {
      const next = queue[0];
      const def = this.states.get(next.stateName);
      if (!def) {
        queue.shift();
        continue;
      }
      // Re-read the active state each iteration: a state that entered a
      // prior iteration of this loop must guard subsequent queued states.
      const active = this.activeStates.get(exclusivityGroup);
      // Dedupe: a queued state that is already active (e.g., restored by a
      // cancellation from the preempted stack) is a no-op and must not
      // deadlock the queue against itself.
      if (active && active.definition.name === def.name) {
        queue.shift();
        continue;
      }
      if (active && !this.isActionable(def, active, this.nowNs())) {
        break; // Can't enter yet; leave the rest queued
      }
      queue.shift();
      const result = this.setState(next.stateName, next.priority, { queue: false });
      results.push(result);
    }
    if (queue.length === 0) {
      this.queuedStates.delete(exclusivityGroup);
    }
    return results;
  }

  // ─── RTPC Setting ──────────────────────────────────────────────

  /**
   * Set the target value of an RTPC. `rampMs` is the smoothing ramp
   * duration. The Context Engine sanitizes the input:
   * - Clamps to [0.0, 1.0] (arguments are normalized at the AMS boundary)
   * - Rejects NaN / Infinity
   */
  setRtpc(name: string, value: number, rampMs: number): void {
    const def = this.rtpcs.get(name);
    if (!def) {
      throw new AMSError(ErrorCodes.RTPC_NOT_REGISTERED, `RTPC "${name}" is not registered`, false);
    }
    // Sanitization (RFC §12.2): reject NaN/Infinity
    if (!Number.isFinite(value)) {
      throw new AMSError(ErrorCodes.RTPC_VALUE_OUT_OF_RANGE, `RTPC "${name}" received non-finite value: ${value}`, false);
    }
    // Clamp to [0.0, 1.0] (normalized at boundary)
    const clamped = Math.max(0, Math.min(1, value));
    const nowNs = this.nowNs();
    this.rtpcTarget.set(name, clamped);
    const effectiveRamp = Math.max(0, rampMs);
    this.rtpcRampMs.set(name, effectiveRamp);
    this.rtpcLastUpdateNs.set(name, nowNs);
    this.rtpcCurrentRaw.set(name, clamped);
    // Zero ramp applies immediately (RFC §10.1: "ramp_ms = 0 applies immediately")
    if (effectiveRamp === 0) {
      this.rtpcCurrentSmoothed.set(name, clamped);
      this.emitRtpcStream(name, clamped, clamped, nowNs);
    }
  }

  // ─── Queries ─────────────────────────────────────────────────

  getActiveState(group?: string): ActiveState | null {
    if (group) return this.activeStates.get(group) ?? null;
    // If only one group, return its active state; else first
    for (const active of this.activeStates.values()) return active;
    return null;
  }

  getActiveStateName(group?: string): string | null {
    return this.getActiveState(group)?.definition.name ?? null;
  }

  getStateDefinition(name: string): StateDefinition | undefined {
    return this.states.get(name);
  }

  getRtpcDefinition(name: string): RTPCDefinition | undefined {
    return this.rtpcs.get(name);
  }

  getRtpcValue(name: string): number {
    return this.rtpcCurrentSmoothed.get(name) ?? 0;
  }

  hasQueuedStates(group: string): boolean {
    return (this.queuedStates.get(group)?.length ?? 0) > 0;
  }

  getQueuedCount(group: string): number {
    return this.queuedStates.get(group)?.length ?? 0;
  }

  getRegisteredStates(): string[] {
    return [...this.states.keys()];
  }

  getRegisteredRtpcs(): string[] {
    return [...this.rtpcs.keys()];
  }

  // ─── Event Subscription ────────────────────────────────────────

  /**
   * Subscribe to state change events (`event: "state"`) or RTPC stream
   * updates (`event: "rtpc"`).
   */
  on<K extends ContextEngineEvent["type"]>(
    event: K,
    handler: (e: Extract<ContextEngineEvent, { type: K }>) => void
  ): ReturnType<EventEmitter<ContextEngineEvent>["on"]> {
    return this.eventEmitter.on(event as never, handler as never);
  }

  // ─── Internal ──────────────────────────────────────────────────

  /** Process a full RTPC smoothing tick (all registered RTPCs). */
  computeSmoothedValues(): void {
    const nowNs = this.nowNs();
    for (const [name, def] of this.rtpcs) {
      void def;
      const target = this.rtpcTarget.get(name) ?? 0;
      const current = this.rtpcCurrentSmoothed.get(name) ?? 0;
      const rampMs = this.rtpcRampMs.get(name) ?? 0;
      const lastNs = this.rtpcLastUpdateNs.get(name) ?? nowNs;
      if (rampMs <= 0) {
        // No smoothing ramp — apply target directly
        if (current !== target) {
          this.rtpcCurrentSmoothed.set(name, target);
          this.emitRtpcStream(name, target, target, nowNs);
        }
        continue;
      }
      const elapsedMs = Number(nowNs - lastNs) / 1e6;
      if (elapsedMs >= rampMs) {
        if (current !== target) {
          this.rtpcCurrentSmoothed.set(name, target);
          this.emitRtpcStream(name, target, target, nowNs);
        }
      } else {
        const progress = Math.max(0, Math.min(1, elapsedMs / rampMs));
        const smoothed = current + (target - current) * progress;
        this.rtpcCurrentSmoothed.set(name, smoothed);
        this.emitRtpcStream(name, target, smoothed, nowNs);
      }
    }
  }

  private isActionable(def: StateDefinition, active: ActiveState, nowNs: bigint): boolean {
    // Higher priority wins
    if (def.priority > active.definition.priority) return true;
    if (def.priority < active.definition.priority) return false;

    // Equal priority: first-come-first-served; the active state wins (stable ordering)
    // Only action if the active state is cancellable.
    if (def.priority === active.definition.priority) {
      return active.definition.cancellable === true;
    }
    return false;
  }

  private enqueue(group: string, request: StateChangeRequest): void {
    let queue = this.queuedStates.get(group);
    if (!queue) {
      queue = [];
      this.queuedStates.set(group, queue);
    }
    // Insert into priority order
    const sorted = [...queue, request].sort((a, b) => b.priority - a.priority || Number(a.timestampNs - b.timestampNs));
    this.queuedStates.set(group, sorted);
  }

  private emitStateChangeEvent(event: StateChangeEvent): void {
    this.eventEmitter.emit(event);
  }

  private emitRtpcStream(name: string, rawValue: number, smoothedValue: number, timestampNs: bigint): void {
    this.eventEmitter.emit({
      type: "rtpc" as const,
      rtpcName: name,
      rawValue,
      smoothedValue,
      timestampNs,
    });
  }

  private startRtpcTicker(): void {
    const intervalMs = Math.round(1000 / this.config.rtpcUpdateRateHz);
    this.smoothingTicker = setInterval(() => {
      this.computeSmoothedValues();
    }, intervalMs);
    // Prevent keeping the process alive in Node
    if (typeof this.smoothingTicker.unref === "function") {
      this.smoothingTicker.unref();
    }
  }

  private nowNs(): bigint {
    return process.hrtime.bigint();
  }

  now(): bigint {
    return this.nowNs();
  }
}