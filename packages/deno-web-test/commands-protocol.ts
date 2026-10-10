/**
 * The channel by which a test running in the page asks the driver for what
 * only the driver can do, such as a key press the browser treats as the
 * person's own: the names both ends use, and the commands that cross it.
 */

import type { Keyboard } from "@astral/astral";
import { backtickQuote } from "@commonfabric/utils/markdown";

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

/** The keys a test may hold down while it presses another. */
export const MODIFIER_KEYS = [
  "Shift",
  "Alt",
  "Control",
  "Meta",
] as const satisfies readonly AstralKey[];

/** A key a test may hold down while it presses another. */
export type ModifierKey = typeof MODIFIER_KEYS[number];

/** A key press: `press`, with each of `modifiers` held down around it. */
export type KeyPress = {
  press: PressableKey;
  modifiers: readonly ModifierKey[];
};

/** A command a test sends to the driver, numbered by the document sending it. */
export type Command = { id: number } & KeyPress;

/**
 * Returns the id of the command `parsed`, or `undefined` where it has none.
 * A command with an id is settled, even when the rest of it is refused.
 */
export function commandId(parsed: unknown): number | undefined {
  if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) {
    return undefined;
  }
  return typeof parsed.id === "number" ? parsed.id : undefined;
}

/**
 * Reads the key press the command `parsed` asks for, throwing on a key or
 * modifier the driver does not press: the page is the test's own code, so
 * such a command is a mistake to report to the test that sent it.
 */
export function readKeyPress(parsed: object): KeyPress {
  const key = "press" in parsed ? parsed.press : undefined;
  const press = PRESSABLE_KEYS.find((known) => known === key);
  if (press === undefined) {
    throw new Error(
      `${backtickQuote(String(key))} is not a key a test may press`,
    );
  }
  const held = "modifiers" in parsed ? parsed.modifiers : [];
  if (!Array.isArray(held)) {
    throw new Error("A key press's modifiers must be an array");
  }
  const modifiers = held.map((name) => {
    const modifier = MODIFIER_KEYS.find((known) => known === name);
    if (modifier === undefined) {
      throw new Error(
        `${backtickQuote(String(name))} is not a key a test may hold down`,
      );
    }
    return modifier;
  });
  return { press, modifiers };
}

/**
 * Presses `keyPress` on `keyboard`, holding its modifiers down around the key
 * and releasing them whether or not the press succeeds.
 */
export async function pressOn(
  keyboard: Keyboard,
  keyPress: KeyPress,
): Promise<void> {
  const held: ModifierKey[] = [];
  try {
    for (const modifier of keyPress.modifiers) {
      await keyboard.down(modifier);
      held.push(modifier);
    }
    await keyboard.press(keyPress.press);
  } finally {
    for (const modifier of held.reverse()) {
      await keyboard.up(modifier);
    }
  }
}
