/**
 * The channel by which a test running in the page asks the driver for what
 * only the driver can do, such as a key press the browser treats as the
 * person's own. The page side is `commands.ts`; the driver side is
 * `BrowserController` in `browser.ts`.
 */

import type { Keyboard } from "@astral/astral";

/**
 * Name of the page global through which a test sends a command to the driver.
 * It is a CDP binding: calling it raises `Runtime.bindingCalled` in the driver.
 */
export const DRIVER_BINDING = "__denoWebTestDriver";

/**
 * Name of the page global the driver calls to settle a command, with the
 * command's id and, when it failed, a message saying why.
 */
export const SETTLE_GLOBAL = "__denoWebTestSettle";

/** A key that astral's keyboard can press. */
type AstralKey = Parameters<Keyboard["press"]>[0];

/**
 * The keys a test may press. Each is a name astral's keyboard knows, which is
 * what lets the driver hand a name the page sent to astral without asserting
 * its type. A key missing here is added here.
 */
export const PRESSABLE_KEYS = [
  "Tab",
  "Enter",
  " ",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
] as const satisfies readonly AstralKey[];

/** A key a test may press. */
export type PressableKey = typeof PRESSABLE_KEYS[number];

/** A command a test sends to the driver. */
export type Command = { id: number; press: PressableKey };

/**
 * Parses a command the page sent through `DRIVER_BINDING`, throwing when it
 * is not one: the page is the test's own code, so a malformed command is a
 * bug to report rather than a request to ignore.
 */
export function parseCommand(payload: string): Command {
  const parsed: unknown = JSON.parse(payload);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`A command must be an object; received ${payload}`);
  }
  const id = "id" in parsed ? parsed.id : undefined;
  const key = "press" in parsed ? parsed.press : undefined;
  const press = PRESSABLE_KEYS.find((known) => known === key);
  if (typeof id !== "number" || press === undefined) {
    throw new Error(
      `A command needs a numeric id and a key from PRESSABLE_KEYS; received ${payload}`,
    );
  }
  return { id, press };
}
