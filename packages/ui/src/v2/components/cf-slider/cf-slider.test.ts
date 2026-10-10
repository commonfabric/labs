/**
 * What a slider bound to a cell does: it shows the cell's value, writes a
 * move to the cell once and announces it, and leaves a cell it is only
 * showing alone. A slider given a plain number keeps that number as its own
 * state, as it always has.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFSlider } from "./index.ts";

interface Key {
  key: string;
  preventDefault(): void;
}

/**
 * The element's own members these tests drive. A Lit element mounts only in
 * a browser, so without one the tests bind `value` and press keys through
 * these, on an element that was never connected.
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
  _handleKeyDown(event: Key): void;
};

/** A slider over 0–100 holding `value`, as a change of `value` binds it. */
function sliderWith(value: CellHandle<number> | number): SliderInternals {
  const element = new CFSlider() as unknown as SliderInternals;
  element.value = value;
  element.willUpdate(new Map([["value", undefined]]));
  return element;
}

const press = (element: SliderInternals, key: string) =>
  element._handleKeyDown({ key, preventDefault: () => {} });

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

    press(element, "ArrowRight");

    expect(writesSent(value)).toEqual([
      expect.objectContaining({ type: "cell:set", value: 31 }),
    ]);
    expect(announced).toEqual([{ value: 31, oldValue: 30 }]);
  });

  it("writes nothing for a key that does not move it", () => {
    const value = createMockCellHandle(100);
    const element = sliderWith(value);

    press(element, "ArrowRight");
    press(element, "End");
    press(element, "a");

    expect(writesSent(value)).toEqual([]);
  });

  it("shows an out-of-range cell clamped, without rewriting it", () => {
    const value = createMockCellHandle(150);
    const element = sliderWith(value);
    element.updated(new Map([["max", undefined]]));

    expect(element.getPercentageValue()).toBe(100);
    expect(writesSent(value)).toEqual([]);
  });
});

describe("CFSlider given a plain number", () => {
  it("moves its own value and announces it", () => {
    const element = sliderWith(30);
    const announced = announcements(element);

    press(element, "ArrowLeft");

    expect(element.value).toBe(29);
    expect(announced).toEqual([{ value: 29, oldValue: 30 }]);
  });
});
