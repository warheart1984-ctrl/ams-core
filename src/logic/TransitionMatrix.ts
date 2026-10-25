import { AMSError, ErrorCodes } from "../types.js";
import type { TransitionDescriptor, TransitionMatrixEntry } from "../types.js";

/**
 * Transition Matrix — the authoritative lookup table driving horizontal
 * re-sequencing decisions.
 *
 * Lookup precedence (RFC §8.3): exact match > wildcard (ANY) > fallback.
 * Lookups are O(1) via hash map indexing (RFC §13.2).
 */
export class TransitionMatrix {
  private explicit = new Map<string, TransitionMatrixEntry>();
  private wildcard = new Map<string, TransitionMatrixEntry>(); // key: toState
  private fallback: TransitionMatrixEntry | null = null;

  constructor(descriptors: TransitionDescriptor[]) {
    for (const d of descriptors) {
      this.add(d);
    }
  }

  add(descriptor: TransitionDescriptor): void {
    if (!descriptor.fromState || !descriptor.toState) {
      throw new AMSError(ErrorCodes.INVALID_CONFIG, "Transition descriptor requires fromState and toState", false);
    }
    const entry: TransitionMatrixEntry = { descriptor };
    if (descriptor.fromState === "*") {
      if (descriptor.toState === "*") {
        this.fallback = entry;
      } else {
        this.wildcard.set(descriptor.toState, entry);
      }
    } else {
      const key = this.key(descriptor.fromState, descriptor.toState);
      this.explicit.set(key, entry);
    }
  }

  /**
   * Look up a transition descriptor for (from, to).
   * Precedence: explicit > wildcard(ANY→to) > fallback.
   */
  lookup(fromState: string, toState: string): TransitionDescriptor | null {
    const explicit = this.explicit.get(this.key(fromState, toState));
    if (explicit) return explicit.descriptor;

    const wildcard = this.wildcard.get(toState);
    if (wildcard) return wildcard.descriptor;

    if (this.fallback) return this.fallback.descriptor;

    return null;
  }

  /** Returns true if an exact or wildcard entry exists for (from, to). */
  hasSpecific(fromState: string, toState: string): boolean {
    return this.explicit.has(this.key(fromState, toState)) || this.wildcard.has(toState);
  }

  /** Clear all entries. */
  clear(): void {
    this.explicit.clear();
    this.wildcard.clear();
    this.fallback = null;
  }

  get size(): number {
    return this.explicit.size + this.wildcard.size + (this.fallback ? 1 : 0);
  }

  private key(from: string, to: string): string {
    return `${from}\u0001${to}`;
  }
}