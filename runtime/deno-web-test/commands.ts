/**
 * Commands a browser test sends to the driver, for input a script in the page
 * cannot produce itself. A `KeyboardEvent` a script dispatches is untrusted:
 * listeners see it, but the browser takes no default action, so a dispatched
 * Tab moves no focus. A key the driver presses arrives as the person's would.
 */

import {
  type Command,
  DRIVER_BINDING,
  type ModifierKey,
  type PressableKey,
  SETTLE_GLOBAL,
} from "./commands-protocol.ts";

export type { ModifierKey, PressableKey } from "./commands-protocol.ts";

/** The commands sent and not yet settled, by id. */
const pending = new Map<
  number,
  { resolve: () => void; reject: (error: Error) => void }
>();
let nextId = 0;

/**
 * Settles the command numbered `id`, rejecting it with `error` when there is
 * one. The driver calls it through `SETTLE_GLOBAL`.
 */
function settle(id: number, error: string | null): void {
  const waiting = pending.get(id);
  if (!waiting) {
    throw new Error(`No command ${id} is waiting to be settled`);
  }
  pending.delete(id);
  if (error === null) {
    waiting.resolve();
  } else {
    waiting.reject(new Error(error));
  }
}

/**
 * Helper for `pressKey`, which returns the driver's binding after making
 * `settle` the page's settler. Throws outside the deno-web-test driver, and
 * where another copy of this module already settles commands in the page,
 * since each copy would then settle the other's.
 */
function connect(): (payload: string) => void {
  const send: unknown = Reflect.get(globalThis, DRIVER_BINDING);
  if (typeof send !== "function") {
    throw new Error(
      "pressKey needs the deno-web-test driver, which runs this page",
    );
  }
  const settler: unknown = Reflect.get(globalThis, SETTLE_GLOBAL);
  if (settler === undefined) {
    Reflect.set(globalThis, SETTLE_GLOBAL, settle);
  } else if (settler !== settle) {
    throw new Error(
      "Two copies of deno-web-test's commands module are loaded in this page",
    );
  }
  return (payload) => send(payload);
}

/**
 * Presses `key` as the person at the keyboard would, holding `modifiers` down
 * around it, and resolves once the browser has handled the press: focus a
 * Tab moves has moved, and listeners for the key's events have run. Presses
 * run one at a time, in the order they were asked for. Rejects when the
 * driver refuses the press, as it does a key it does not know.
 */
export function pressKey(
  key: PressableKey,
  options: { modifiers?: readonly ModifierKey[] } = {},
): Promise<void> {
  const send = connect();
  const command: Command = {
    id: nextId++,
    press: key,
    modifiers: options.modifiers ?? [],
  };
  return new Promise((resolve, reject) => {
    pending.set(command.id, { resolve, reject });
    send(JSON.stringify(command));
  });
}
