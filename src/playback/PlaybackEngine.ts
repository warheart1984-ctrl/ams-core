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
  /** Called when a dispatched CUE_SWITCH reaches its audible position. Wired to the logic layer. */
  onCueStarted?: (cueId: string, atSample: number) => void;
  /** Called when a dispatched crossfade completes. Wired to the logic layer. */
  onTransitionEnded?: (fromCueId: string, toCueId: string, elapsedMs: number) => void;
  /** CUE_SWITCHes handed to the adapter but not yet audible (atSample in the future). */
  private dispatchedSwitches: { cueId: string; atSample: number; crossfadeMs: number }[] = [];
  /**
   * Logical position minus adapter output position. Adapters report a
   * monotonic device position, so a seek moves the logical timeline
   * without moving the output; this offset keeps the two comparable.
   */
  private outputOffset = 0;
  /** Audible cue switches whose crossfade has not yet completed. */
  private pendingTransitionEnds: { fromCueId: string; toCueId: string; startSample: number; endSample: number; crossfadeMs: number }[] = [];
  private lastAudibleCueId = "";
  /** Stingers currently sounding or scheduled, with their scheduled end position (RFC §7.3). */
  private activeStingers: { stingerId: string; startSample: number; endSample: number }[] = [];
  /** STINGERs handed to the adapter but not yet sounding. */
  private dispatchedStingers: { stingerId: string; atSample: number }[] = [];

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
    // Catch the clock up to the output first, or the samples played since
    // the last poll are left behind as drift for the whole pause.
    this.tick();
    this.clock.pause(this.nowNs());
    this.adapter.pause();
  }

  resume(): void {
    this.clock.resume(this.nowNs());
    this.adapter.resume();
  }

  seekToSample(targetSample: number): void {
    // Re-anchor the logical timeline to the current output position so the
    // seek is not measured as drift and pulled back by recoverDrift.
    const outputSample = this.adapter.getCurrentOutputSample();
    this.clock.seekToSample(BigInt(targetSample));
    this.outputOffset = targetSample - outputSample;
    this.lastOutputSample = outputSample;
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

    // While paused the musical timeline stands still. Output that still
    // moves (e.g. an asynchronous device suspend) is absorbed into the
    // offset rather than reported as drift.
    if (this.clock.isPaused()) {
      this.outputOffset -= delta;
      this.lastOutputSample = outputSample;
      return;
    }

    // Advance logical clock
    this.clock.advance(BigInt(Math.max(0, delta)));

    // The logical position is the clock's, not a second tracker that was
    // never updated (a constant 0 made every tick report a drift violation
    // and fed runaway corrections into recoverDrift).
    const logical = this.clock.snapshot().sample.samples;
    this.currentSample = logical;
    // Where the audio output currently is on the logical timeline.
    const position = outputSample + this.outputOffset;
    const drift = position - logical;
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
    const horizon = position + lookaheadSamples;

    // Dispatch instructions to the adapter. Past-due and IMMEDIATE entries
    // dispatch now; future entries inside the lookahead horizon are handed
    // over for sample-accurate firing. (Previously due instructions were
    // collected into a list nobody read and silently dropped.)
    let index = 0;
    while (index < this.scheduleQueue.length) {
      const entry = this.scheduleQueue[index];
      if (entry.instruction.immediately || entry.atSample <= horizon) {
        // Adapters schedule against their own output position.
        this.adapter.schedule({ ...entry.instruction, atSample: entry.atSample - this.outputOffset });
        this.noteDispatched(entry.instruction);
        this.scheduleQueue.splice(index, 1);
      } else {
        index++;
      }
    }

    // Promote dispatched cue switches whose audible position has arrived,
    // then report any crossfades that completed.
    this.promoteDispatched(position);

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

  /**
   * Drop every CUE_SWITCH that has not become audible yet, queued or already
   * handed to the adapter. Called when a newer transition supersedes them,
   * so a stale BAR-quantized switch cannot land after an IMMEDIATE one.
   * Returns the number of switches dropped.
   */
  cancelPendingCueSwitches(): number {
    const queued = this.scheduleQueue.length;
    this.scheduleQueue = this.scheduleQueue.filter((e) => e.instruction.type !== "CUE_SWITCH");
    const dropped = queued - this.scheduleQueue.length + this.dispatchedSwitches.length;
    // The adapter already holds these; tell it to withdraw them.
    for (const sw of this.dispatchedSwitches) {
      this.adapter.schedule({ type: "CANCEL", atSample: sw.atSample - this.outputOffset, targetCueId: sw.cueId });
    }
    this.dispatchedSwitches = [];
    return dropped;
  }

  /**
   * Drop every instance of `stingerId` that has not started sounding yet,
   * queued or already handed to the adapter, and release its slot in the
   * conflict tracking. A stinger that is already sounding plays out.
   * Returns the number of instances dropped.
   */
  cancelPendingStinger(stingerId: string): number {
    const queued = this.scheduleQueue.length;
    this.scheduleQueue = this.scheduleQueue.filter(
      (e) => !(e.instruction.type === "STINGER" && e.instruction.stingerId === stingerId)
    );
    let dropped = queued - this.scheduleQueue.length;
    this.dispatchedStingers = this.dispatchedStingers.filter((s) => {
      if (s.stingerId !== stingerId) return true;
      this.adapter.schedule({ type: "CANCEL", atSample: s.atSample - this.outputOffset, stingerId });
      dropped++;
      return false;
    });
    const now = this.clock.snapshot().sample.samples;
    this.activeStingers = this.activeStingers.filter((s) => s.stingerId !== stingerId || s.startSample <= now);
    return dropped;
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
    // Crossfade completion is handled in promoteDispatched: pending entries
    // fire onTransitionEnded once output passes their scheduled end.
  }

  /** Track a dispatched CUE_SWITCH so its audible start/end can be reported. */
  private noteDispatched(instruction: PlaybackInstruction): void {
    if (instruction.type === "STINGER" && instruction.stingerId) {
      this.dispatchedStingers.push({ stingerId: instruction.stingerId, atSample: instruction.atSample });
    }
    if (instruction.type === "CUE_SWITCH" && instruction.targetCueId) {
      this.dispatchedSwitches.push({
        cueId: instruction.targetCueId,
        atSample: instruction.atSample,
        crossfadeMs: instruction.crossfadeMs ?? 0,
      });
      this.dispatchedSwitches.sort((a, b) => a.atSample - b.atSample);
    }
  }

  /**
   * Report audible cue starts and completed transitions to the logic layer.
   * A switch counts as started once output passes its scheduled position;
   * its transition ends once output passes position + crossfade duration.
   */
  private promoteDispatched(outputSample: number): void {
    // Stingers that have started sounding can no longer be cancelled.
    this.dispatchedStingers = this.dispatchedStingers.filter((s) => s.atSample > outputSample);
    while (this.dispatchedSwitches.length > 0 && this.dispatchedSwitches[0].atSample <= outputSample) {
      const sw = this.dispatchedSwitches.shift()!;
      // The previous cue is whatever was audible when this one starts, not
      // when it was dispatched.
      const fromCueId = this.lastAudibleCueId;
      // A crossfade still running is cut short by the new switch: report
      // its end now so every audible transition gets a transition_end.
      for (const cut of this.pendingTransitionEnds.splice(0)) {
        const elapsedMs = ((sw.atSample - cut.startSample) * 1000) / this.config.sampleRate;
        this.onTransitionEnded?.(cut.fromCueId, cut.toCueId, Math.max(0, Math.round(elapsedMs)));
      }
      this.lastAudibleCueId = sw.cueId;
      this.onCueStarted?.(sw.cueId, sw.atSample);
      if (sw.crossfadeMs > 0) {
        this.pendingTransitionEnds.push({
          fromCueId,
          toCueId: sw.cueId,
          startSample: sw.atSample,
          endSample: sw.atSample + (sw.crossfadeMs / 1000) * this.config.sampleRate,
          crossfadeMs: sw.crossfadeMs,
        });
      } else {
        this.onTransitionEnded?.(fromCueId, sw.cueId, 0);
      }
    }
    while (this.pendingTransitionEnds.length > 0 && this.pendingTransitionEnds[0].endSample <= outputSample) {
      const end = this.pendingTransitionEnds.shift()!;
      this.onTransitionEnded?.(end.fromCueId, end.toCueId, end.crossfadeMs);
    }
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
      startSample: atSample,
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