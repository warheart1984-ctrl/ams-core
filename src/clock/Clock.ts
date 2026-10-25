/**
 * Logical clock for the AMS scheduling system.
 *
 * The clock operates in two time domains:
 *   - Wall time: monotonic nanosecond timestamps for event ordering
 *   - Musical time: beat/bar positions derived from the beat grid
 *
 * Determinism guarantee: given identical state sequences and RTPC streams,
 * the logical clock produces identical event orderings and scheduling
 * decisions. Wall-clock drift is recovered via the clock recovery model
 * (see ClockRecovery). The clock does NOT guarantee that audio output
 * arrives at identical wall times across hardware — it guarantees
 * identical logical sequencing.
 */

export interface ClockConfig {
  /** Initial BPM. Must be > 0. */
  bpm: number;
  /** Time signature numerator (beats per bar). Must be > 0. */
  timeSignatureNumerator: number;
  /** Time signature denominator. Must be a power of 2. */
  timeSignatureDenominator: number;
  /** Samples per second (sample rate). Must be 44100 or 48000. */
  sampleRate: number;
}

export interface BeatPosition {
  bar: number;
  beat: number;
  /** Sub-beat fractional position [0.0, 1.0) */
  subBeat: number;
  /** Total beat count from start (bar * numerator + beat + subBeat) */
  totalBeats: number;
}

export interface SamplePosition {
  /** Absolute sample count from start */
  samples: number;
  /** Sample rate used for conversion */
  sampleRate: number;
}

export interface ClockSnapshot {
  /** Monotonic wall timestamp in nanoseconds */
  wallTimeNs: bigint;
  /** Musical position */
  beat: BeatPosition;
  /** Sample position */
  sample: SamplePosition;
  /** Current BPM at this snapshot */
  bpm: number;
  /** Time signature */
  timeSignature: [number, number];
}

/**
 * Drift recovery model.
 *
 * The clock tracks drift between the logical timeline and the audio
 * output timeline. Recovery is applied at bar boundaries to avoid
 * perceptible jumps. The drift tolerance is ≤1 ms per minute of
 * continuous playback (RFC §9).
 */
export interface ClockRecovery {
  /** Accumulated drift in samples. Positive = audio ahead of logical. */
  driftSamples: number;
  /** Maximum allowed drift before forced correction (samples) */
  maxDriftBeforeCorrection: number;
  /** Recovery rate: fraction of drift to correct per bar [0.0, 1.0] */
  recoveryRatePerBar: number;
}

export class Clock {
  private config: ClockConfig;
  private samplesPerBeat: number;
  private samplesPerBar: number;
  private currentSample: bigint = 0n;
  private startWallTimeNs: bigint = 0n;
  private recovery: ClockRecovery;
  private paused: boolean = false;
  private pauseWallTimeNs: bigint = 0n;
  private totalPausedNs: bigint = 0n;

  constructor(config: ClockConfig) {
    if (![44100, 48000].includes(config.sampleRate)) {
      throw new Error(`Unsupported sample rate ${config.sampleRate}; must be 44100 or 48000`);
    }
    if (config.bpm <= 0 || !Number.isFinite(config.bpm)) {
      throw new Error(`Invalid BPM ${config.bpm}; must be a positive finite number`);
    }
    if (config.timeSignatureNumerator <= 0) {
      throw new Error(`Invalid time signature numerator ${config.timeSignatureNumerator}`);
    }
    this.config = { ...config };
    this.samplesPerBeat = this.computeSamplesPerBeat(config.bpm, config.sampleRate);
    this.samplesPerBar = this.samplesPerBeat * config.timeSignatureNumerator;
    this.recovery = {
      driftSamples: 0,
      maxDriftBeforeCorrection: Math.floor(config.sampleRate * 0.001), // 1 ms
      recoveryRatePerBar: 0.25,
    };
  }

  /**
   * Initialize the clock. Must be called before any other method.
   */
  start(wallTimeNs: bigint): void {
    this.startWallTimeNs = wallTimeNs;
    this.currentSample = 0n;
    this.totalPausedNs = 0n;
    this.recovery.driftSamples = 0;
  }

  pause(wallTimeNs: bigint): void {
    if (this.paused) return;
    this.paused = true;
    this.pauseWallTimeNs = wallTimeNs;
  }

  resume(wallTimeNs: bigint): void {
    if (!this.paused) return;
    this.paused = false;
    this.totalPausedNs += wallTimeNs - this.pauseWallTimeNs;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Advance the clock by a given number of samples.
   * Returns the snapshot after advancement.
   */
  advance(samples: bigint): ClockSnapshot {
    if (this.paused) {
      return this.snapshot();
    }
    this.currentSample += samples;
    this.recoverDrift();
    return this.snapshot();
  }

  /**
   * Seek to a specific sample position.
   */
  seekToSample(targetSample: bigint): ClockSnapshot {
    this.currentSample = targetSample;
    this.recovery.driftSamples = 0;
    return this.snapshot();
  }

  /**
   * Get the current snapshot without advancing.
   */
  snapshot(): ClockSnapshot {
    const beat = this.sampleToBeat(this.currentSample);
    const wallNs = this.computeWallTime();
    return {
      wallTimeNs: wallNs,
      beat,
      sample: {
        samples: Number(this.currentSample),
        sampleRate: this.config.sampleRate,
      },
      bpm: this.config.bpm,
      timeSignature: [this.config.timeSignatureNumerator, this.config.timeSignatureDenominator],
    };
  }

  /**
   * Convert a sample position to a beat position.
   */
  sampleToBeat(samples: bigint): BeatPosition {
    const samplesPerBeat = BigInt(this.samplesPerBeat);
    const totalBeats = Number(samples) / this.samplesPerBeat;
    const bar = Math.floor(totalBeats / this.config.timeSignatureNumerator);
    const beatInBar = Math.floor(totalBeats) % this.config.timeSignatureNumerator;
    const subBeat = totalBeats - Math.floor(totalBeats);
    return {
      bar,
      beat: beatInBar,
      subBeat,
      totalBeats,
    };
  }

  /**
   * Convert a beat position to a sample position.
   */
  beatToSample(beat: BeatPosition): bigint {
    const totalBeats = beat.bar * this.config.timeSignatureNumerator + beat.beat + beat.subBeat;
    return BigInt(Math.round(totalBeats * this.samplesPerBeat));
  }

  /**
   * Get the sample position of the next beat boundary from current position.
   */
  nextBeatSample(): bigint {
    const samplesPerBeat = BigInt(this.samplesPerBeat);
    const currentBeatPos = this.currentSample / samplesPerBeat;
    const nextBeat = (currentBeatPos + 1n) * samplesPerBeat;
    return nextBeat;
  }

  /**
   * Get the sample position of the next bar boundary from current position.
   */
  nextBarSample(): bigint {
    const samplesPerBar = BigInt(this.samplesPerBar);
    const currentBar = this.currentSample / samplesPerBar;
    const nextBar = (currentBar + 1n) * samplesPerBar;
    return nextBar;
  }

  /**
   * Report external drift (e.g., from audio output callback).
   * Positive drift = audio output is ahead of logical timeline.
   */
  reportDrift(driftSamples: number): void {
    this.recovery.driftSamples = driftSamples;
  }

  getSamplesPerBeat(): number {
    return this.samplesPerBeat;
  }

  getSamplesPerBar(): number {
    return this.samplesPerBar;
  }

  getConfig(): Readonly<ClockConfig> {
    return this.config;
  }

  private computeWallTime(): bigint {
    if (this.paused) {
      return this.pauseWallTimeNs - this.totalPausedNs;
    }
    const elapsed = this.currentSample * 1000000000n / BigInt(this.config.sampleRate);
    return this.startWallTimeNs + elapsed - this.totalPausedNs;
  }

  private recoverDrift(): void {
    const absDrift = Math.abs(this.recovery.driftSamples);
    if (absDrift <= this.recovery.maxDriftBeforeCorrection) return;

    const correction = Math.round(this.recovery.driftSamples * this.recovery.recoveryRatePerBar);
    if (correction !== 0) {
      this.currentSample += BigInt(correction);
      this.recovery.driftSamples -= correction;
    }
  }

  private computeSamplesPerBeat(bpm: number, sampleRate: number): number {
    const beatsPerSecond = bpm / 60.0;
    return Math.round(sampleRate / beatsPerSecond);
  }
}
