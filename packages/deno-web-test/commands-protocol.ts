/**
 * The channel by which a test running in the page asks the driver for what
 * only the driver can do, such as a key press the browser treats as the
 * person's own: the names both ends use, and the commands that cross it. The
 * page side imports this module, so it holds nothing the page does not need.
 */

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

/**
 * The keys a test may press. Each is a name astral's keyboard knows: the
 * driver hands them to it, so a name it does not know fails the type check
 * there. A key missing here is added here.
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
] as const;

/** A key a test may press. */
export type PressableKey = typeof PRESSABLE_KEYS[number];

/** The keys a test may hold down while it presses another. */
export const MODIFIER_KEYS = [
  "Shift",
  "Alt",
  "Control",
  "Meta",
] as const;

/** A key a test may hold down while it presses another. */
export type ModifierKey = typeof MODIFIER_KEYS[number];

/** A key press: `press`, with each of `modifiers` held down around it. */
export type KeyPress = {
  press: PressableKey;
  modifiers: readonly ModifierKey[];
};

/** A command a test sends to the driver, numbered by the document sending it. */
export type Command = { id: number } & KeyPress;
