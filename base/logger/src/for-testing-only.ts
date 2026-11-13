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
};

/** What a capture recorded so far, which disposing ends. */
export type CapturedLogs = Disposable & {
  readonly logs: readonly CapturedLog[];

  /** The text of every line logged under `key`. */
  textsOf(key: string): string[];
};

/**
 * Captures what the logger named `moduleName` emits, at every level, until the
 * returned value is disposed. For that time the logger is enabled at `debug`
 * and the global floor `CF_LOG_LEVEL` sets is lifted, so a message the logger
 * builds lazily is built whatever the environment says. Each line the logger
 * logs is recorded rather than printed, whether it would have gone to
 * `console` or, under `LOG_TO_STDERR`, to stderr, and the count summary the
 * logger prints every so many calls is left out of both. Disposing puts back
 * the logger's state and the floor.
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
  const prior = {
    disabled: logger.disabled,
    level: logger.level,
    floor: getGlobalLogFloor(),
  };
  logger.disabled = false;
  logger.level = "debug";
  setGlobalLogFloor(undefined);
  const logs: CapturedLog[] = [];
  logSinks.set(logger, (level, key, messages) =>
    logs.push({
      level,
      key,
      text: messages.map((message) =>
        typeof message === "string"
          ? message
          : message instanceof Error
          ? message.message
          : Deno.inspect(message)
      ).join(" "),
    }));
  return {
    logs,
    textsOf: (key) =>
      logs.filter((log) => log.key === key).map((log) => log.text),
    [Symbol.dispose]: () => {
      logSinks.delete(logger);
      logger.disabled = prior.disabled;
      logger.level = prior.level;
      setGlobalLogFloor(prior.floor);
    },
  };
};
