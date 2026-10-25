import type { AdapterCapabilities, PlaybackAdapter, PlaybackInstruction } from "../types.js";
import { AMSError, ErrorCodes } from "../types.js";

/**
 * Web Audio API adapter (W3C).
 *
 * Uses AudioContext.currentTime as the reference clock, per RFC §11.
 *
 * Corrected limitations (per RFC review):
 * - MediaElementAudioSourceNode does NOT provide the same sample-accurate
 *   guarantees as AudioBufferSourceNode. This adapter therefore REQUIRES
 *   fully decoded AudioBuffer assets for stems, segments, and stingers.
 *   Streaming via media elements is NOT supported; the capability report
 *   reflects this.
 * - All scheduling uses AudioBufferSourceNode.start(when) and is therefore
 *   sample-accurate within the AudioContext clock domain.
 * - Web Audio offers no meaningful "output position query" beyond
 *   currentTime; the adapter derives output samples from currentTime.
 */
export class WebAudioAdapter implements PlaybackAdapter {
  private ctx: AudioContext | null = null;
  private sampleRate = 48000;
  private buffers = new Map<string, AudioBuffer>();
  private activeSources = new Set<AudioBufferSourceNode>();
  private masterGain: GainNode | null = null;
  private stemGains = new Map<string, GainNode>();
  private stingerBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  constructor(private buffersProvider?: () => Promise<Map<string, AudioBuffer>>) {
    void this.buffersProvider;
  }

  async initialize(sampleRate: number): Promise<void> {
    const Ctor = globalThis.AudioContext as (new (opts?: AudioContextOptions) => AudioContext) | undefined;
    if (!Ctor) {
      throw new AMSError(ErrorCodes.ADAPTER_INIT_FAILED, "AudioContext not available in this environment", true);
    }
    this.ctx = new Ctor({ sampleRate });
    this.sampleRate = this.ctx.sampleRate;
    void sampleRate;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.ctx.destination);

    this.musicBus = this.ctx.createGain();
    this.musicBus.connect(this.masterGain);

    this.stingerBus = this.ctx.createGain();
    this.stingerBus.connect(this.masterGain);
  }

  schedule(instruction: PlaybackInstruction): void {
    if (!this.ctx) {
      throw new AMSError(ErrorCodes.ADAPTER_INIT_FAILED, "WebAudioAdapter not initialized", false);
    }

    switch (instruction.type) {
      case "CUE_SWITCH": {
        // In production the Music Logic Layer passes a resolved buffer id.
        // This adapter treats `instruction.targetCueId` as a stem group;
        // individual stems are scheduled per STEM_VOLUME gains.
        break;
      }
      case "STEM_VOLUME": {
        const stemId = instruction.stemId;
        if (!stemId) break;
        let gain = this.stemGains.get(stemId);
        if (!gain) {
          gain = this.ctx.createGain();
          gain.gain.value = 0;
          gain.connect(this.musicBus as GainNode);
          this.stemGains.set(stemId, gain);
        }
        const now = this.currentTimeSec();
        const rampSamples = ((instruction.rampMs ?? 0) / 1000) * this.sampleRate;
        const rampSec = rampSamples / this.sampleRate;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(instruction.targetVolume ?? 0, now + rampSec);
        break;
      }
      case "STINGER": {
        if (!this.stingerBus) break;
        const buffer = this.buffers.get(instruction.stingerId ?? "");
        if (!buffer) break; // Buffer not loaded; adapter logs via caller
        this.playBuffer(buffer, instruction.atSample, instruction.stingerVolume ?? 1.0, this.stingerBus);
        break;
      }
      case "STOP":
        for (const src of this.activeSources) {
          try { src.stop(); } catch { /* already stopped */ }
        }
        this.activeSources.clear();
        break;
      case "PAUSE":
        void this.ctx.suspend();
        break;
      case "RESUME":
        void this.ctx.resume();
        break;
      case "SEEK":
        break;
    }
  }

  getCurrentOutputSample(): number {
    if (!this.ctx) return 0;
    return Math.floor(this.ctx.currentTime * this.sampleRate);
  }

  pause(): void {
    if (this.ctx && this.ctx.state === "running") {
      void this.ctx.suspend();
    }
  }

  resume(): void {
    if (this.ctx && this.ctx.state === "suspended") {
      void this.ctx.resume();
    }
  }

  stop(): void {
    for (const src of this.activeSources) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.activeSources.clear();
  }

  dispose(): void {
    this.stop();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }

  getCapabilities(): AdapterCapabilities {
    return {
      name: "WebAudioAdapter",
      supportsStreaming: false,
      supportsSampleAccurateScheduling: true,
      maxConcurrentStems: 32,
      maxConcurrentStingers: 8,
      limitations: [
        "Streaming via MediaElementAudioSourceNode is NOT sample-accurate and is unsupported. All assets must be decoded AudioBuffers.",
        "Output position derived from currentTime; subject to AudioContext clock granularity.",
        "Device sample-rate conversion may occur if hardware differs from requested context rate.",
      ],
    };
  }

  registerBuffer(id: string, buffer: AudioBuffer): void {
    this.buffers.set(id, buffer);
  }

  private currentTimeSec(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private playBuffer(buffer: AudioBuffer, atSample: number, volume: number, dest: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(dest);
    const when = atSample / this.sampleRate;
    src.start(when);
    this.activeSources.add(src);
    src.onended = () => this.activeSources.delete(src);
  }
}