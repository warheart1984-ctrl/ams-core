// Portable test discovery: `node --test "dist/**/*.test.js"` relies on glob
// support that Node 20 does not provide. Walk dist/ ourselves and pass the
// explicit file list, which every supported Node version understands.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".test.js")) yield path;
  }
}

const files = [];
for await (const f of walk("dist")) files.push(f);
if (files.length === 0) {
  console.error("No test files found under dist/ — run `npm run build` first.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
