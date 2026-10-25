"""Small JSONL bridge for the vendored BeatBox score lane.

The process is intentionally stateless: one JSON request in, one JSON result
out. This keeps the TypeScript AMS host independent of Python internals.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent / "src"
sys.path.insert(0, str(ROOT))

from beatbox.score_lane import ScoreLane  # noqa: E402
from audio_pipeline.contracts import BeatboxCuePlan, MusicCueEntry  # noqa: E402
from speakers.contracts import BusConfig, DuckingRule, RenderTarget, SpeakersMixPlan, StemEntry  # noqa: E402
from speakers.mix_lane import render_final_mix  # noqa: E402


def handle(request: dict) -> dict:
    operation = request.get("operation", "score")
    if operation == "mix":
        music_path = request.get("music_path")
        voice_paths = request.get("voice_paths", [])
        if not music_path and not voice_paths:
            raise ValueError("mix requires music_path or voice_paths")
        plan = SpeakersMixPlan(
            session_id=request.get("session_id", "ams-session"),
            story_id=request.get("story_id", "adaptive-music"),
            run_id=request.get("run_id", "run-1"),
            scene_id=request.get("scene_id", "scene-1"),
            mix_version="ams-bridge-v1",
            buses={"master": BusConfig(-16.0, -1.0), "music": BusConfig(-20.0, -2.0), "voice": BusConfig(-18.0, -1.0)},
            ducking_rules=[DuckingRule("voice_ducks_music", "voice", "music", 8.0, 50, 250)],
            render_targets=[RenderTarget("wav_master", "wav", 44100, 16, 1, "{story_id}_{run_id}_final_mix.wav")],
        )
        if music_path:
            plan.music_stem = StemEntry("music", music_path, 0.0, request.get("music_provider", "ace-step"))
        if voice_paths:
            plan.voice_stem = StemEntry("voice", voice_paths[0], 0.0, request.get("voice_provider", "speakers"))
        output_root = request.get("output_root", ".runtime-audio")
        output = render_final_mix(plan, {}, {}, output_root)
        return {"ok": True, "mix": {"audio_path": output, "session_id": plan.session_id, "music_path": music_path, "voice_paths": voice_paths}}
    if operation != "score":
        raise ValueError(f"Unsupported operation: {operation}")
    cues = [MusicCueEntry(**cue) for cue in request.get("cues", [])]
    plan = BeatboxCuePlan(
        session_id=request.get("session_id", "ams-session"),
        story_id=request.get("story_id", "adaptive-music"),
        run_id=request.get("run_id", "run-1"),
        scene_id=request.get("scene_id", "scene-1"),
        tone=request.get("tone", "adaptive"),
        target=request.get("target", "game"),
        cues=cues,
        total_duration_seconds=sum(c.duration_seconds for c in cues),
    )
    artifact = ScoreLane().score(plan.to_score_request(request.get("output_path", "")))
    return {"ok": True, "artifact": {
        "session_id": artifact.session_id,
        "scene_id": artifact.scene_id,
        "audio_path": artifact.audio_path,
        "timeline_path": artifact.timeline_path,
        "provider": artifact.provider,
        "continuity_passed": artifact.continuity_passed,
        "cue_count": artifact.cue_count,
        "total_duration_seconds": artifact.total_duration_seconds,
    }}


for line in sys.stdin:
    try:
        print(json.dumps(handle(json.loads(line))), flush=True)
    except Exception as exc:  # bridge errors remain machine-readable
        print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
