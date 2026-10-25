import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

export interface SpeakersMixRequest {
  session_id?: string;
  story_id?: string;
  run_id?: string;
  scene_id?: string;
  music_path?: string;
  voice_paths?: string[];
  music_provider?: string;
  voice_provider?: string;
  output_root?: string;
}

export interface SpeakersMixResult {
  ok: boolean;
  mix?: { audio_path: string; session_id: string; music_path?: string; voice_paths: string[] };
  error?: string;
}

export async function runSpeakersMix(request: SpeakersMixRequest, options: { python?: string; runner?: string } = {}): Promise<SpeakersMixResult> {
  const child = spawn(options.python ?? process.env.PYTHON ?? "python", [options.runner ?? resolve(process.cwd(), "integrations/beatbox-speakers/bridge_runner.py")], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(`${JSON.stringify({ operation: "mix", ...request })}\n`);
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const [code] = await once(child, "close") as [number];
  const output = Buffer.concat(chunks).toString("utf8").trim().split("\n").pop() ?? "";
  if (code !== 0 && !output) throw new Error(`Speakers bridge exited with code ${code}`);
  return JSON.parse(output) as SpeakersMixResult;
}
