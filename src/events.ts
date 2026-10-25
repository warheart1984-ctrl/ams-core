import type { AMSEvent, EventHandler, UnsubHandle } from "./types.js";

/**
 * Typed event emitter.
 *
 * Callback threading guarantees:
 * - Callbacks registered via `on()` are invoked synchronously
 *   on the calling thread of the emitting component.
 * - To guarantee cross-thread safety, use the AMS facade which
 *   serializes event delivery through a single threading model.
 */
export class EventEmitter<T extends { type: string } = AMSEvent> {
  private handlers = new Map<string, Set<(event: T) => void>>();

  /**
   * @param logger Sink for handler failures when no `error` listener is
   *   registered. Defaults to `console`.
   */
  constructor(private readonly logger: Pick<Console, "error"> = console) {}

  on<K extends T["type"]>(type: K, handler: (event: Extract<T, { type: K }>) => void): UnsubHandle {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as unknown as (event: T) => void);
    return {
      unsubscribe: () => {
        set.delete(handler as unknown as (event: T) => void);
      },
    };
  }

  emit(event: T): void {
    const set = this.handlers.get(event.type);
    if (!set) return;
    // Snapshot the set to allow unsubscribing during iteration
    for (const handler of [...set]) {
      try {
        handler(event);
      } catch (err) {
        // Errors in user callbacks must not break the audio pipeline. Prefer
        // the `error` event channel; with no listener, surface via the logger
        // rather than dropping the failure silently.
        const errorSet = this.handlers.get("error" as T["type"]);
        if (errorSet && errorSet.size > 0) {
          for (const errorHandler of [...errorSet]) {
            try {
              (errorHandler as (e: T) => void)({
                type: "error",
                code: "CALLBACK_ERROR",
                message: `Unhandled error in ${event.type} handler: ${err instanceof Error ? err.message : String(err)}`,
                recoverable: true,
                context: { eventType: event.type },
              } as unknown as T);
            } catch {
              // Swallow recursive errors
            }
          }
        } else {
          try {
            this.logger.error(
              `Unhandled error in ${event.type} handler:`,
              err instanceof Error ? err : String(err)
            );
          } catch {
            // A logger that throws must not break the pipeline either.
          }
        }
      }
    }
  }

  removeAll(): void {
    this.handlers.clear();
  }

  handlerCount(type?: string): number {
    if (type === undefined) {
      let count = 0;
      for (const set of this.handlers.values()) count += set.size;
      return count;
    }
    return this.handlers.get(type as T["type"])?.size ?? 0;
  }
}