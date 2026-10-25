import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

export interface BeatboxCue {
  shot_number: number;
  cue_start_seconds: number;
  duration_seconds: number;
  mood: string;
  bpm: number;
  energy: number;
  tension: number;
  valence: number;
  description?: string;
}

export interface BeatboxScoreRequest {
  session_id?: string;
  story_id?: string;
  run_id?: string;
  scene_id?: string;
  tone?: string;
  target?: "movie" | "game";
  output_path?: string;
  cues: BeatboxCue[];
}

export interface BeatboxScoreResult {
  ok: boolean;
  artifact?: { audio_path: string; timeline_path: string; cue_count: number; continuity_passed: boolean; provider: string; total_duration_seconds: number };
  error?: string;
}

export async function runBeatboxScore(
  request: BeatboxScoreRequest,
  options: { python?: string; runner?: string } = {},
): Promise<BeatboxScoreResult> {
  const python = options.python ?? process.env.PYTHON ?? "python";
  const runner = options.runner ?? resolve(process.cwd(), "integrations/beatbox-speakers/bridge_runner.py");
  const child = spawn(python, [runner], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write(`${JSON.stringify({ operation: "score", ...request })}\n`);
  child.stdin.end();
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const [code] = await once(child, "close") as [number];
  const output = Buffer.concat(chunks).toString("utf8").trim().split("\n").pop() ?? "";
  if (code !== 0 && !output) throw new Error(`BeatBox bridge exited with code ${code}`);
  return JSON.parse(output) as BeatboxScoreResult;
}
