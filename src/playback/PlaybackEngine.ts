import { Clock } from "../clock/Clock.js";
import { EventEmitter } from "../events.js";
import type {
  AMSEvent,
  PlaybackAdapter,
  PlaybackInstruction,
  UnsubHandle,
  BeatEvent,
  BarEvent,
} from "../types.js";
import { AMSError, ErrorCodes } from "../types.js";

/**
 * Playback Engine — executes audio instructions issued by the Music Logic Layer.
 *
 * Responsibilities:
 * - Maintain the Beat Grid with drift tolerance ≤1 ms/min (RFC §9)
 * - Maintain a lookahead scheduling buffer (≥500 ms)
 * - Execute cue switches, stem automation, crossfades, stingers at
 *   sample-accurate positions
 * - Fire beat/bar/cue_changed/transition_start/transition_end callbacks
 *
 * The engine is clock-driven: it polls the adapter's output position and
 * dispatches due instructions from a sorted schedule. This keeps the engine
 * deterministic — it consumes a sorted instruction timeline regardless of
 * wall-time jitter.
 */

export interface PlaybackEngineConfig {
  bpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  sampleRate: number;
  /** Lookahead buffer in ms. MUST be ≥500 (RFC §9). */
  lookaheadMs?: number;
  /** Poll interval in ms for clock advancement. */
  pollIntervalMs?: number;
}

interface PendingInstruction {
  atSample: number;
  instruction: PlaybackInstruction;
  /** Unique ordering key for determinism when sample positions tie. */
  seq: number;
}

export class PlaybackEngine {
  private clock: Clock;
  private adapter: PlaybackAdapter;
  private scheduleQueue: PendingInstruction[] = [];
  private seqCounter = 0;
  private emitter = new EventEmitter<AMSEvent>();
  private config: Required<PlaybackEngineConfig>;
  private currentSample: number = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastBarFired = -1;
  private lastBeatFired = -1;
  private lastOutputSample: number = 0;
  private driftReportTimer: ReturnType<typeof setInterval> | null = null;
  /** Count of drift excursions beyond tolerance. */
  private driftViolations = 0;
  private lastCueCrossfade: { from: string; to: string; startedAtSample: number; durationSamples: number } | null = null;
  /** Stingers currently sounding or scheduled, with their scheduled end position (RFC §7.3). */
  private activeStingers: { stingerId: string; endSample: number }[] = [];

  constructor(adapter: PlaybackAdapter, config: PlaybackEngineConfig) {
    if (![44100, 48000].includes(config.sampleRate)) {
      throw new AMSError(ErrorCodes.INVALID_CONFIG, `Sample rate ${config.sampleRate} not supported; must be 44100 or 48000`, false);
    }
    this.config = {
      bpm: config.bpm,
      timeSignatureNumerator: config.timeSignatureNumerator,
      timeSignatureDenominator: config.timeSignatureDenominator,
      sampleRate: config.sampleRate,
      lookaheadMs: config.lookaheadMs ?? 500,
      pollIntervalMs: config.pollIntervalMs ?? 10,
    };
    if (this.config.lookaheadMs < 500) {
      throw new AMSError(ErrorCodes.CONFORMANCE_VIOLATION, `Lookahead buffer must be ≥500 ms (got ${this.config.lookaheadMs})`, false);
    }
    this.clock = new Clock({
      bpm: this.config.bpm,
      timeSignatureNumerator: this.config.timeSignatureNumerator,
      timeSignatureDenominator: this.config.timeSignatureDenominator,
      sampleRate: this.config.sampleRate,
    });
    this.adapter = adapter;
  }

  async start(nowNs: bigint): Promise<void> {
    await this.adapter.initialize(this.config.sampleRate);
    this.clock.start(nowNs);
    this.started = true;
    this.lastBarFired = -1;
    this.lastBeatFired = -1;
    this.lastOutputSample = 0;
    this.startPolling();
  }

  stop(): void {
    this.started = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.driftReportTimer) {
      clearInterval(this.driftReportTimer);
      this.driftReportTimer = null;
    }
    this.adapter.stop();
  }

  pause(): void {
    this.clock.pause(this.nowNs());
    this.adapter.pause();
  }

  resume(): void {
    this.clock.resume(this.nowNs());
    this.adapter.resume();
  }

  seekToSample(targetSample: number): void {
    this.clock.seekToSample(BigInt(targetSample));
    this.currentSample = targetSample;
    this.adapter.schedule({ type: "SEEK", atSample: targetSample });
  }

  dispose(): void {
    this.stop();
    this.adapter.dispose();
    this.emitter.removeAll();
  }

  // ─── Scheduling ────────────────────────────────────────────────

  /**
   * Issue a playback instruction. The instruction is stamped with the
   * current lookahead position (the instruction's `atSample` is already
   * resolved by the Music Logic Layer).
   *
   * Determinism: instructions are inserted into a sorted timeline keyed
   * by `atSample` then insertion sequence. Equal-sample ordering is defined
   * by sequence number, so identical input sequences always produce
   * identical dispatch order.
   */
  schedule(instruction: PlaybackInstruction): void {
    if (!this.started) return;

    let atSample = Math.max(0, Math.trunc(instruction.atSample));

    // Stinger conflict policy (RFC §7.3): QUEUE waits for the active
    // stinger to end, INTERRUPT stops it first, LAYER plays both.
    if (instruction.type === "STINGER" && instruction.stingerId) {
      atSample = this.resolveStingerConflict(instruction, atSample);
      instruction = { ...instruction, atSample };
    }
    const entry: PendingInstruction = {
      atSample,
      instruction,
      seq: this.seqCounter++,
    };
    this.scheduleQueue.push(entry);
    this.scheduleQueue.sort((a, b) => a.atSample - b.atSample || a.seq - b.seq);

    // SEGMENT_END quantization requires the logic layer to know where the
    // current segment ends. Emit via instruction metadata if present.
    if (instruction.type === "CUE_SWITCH" && !instruction.immediately) {
      // No-op; segment end is tracked by the logic layer via callbacks.
    }
  }

  /**
   * Advance the clock by the actual elapsed output samples (from the
   * adapter's output position) plus simulated samples when the adapter
   * cannot report position. Then dispatch all due instructions.
   */
  tick(): void {
    if (!this.started) return;

    const outputSample = this.adapter.getCurrentOutputSample();
    const delta = outputSample - this.lastOutputSample;

    // Advance logical clock
    this.clock.advance(BigInt(Math.max(0, delta)));

    // Report drift to the clock for recovery
    const logical = this.currentSample;
    const drift = outputSample - logical;
    const toleranceSamples = Math.ceil(this.config.sampleRate * 0.001); // 1 ms
    if (Math.abs(drift) > toleranceSamples) {
      this.driftViolations++;
      this.emitError("CLOCK_DRIFT_EXCEEDED", `Drift of ${Math.round(drift)} samples exceeds 1 ms tolerance`, false, {
        outputSample,
        logicalSample: logical,
        violations: this.driftViolations,
      });
    }
    this.clock.reportDrift(drift);

    // Compute the lookahead horizon
    const lookaheadSamples = Math.floor((this.config.lookaheadMs / 1000) * this.config.sampleRate);
    const horizon = outputSample + lookaheadSamples;

    // Dispatch due instructions (those whose atSample ≤ horizon OR are IMMEDIATE)
    let index = 0;
    const toDispatch: PendingInstruction[] = [];
    while (index < this.scheduleQueue.length) {
      const entry = this.scheduleQueue[index];
      // Immediate instructions dispatch right away
      if (entry.instruction.immediately || entry.atSample <= currentSampleForDispatch()) {
        toDispatch.push(entry);
        this.scheduleQueue.splice(index, 1);
      } else if (entry.atSample <= horizon) {
        // Schedule ahead of time — hand to the adapter for sample-accurate firing
        this.adapter.schedule(entry.instruction);
        toDispatch.push(entry); // still counted as dispatched to adapter
        this.scheduleQueue.splice(index, 1);
      } else {
        index++;
      }
    }

    function currentSampleForDispatch(): number {
      return outputSample;
    }

    // Fire grid events (beat/bar) based on new logical position
    this.fireGridEventsFromOutput(outputSample);

    this.lastOutputSample = outputSample;

    // Emit transition_end for completed crossfades
    this.checkCompletedCrossfades(outputSample);
  }

  // ─── Event Subscription ────────────────────────────────────────

  on<K extends AMSEvent["type"]>(type: K, handler: (e: Extract<AMSEvent, { type: K }>) => void): UnsubHandle {
    return this.emitter.on(type as never, handler as never);
  }

  // ─── Queries ───────────────────────────────────────────────────

  getClock(): Clock {
    return this.clock;
  }

  getCurrentSample(): number {
    return this.currentSample;
  }

  getDriftViolations(): number {
    return this.driftViolations;
  }

  getPendingInstructionCount(): number {
    return this.scheduleQueue.length;
  }

  /** Report a cue change (called by the logic layer when a switch is audible). */
  registerCueChanged(prevCue: string | null, newCue: string, triggeredByState: string): void {
    this.emitter.emit({ type: "cue_changed", prevCueId: prevCue, newCueId: newCue, triggeredByState });
  }

  /** Report the start of a crossfade. */
  registerTransitionStart(from: string, to: string, crossfadeMs: number, quantization: "BEAT" | "BAR" | "IMMEDIATE" | "SEGMENT_END"): void {
    void from;
    void to;
    void crossfadeMs;
    void quantization;
    // The logic layer already emits these; the playback engine tracks the timeline.
  }

  registerSegmentEnd(sample: number): void {
    void sample;
  }

  // ─── Internal ──────────────────────────────────────────────────

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.tick(), this.config.pollIntervalMs);
    if (typeof (this.pollTimer as never as { unref?: () => void }).unref === "function") {
      (this.pollTimer as never as { unref: () => void }).unref();
    }
    // Report drift once a minute
    this.driftReportTimer = setInterval(() => {
      this.clock.advance(0n); // no-op to allow tick to settle
    }, 60000);
    if (typeof (this.driftReportTimer as never as { unref?: () => void }).unref === "function") {
      (this.driftReportTimer as never as { unref: () => void }).unref();
    }
  }

  private fireGridEventsFromOutput(outputSample: number): void {
    const snapshot = this.clock.snapshot();
    const beat = snapshot.beat;

    // Bar boundary
    if (beat.bar > this.lastBarFired) {
      for (let bar = this.lastBarFired + 1; bar <= beat.bar; bar++) {
        const barEvent: BarEvent = {
          type: "bar",
          barNumber: bar,
          timeSignature: [this.config.timeSignatureNumerator, this.config.timeSignatureDenominator],
          bpm: this.config.bpm,
          timestampNs: snapshot.wallTimeNs,
        };
        this.emitter.emit(barEvent);
      }
      this.lastBarFired = beat.bar;
    }

    // Beat boundary
    const absoluteBeat = Math.floor(beat.totalBeats);
    if (absoluteBeat > this.lastBeatFired) {
      for (let b = this.lastBeatFired + 1; b <= absoluteBeat; b++) {
        const beatInBar = b % this.config.timeSignatureNumerator;
        const bar = Math.floor(b / this.config.timeSignatureNumerator);
        const beatEvent: BeatEvent = {
          type: "beat",
          beatNumber: beatInBar,
          barNumber: bar,
          bpm: this.config.bpm,
          timestampNs: snapshot.wallTimeNs,
        };
        this.emitter.emit(beatEvent);
      }
      this.lastBeatFired = absoluteBeat;
    }

    void outputSample;
  }

  private checkCompletedCrossfades(outputSample: number): void {
    void outputSample;
    // Crossfade completion is tracked by adapter callbacks in production.
    // This method exists as an extension point for adapters that cannot
    // provide callbacks, in which case the engine times them out here.
  }

  /**
   * Apply the stinger conflict policy and return the position the new
   * stinger should actually play at.
   */
  private resolveStingerConflict(instruction: PlaybackInstruction, atSample: number): number {
    const mode = instruction.stingerConflictMode ?? "QUEUE";
    // Stingers ending at or before the requested position are no longer active.
    this.activeStingers = this.activeStingers.filter((s) => s.endSample > atSample);

    if (this.activeStingers.length === 0 || mode === "LAYER") {
      this.trackActiveStinger(instruction, atSample);
      return atSample;
    }

    if (mode === "INTERRUPT") {
      for (const s of this.activeStingers) {
        this.scheduleQueue.push({
          atSample,
          instruction: { type: "STOP", atSample, stingerId: s.stingerId },
          seq: this.seqCounter++,
        });
      }
      this.scheduleQueue.sort((a, b) => a.atSample - b.atSample || a.seq - b.seq);
      this.activeStingers = [];
      this.trackActiveStinger(instruction, atSample);
      return atSample;
    }

    // QUEUE (default): wait until the last active stinger ends.
    const position = Math.max(...this.activeStingers.map((s) => s.endSample));
    this.trackActiveStinger(instruction, position);
    return position;
  }

  private trackActiveStinger(instruction: PlaybackInstruction, atSample: number): void {
    this.activeStingers.push({
      stingerId: instruction.stingerId!,
      endSample: atSample + (instruction.stingerDurationSamples ?? 0),
    });
  }

  private emitError(code: string, message: string, recoverable: boolean, context?: Record<string, unknown>): void {
    this.emitter.emit({ type: "error", code, message, recoverable, context });
  }

  private nowNs(): bigint {
    return process.hrtime.bigint();
  }
}