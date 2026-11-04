/**
 * Test utility for keyboard tests of a control: places it in the page between
 * two buttons, with focus on the button before it, so that a Tab pressed
 * through `pressKey` either reaches the control or passes over it to the
 * button after.
 */

import type { ReactiveElement } from "lit";

/** A control placed between two buttons, removed again on disposal. */
export type BetweenButtons<E extends ReactiveElement> = {
  control: E;
  before: HTMLButtonElement;
  after: HTMLButtonElement;
  [Symbol.dispose]: () => void;
};

/**
 * Places `control` between two buttons once it has rendered, and focuses the
 * button before it.
 */
export async function betweenButtons<E extends ReactiveElement>(
  control: E,
): Promise<BetweenButtons<E>> {
  const before = document.createElement("button");
  const after = document.createElement("button");
  document.body.append(before, control, after);
  await control.updateComplete;
  before.focus();
  return {
    control,
    before,
    after,
    [Symbol.dispose]: () => {
      before.remove();
      control.remove();
      after.remove();
    },
  };
}
