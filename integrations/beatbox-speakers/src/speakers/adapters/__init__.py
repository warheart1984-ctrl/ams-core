from __future__ import annotations

import os

from speakers.adapters.base_adapter import SpeakerAdapter
from speakers.adapters.deterministic_adapter import DeterministicSpeakerAdapter
from speakers.adapters.elevenlabs_adapter import ElevenLabsAdapter, ElevenLabsConfig
from speakers.adapters.vevo2_adapter import Vevo2Adapter


def build_speaker_adapter_from_env() -> SpeakerAdapter:
    provider = os.environ.get("SPEAKER_PROVIDER", "deterministic").lower()
    if provider == "elevenlabs":
        config = ElevenLabsConfig.from_env()
        if config.available:
            return ElevenLabsAdapter(config)
    if provider == "vevo2":
        adapter = Vevo2Adapter()
        if adapter.available:
            return adapter
    return DeterministicSpeakerAdapter()


__all__ = [
    "SpeakerAdapter",
    "DeterministicSpeakerAdapter",
    "ElevenLabsAdapter",
    "ElevenLabsConfig",
    "Vevo2Adapter",
    "build_speaker_adapter_from_env",
]
