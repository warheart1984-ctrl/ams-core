import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CueBankManifest } from "../types.js";
import { AMSError, ErrorCodes } from "../types.js";
import { assertManifestValid, sha256Hex, type ManifestValidationOptions } from "../security/manifest.js";

/**
 * File-system cue bank reader.
 *
 * A cue bank is a directory (or single-file bundle) whose root contains a
 * `manifest.json` plus the referenced assets. This reader:
 * 1. Loads manifest.json
 * 2. Loads every asset listed in `checksums`
 * 3. Validates integrity (and authenticity if a verification key is given)
 *
 * The manifest itself is hashed into the checksum map when embedded as
 * `"manifest.json"`, closing the tamper vector that allowed a co-modified
 * manifest+assets (RFC review: SHA-256 detects corruption, not malice).
 */
export class FSCueBankReader {
  constructor(private readonly options?: ManifestValidationOptions) {}

  async read(bankPath: string): Promise<{ manifest: CueBankManifest; assets: Map<string, Uint8Array> }> {
    let manifestRaw: Buffer;
    try {
      manifestRaw = await readFile(join(bankPath, "manifest.json"));
    } catch (err) {
      throw new AMSError(ErrorCodes.BANK_LOAD_FAILED, `Cue bank "${bankPath}" has no manifest.json: ${err instanceof Error ? err.message : String(err)}`, false);
    }

    let manifest: CueBankManifest;
    try {
      manifest = JSON.parse(manifestRaw.toString("utf8")) as CueBankManifest;
    } catch (err) {
      throw new AMSError(ErrorCodes.BANK_LOAD_FAILED, `Cue bank "${bankPath}" manifest.json is malformed: ${err instanceof Error ? err.message : String(err)}`, false);
    }

    // Basic manifest shape validation
    if (!manifest.version || typeof manifest.checksums !== "object") {
      throw new AMSError(ErrorCodes.BANK_VALIDATION_FAILED, `Cue bank "${bankPath}" manifest is missing version or checksums`, false);
    }

    // Load all enumerated assets
    const assets = new Map<string, Uint8Array>();
    for (const assetName of Object.keys(manifest.checksums)) {
      try {
        const data = await readFile(join(bankPath, assetName));
        assets.set(assetName, new Uint8Array(data));
      } catch (err) {
        throw new AMSError(ErrorCodes.BANK_LOAD_FAILED, `Asset "${assetName}" in "${bankPath}" unreadable: ${err instanceof Error ? err.message : String(err)}`, false);
      }
    }

    // If the manifest embeds its own checksum, include it in the asset map
    if (typeof manifest.checksums["manifest.json"] === "string") {
      assets.set("manifest.json", new Uint8Array(manifestRaw));
    }

    // Validate integrity + authenticity
    if (this.options?.verificationKey || !this.options?.skipChecksum) {
      const result = assertManifestValidSafe(manifest, assets, this.options);
      if (result instanceof AMSError) throw result;
    }

    return { manifest, assets };
  }
}

function assertManifestValidSafe(manifest: CueBankManifest, assets: Map<string, Uint8Array>, options?: ManifestValidationOptions): void | AMSError {
  try {
    assertManifestValid(manifest, assets, options);
    return undefined;
  } catch (err) {
    return err instanceof AMSError ? err : new AMSError(ErrorCodes.BANK_VALIDATION_FAILED, `Validation failed: ${String(err)}`, false);
  }
}

/** Compute a hex digest of the whole bank directory manifest for reporting. */
export async function bankFingerprint(bankPath: string): Promise<string> {
  const manifestRaw = await readFile(join(bankPath, "manifest.json"));
  return sha256Hex(new Uint8Array(manifestRaw));
}

/** List available cue banks in a root directory (each subdirectory with a manifest.json). */
export async function listCueBanks(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const banks: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(rootDir, entry.name, "manifest.json"));
      banks.push(join(rootDir, entry.name));
    } catch {
      // Not a cue bank; skip
    }
  }
  return banks;
}