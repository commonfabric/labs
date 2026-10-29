/**
 * The driver's side of the command channel `commands-protocol.ts` describes:
 * reading a command a test sent, and carrying out the key press it asks for.
 */

import type { Keyboard } from "@astral/astral";
import { backtickQuote } from "@commonfabric/utils/markdown";

import {
  type KeyPress,
  MODIFIER_KEYS,
  type ModifierKey,
  PRESSABLE_KEYS,
} from "./commands-protocol.ts";

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
