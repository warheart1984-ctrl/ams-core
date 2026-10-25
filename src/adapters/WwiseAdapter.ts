import type { AdapterCapabilities, PlaybackAdapter, PlaybackInstruction } from "../types.js";

/**
 * Audiokinetic Wwise adapter — documented stub.
 *
 * RFC §11 normative requirements for Wwise adapter:
 *
 * 1. RTPCs use `AK::SoundEngine::SetRTPCValue()`.
 *
 * 2. States use `AK::SoundEngine::SetState()`.
 *
 * 3. Beat Grid MUST be maintained independently by the AMS Playback Engine.
 *    Wwise does not natively expose a beat-accurate callback mechanism for
 *    all event types — this is the critical difference from FMOD.
 *
 * 4. Adapter MUST use Wwise's `AkGameObjectID` pattern to associate music
 *    playback with a dedicated AMS game object.
 *
 * Limitations (documented in adapter capabilities):
 *
 * - Wwise's `SetRTPCValue()` applies to a game object. All AMS music
 *   states must be routed through a single game object to maintain
 *   consistent RTPC values across stems. Multiple game objects
 *   receiving conflicting RTPC values will produce undefined behaviour.
 *
 * - Wwise provides `AK::SoundEngine::GetSourcePlayPosition()` but it
 *   returns an approximation subject to Wwise's own buffer latency.
 *   The AMS Beat Grid MUST use its own independent clock for beat
 *   alignment; Wwise position is used only for drift measurement.
 *
 * - Crossfade scheduling: Wwise supports switch/transition containers,
 *   but AMS drives crossfades independently by controlling per-stem
 *   volumes. This is intentional to maintain AMS quantization authority.
 *   Wwise's built-in transitions MUST NOT be used for AMS-driven music
 *   as they would conflict with AMS scheduling.
 *
 * - Bank loading: Wwise banks are loaded via
 *   `AK::SoundEngine::LoadBank()`. AMS `loadCueBank()` is advisory;
 *   the adapter must pre-load the corresponding Wwise bank before
 *   `initialize()` returns.
 */
export class WwiseAdapter implements PlaybackAdapter {
  private currentRtpcs = new Map<string, number>();

  async initialize(sampleRate: number): Promise<void> {
    void sampleRate;
    // Wwise: create the dedicated AMS game object
    // AK::SoundEngine::RegisterGameObj(gameObjectId, "AMS")
  }

  schedule(instruction: PlaybackInstruction): void {
    switch (instruction.type) {
      case "CUE_SWITCH": {
        // Map targetCueId → Wwise event ID
        // AK::SoundEngine::PostEvent(eventId, gameObjectId)
        // Quantization: AMS controls the timing independently via the
        // Beat Grid, not via Wwise's switch containers.
        break;
      }
      case "STEM_VOLUME": {
        // AK::SoundEngine::SetRTPCValue(rtpcId, volume, gameObjectId)
        // The stem ID maps to a Wwise RTPC associated with the event.
        // AMS owns the smoothing and grid alignment.
        break;
      }
      case "STINGER": {
        // AK::SoundEngine::PostEvent(stingerEventId, gameObjectId)
        // One-shot event on the AMS game object.
        break;
      }
      case "STOP":
        // AK::SoundEngine::StopAll(gameObjectId)
        break;
      case "PAUSE":
      case "RESUME":
      case "SEEK":
        // Delegate to Wwise channel control.
        break;
    }
  }

  getCurrentOutputSample(): number {
    // Derived from AK::SoundEngine::GetSourcePlayPosition().
    // Subject to Wwise's own buffer latency. For drift measurement
    // only — the AMS Beat Grid uses its own clock for scheduling.
    return 0;
  }

  pause(): void { /* Wwise suspend/resume */ }
  resume(): void { /* Wwise suspend/resume */ }
  stop(): void { /* Stop all AMS events */ }
  dispose(): void {
    this.currentRtpcs.clear();
  }

  getCapabilities(): AdapterCapabilities {
    return {
      name: "WwiseAdapter",
      supportsStreaming: true,
      supportsSampleAccurateScheduling: false,
      maxConcurrentStems: 16,
      maxConcurrentStingers: 8,
      limitations: [
        "Beat Grid is maintained independently by the AMS. Wwise does NOT expose beat-accurate callbacks for all event types — this is the primary architectural difference from the FMOD adapter.",
        "getCurrentOutputSample() is derived from GetSourcePlayPosition() and is an approximation subject to Wwise's internal buffer latency (typically 10–20 ms). Used for drift measurement only.",
        "All AMS music must be routed through a single AkGameObjectID. Multiple game objects will produce undefined RTPC state.",
        "Wwise built-in transition containers MUST NOT be used for AMS-driven music. Crossfades are controlled independently via per-stem RTPC volume modulation to preserve AMS quantization authority.",
        "Bank loading is handled natively by Wwise. loadCueBank() does not manage Wwise bank resources.",
        "SetRTPCValue() is called per-event. A music cue with multiple stems may require multiple SetRTPCValue calls for a single stem volume change, which is slower than FMOD's per-parameter API.",
      ],
    };
  }
}