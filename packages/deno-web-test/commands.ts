/**
 * Commands a browser test sends to the driver, for input a script in the page
 * cannot produce itself. A `KeyboardEvent` a script dispatches is untrusted:
 * listeners see it, but the browser takes no default action, so a dispatched
 * Tab moves no focus. A key the driver presses arrives as the person's would.
 */

import {
  type Command,
  DRIVER_BINDING,
  PRESSABLE_KEYS,
  type PressableKey,
  SETTLE_GLOBAL,
} from "./commands-protocol.ts";

export type { PressableKey } from "./commands-protocol.ts";

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
 * Presses `key` as the person at the keyboard would, and resolves once the
 * browser has handled the press: focus a Tab moves has moved, and listeners
 * for the key's events have run. Throws outside the deno-web-test driver, and
 * on a key not in `PRESSABLE_KEYS`, which a test bundled unchecked can pass.
 */
export function pressKey(key: PressableKey): Promise<void> {
  if (!PRESSABLE_KEYS.some((known) => known === key)) {
    throw new Error(`pressKey cannot press ${JSON.stringify(key)}`);
  }
  const send: unknown = Reflect.get(globalThis, DRIVER_BINDING);
  if (typeof send !== "function") {
    throw new Error(
      "pressKey needs the deno-web-test driver, which runs this page",
    );
  }
  Reflect.set(globalThis, SETTLE_GLOBAL, settle);
  const command: Command = { id: nextId++, press: key };
  return new Promise((resolve, reject) => {
    pending.set(command.id, { resolve, reject });
    send(JSON.stringify(command));
  });
}
