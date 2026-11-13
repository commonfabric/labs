/**
 * Captures what a named logger prints, for the tests whose subject is a log
 * line. A logger's level decides whether a lazy message is built at all, so a
 * case reading one enables the logger and lowers its level for its own length.
 */

import { getLogger } from "@commonfabric/logger";

const CONSOLE_METHODS = ["debug", "info", "log", "warn", "error"] as const;

/** The lines a logger printed while a capture stood. */
export interface LogCapture extends Disposable {
  /** Every printed line naming `messageKey`, its arguments rendered. */
  lines(messageKey: string): string[];

  /**
   * Every printed line naming `messageKey`, as the arguments that followed
   * the key, unrendered.
   */
  messages(messageKey: string): unknown[][];

  /** Resolves with the first line naming `messageKey`, once one prints. */
  line(messageKey: string): Promise<string>;
}

const render = (args: unknown[]): string =>
  args.map((value) =>
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === "string"
      ? value
      : JSON.stringify(value)
  ).join(" ");

/**
 * Enables the logger named `name`, sets it to `debug`, and records every
 * console line until the capture is disposed, which restores the logger and
 * the console. The lines of every logger are recorded, and the accessors pick
 * out the ones naming a key.
 */
export const captureLogs = (name: string): LogCapture => {
  const logger = getLogger(name);
  const { level, disabled } = logger;
  logger.level = "debug";
  logger.disabled = false;
  const printed: unknown[][] = [];
  const waiters: { key: string; resolve: (line: string) => void }[] = [];
  const naming = (messageKey: string) =>
    printed.filter((args) => args.includes(messageKey));
  const originals = CONSOLE_METHODS.map((method) => {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      printed.push(args);
      for (const waiter of [...waiters]) {
        if (!args.includes(waiter.key)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(render(args));
      }
    };
    return [method, original] as const;
  });
  return {
    lines: (messageKey) => naming(messageKey).map(render),
    messages: (messageKey) =>
      naming(messageKey).map((args) =>
        args.slice(args.indexOf(messageKey) + 1)
      ),
    line: (messageKey) => {
      const found = naming(messageKey)[0];
      if (found !== undefined) return Promise.resolve(render(found));
      const { promise, resolve } = Promise.withResolvers<string>();
      waiters.push({ key: messageKey, resolve });
      return promise;
    },
    [Symbol.dispose]: () => {
      for (const [method, original] of originals) console[method] = original;
      logger.level = level;
      logger.disabled = disabled;
    },
  };
};
