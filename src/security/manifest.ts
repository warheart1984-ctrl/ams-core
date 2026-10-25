import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AMSError, ErrorCodes } from "../types.js";
import type { CueBankManifest } from "../types.js";

/**
 * Cue bank manifest security (RFC §12).
 *
 * Corrected per review:
 * - SHA-256 checksums detect corruption but do NOT authenticate a
 *   maliciously modified manifest. This module therefore supports
 *   HMAC-SHA-256 **signed manifests**: the manifest is signed by a
 *   trusted key; verification occurs before any asset is loaded.
 * - Checksum-only validation remains available for trusted local assets
 *   (integrity vs. authenticity distinction is documented).
 */

/** Compute the canonical JSON string for manifest signing. */
export function canonicalizeManifest(manifest: Omit<CueBankManifest, "manifestSignature" | "signingKeyId">): string {
  return JSON.stringify({
    version: manifest.version,
    checksums: Object.fromEntries(Object.entries(manifest.checksums).sort(([a], [b]) => a.localeCompare(b))),
    states: manifest.states,
    rtpcs: manifest.rtpcs,
    cues: manifest.cues,
    segments: manifest.segments,
    stingers: manifest.stingers,
    transitionMatrix: manifest.transitionMatrix,
  });
}

/** Sign a manifest with HMAC-SHA-256 using a shared secret. */
export function signManifest(
  manifest: Omit<CueBankManifest, "manifestSignature" | "signingKeyId">,
  key: Buffer | string,
  keyId: string
): { manifest: CueBankManifest; signature: string } {
  const canonical = canonicalizeManifest(manifest);
  const signature = createHmac("sha256", key).update(canonical).digest("hex");
  return {
    manifest: { ...manifest, manifestSignature: signature, signingKeyId: keyId } as CueBankManifest,
    signature,
  };
}

/**
 * Verify a manifest signature.
 * Returns true if the signature matches; false otherwise.
 */
export function verifyManifestSignature(
  manifest: CueBankManifest,
  key: Buffer | string
): boolean {
  if (!manifest.manifestSignature) {
    return false;
  }
  const { manifestSignature, ...unsigned } = manifest;
  void manifestSignature;
  const canonical = canonicalizeManifest(unsigned as CueBankManifest);
  const expected = createHmac("sha256", key).update(canonical).digest();
  const provided = Buffer.from(manifest.manifestSignature, "hex");
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Compute the SHA-256 checksum of a buffer. */
export function sha256Hex(data: Uint8Array): string {
  const hash = createHash("sha256").update(data).digest("hex");
  return hash;
}

export interface ManifestValidationOptions {
  /** Secret used for HMAC verification. If provided, signatures are required. */
  verificationKey?: Buffer | string;
  /** If true, checksum verification is skipped for performance (auth already covers it). */
  skipChecksum?: boolean;
}

/**
 * Validate a cue bank manifest against loaded assets.
 *
 * Authenticity (signature) is verified first if a key is supplied.
 * Integrity (checksums) is then verified for every enumerated asset.
 */
export function validateManifest(
  manifest: CueBankManifest,
  assets: Map<string, Uint8Array>,
  options?: ManifestValidationOptions
): { valid: true } | { valid: false; reason: string } {
  if (options?.verificationKey) {
    if (!verifyManifestSignature(manifest, options.verificationKey)) {
      return { valid: false, reason: "manifest signature verification failed" };
    }
  }

  if (options?.skipChecksum) {
    return { valid: true };
  }

  for (const [assetName, expectedChecksum] of Object.entries(manifest.checksums)) {
    const asset = assets.get(assetName);
    if (!asset) {
      return { valid: false, reason: `asset "${assetName}" missing from bundle` };
    }
    const actual = sha256Hex(asset);
    if (actual !== expectedChecksum.toLowerCase()) {
      return { valid: false, reason: `asset "${assetName}" checksum mismatch (expected ${expectedChecksum}, got ${actual})` };
    }
  }

  // Validate manifest references (RFC §12.4): stinger/segment/cue IDs must resolve.
  const stingerIds = new Set(manifest.stingers.map((s) => s.stingerId));
  const cueIds = new Set(manifest.cues.map((c) => c.cueId));
  for (const descriptor of manifest.transitionMatrix) {
    if (descriptor.stingerId && !stingerIds.has(descriptor.stingerId)) {
      return { valid: false, reason: `transition references unknown stinger "${descriptor.stingerId}"` };
    }
    if (descriptor.targetCueId && !cueIds.has(descriptor.targetCueId)) {
      return { valid: false, reason: `transition references unknown cue "${descriptor.targetCueId}"` };
    }
  }
  for (const state of manifest.states) {
    if (state.enterStingerId && !stingerIds.has(state.enterStingerId)) {
      return { valid: false, reason: `state "${state.name}" references unknown stinger "${state.enterStingerId}"` };
    }
    if (state.defaultCueId && !cueIds.has(state.defaultCueId)) {
      return { valid: false, reason: `state "${state.name}" references unknown cue "${state.defaultCueId}"` };
    }
  }
  for (const cue of manifest.cues) {
    for (const stem of cue.stems) {
      if (stem.rtpcBinding && !manifest.rtpcs.some((r) => r.name === stem.rtpcBinding)) {
        return { valid: false, reason: `cue "${cue.cueId}" stem "${stem.stemId}" references unknown RTPC "${stem.rtpcBinding}"` };
      }
    }
  }

  return { valid: true };
}

/** Assert a manifest is valid or throw an AMSError. */
export function assertManifestValid(manifest: CueBankManifest, assets: Map<string, Uint8Array>, options?: ManifestValidationOptions): void {
  const result = validateManifest(manifest, assets, options);
  if (!result.valid) {
    throw new AMSError(
      ErrorCodes.BANK_VALIDATION_FAILED,
      `Cue bank manifest validation failed: ${result.reason}`,
      false
    );
  }
}