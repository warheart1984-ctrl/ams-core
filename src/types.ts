/**
 * Shared type definitions for the Adaptive Music System.
 *
 * Corrected per review:
 * - State semantics: explicit preemption rules, queued states, re-entry, cancellation
 * - Transition model: conditions, cooldowns, priorities, hysteresis, min durations, interruptibility
 * - Lifecycle API: pause/resume/stop/seek/unload, error semantics, callback threading
 */

import type { ClockSnapshot } from "./clock/Clock.js";

// ─── State Machine ───────────────────────────────────────────────

export interface StateDefinition {
  name: string;
  priority: number; // 0–255, higher wins
  exclusivityGroup: string;
  defaultCueId?: string;
  enterStingerId?: string;
  /** Minimum duration in milliseconds before this state can be preempted. 0 = immediate. */
  minDurationMs?: number;
  /** Whether this state can be re-entered if already active. Default: true. */
  reentrant?: boolean;
  /** Whether this state can be cancelled by a lower-priority state. Default: false. */
  cancellable?: boolean;
}

export interface StateChangeRequest {
  stateName: string;
  priority: number;
  timestampNs: bigint;
  /** If true, this is a cancellation of the current state, not a new state entry. */
  cancellation?: boolean;
}

export interface ActiveState {
  definition: StateDefinition;
  enteredAtNs: bigint;
  /** Stack of states that were preempted by this state, for restoration. */
  preemptedStack: StateDefinition[];
}

export type StateTransitionResult =
  | { kind: "accepted"; prev: string | null; next: string }
  | { kind: "preempted"; preempts: string; prev: string | null; next: string }
  | { kind: "queued"; position: number; next: string }
  | { kind: "rejected"; reason: string; next: string }
  | { kind: "cancelled"; cancelled: string; restored: string | null }
  | { kind: "reentry"; state: string };

// ─── RTPC ────────────────────────────────────────────────────────

export interface RTPCDefinition {
  name: string;
  min: number;
  max: number;
  smoothingMs: number;
  defaultValue?: number;
}

export interface RTPCValue {
  name: string;
  rawValue: number;
  smoothedValue: number;
  timestampNs: bigint;
}

// ─── Mapping Functions ───────────────────────────────────────────

export type MappingFunction =
  | { type: "LINEAR" }
  | { type: "THRESHOLD"; threshold: number }
  | { type: "CURVE"; points: Array<{ x: number; y: number }> };

export function evaluateMapping(fn: MappingFunction, x: number): number {
  const clamped = Math.max(0, Math.min(1, x));
  switch (fn.type) {
    case "LINEAR":
      return clamped;
    case "THRESHOLD":
      return clamped >= fn.threshold ? 1.0 : 0.0;
    case "CURVE": {
      // Bezier over the control points' ordinates: B(t) = Σ C(n,i) t^i (1-t)^(n-i) y_i,
      // evaluated at t = clamped input (RFC §7.1: f(x) = evaluate_bezier(points, x)).
      // B(0) = y₀ and B(1) = yₙ exactly; a monotone control polygon yields a
      // monotone curve. Intermediate points' x positions act as shape handles.
      const pts = fn.points;
      if (pts.length === 0) return clamped;
      if (pts.length === 1) return pts[0].y;
      const n = pts.length - 1;
      let y = 0;
      for (let i = 0; i <= n; i++) {
        y += bernstein(n, i, clamped) * pts[i].y;
      }
      return y;
    }
  }
}

/** Bernstein basis polynomial B(i,n)(t) = C(n,i) t^i (1-t)^(n-i). */
function bernstein(n: number, i: number, t: number): number {
  // Binomial coefficient via multiplicative recurrence (no factorial overflow).
  let coeff = 1;
  for (let k = 0; k < i; k++) coeff = (coeff * (n - k)) / (k + 1);
  return coeff * Math.pow(1 - t, n - i) * Math.pow(t, i);
}

// ─── Stems / Layering ────────────────────────────────────────────

export interface StemDefinition {
  stemId: string;
  volumeMapping: MappingFunction;
  rtpcBinding: string; // RTPC name
  /** Initial volume when stem is not driven by RTPC. Default: 0.0 */
  defaultVolume?: number;
}

export interface CueDefinition {
  cueId: string;
  stems: StemDefinition[];
  bpm: number;
  timeSignature: [number, number];
  loopTargetCueId?: string;
  /** Minimum duration in ms before this cue can be interrupted. 0 = immediate. */
  minDurationMs?: number;
  /** Whether this cue can be interrupted by transitions. Default: true. */
  interruptible?: boolean;
}

// ─── Segments / Horizontal Re-sequencing ─────────────────────────

export interface SegmentDefinition {
  segmentId: string;
  entryPointSamples: number;
  exitPointSamples: number;
  defaultLoopTargetSegmentId?: string;
}

// ─── Stingers ────────────────────────────────────────────────────

export type StingerConflictMode = "QUEUE" | "INTERRUPT" | "LAYER";

export interface StingerDefinition {
  stingerId: string;
  durationBars: number;
  quantization: QuantizationMode;
  mixVolume?: number;
  conflictMode?: StingerConflictMode;
  /** Whether to duck the primary music layer. Default: false. */
  duckPrimary?: boolean;
  duckAmount?: number;
}

// ─── Transitions ─────────────────────────────────────────────────

export type QuantizationMode = "IMMEDIATE" | "BEAT" | "BAR" | "SEGMENT_END";

export type TransitionType = "CUE_SWITCH" | "LAYER_BLEND";

export interface TransitionDescriptor {
  fromState: string;
  toState: string;
  type: TransitionType;
  quantization: QuantizationMode;
  crossfadeMs?: number;
  stingerId?: string;
  stingerVolume?: number;
  /** Target cue to transition to. If omitted, uses the target state's defaultCueId. */
  targetCueId?: string;
  /** Entry point override (samples). If omitted, uses segment default. */
  entryPoint?: number;
  /** Minimum time in ms before this same transition can be triggered again. 0 = no cooldown. */
  cooldownMs?: number;
  /** Priority of this transition rule. Higher wins when multiple rules match. Default: 0. */
  priority?: number;
  /** Whether this transition can interrupt an in-progress transition. Default: true. */
  interruptible?: boolean;
  /** Condition expression evaluated against RTPC values. If false, transition is skipped. */
  condition?: string;
  /** Hysteresis band: RTPC must move this far past a threshold before re-triggering. */
  hysteresisBand?: number;
  /** Minimum time the source cue must have been playing before this transition is allowed. */
  minSourceDurationMs?: number;
  /** Maximum time the source cue can play before forcing this transition. 0 = no timeout. */
  maxSourceDurationMs?: number;
}

export interface TransitionMatrixEntry {
  descriptor: TransitionDescriptor;
  /** Timestamp of last execution for cooldown tracking */
  lastExecutedAtNs?: bigint;
}

// ─── Playback Instructions ───────────────────────────────────────

export interface PlaybackInstruction {
  type: "CUE_SWITCH" | "STEM_VOLUME" | "STINGER" | "CROSSFADE" | "STOP" | "SEEK" | "PAUSE" | "RESUME";
  /** Target sample position for sample-accurate scheduling */
  atSample: number;
  /** Cue switch parameters */
  targetCueId?: string;
  crossfadeMs?: number;
  entryPoint?: number;
  /** Stem volume parameters */
  stemId?: string;
  targetVolume?: number;
  rampMs?: number;
  /** Stinger parameters */
  stingerId?: string;
  stingerVolume?: number;
  /** General */
  immediately?: boolean;
}

// ─── Events ──────────────────────────────────────────────────────

export interface BeatEvent {
  type: "beat";
  beatNumber: number;
  barNumber: number;
  bpm: number;
  timestampNs: bigint;
}

export interface BarEvent {
  type: "bar";
  barNumber: number;
  timeSignature: [number, number];
  bpm: number;
  timestampNs: bigint;
}

export interface CueChangedEvent {
  type: "cue_changed";
  prevCueId: string | null;
  newCueId: string;
  triggeredByState: string;
}

export interface TransitionStartEvent {
  type: "transition_start";
  fromCueId: string;
  toCueId: string;
  crossfadeMs: number;
  quantization: QuantizationMode;
}

export interface TransitionEndEvent {
  type: "transition_end";
  fromCueId: string;
  toCueId: string;
  elapsedMs: number;
}

export interface ErrorEvent {
  type: "error";
  code: string;
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
}

export interface WarningEvent {
  type: "warning";
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export type AMSEvent =
  | BeatEvent
  | BarEvent
  | CueChangedEvent
  | TransitionStartEvent
  | TransitionEndEvent
  | ErrorEvent
  | WarningEvent;

export type EventHandler<T = { type: string }> = (event: T) => void;

// ─── Cue Bank ────────────────────────────────────────────────────

export interface CueBankManifest {
  version: string;
  /** SHA-256 checksums of all constituent assets */
  checksums: Record<string, string>;
  /** HMAC-SHA-256 signature of the manifest (for authenticated integrity) */
  manifestSignature?: string;
  /** Public key identifier for signature verification */
  signingKeyId?: string;
  states: StateDefinition[];
  rtpcs: RTPCDefinition[];
  cues: CueDefinition[];
  segments: SegmentDefinition[];
  stingers: StingerDefinition[];
  transitionMatrix: TransitionDescriptor[];
}

export interface CueBankHandle {
  manifest: CueBankManifest;
  loadedAtNs: bigint;
  /** Memory usage in bytes */
  memoryBytes: number;
  /** Pinned banks are exempt from the 30-second inactivity eviction (RFC §13.1). */
  pinned?: boolean;
}

// ─── Memory Profiles ─────────────────────────────────────────────

export type MemoryProfile = "DEFAULT" | "REDUCED" | "MINIMAL";

export const MEMORY_PROFILE_LIMITS: Record<MemoryProfile, number> = {
  DEFAULT: 64 * 1024 * 1024,   // 64 MB
  REDUCED: 32 * 1024 * 1024,   // 32 MB
  MINIMAL: 16 * 1024 * 1024,   // 16 MB
};

// ─── Lifecycle ───────────────────────────────────────────────────

export type AMSLifecycleState =
  | "uninitialized"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "stopped"
  | "error";

export interface UnsubHandle {
  unsubscribe(): void;
}

// ─── Adapter Interface ───────────────────────────────────────────

export interface PlaybackAdapter {
  /** Initialize the adapter with audio context */
  initialize(sampleRate: number): Promise<void>;
  /** Schedule a playback instruction at a specific sample position */
  schedule(instruction: PlaybackInstruction): void;
  /** Get current audio output position in samples (for drift measurement) */
  getCurrentOutputSample(): number;
  /** Pause audio output */
  pause(): void;
  /** Resume audio output */
  resume(): void;
  /** Stop all audio output */
  stop(): void;
  /** Release resources */
  dispose(): void;
  /** Get adapter-specific capabilities/limitations */
  getCapabilities(): AdapterCapabilities;
}

export interface AdapterCapabilities {
  name: string;
  supportsStreaming: boolean;
  supportsSampleAccurateScheduling: boolean;
  maxConcurrentStems: number;
  maxConcurrentStingers: number;
  /** Known limitations */
  limitations: string[];
}

// ─── Error Types ─────────────────────────────────────────────────

export class AMSError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly recoverable: boolean = true,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AMSError";
  }
}

export const ErrorCodes = {
  BANK_VALIDATION_FAILED: "BANK_VALIDATION_FAILED",
  BANK_SIZE_EXCEEDED: "BANK_SIZE_EXCEEDED",
  BANK_LOAD_FAILED: "BANK_LOAD_FAILED",
  STATE_NOT_REGISTERED: "STATE_NOT_REGISTERED",
  RTPC_NOT_REGISTERED: "RTPC_NOT_REGISTERED",
  RTPC_VALUE_OUT_OF_RANGE: "RTPC_VALUE_OUT_OF_RANGE",
  STINGER_NOT_FOUND: "STINGER_NOT_FOUND",
  CUE_NOT_FOUND: "CUE_NOT_FOUND",
  TRANSITION_FAILED: "TRANSITION_FAILED",
  CLOCK_DRIFT_EXCEEDED: "CLOCK_DRIFT_EXCEEDED",
  ADAPTER_INIT_FAILED: "ADAPTER_INIT_FAILED",
  INVALID_CONFIG: "INVALID_CONFIG",
  LIFECYCLE_VIOLATION: "LIFECYCLE_VIOLATION",
  SEGMENT_NOT_FOUND: "SEGMENT_NOT_FOUND",
  CONFORMANCE_VIOLATION: "CONFORMANCE_VIOLATION",
} as const;
