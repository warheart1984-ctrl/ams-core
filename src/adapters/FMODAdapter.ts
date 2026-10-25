import type { AdapterCapabilities, PlaybackAdapter, PlaybackInstruction } from "../types.js";

/**
 * FMOD Studio adapter — documented stub.
 *
 * RFC §11 normative requirements for FMOD adapter:
 *
 * 1. States are implemented via FMOD Studio parameter API
 *    (`FMOD::Studio::EventInstance::setParameterByName()`) or the
 *    built-in State/Snapshot mechanism where parameter value = active
 *    state's priority.
 *
 * 2. RTPCs map directly to FMOD's existing RTPC parameter system.
 *
 * 3. Beat Grid MUST use FMOD's timeline callback system
 *    (`FMOD_STUDIO_EVENT_CALLBACK_TIMELINE_BEAT`) as the authoritative
 *    source of beat events. The AMS Beat Grid synchronises from that
 *    callback, not from independent timing.
 *
 * Limitations (to be documented in adapter capabilities):
 *
 * - FMOD handles sample-accurate scheduling internally via its own
 *   timeline system. The AMS lookahead buffer MUST be set to 0 and
 *   all scheduling is delegated to FMOD — the AMS cannot independently
 *   guarantee sample accuracy outside FMOD's timeline.
 *
 * - FMOD does not expose a direct "current playback position in samples"
 *   API for arbitrary events. `getCurrentOutputSample()` is derived from
 *   `FMOD::Channel::getPosition()` and is subject to FMOD's internal
 *   buffering latency (typically 5–10 ms).
 *
 * - Crossfade behaviour depends on the FMOD event graph. If the host
 *   application uses FMOD transitions directly, those transitions may
 *   conflict with AMS-driven scheduling. The adapter MUST be the sole
 *   authority for music scheduling when connected.
 *
 * - Bank loading is handled by FMOD's own bank system. The AMS
 *   `loadCueBank()` method is a no-op when using the FMOD adapter;
 *   state/cue registration is handled via FMOD parameter registration
 *   during `initialize()`.
 */
export class FMODAdapter implements PlaybackAdapter {
  private studioSystem: unknown = null;
  private bus: unknown = null;

  async initialize(sampleRate: number): Promise<void> {
    // FMOD Studio initialization stub
    // In production: import and call FMOD bindings
    void sampleRate;
  }

  schedule(instruction: PlaybackInstruction): void {
    switch (instruction.type) {
      case "CUE_SWITCH":
        // Delegate to FMOD Studio's built-in transition system.
        // The `targetCueId` maps to an FMOD event instance.
        // Quantization is handled by FMOD's timeline.
        break;
      case "STEM_VOLUME":
        // Maps to `EventInstance::setParameterByName()` for the stem's
        // RTPC parameter.
        break;
      case "STINGER":
        // Play a one-shot FMOD event on a separate channel group.
        break;
      case "CANCEL":
        // Release the not-yet-started event instance scheduled for atSample.
        break;
      case "STOP":
      case "PAUSE":
      case "RESUME":
      case "SEEK":
        // Delegate to FMOD channel control.
        break;
    }
  }

  getCurrentOutputSample(): number {
    // Derived from FMOD::Channel::getPosition().
    // Subject to FMOD internal buffering latency (5–10 ms).
    return 0;
  }

  pause(): void { /* FMOD bus/channel pause */ }
  resume(): void { /* FMOD bus/channel resume */ }
  stop(): void { /* FMOD channel stop */ }
  dispose(): void { /* FMOD system release */ }

  getCapabilities(): AdapterCapabilities {
    return {
      name: "FMODAdapter",
      supportsStreaming: true,
      supportsSampleAccurateScheduling: true,
      maxConcurrentStems: 32,
      maxConcurrentStingers: 8,
      limitations: [
        "Beat Grid is synchronized from FMOD timeline callbacks, not an independent clock. AMS Beat Grid acts as a slave.",
        "getCurrentOutputSample() is derived from Channel::getPosition() and is subject to FMOD's 5–10 ms internal buffering latency.",
        "Crossfade scheduling is delegated to FMOD Studio's built-in transition graph. AMS crossfade parameters are advisory when FMOD's internal transitions are active.",
        "Bank loading is handled natively by FMOD. loadCueBank() does not manage FMOD bank resources.",
        "Sample-accurate scheduling is guaranteed only for events created through FMOD Studio. Manual FMOD DSP graph manipulation may break sample accuracy.",
      ],
    };
  }
}