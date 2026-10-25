/**
 * Adaptive Music System (RFC-AMS-001) — core library.
 */

export { AMS, type AMSConfig } from "./AMS.js";
export { ContextEngine, type ContextEngineConfig } from "./context/index.js";
export { MusicLogicLayer } from "./logic/MusicLogicLayer.js";
export { TransitionMatrix } from "./logic/TransitionMatrix.js";
export { PlaybackEngine, type PlaybackEngineConfig } from "./playback/PlaybackEngine.js";
export { Clock, type ClockConfig, type ClockSnapshot, type BeatPosition, type SamplePosition, type ClockRecovery } from "./clock/index.js";
export { NullAdapter } from "./adapters/NullAdapter.js";
export { WebAudioAdapter } from "./adapters/WebAudioAdapter.js";
export { FSCueBankReader, listCueBanks, bankFingerprint } from "./bank/index.js";
export { evaluateMapping } from "./types.js";
export {
  AMSError,
  ErrorCodes,
  MEMORY_PROFILE_LIMITS,
} from "./types.js";
export type {
  // Core types
  StateDefinition,
  StateChangeRequest,
  ActiveState,
  StateTransitionResult,
  RTPCDefinition,
  RTPCValue,
  MappingFunction,
  StemDefinition,
  CueDefinition,
  SegmentDefinition,
  StingerDefinition,
  StingerConflictMode,
  QuantizationMode,
  TransitionType,
  TransitionDescriptor,
  TransitionMatrixEntry,
  PlaybackInstruction,
  // Events
  BeatEvent,
  BarEvent,
  CueChangedEvent,
  TransitionStartEvent,
  TransitionEndEvent,
  ErrorEvent,
  AMSEvent,
  EventHandler,
  // Cue bank
  CueBankManifest,
  CueBankHandle,
  MemoryProfile,
  // Lifecycle
  AMSLifecycleState,
  UnsubHandle,
  // Adapters
  PlaybackAdapter,
  AdapterCapabilities,
} from "./types.js";
export type { EventEmitter } from "./events.js";
export { runBeatboxScore, type BeatboxCue, type BeatboxScoreRequest, type BeatboxScoreResult } from "./pipeline/BeatboxBridge.js";
export { runSpeakersMix, type SpeakersMixRequest, type SpeakersMixResult } from "./pipeline/SpeakersBridge.js";
