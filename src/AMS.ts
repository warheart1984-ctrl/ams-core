import { ContextEngine } from "./context/ContextEngine.js";
import { MusicLogicLayer } from "./logic/MusicLogicLayer.js";
import { PlaybackEngine } from "./playback/PlaybackEngine.js";
import { TransitionMatrix } from "./logic/TransitionMatrix.js";
import type {
  AMSEvent,
  AMSLifecycleState,
  CueBankHandle,
  CueBankManifest,
  CueChangedEvent,
  ErrorEvent,
  EventHandler,
  MemoryProfile,
  PlaybackAdapter,
  StateDefinition,
  StingerDefinition,
  UnsubHandle,
} from "./types.js";
import { AMSError, ErrorCodes, MEMORY_PROFILE_LIMITS, stingerDurationSamples } from "./types.js";

/**
 * AMS Facade — the public API of the Adaptive Music System.
 *
 * Lifecycle: uninitialized → loading → ready → playing ⇄ paused → stopped
 *
 * Threading model: callbacks from `on()` are delivered synchronously on the
 * thread that produces the event (the clock tick). The facade serializes
 * state mutations through the Context Engine. For multi-threaded hosts,
 * the host MUST route AMS calls to a single thread (e.g., the main game
 * thread); the internal tick loop runs the Playback Engine on a dedicated
 * interval.
 */

export interface AMSConfig {
  sampleRate: number;
  bpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  memoryProfile?: MemoryProfile;
  rtpcUpdateRateHz?: number;
  rtpcSmoothingMs?: number;
  lookaheadMs?: number;
  pollingIntervalMs?: number;
}

export class AMS {
  private config: Required<AMSConfig>;
  private contextEngine: ContextEngine;
  private playbackEngine: PlaybackEngine;
  private logicLayer: MusicLogicLayer;
  private adapter: PlaybackAdapter;
  private lifecycle: AMSLifecycleState = "uninitialized";
  private banks = new Map<string, CueBankHandle>();
  private bankMemoryUsed = new Map<string, number>();
  private bankLastActiveNs = new Map<string, bigint>();
  private memoryProfile: MemoryProfile;
  private listeners = new Map<string, Set<EventHandler<AMSEvent>>>();
  private startedNs: bigint | null = null;
  private evictionTicker: ReturnType<typeof setInterval> | null = null;

  constructor(adapter: PlaybackAdapter, config: AMSConfig) {
    if (![44100, 48000].includes(config.sampleRate)) {
      throw new AMSError(ErrorCodes.INVALID_CONFIG, `Invalid sample rate ${config.sampleRate}; must be 44100 or 48000`, false);
    }
    if (config.bpm <= 0) {
      throw new AMSError(ErrorCodes.INVALID_CONFIG, "BPM must be > 0", false);
    }
    this.memoryProfile = config.memoryProfile ?? "DEFAULT";
    this.config = {
      sampleRate: config.sampleRate,
      bpm: config.bpm,
      timeSignatureNumerator: config.timeSignatureNumerator,
      timeSignatureDenominator: config.timeSignatureDenominator,
      memoryProfile: this.memoryProfile,
      rtpcUpdateRateHz: config.rtpcUpdateRateHz ?? 60,
      rtpcSmoothingMs: config.rtpcSmoothingMs ?? 200,
      lookaheadMs: config.lookaheadMs ?? 500,
      pollingIntervalMs: config.pollingIntervalMs ?? 10,
    };
    this.adapter = adapter;

    // Playback Engine first (owns the clock)
    this.playbackEngine = new PlaybackEngine(adapter, {
      bpm: this.config.bpm,
      timeSignatureNumerator: this.config.timeSignatureNumerator,
      timeSignatureDenominator: this.config.timeSignatureDenominator,
      sampleRate: this.config.sampleRate,
      lookaheadMs: this.config.lookaheadMs,
      pollIntervalMs: this.config.pollingIntervalMs,
    });

    // Context Engine
    this.contextEngine = new ContextEngine({
      rtpcUpdateRateHz: this.config.rtpcUpdateRateHz,
    });

    // Music Logic Layer (empty matrix; populated from cue bank)
    const matrix = new TransitionMatrix([]);
    this.logicLayer = new MusicLogicLayer({
      matrix,
      clock: this.playbackEngine.getClock(),
      adapter,
      onInstruction: (instruction) => this.playbackEngine.schedule(instruction),
      emitError: (code, message, recoverable, context) => this.emitError(code, message, recoverable, context),
      emitTransitionStart: (e) => this.dispatch(e),
      emitTransitionEnd: (from, to, elapsedMs) => this.dispatch({ type: "transition_end", fromCueId: from ?? "", toCueId: to, elapsedMs } as const),
      emitCueChanged: (e) => {
        // A cue going active resets its bank's eviction timer (RFC §13.1).
        const path = this.findBankPath((m) => m.cues.some((c) => c.cueId === e.newCueId));
        if (path) this.bankLastActiveNs.set(path, process.hrtime.bigint());
        this.dispatch(e);
      },
      config: { queueTtlMs: 0 },
    });

    // Wire the engine's audible-position callbacks back to the logic layer:
    // cue_changed / transition_end / RTPC stem mapping / cooldowns / bank
    // activity all depend on these firing.
    this.playbackEngine.onCueStarted = (cueId) => {
      this.logicLayer.onCueChanged(this.logicLayer.getActiveCueId(), cueId, this.logicLayer.getActiveState() ?? "");
    };
    this.playbackEngine.onTransitionEnded = (from, to, elapsedMs) => {
      this.logicLayer.onTransitionEnded(from, to, elapsedMs);
    };

    // Wire context engine to logic layer
    this.contextEngine.on("state", (e) => {
      if (e.kind === "accepted" || e.kind === "preempted" || e.kind === "cancelled") {
        this.logicLayer.handleStateChange(e.prevState, e.newState);
      } else if (e.kind === "reentry") {
        // Re-entry: no-op for audio (same cue already active)
      }
    });
    this.contextEngine.on("rtpc", (e) => {
      this.logicLayer.updateRtpcValue(e.rtpcName, e.smoothedValue);
    });

    // Wire playback engine events out to the public API
    this.playbackEngine.on("beat", (e) => this.dispatch({ ...e }));
    this.playbackEngine.on("bar", (e) => this.dispatch({ ...e }));
    this.playbackEngine.on("error", (e) => this.dispatch({ ...e }));
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /** Initialize the AMS, adapter, and clock. */
  async initialize(): Promise<void> {
    if (this.lifecycle !== "uninitialized") {
      throw new AMSError(ErrorCodes.LIFECYCLE_VIOLATION, `Cannot initialize from state "${this.lifecycle}"`, false);
    }
    this.lifecycle = "loading";
    const now = process.hrtime.bigint();
    try {
      await this.playbackEngine.start(now);
      this.contextEngine.start(now);
      this.startedNs = now;
      // Periodic inactivity eviction (RFC §13.1): unpinned banks with no
      // active cue reference for >= 30 s must be evicted, not just evictable.
      this.evictionTicker = setInterval(() => this.evictInactiveBanks(), 5000);
      if (typeof this.evictionTicker.unref === "function") {
        this.evictionTicker.unref();
      }
      this.lifecycle = "ready";
    } catch (err) {
      this.lifecycle = "error";
      throw new AMSError(
        ErrorCodes.ADAPTER_INIT_FAILED,
        `Failed to initialize playback adapter: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    }
  }

  getLifecycle(): AMSLifecycleState {
    return this.lifecycle;
  }

  /** Stop the clock, engines, and the eviction ticker. */
  stop(): void {
    if (this.evictionTicker) {
      clearInterval(this.evictionTicker);
      this.evictionTicker = null;
    }
    this.contextEngine.stop();
    this.playbackEngine.stop();
    this.lifecycle = "stopped";
  }

  getCapabilities() {
    return this.adapter.getCapabilities();
  }

  // ─── Public API (RFC §10.1) ────────────────────────────────────

  /**
   * Set the active State within its exclusivity group.
   * Higher-priority states preempt; lower-priority requests are queued
   * (default) and drained when the guard clears.
   */
  setState(stateName: string, priority?: number, options?: { queue?: boolean }): void {
    this.requirePlayable();
    // Priority override bounds (RFC §12.5): out-of-range values are clamped
    // to [0, 255], never rejected, and a warning event is emitted.
    let effectivePriority = priority;
    if (priority !== undefined) {
      const clamped = Number.isFinite(priority) ? Math.max(0, Math.min(255, Math.trunc(priority))) : 0;
      if (clamped !== priority) {
        this.emitWarning("PRIORITY_CLAMPED", `setState("${stateName}") priority ${priority} clamped to ${clamped}`, {
          stateName,
          supplied: priority,
          clamped,
        });
      }
      effectivePriority = clamped;
    }
    const result = this.contextEngine.setState(stateName, effectivePriority, options);
    if (result.kind === "rejected") {
      this.emitError("STATE_REJECTED", `setState("${stateName}") rejected: ${result.reason}`, true);
    }
    // For queued results, the queue drain happens on tick or explicit call.
    if (result.kind === "queued") {
      // Attempt immediate drain if the current state's guards have cleared.
      this.contextEngine.processQueue(
        this.contextEngine.getStateDefinition(stateName)?.exclusivityGroup ?? ""
      );
    }
  }

  /**
   * Cancel the active state in an exclusivity group.
   * Only meaningful for preempted/cancellable states.
   */
  cancelState(exclusivityGroup: string): void {
    this.requirePlayable();
    const result = this.contextEngine.cancelState(exclusivityGroup);
    if (result.kind === "cancelled" && result.restored) {
      // The restored state's cue should already be in the matrix.
    }
  }

  /**
   * Set the target value of a registered RTPC (range [0.0, 1.0]).
   * `rampMs` controls the smoothing ramp.
   */
  setRTPC(name: string, value: number, rampMs: number): void {
    this.requirePlayable();
    // Sanitize per RFC §12.2: clamp to [0,1], reject NaN/Infinity.
    if (!Number.isFinite(value)) {
      throw new AMSError(ErrorCodes.RTPC_VALUE_OUT_OF_RANGE, `RTPC "${name}" received NaN/Infinity`, false);
    }
    const clamped = Math.max(0, Math.min(1, value));
    this.contextEngine.setRtpc(name, clamped, rampMs);
  }

  /**
   * Trigger a stinger by ID.
   */
  triggerStinger(stingerId: string): void {
    this.requirePlayable();
    const bankPath = this.findBankPath((m) => m.stingers.some((s) => s.stingerId === stingerId));
    const bank = bankPath ? this.banks.get(bankPath)! : null;
    if (!bank) {
      this.emitError(ErrorCodes.STINGER_NOT_FOUND, `Stinger "${stingerId}" not found in any loaded bank`, true);
      return;
    }
    // A stinger firing counts as bank activity (RFC §13.1 eviction reset).
    this.bankLastActiveNs.set(bankPath!, process.hrtime.bigint());
    const stinger = bank.manifest.stingers.find((s) => s.stingerId === stingerId);
    const clock = this.playbackEngine.getClock();
    const snap = clock.snapshot();
    const atSample = this.resolveStingerPosition(stinger!.quantization, snap.sample.samples);
    this.playbackEngine.schedule({
      type: "STINGER",
      atSample,
      stingerId,
      stingerVolume: stinger?.mixVolume ?? 1.0,
      stingerDurationSamples: stinger
        ? stingerDurationSamples(stinger.durationBars, snap.bpm, snap.timeSignature[0], snap.sample.sampleRate)
        : 0,
      stingerConflictMode: stinger?.conflictMode ?? "QUEUE",
    });
  }

  /**
   * Load a cue bank (RFC §10.1). Validates checksums and size limits
   * before resolving. Registers states, RTPCs, cues, stingers, and the
   * transition matrix.
   *
   * @param verification An HMAC-SHA-256 shared secret for signed manifests.
   *   If provided, signature verification is REQUIRED before load proceeds.
   * @param options.pinned If true, the bank is exempt from inactivity
   *   eviction (RFC §13.1); it stays resident until explicitly unloaded.
   */
  async loadCueBank(bankPath: string, loader?: {
    read: (path: string) => Promise<{ manifest: CueBankManifest; assets: Map<string, Uint8Array> }>;
  }, verification?: Buffer | string, options?: { pinned?: boolean }): Promise<CueBankHandle> {
    if (!loader) {
      throw new AMSError(ErrorCodes.BANK_LOAD_FAILED, "A cue bank loader must be provided (FS/HTTP/URL adapter)", false);
    }
    // A failed or slow load must not brick the engine or drop "playing".
    const priorLifecycle = this.lifecycle === "uninitialized" || this.lifecycle === "error" ? "ready" : this.lifecycle;
    this.lifecycle = "loading";
    try {
      const { manifest, assets } = await loader.read(bankPath);

      // Authenticity + integrity validation (RFC §12) — the manifest
      // declared checksums are verified against the loaded asset bytes,
      // and any manifest references (stingers/segments/cues/RTPCs) are
      // resolved against the manifest itself. Rejects before any partial load.
      const { assertManifestValid } = await import("./security/manifest.js");
      assertManifestValid(manifest, assets, {
        verificationKey: verification,
      });

      // Memory profile enforcement
      let totalBytes = 0;
      for (const asset of assets.values()) {
        totalBytes += asset.byteLength;
      }
      const limit = MEMORY_PROFILE_LIMITS[this.memoryProfile];
      if (totalBytes > limit) {
        throw new AMSError(
          ErrorCodes.BANK_SIZE_EXCEEDED,
          `Cue bank "${bankPath}" is ${Math.round(totalBytes / 1024 / 1024)} MB, exceeds ${this.memoryProfile} limit of ${Math.round(limit / 1024 / 1024)} MB`,
          false
        );
      }

      // Register states
      for (const stateDef of manifest.states) {
        const def: StateDefinition = { ...stateDef };
        try {
          this.contextEngine.registerState(def);
        } catch {
          // Skip duplicate state registration (already registered)
        }
        if (def.defaultCueId) {
          this.logicLayer.registerStateDefaultCue(def.name, def.defaultCueId);
        }
      }

      // Register RTPCs
      for (const rtpcDef of manifest.rtpcs) {
        try {
          this.contextEngine.registerRtpc(rtpcDef);
        } catch {
          // Skip duplicate
        }
      }

      // Load cues and stingers into logic layer
      this.logicLayer.loadCues(manifest.cues);
      this.logicLayer.loadStingers(manifest.stingers);

      // Build and add transition matrix
      const matrix = this.logicLayer.getMatrix();
      for (const descriptor of manifest.transitionMatrix) {
        matrix.add(descriptor);
      }

      const handle: CueBankHandle = {
        manifest,
        loadedAtNs: process.hrtime.bigint(),
        memoryBytes: totalBytes,
        pinned: options?.pinned === true,
      };
      this.banks.set(bankPath, handle);
      this.bankMemoryUsed.set(bankPath, totalBytes);
      this.bankLastActiveNs.set(bankPath, process.hrtime.bigint());

      this.lifecycle = priorLifecycle === "playing" || priorLifecycle === "paused" ? priorLifecycle : "ready";
      return handle;
    } catch (err) {
      this.lifecycle = priorLifecycle;
      if (err instanceof AMSError) throw err;
      throw new AMSError(ErrorCodes.BANK_LOAD_FAILED, `Failed to load cue bank "${bankPath}": ${err instanceof Error ? err.message : String(err)}`, false);
    }
  }

  /**
   * Unload a cue bank, evicting its memory and clearing its states/cues.
   */
  unloadCueBank(bankPath: string): void {
    const bank = this.banks.get(bankPath);
    if (!bank) return;

    const others = [...this.banks.entries()].filter(([p]) => p !== bankPath).map(([, b]) => b);
    // Only remove registrations no other loaded bank also declares — bank
    // load silently skips duplicates, so ownership is shared.
    for (const stateDef of bank.manifest.states) {
      this.logicLayer.unregisterStateDefaultCue(stateDef.name);
      if (!others.some((b) => b.manifest.states.some((s) => s.name === stateDef.name))) {
        this.contextEngine.unregisterState(stateDef.name);
      }
    }
    for (const rtpcDef of bank.manifest.rtpcs) {
      if (!others.some((b) => b.manifest.rtpcs.some((r) => r.name === rtpcDef.name))) {
        this.contextEngine.unregisterRtpc(rtpcDef.name);
      }
    }
    this.logicLayer.unloadCues(bank.manifest.cues.map((c) => c.cueId));
    this.logicLayer.unloadStingers(bank.manifest.stingers.map((s) => s.stingerId));

    // Rebuild the transition matrix from the remaining banks.
    const matrix = this.logicLayer.getMatrix();
    matrix.clear();
    for (const b of others) {
      for (const descriptor of b.manifest.transitionMatrix) {
        matrix.add(descriptor);
      }
    }

    this.banks.delete(bankPath);
    this.bankMemoryUsed.delete(bankPath);
    this.bankLastActiveNs.delete(bankPath);
  }

  /** Evict unpinned banks inactive for ≥30 s (RFC §13.1). */
  evictInactiveBanks(nowNs: bigint = process.hrtime.bigint()): string[] {
    const evicted: string[] = [];
    const idleThresholdNs = 30n * 1000000000n;
    for (const [path, lastActive] of this.bankLastActiveNs) {
      if (this.banks.get(path)?.pinned) continue;
      if (nowNs - lastActive > idleThresholdNs) {
        this.unloadCueBank(path);
        evicted.push(path);
      }
    }
    return evicted;
  }

  // ─── Event subscription (RFC §10.1 / §10.2) ───────────────────

  on<K extends AMSEvent["type"]>(event: K, callback: (payload: Extract<AMSEvent, { type: K }>) => void): UnsubHandle {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const handler = callback as EventHandler<AMSEvent>;
    set.add(handler);
    return {
      unsubscribe: () => {
        set.delete(handler);
      },
    };
  }

  // ─── Queries ───────────────────────────────────────────────────

  getActiveState(group?: string): string | null {
    return this.contextEngine.getActiveStateName(group);
  }

  getActiveCueId(): string | null {
    return this.logicLayer.getActiveCueId();
  }

  getRtpcValue(name: string): number | undefined {
    return this.logicLayer.getRtpcValue(name);
  }

  getContextEngine(): ContextEngine {
    return this.contextEngine;
  }

  getPlaybackEngine(): PlaybackEngine {
    return this.playbackEngine;
  }

  getMusicLogicLayer(): MusicLogicLayer {
    return this.logicLayer;
  }

  getLoadedBanks(): string[] {
    return [...this.banks.keys()];
  }

  // ─── Internal ──────────────────────────────────────────────────

  private requirePlayable(): void {
    if (this.lifecycle !== "ready" && this.lifecycle !== "playing") {
      throw new AMSError(ErrorCodes.LIFECYCLE_VIOLATION, `AMS is in "${this.lifecycle}" state; expected ready/playing`, true);
    }
  }

  private resolveStingerPosition(quantization: StingerDefinition["quantization"], currentSample: number): number {
    switch (quantization) {
      case "IMMEDIATE":
        return currentSample;
      case "BEAT":
        return Number(this.playbackEngine.getClock().nextBeatSample());
      case "BAR":
        return Number(this.playbackEngine.getClock().nextBarSample());
      case "SEGMENT_END":
        return this.logicLayer.getSegmentEndSample() ?? currentSample;
    }
  }

  private findBankPath(pred: (m: CueBankManifest) => boolean): string | null {
    for (const [path, bank] of this.banks) {
      if (pred(bank.manifest)) return path;
    }
    return null;
  }

  private dispatch(event: AMSEvent): void {
    const set = this.listeners.get(event.type);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        (handler as (e: AMSEvent) => void)(event);
      } catch (err) {
        if (event.type === "error") {
          // An error handler that throws must not recurse into itself.
          try {
            console.error(`Unhandled error in "error" handler:`, err instanceof Error ? err : String(err));
          } catch {
            // Even the console must not break dispatch.
          }
        } else {
          const message = `Unhandled error in "${event.type}" handler`;
          this.emitError("CALLBACK_ERROR", message, true);
        }
      }
    }
  }

  private emitError(code: string, message: string, recoverable: boolean, context?: Record<string, unknown>): void {
    const errEvent: ErrorEvent = { type: "error", code, message, recoverable, context };
    this.dispatch(errEvent);
  }

  private emitWarning(code: string, message: string, context?: Record<string, unknown>): void {
    this.dispatch({ type: "warning", code, message, context });
  }
}

export type { CueBankManifest, CueBankHandle } from "./types.js";