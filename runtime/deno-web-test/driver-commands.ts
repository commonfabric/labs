/**
 * The driver's side of the command channel `commands-protocol.ts` describes:
 * reading a command a test sent, and carrying out the key press it asks for.
 */

import type { Keyboard } from "@astral/astral";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { backtickQuote } from "@commonfabric/text/markdown";

import {
  type KeyPress,
  MODIFIER_KEYS,
  type ModifierKey,
  PRESSABLE_KEYS,
} from "./commands-protocol.ts";

/** The part of astral's `Keyboard` a key press uses. */
export type KeyPresser = Pick<Keyboard, "down" | "up" | "press">;

/**
 * What settling a command in the document that sent it came back with:
 * `undefined` where that document is gone, and `exceptionDetails` where the
 * settler threw there.
 */
export type SettleResult =
  | {
    exceptionDetails?: { exception?: { description?: string }; text: string };
  }
  | undefined;

/**
 * Carries out the command `payload` a test sent, pressing its key on
 * `keyboard`, and settles it through `settle`, with why the press failed where
 * it did. Resolves with a message to report on the console where the command
 * has no id, and so cannot be settled, or where settling it failed, and with
 * `undefined` otherwise. It never rejects.
 */
export async function runCommand(
  payload: string,
  keyboard: KeyPresser,
  settle: (id: number, error: string | null) => Promise<SettleResult>,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    // `commandId` reports the payload below.
  }
  const id = commandId(parsed);
  if (id === undefined || typeof parsed !== "object" || parsed === null) {
    return `A test sent a command with no id: ${backtickQuote(payload)}`;
  }
  let error: string | null = null;
  try {
    await pressOn(keyboard, readKeyPress(parsed));
  } catch (e) {
    error = describeFailure(e);
  }
  let failure: string | undefined;
  try {
    const settled = await settle(id, error);
    if (settled === undefined) {
      failure = "the document that sent it is gone";
    } else if (settled.exceptionDetails) {
      const { exception, text } = settled.exceptionDetails;
      failure = exception?.description ?? text;
    }
  } catch (e) {
    failure = describeFailure(e);
  }
  return failure === undefined
    ? undefined
    : `Command ${id} could not be settled: ${failure}`;
}

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
  keyboard: KeyPresser,
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
