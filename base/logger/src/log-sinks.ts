/**
 * Where a captured logger's lines go instead of stderr or `console`. This is
 * internal to the package: `logger.ts` reads it, `for-testing-only.ts` fills
 * it, and no export-map entry reaches it.
 */

import type { ActiveLogLevel, Logger } from "./logger.ts";

/** Takes one line a logger emitted, its messages already resolved. */
export type LogSink = (
  level: ActiveLogLevel,
  key: string,
  messages: readonly unknown[],
) => void;

/** The loggers being captured, each with where its lines go. */
export const logSinks: WeakMap<Logger, LogSink> = new WeakMap();
