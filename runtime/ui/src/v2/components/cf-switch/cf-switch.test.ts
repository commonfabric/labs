/**
 * What a click on a switch writes: the toggle of what its cell holds, once,
 * computed from what the worker answers for the cell rather than from a cell
 * it has not read or may not show.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  holdReads,
  pushRefusal,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFSwitch } from "./index.ts";

/**
 * The element's own members these tests drive. A Lit element mounts only in
 * a browser, so without one the tests bind `checked` and click through
 * these, on an element that was never connected.
 */
type SwitchInternals = {
  checked: CellHandle<boolean>;
  addEventListener(type: string, listener: (event: Event) => void): void;
  willUpdate(changedProperties: Map<string, unknown>): void;
  _handleClick(event: Event): void;
};

/** A switch bound to `checked`, as a change of `checked` binds it. */
function boundTo(checked: CellHandle<boolean>): SwitchInternals {
  const element = new CFSwitch() as unknown as SwitchInternals;
  element.checked = checked;
  element.willUpdate(new Map([["checked", undefined]]));
  return element;
}

describe("CFSwitch click", () => {
  it("writes the toggle of an admitted value once, and announces it", () => {
    const checked = createMockCellHandle(false);
    const element = boundTo(checked);
    const announced: unknown[] = [];
    element.addEventListener("cf-change", (event) => {
      if (event instanceof CustomEvent) announced.push(event.detail);
    });

    element._handleClick(new Event("click"));

    expect(writesSent(checked)).toEqual([
      expect.objectContaining({ type: "cell:set", value: true }),
    ]);
    expect(announced).toContainEqual({ checked: true });
  });

  it("writes nothing until the worker answers a cell it has not read, then the toggle of the answer, once", async () => {
    const checked = createMockCellHandle<boolean>();
    const answer = holdReads(checked);
    const element = boundTo(checked);

    element._handleClick(new Event("click"));
    expect(writesSent(checked)).toEqual([]);

    const time = new FakeTime();
    try {
      answer({ value: true });
      // The toggle settles once the worker's answer reaches it.
      await time.runMicrotasks();
    } finally {
      time.restore();
    }

    expect(writesSent(checked)).toEqual([
      expect.objectContaining({ type: "cell:set", value: false }),
    ]);
  });

  it("writes nothing while the worker refuses the cell's read", () => {
    const checked = createMockCellHandle(false);
    const element = boundTo(checked);
    pushRefusal(checked);

    element._handleClick(new Event("click"));

    expect(writesSent(checked)).toEqual([]);
  });
});
