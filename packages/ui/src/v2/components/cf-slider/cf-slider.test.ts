/**
 * What a slider bound to a cell does: it shows the cell's value, takes a key
 * step from what the cell holds (asking the worker first where it has read
 * nothing), writes moves in the order they were made, announces each move a
 * person makes once its write is made, and never rewrites or unbinds a cell
 * it is only showing. A slider given a plain number keeps that number as its
 * own state.
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
 * run the update hooks by hand, and press keys through the handler the
 * element listens with, on an element that was never connected.
 */
type SliderInternals = {
  value: CellHandle<number> | number;
  min: number;
  max: number;
  step: number;
  addEventListener(type: string, listener: (event: Event) => void): void;
  getAttribute(name: string): string | null;
  willUpdate(changedProperties: Map<string, unknown>): void;
  updated(changedProperties: Map<string, unknown>): void;
  getPercentageValue(): number;
  setValue(value: number): void;
  increment(): void;
  decrement(): void;
  _handleKeyDown(event: { key: string; preventDefault(): void }): void;
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

/** What each `cf-change` carried, and where the slider stood as it fired. */
const announcements = (element: SliderInternals) => {
  const seen: { detail: unknown; shown: number }[] = [];
  element.addEventListener("cf-change", (event) => {
    if (event instanceof CustomEvent) {
      // Over 0–100 the percentage is the value, up to float noise.
      const shown = Math.round(element.getPercentageValue() * 1e6) / 1e6;
      seen.push({ detail: event.detail, shown });
    }
  });
  return seen;
};

const written = (value: CellHandle<number>) =>
  writesSent(value).map((write) => write.value);

/** Lets the mock worker's answers and queued writes go through. */
async function settle(): Promise<void> {
  const time = new FakeTime();
  try {
    await time.runMicrotasks();
  } finally {
    time.restore();
  }
}

describe("CFSlider bound to a cell", () => {
  it("shows the cell's value", () => {
    const element = sliderWith(createMockCellHandle(30));
    expect(element.getPercentageValue()).toBe(30);
    element.updated(new Map());
    expect(element.getAttribute("aria-valuenow")).toBe("30");
  });

  it("writes a key step once, and announces it after the write", async () => {
    const value = createMockCellHandle(30);
    const element = sliderWith(value);
    const announced = announcements(element);

    press(element, "ArrowRight");
    await settle();

    expect(written(value)).toEqual([31]);
    expect(announced).toEqual([
      { detail: { value: 31, oldValue: 30 }, shown: 31 },
    ]);
  });

  it("steps from what the worker answers for a cell it has not read", async () => {
    const value = createMockCellHandle<number>();
    const answer = holdReads(value);
    const element = sliderWith(value);
    const announced = announcements(element);

    press(element, "ArrowRight");
    expect(written(value)).toEqual([]);
    expect(announced).toEqual([]);

    answer({ value: 12 });
    await settle();

    expect(written(value)).toEqual([13]);
    expect(announced.map((a) => a.detail)).toEqual([
      { value: 13, oldValue: 12 },
    ]);
  });

  it("writes a move to a place at once, without waiting on a read", async () => {
    // A drag on a cell the worker has not answered for yet: each move goes
    // out as it is made, so no move can overtake another.
    const value = createMockCellHandle<number>();
    holdReads(value);
    const element = sliderWith(value);

    element.setValue(10);
    element.setValue(20);
    await settle();

    expect(written(value)).toEqual([10, 20]);
  });

  it("writes and announces nothing while the worker refuses the read", async () => {
    const value = createMockCellHandle(30);
    const element = sliderWith(value);
    const announced = announcements(element);
    pushRefusal(value);

    press(element, "ArrowRight");
    press(element, "End");
    await settle();

    expect(written(value)).toEqual([]);
    expect(announced).toEqual([]);
  });

  it("writes and announces nothing for a move that leaves it where it is", async () => {
    const atMax = createMockCellHandle(100);
    const full = sliderWith(atMax);
    const fullAnnounced = announcements(full);
    press(full, "ArrowRight");
    press(full, "End");

    const empty = createMockCellHandle<number>(undefined);
    const blank = sliderWith(empty);
    const blankAnnounced = announcements(blank);
    press(blank, "Home");
    await settle();

    expect(written(atMax)).toEqual([]);
    expect(fullAnnounced).toEqual([]);
    expect(written(empty)).toEqual([]);
    expect(blankAnnounced).toEqual([]);
  });

  it("announces nothing for a call from code", async () => {
    const value = createMockCellHandle(30);
    const element = sliderWith(value);
    const announced = announcements(element);

    element.increment();
    await settle();
    element.setValue(50);
    await settle();

    expect(written(value)).toEqual([31, 50]);
    expect(announced).toEqual([]);
  });

  it("never snaps past the maximum", async () => {
    const value = createMockCellHandle(8);
    const element = sliderWith(value);
    element.max = 10;
    element.step = 4;

    press(element, "End");
    await settle();

    expect(written(value)).toEqual([10]);
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

    press(element, "ArrowLeft");

    expect(element.value).toBe(29);
    expect(announced).toEqual([
      { detail: { value: 29, oldValue: 30 }, shown: 29 },
    ]);
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

  it("snaps to a fractional step without binary noise", () => {
    const element = sliderWith(0);
    element.max = 1;
    element.step = 0.1;

    element.setValue(0.3);

    expect(element.value).toBe(0.3);
  });

  it("keeps a finite value when the step is zero", () => {
    const element = sliderWith(30);
    element.step = 0;

    element.setValue(42);

    expect(element.value).toBe(42);
  });
});
