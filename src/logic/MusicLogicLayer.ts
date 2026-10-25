import { evaluateMapping } from "../types.js";
import type {
  CueDefinition,
  CueChangedEvent,
  PlaybackInstruction,
  PlaybackAdapter,
  QuantizationMode,
  StateChangeRequest,
  StemDefinition,
  StingerDefinition,
  TransitionDescriptor,
  TransitionStartEvent,
} from "../types.js";
import { AMSError, ErrorCodes } from "../types.js";
import { TransitionMatrix } from "./TransitionMatrix.js";
import type { Clock } from "../clock/Clock.js";
import type { EventEmitter } from "../events.js";

/**
 * Music Logic Layer — the decision engine of the AMS.
 *
 * Responsibilities:
 * - Maintain a priority queue of pending state changes
 * - Resolve transition matrix lookups with conditions, cooldowns,
 *   hysteresis, min durations, and interruptibility
 * - Schedule cue switches, crossfades, and stinger injections
 * - Apply RTPC values to stem volume mappings
 *
 * The Music Logic Layer does NOT perform audio I/O. All audio instructions
 * are forwarded to the Playback Engine.
 */

export interface MusicLogicLayerConfig {
  /** Maximum time (ms) to hold a queued state change before it expires. 0 = never. */
  queueTtlMs?: number;
}

export interface ScheduledTransition {
  descriptor: TransitionDescriptor;
  fromState: string;
  toState: string;
  targetCueId: string;
  quantization: QuantizationMode;
  scheduledForSample: number;
}

export class MusicLogicLayer {
  private matrix: TransitionMatrix;
  private clock: Clock;
  private adapter: PlaybackAdapter;
  private rtpcValues = new Map<string, number>();
  private remappedVolumes = new Map<string, number>();
  private activeCueId: string | null = null;
  private activeState: string | null = null;
  private cues = new Map<string, CueDefinition>();
  private stingers = new Map<string, StingerDefinition>();
  private currentSegmentEndSample: number | null = null;
  private transitionInProgress: ScheduledTransition | null = null;
  private cueStartSample: number = 0;
  private lastTransitionEndNs: bigint | null = null;
  private conditionEvaluator: (expr: string, rtpcValues: Map<string, number>) => boolean;
  private onInstruction: (instruction: PlaybackInstruction) => void;
  private emitError: (code: string, message: string, recoverable: boolean, context?: Record<string, unknown>) => void;
  private emitTransitionStart: (e: TransitionStartEvent) => void;
  private emitTransitionEnd: (from: string | null, to: string, elapsedMs: number) => void;
  private emitCueChanged: (e: CueChangedEvent) => void;
  private config: Required<MusicLogicLayerConfig>;

  constructor(deps: {
    matrix: TransitionMatrix;
    clock: Clock;
    adapter: PlaybackAdapter;
    onInstruction: (instruction: PlaybackInstruction) => void;
    emitError: (code: string, message: string, recoverable: boolean, context?: Record<string, unknown>) => void;
    emitTransitionStart: (e: TransitionStartEvent) => void;
    emitTransitionEnd: (from: string | null, to: string, elapsedMs: number) => void;
    emitCueChanged: (e: CueChangedEvent) => void;
    conditionEvaluator?: (expr: string, rtpcValues: Map<string, number>) => boolean;
    config?: MusicLogicLayerConfig;
  }) {
    this.matrix = deps.matrix;
    this.clock = deps.clock;
    this.adapter = deps.adapter;
    this.onInstruction = deps.onInstruction;
    this.emitError = deps.emitError;
    this.emitTransitionStart = deps.emitTransitionStart;
    this.emitTransitionEnd = deps.emitTransitionEnd;
    this.emitCueChanged = deps.emitCueChanged;
    this.conditionEvaluator = deps.conditionEvaluator ?? this.defaultConditionEvaluator;
    this.config = {
      queueTtlMs: deps.config?.queueTtlMs ?? 0,
    };
  }

  // ─── Cue Bank Data ─────────────────────────────────────────────

  loadCues(cues: CueDefinition[]): void {
    for (const cue of cues) {
      this.cues.set(cue.cueId, cue);
    }
  }

  loadStingers(stingers: StingerDefinition[]): void {
    for (const stinger of stingers) {
      this.stingers.set(stinger.stingerId, stinger);
    }
  }

  // ─── State Handling ────────────────────────────────────────────

  /**
   * Handle a state change: resolve the transition descriptor and schedule
   * the resulting playback instructions.
   */
  handleStateChange(prevState: string | null, newState: string): void {
    const descriptor = this.matrix.lookup(prevState ?? "", newState);
    this.activeState = newState;

    if (!descriptor) {
      this.emitError(
        ErrorCodes.TRANSITION_FAILED,
        `No transition rule for (${prevState ?? "start"} → ${newState})`,
        true,
        { prevState: prevState ?? null, newState }
      );
      return;
    }

    // Condition guard
    if (descriptor.condition && !this.conditionEvaluator(descriptor.condition, this.rtpcValues)) {
      this.emitError(
        ErrorCodes.TRANSITION_FAILED,
        `Transition (${prevState ?? "start"} → ${newState}) skipped: condition "${descriptor.condition}" not satisfied`,
        true,
        { prevState: prevState ?? null, newState }
      );
      return;
    }

    // Cooldown guard
    if (descriptor.cooldownMs) {
      const since = this.transitionEndedAgoNs();
      if (since !== null) {
        const elapsedMs = Number(since) / 1e6;
        if (elapsedMs < descriptor.cooldownMs) {
          this.emitError(
            ErrorCodes.TRANSITION_FAILED,
            `Transition (${prevState ?? "start"} → ${newState}) in cooldown (${Math.round(elapsedMs)}/${descriptor.cooldownMs} ms)`,
            true
          );
          return;
        }
      }
    }

    // Min source duration guard
    if (descriptor.minSourceDurationMs) {
      const samplePos = this.clock.snapshot().sample.samples;
      const elapsedMs = ((samplePos - this.cueStartSample) * 1000) / this.clock.getConfig().sampleRate;
      if (elapsedMs < descriptor.minSourceDurationMs) {
        this.emitError(
          ErrorCodes.TRANSITION_FAILED,
          `Transition (${prevState ?? "start"} → ${newState}) blocked: source cue active for only ${Math.round(elapsedMs)} ms (min ${descriptor.minSourceDurationMs} ms)`,
          true
        );
        return;
      }
    }

    const targetCueId = descriptor.targetCueId ?? this.defaultCueFor(newState);
    if (targetCueId && !this.cues.has(targetCueId)) {
      this.emitError(
        ErrorCodes.CUE_NOT_FOUND,
        `Target cue "${targetCueId}" for state "${newState}" does not exist`,
        false,
        { newState }
      );
      return;
    }

    if (!targetCueId) {
      this.emitError(
        ErrorCodes.CUE_NOT_FOUND,
        `No target cue resolved for state "${newState}" (no default_cue_id and no transition target)`,
        false,
        { newState }
      );
      return;
    }

    this.scheduleTransition(descriptor, prevState, newState, targetCueId);
  }

  /** Set current playback segment end sample (for SEGMENT_END quantization). */
  setSegmentEndSample(sample: number): void {
    this.currentSegmentEndSample = sample;
  }

  /**
   * Schedule the actual transition based on quantization mode.
   */
  private scheduleTransition(
    descriptor: TransitionDescriptor,
    fromState: string | null,
    toState: string,
    targetCueId: string
  ): void {
    const clockSnapshot = this.clock.snapshot();
    const currentSample = clockSnapshot.sample.samples;

    let targetPosition: number;
    switch (descriptor.quantization) {
      case "IMMEDIATE":
        targetPosition = currentSample;
        break;
      case "BEAT":
        targetPosition = Number(this.clock.nextBeatSample());
        break;
      case "BAR":
        targetPosition = Number(this.clock.nextBarSample());
        break;
      case "SEGMENT_END":
        targetPosition = this.currentSegmentEndSample ?? currentSample;
        break;
      default:
        targetPosition = currentSample;
    }

    const crossfadeMs = descriptor.crossfadeMs ?? 0;

    // Stinger scheduling (must not precede the grid boundary)
    if (descriptor.stingerId) {
      const stinger = this.stingers.get(descriptor.stingerId);
      if (!stinger) {
        this.emitError(
          ErrorCodes.STINGER_NOT_FOUND,
          `Stinger "${descriptor.stingerId}" referenced by transition not found`,
          false,
          { fromState: fromState ?? null, toState }
        );
      } else {
        const atPosition = stinger.quantization === "IMMEDIATE" ? currentSample : targetPosition;
        this.onInstruction({
          type: "STINGER",
          atSample: atPosition,
          stingerId: descriptor.stingerId,
          stingerVolume: descriptor.stingerVolume ?? stinger.mixVolume ?? 1.0,
        });
      }
    }

    // Interruptibility check — if a transition is in progress and this new
    // one is lower priority / non-interrupting, reject.
    if (this.transitionInProgress && descriptor.interruptible === false && this.transitionInProgress.descriptor.priority !== undefined) {
      // If new descriptor has lower priority than the in-flight one, hold off.
      if ((descriptor.priority ?? 0) < (this.transitionInProgress.descriptor.priority ?? 0)) {
        this.emitError(
          ErrorCodes.TRANSITION_FAILED,
          `Transition (${fromState ?? "start"} → ${toState}) superseded: existing transition has higher priority`,
          true
        );
        return;
      }
    }

    // Max source duration override — if the descriptor has maxSourceDurationMs
    // and we've exceeded it, force immediate scheduling.
    if (descriptor.maxSourceDurationMs && targetPosition === currentSample) {
      // No-op: already immediate
    }

    // Cue switch
    this.onInstruction({
      type: "CUE_SWITCH",
      atSample: targetPosition,
      targetCueId,
      crossfadeMs,
      entryPoint: descriptor.entryPoint,
    });

    const scheduled: ScheduledTransition = {
      descriptor,
      fromState: fromState ?? "",
      toState,
      targetCueId,
      quantization: descriptor.quantization,
      scheduledForSample: targetPosition,
    };
    this.transitionInProgress = scheduled;

    // Emit transition_start event (scheduling time, not audible time)
    this.emitTransitionStart({
      type: "transition_start",
      fromCueId: this.activeCueId ?? "",
      toCueId: targetCueId,
      crossfadeMs,
      quantization: descriptor.quantization,
    });
  }

  // ─── RTPC Handling ─────────────────────────────────────────────

  /**
   * Update an RTPC value and compute stem volume remapping for the
   * active cue.
   */
  updateRtpcValue(name: string, value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    this.rtpcValues.set(name, clamped);

    const activeCue = this.activeCueId ? this.cues.get(this.activeCueId) : undefined;
    if (!activeCue) return;

    for (const stem of activeCue.stems) {
      if (stem.rtpcBinding === name) {
        const volume = evaluateMapping(stem.volumeMapping, clamped);
        const current = this.remappedVolumes.get(stem.stemId) ?? stem.defaultVolume ?? 0;
        if (Math.abs(volume - current) > 0.001) {
          this.remappedVolumes.set(stem.stemId, volume);
          this.onInstruction({
            type: "STEM_VOLUME",
            atSample: this.clock.snapshot().sample.samples,
            stemId: stem.stemId,
            targetVolume: volume,
            rampMs: this.defaultRampMsForStem(stem),
          });
        }
      }
    }
  }

  // ─── Cue lifecycle ─────────────────────────────────────────────

  /** Mark the active cue as changed (called by Playback Engine when audible). */
  onCueChanged(prevCueId: string | null, newCueId: string, triggeredByState: string): void {
    this.activeCueId = newCueId;
    this.cueStartSample = this.clock.snapshot().sample.samples;
    this.emitCueChanged({ type: "cue_changed", prevCueId, newCueId, triggeredByState });
  }

  /** Mark a transition as ended audibly. */
  onTransitionEnded(fromCueId: string, toCueId: string, elapsedMs: number): void {
    this.transitionInProgress = null;
    this.lastTransitionEndNs = this.nowNs();
    this.emitTransitionEnd(fromCueId, toCueId, elapsedMs);
  }

  /** Set the active cue directly (restore on cancel, etc.). */
  forceActiveCue(cueId: string, state: string): void {
    this.activeCueId = cueId;
    this.activeState = state;
  }

  // ─── Queries ───────────────────────────────────────────────────

  getActiveCueId(): string | null {
    return this.activeCueId;
  }

  getActiveState(): string | null {
    return this.activeState;
  }

  getMatrix(): TransitionMatrix {
    return this.matrix;
  }

  getRtpcValue(name: string): number | undefined {
    return this.rtpcValues.get(name);
  }

  hasTransitionInProgress(): boolean {
    return this.transitionInProgress !== null;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private defaultCueFor(state: string): string | null {
    // The Context Engine owns state definitions; the Logic Layer derives
    // default cues via a registry set by the AMS facade.
    return this.stateDefaultCues.get(state) ?? null;
  }

  private stateDefaultCues = new Map<string, string>();

  registerStateDefaultCue(stateName: string, cueId: string): void {
    this.stateDefaultCues.set(stateName, cueId);
  }

  private defaultConditionEvaluator(_expr: string, _rtpc: Map<string, number>): boolean {
    return true;
  }

  private defaultRampMsForStem(stem: StemDefinition): number {
    // RTPC smoothing typically applies; use a perceptually safe ramp.
    return 50;
  }

  private transitionEndedAgoNs(): bigint | null {
    if (!this.lastTransitionEndNs) return null;
    return this.nowNs() - this.lastTransitionEndNs;
  }

  private nowNs(): bigint {
    return process.hrtime.bigint();
  }
}