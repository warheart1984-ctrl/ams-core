from __future__ import annotations

import json
import os
import shlex
import subprocess
import tempfile
import wave
from pathlib import Path
from typing import Any, Optional

from speakers.adapters.base_adapter import SpeakerAdapter, SpeakerAdapterError


class Vevo2Adapter(SpeakerAdapter):
    """Bridge for an external Amphion Vevo2 inference runner.

    The runner receives a JSON request on stdin and must write a WAV file to
    the path supplied in ``--output``. Keeping inference external lets us use
    the same contract for CPU, CUDA, or a hosted Vevo2 runner.
    """

    provider_name = "vevo2"

    def __init__(self, command: Optional[str] = None, timeout: int = 600) -> None:
        self.command = command or os.environ.get("SPEAKER_VEVO2_COMMAND", "")
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return bool(self.command.strip())

    def _execute_inner(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if action == "list_voices":
            return {"ok": True, "profiles": ["vevo2_neutral"]}
        if action != "synthesize":
            raise ValueError(f"Unknown action: {action}")
        if not self.available:
            raise SpeakerAdapterError(
                "Vevo2 is not configured; set SPEAKER_VEVO2_COMMAND to an inference runner"
            )

        with tempfile.TemporaryDirectory(prefix="ams-vevo2-") as workdir:
            output = Path(workdir) / "vocals.wav"
            request = {
                "lyrics": payload["text"],
                "voice_profile_id": payload.get("voice_profile_id", "vevo2_neutral"),
                "melody_path": payload.get("melody_path"),
                "reference_audio_path": payload.get("reference_audio_path"),
                "sample_rate": int(payload.get("sample_rate", 44100)),
            }
            args = shlex.split(self.command) + ["--output", str(output)]
            try:
                result = subprocess.run(
                    args,
                    input=json.dumps(request),
                    text=True,
                    capture_output=True,
                    timeout=self.timeout,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise SpeakerAdapterError(f"Vevo2 runner failed: {exc}") from exc
            if result.returncode != 0:
                detail = (result.stderr or result.stdout).strip()[-500:]
                raise SpeakerAdapterError(f"Vevo2 runner exited {result.returncode}: {detail}")
            if not output.exists():
                raise SpeakerAdapterError("Vevo2 runner did not create an output WAV")
            audio = output.read_bytes()
            try:
                with wave.open(str(output), "rb") as wav:
                    duration = wav.getnframes() / wav.getframerate()
                    rate = wav.getframerate()
                    channels = wav.getnchannels()
            except (wave.Error, EOFError) as exc:
                raise SpeakerAdapterError("Vevo2 output is not a readable WAV") from exc
            return {"ok": True, "audio_bytes": audio, "duration_seconds": duration,
                    "sample_rate": rate, "channels": channels}
