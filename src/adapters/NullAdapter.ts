import type {
  AdapterCapabilities,
  PlaybackAdapter,
  PlaybackInstruction,
} from "../types.js";

/**
 * Null adapter for headless testing.
 *
 * The Null adapter simulates audio output: `getCurrentOutputSample()`
 * advances at the configured sample rate against a monotonic clock,
 * mimicking the drift characteristics of a real audio device (subject
 * to optional simulated jitter). This enables deterministic conformance
 * testing of the scheduling pipeline without an audio runtime.
 */
export class NullAdapter implements PlaybackAdapter {
  private sampleRate: number;
  private startTimeNs: bigint;
  private paused = false;
  private pauseStartNs: bigint | null = null;
  private pausedTotalNs: bigint = 0n;
  private outputSample: number = 0;
  private simulatedDriftSamples = 0;
  private readonly simulatedDriftPerMinute: number;
  private disposed = false;

  constructor(config?: { simulatedDriftPerMinute?: number }) {
    this.sampleRate = 44100;
    this.startTimeNs = 0n;
    this.simulatedDriftPerMinute = config?.simulatedDriftPerMinute ?? 0;
  }

  async initialize(sampleRate: number): Promise<void> {
    this.sampleRate = sampleRate;
    this.startTimeNs = process.hrtime.bigint();
    this.outputSample = 0;
  }

  /**
   * Simulate output position. Advances at real-time rate from
   * initialization, minus pauses, plus simulated drift.
   */
  getCurrentOutputSample(): number {
    if (this.paused) {
      return this.outputSample;
    }
    const elapsedNs = process.hrtime.bigint() - this.startTimeNs - this.pausedTotalNs;
    const elapsedSamples = Math.floor(Number(elapsedNs) * this.sampleRate / 1e9);
    // Apply a small linear drift so the drift-recovery path can be tested.
    const driftSamples = Math.floor((elapsedSamples * this.simulatedDriftPerMinute) / (60 * this.sampleRate));
    return elapsedSamples + driftSamples;
  }

  schedule(instruction: PlaybackInstruction): void {
    void instruction;
    // Null adapter records nothing; the scheduler timeline is authoritative.
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pauseStartNs = process.hrtime.bigint();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pausedTotalNs += process.hrtime.bigint() - (this.pauseStartNs as bigint);
    this.pauseStartNs = null;
  }

  stop(): void {
    this.outputSample = 0;
  }

  dispose(): void {
    this.disposed = true;
  }

  getCapabilities(): AdapterCapabilities {
    return {
      name: "NullAdapter",
      supportsStreaming: false,
      supportsSampleAccurateScheduling: true,
      maxConcurrentStems: 64,
      maxConcurrentStingers: 16,
      limitations: [
        "No audio output.",
        "For test/validation use only.",
      ],
    };
  }

  getSampleRate(): number {
    return this.sampleRate;
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}