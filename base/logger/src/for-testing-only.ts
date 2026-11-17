/**
 * What this package offers to tests alone: a capture of what a named logger
 * emits, for a test that turns a logger on to read what it prints.
 */

import {
  type ActiveLogLevel,
  getGlobalLogFloor,
  getLogger,
  setGlobalLogFloor,
} from "./logger.ts";
import { logSinks } from "./log-sinks.ts";

/** One line a captured logger emitted. */
export type CapturedLog = {
  level: ActiveLogLevel;
  key: string;

  /**
   * The line's resolved messages joined with spaces: a string as it is, an
   * `Error` as its message, and anything else as `Deno.inspect()` renders it.
   */
  text: string;

  /** The line's resolved messages as they were, not rendered. */
  messages: readonly unknown[];
};

/** What a capture recorded so far, which disposing ends. */
export type CapturedLogs = Disposable & {
  readonly logs: readonly CapturedLog[];

  /** The text of every line logged under `key`. */
  textsOf(key: string): string[];

  /** The resolved messages of every line logged under `key`. */
  messagesOf(key: string): (readonly unknown[])[];

  /**
   * Resolves with the first line logged under `key` since the capture began:
   * at once when one is already recorded, otherwise when the logger logs one.
   * A line logged under another key does not resolve it. Rejects, naming the
   * key, when the capture is disposed before such a line is logged, and at
   * once when it is called on a capture already disposed without one.
   */
  first(key: string): Promise<CapturedLog>;
};

/**
 * The global floor in place before the first of the captures now running
 * lifted it, and how many captures are running. The floor goes back only
 * when the last of them ends, so captures of different loggers may overlap
 * and end in any order.
 */
let floorBeforeCaptures: ReturnType<typeof getGlobalLogFloor>;
let runningCaptures = 0;

/**
 * Captures what the logger named `moduleName` emits, at every level, until the
 * returned value is disposed. For that time the logger is enabled at `debug`
 * and the global floor `CF_LOG_LEVEL` sets is lifted, so a message the logger
 * builds lazily is built whatever the environment says. Each line the logger
 * logs is recorded rather than printed, whether it would have gone to
 * `console` or, under `LOG_TO_STDERR`, to stderr, and the count summary the
 * logger prints every so many calls is left out of both. Disposing puts back
 * the logger's state, and the floor once no other capture is running, and
 * rejects every `first()` still waiting.
 *
 * @throws When the logger is already being captured.
 */
export const captureLogsForTestingOnly = (
  moduleName: string,
): CapturedLogs => {
  const logger = getLogger(moduleName);
  if (logSinks.has(logger)) {
    throw new Error(`The logger "${moduleName}" is already being captured.`);
  }
  const prior = { disabled: logger.disabled, level: logger.level };
  logger.disabled = false;
  logger.level = "debug";
  if (runningCaptures++ === 0) {
    floorBeforeCaptures = getGlobalLogFloor();
    setGlobalLogFloor(undefined);
  }
  const logs: CapturedLog[] = [];
  const waiters = new Map<string, PromiseWithResolvers<CapturedLog>[]>();
  logSinks.set(logger, (level, key, messages) => {
    const log: CapturedLog = {
      level,
      key,
      messages,
      text: messages.map((message) =>
        typeof message === "string"
          ? message
          : message instanceof Error
          ? message.message
          : Deno.inspect(message)
      ).join(" "),
    };
    logs.push(log);
    for (const waiter of waiters.get(key) ?? []) waiter.resolve(log);
    waiters.delete(key);
  });
  let ended = false;
  const endedBefore = (key: string) =>
    new Error(
      `The capture of "${moduleName}" ended before a line was logged under "${key}".`,
    );
  return {
    logs,
    first: (key) => {
      const found = logs.find((log) => log.key === key);
      if (found !== undefined) return Promise.resolve(found);
      if (ended) return Promise.reject(endedBefore(key));
      const waiter = Promise.withResolvers<CapturedLog>();
      waiters.set(key, [...waiters.get(key) ?? [], waiter]);
      return waiter.promise;
    },
    textsOf: (key) =>
      logs.filter((log) => log.key === key).map((log) => log.text),
    messagesOf: (key) =>
      logs.filter((log) => log.key === key).map((log) => log.messages),
    [Symbol.dispose]: () => {
      logSinks.delete(logger);
      logger.disabled = prior.disabled;
      logger.level = prior.level;
      if (--runningCaptures === 0) setGlobalLogFloor(floorBeforeCaptures);
      ended = true;
      for (const [key, waiting] of waiters) {
        for (const waiter of waiting) waiter.reject(endedBefore(key));
      }
      waiters.clear();
    },
  };
};
