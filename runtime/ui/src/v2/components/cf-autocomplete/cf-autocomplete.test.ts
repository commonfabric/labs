/**
 * What a multi-select autocomplete writes when an item is chosen: the list
 * its cell holds with the item added, once, computed from what the worker
 * answers for the cell rather than from a cell it has not read.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { type AutocompleteItem, CFAutocomplete } from "./index.ts";

/**
 * The element's own members these tests drive. A Lit element mounts only in
 * a browser, so without one the tests bind its value and choose an item
 * through these, on an element that was never connected.
 */
type AutocompleteInternals = {
  multiple: boolean;
  value: CellHandle<string[]>;
  willUpdate(changedProperties: Map<string, unknown>): void;
  _selectItem(item: AutocompleteItem): void;
};

describe("CFAutocomplete multi-select", () => {
  let time: FakeTime;

  beforeEach(() => {
    time = new FakeTime();
  });
  afterEach(() => {
    time.restore();
  });

  /** A multi-select bound to `value`, as a change of `value` binds it. */
  const multiSelect = (value: CellHandle<string[]>) => {
    const element = new CFAutocomplete() as unknown as AutocompleteInternals;
    element.multiple = true;
    element.value = value;
    element.willUpdate(new Map([["value", undefined]]));
    return element;
  };

  /** Lets the read a choice waits on answer, then its write go out. */
  const settle = async () => {
    await time.runMicrotasks();
    time.tick(50);
  };

  it("writes the first item chosen into a cell the worker answers holds nothing", async () => {
    const value = createMockCellHandle<string[]>();
    await value.sync();
    const element = multiSelect(value);

    element._selectItem({ value: "x", label: "X" });
    await settle();

    expect(writesSent(value)).toEqual([
      expect.objectContaining({ type: "cell:set", value: ["x"] }),
    ]);
  });

  it("writes the first item chosen into a cell it has not read, once the worker answers", async () => {
    const value = createMockCellHandle<string[]>();
    const element = multiSelect(value);

    element._selectItem({ value: "x", label: "X" });
    await settle();

    expect(writesSent(value)).toEqual([
      expect.objectContaining({ type: "cell:set", value: ["x"] }),
    ]);
  });

  it("adds no item the worker's answer already holds", async () => {
    const value = createMockCellHandle<string[]>();
    const element = multiSelect(value);

    // Chosen while the cell shows nothing, and found among its items once
    // the cell answers.
    element._selectItem({ value: "x", label: "X" });
    pushUpdate(value, ["x"]);
    await settle();

    expect(writesSent(value)).toEqual([]);
  });
});
