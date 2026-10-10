/**
 * What a slider bound to a cell does: it shows the cell's value, takes a step
 * from what the cell holds (asking the worker first where it has read
 * nothing), writes the step once and announces it, and never rewrites or
 * unbinds a cell it is only showing. A slider given a plain number keeps that
 * number as its own state, as it always has.
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
import { CFSlider } from "./index.ts";

/**
 * The element's members these tests drive. A Lit element mounts only in a
 * browser, so without one the tests bind `value` as a change of `value` does,
 * and run the update hooks by hand, on an element that was never connected.
 */
type SliderInternals = {
  value: CellHandle<number> | number;
  min: number;
  max: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  getAttribute(name: string): string | null;
  willUpdate(changedProperties: Map<string, unknown>): void;
  updated(changedProperties: Map<string, unknown>): void;
  getPercentageValue(): number;
  setValue(value: number): void;
  increment(): void;
  decrement(): void;
};

/** A slider over 0–100 holding `value`, as a change of `value` binds it. */
function sliderWith(value: CellHandle<number> | number): SliderInternals {
  const element = new CFSlider() as unknown as SliderInternals;
  element.value = value;
  element.willUpdate(new Map([["value", undefined]]));
  return element;
}

const announcements = (element: SliderInternals): unknown[] => {
  const seen: unknown[] = [];
  element.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) seen.push(event.detail);
  });
  return seen;
};

describe("CFSlider bound to a cell", () => {
  it("shows the cell's value", () => {
    const element = sliderWith(createMockCellHandle(30));
    expect(element.getPercentageValue()).toBe(30);
    element.updated(new Map());
    expect(element.getAttribute("aria-valuenow")).toBe("30");
  });

  it("writes a step to the cell once, and announces it", () => {
    const value = createMockCellHandle(30);
    const element = sliderWith(value);
    const announced = announcements(element);

    element.increment();

    expect(writesSent(value)).toEqual([
      expect.objectContaining({ type: "cell:set", value: 31 }),
    ]);
    expect(announced).toEqual([{ value: 31, oldValue: 30 }]);
  });

  it("steps from what the worker answers for a cell it has not read", async () => {
    const value = createMockCellHandle<number>();
    const answer = holdReads(value);
    const element = sliderWith(value);

    element.increment();
    expect(writesSent(value)).toEqual([]);

    const time = new FakeTime();
    try {
      answer({ value: 12 });
      await time.runMicrotasks();
    } finally {
      time.restore();
    }

    expect(writesSent(value)).toEqual([
      expect.objectContaining({ type: "cell:set", value: 13 }),
    ]);
  });

  it("writes and announces nothing while the worker refuses the read", () => {
    const value = createMockCellHandle(30);
    const element = sliderWith(value);
    const announced = announcements(element);
    pushRefusal(value);

    element.increment();
    element.setValue(80);

    expect(writesSent(value)).toEqual([]);
    expect(announced).toEqual([]);
  });

  it("writes nothing for a move that does not change it", () => {
    const value = createMockCellHandle(100);
    const element = sliderWith(value);

    element.increment();
    element.setValue(100);

    expect(writesSent(value)).toEqual([]);
  });

  it("shows an out-of-range cell clamped, and stays bound to it", () => {
    const value = createMockCellHandle(150);
    const element = sliderWith(value);
    element.max = 120;
    element.updated(new Map([["max", undefined]]));

    expect(element.getPercentageValue()).toBe(100);
    expect(writesSent(value)).toEqual([]);
    expect(element.value).toBe(value);
  });
});

describe("CFSlider given a plain number", () => {
  it("moves its own value and announces it", () => {
    const element = sliderWith(30);
    const announced = announcements(element);

    element.decrement();

    expect(element.value).toBe(29);
    expect(announced).toEqual([{ value: 29, oldValue: 30 }]);
  });

  it("sees a move made in the same tick", () => {
    const element = sliderWith(30);

    element.setValue(70);
    element.increment();

    expect(element.value).toBe(71);
  });

  it("brings its value within new bounds", () => {
    const element = sliderWith(90);
    element.max = 50;
    element.updated(new Map([["max", undefined]]));

    expect(element.value).toBe(50);
  });
});
