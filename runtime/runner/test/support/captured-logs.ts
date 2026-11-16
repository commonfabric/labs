/**
 * Captures what a named logger emits, at every level, for as long as the
 * returned value is in scope. The logger is enabled at `debug` and the global
 * floor lifted for that time, so a message the logger builds lazily is built,
 * and each emitted line is recorded with its key and its resolved messages
 * joined into one string.
 */

import {
  getGlobalLogFloor,
  getLogger,
  setGlobalLogFloor,
} from "@commonfabric/logger";

export type CapturedLog = { level: string; key: string; text: string };

export type CapturedLogs = Disposable & {
  readonly logs: CapturedLog[];

  /** The text of every line logged under `key`. */
  textsOf(key: string): string[];
};

const LEVELS = ["debug", "log", "info", "warn", "error"] as const;

export const captureLogs = (moduleName: string): CapturedLogs => {
  const logger = getLogger(moduleName);
  const prior = {
    disabled: logger.disabled,
    level: logger.level,
    floor: getGlobalLogFloor(),
  };
  logger.disabled = false;
  logger.level = "debug";
  setGlobalLogFloor(undefined);
  const logs: CapturedLog[] = [];
  const originals = LEVELS.map((level) => [level, console[level]] as const);
  for (const level of LEVELS) {
    // The logger calls `console[level](prefix, color, key, ...messages)`.
    console[level] = (...args: unknown[]) => {
      logs.push({
        level,
        key: String(args[2]),
        text: args.slice(3).map((arg) =>
          typeof arg === "string"
            ? arg
            : arg instanceof Error
            ? arg.message
            : Deno.inspect(arg)
        ).join(" "),
      });
    };
  }
  return {
    logs,
    textsOf: (key) =>
      logs.filter((log) => log.key === key).map((log) => log.text),
    [Symbol.dispose]: () => {
      for (const [level, original] of originals) console[level] = original;
      logger.disabled = prior.disabled;
      logger.level = prior.level;
      setGlobalLogFloor(prior.floor);
    },
  };
};
