import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import type { CellHandle } from "@commonfabric/runtime-client";

import {
  createMockCellHandle,
  holdReads,
  pushRefusal,
  pushUpdate,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import { CFSlider } from "./index.ts";

/** A slider over 0–100 holding `value`, bound as Lit binds a new value. */
function sliderWith(
  value: CellHandle<number | undefined> | number,
): CFSlider {
  const element = new CFSlider();
  element.value = value;
  element.accessForTestingOnly.update({ value: undefined });
  return element;
}

const press = (element: CFSlider, key: string) =>
  element.accessForTestingOnly.press(key);

/** What each `cf-change` carried, and where the slider stood as it fired. */
const announcements = (element: CFSlider, type = "cf-change") => {
  const seen: { detail: unknown; shown: number }[] = [];
  element.addEventListener(type, (event) => {
    if (event instanceof CustomEvent) {
      // Over 0–100 the percentage is the value, up to float noise.
      const shown = Math.round(element.getPercentageValue() * 1e6) / 1e6;
      seen.push({ detail: event.detail, shown });
    }
  });
  return seen;
};

const written = (value: CellHandle<number | undefined>) =>
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
    const element = sliderWith(createMockCellHandle<number | undefined>(30));
    expect(element.getPercentageValue()).toBe(30);
    element.accessForTestingOnly.update({});
    expect(element.getAttribute("aria-valuenow")).toBe("30");
  });

  it("writes a key step once, and announces it after the write", async () => {
    const value = createMockCellHandle<number | undefined>(30);
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
    const value = createMockCellHandle<number | undefined>();
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
    const value = createMockCellHandle<number | undefined>();
    holdReads(value);
    const element = sliderWith(value);

    element.setValue(10);
    element.setValue(20);
    await settle();

    expect(written(value)).toEqual([10, 20]);
  });

  it("writes and announces nothing while the worker refuses the read", async () => {
    const value = createMockCellHandle<number | undefined>(30);
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
    const atMax = createMockCellHandle<number | undefined>(100);
    const full = sliderWith(atMax);
    const fullAnnounced = announcements(full);
    press(full, "ArrowRight");
    press(full, "End");

    // A cell the worker has read and found empty shows the minimum.
    const empty = createMockCellHandle<number | undefined>();
    const answer = holdReads(empty);
    const blank = sliderWith(empty);
    // A step that has the worker read the cell, and leaves it empty.
    blank.decrement();
    answer({ value: undefined });
    await settle();
    const blankAnnounced = announcements(blank);
    press(blank, "ArrowLeft");
    blank.decrement();
    await settle();

    expect(written(atMax)).toEqual([]);
    expect(fullAnnounced).toEqual([]);
    expect(written(empty)).toEqual([]);
    expect(blankAnnounced).toEqual([]);

    // Home chooses the minimum, which the empty cell then holds.
    press(blank, "Home");
    await settle();
    expect(written(empty)).toEqual([0]);
  });

  it("writes a move to the minimum on a cell it has not read", async () => {
    // The minimum is only what it shows meanwhile; the cell may hold 50.
    const value = createMockCellHandle<number | undefined>();
    holdReads(value);
    const element = sliderWith(value);

    press(element, "Home");
    await settle();

    expect(written(value)).toEqual([0]);
  });

  it("lands a step and a later move in the order they were made", async () => {
    const value = createMockCellHandle<number | undefined>();
    const answer = holdReads(value);
    const element = sliderWith(value);

    press(element, "ArrowRight");
    element.setValue(30);
    answer({ value: 50 });
    await settle();

    expect(written(value)).toEqual([51, 30]);
  });

  it("drops moves queued for one cell when another is bound", async () => {
    const first = createMockCellHandle<number | undefined>();
    const answer = holdReads(first);
    const element = sliderWith(first);
    press(element, "ArrowRight");
    press(element, "End");
    element.setValue(70);

    // Another cell: every mock shares one id, so a path sets it apart.
    const second = createMockCellHandle<number | undefined>(5, {
      path: ["other"],
    });
    element.value = second;
    element.accessForTestingOnly.update({ value: undefined });
    const announced = announcements(element);
    answer({ value: 50 });
    await settle();

    expect(written(first)).toEqual([]);
    expect(written(second)).toEqual([]);
    expect(announced).toEqual([]);
  });

  it("moves at once on a new binding, whatever the old cell still waits on", async () => {
    const stuck = createMockCellHandle<number | undefined>();
    holdReads(stuck);
    const element = sliderWith(stuck);
    press(element, "ArrowRight");

    const next = createMockCellHandle<number | undefined>(30, {
      path: ["other"],
    });
    element.value = next;
    element.accessForTestingOnly.update({ value: undefined });
    press(element, "ArrowRight");
    await settle();
    expect(written(next)).toEqual([31]);

    element.value = 20;
    element.accessForTestingOnly.update({ value: undefined });
    press(element, "ArrowRight");
    expect(element.value).toBe(21);
  });

  it("announces a step on a read cell at once", () => {
    const element = sliderWith(createMockCellHandle<number | undefined>(30));
    const announced = announcements(element);

    press(element, "ArrowRight");

    expect(announced.map((a) => a.detail)).toEqual([
      { value: 31, oldValue: 30 },
    ]);
  });

  it("moves keys between stops: min, each step, and max", async () => {
    // Over 0–10 at step 3 the stops are 0, 3, 6, 9 and 10.
    const value = createMockCellHandle<number | undefined>(7);
    const element = sliderWith(value);
    element.max = 10;
    element.step = 3;

    for (const key of ["ArrowRight", "ArrowRight", "ArrowLeft", "PageDown"]) {
      press(element, key);
      await settle();
    }
    press(element, "End");
    await settle();

    expect(written(value)).toEqual([9, 10, 9, 0, 10]);
  });

  it("puts a place on its nearest stop, max included", async () => {
    const value = createMockCellHandle<number | undefined>(0);
    const element = sliderWith(value);
    element.max = 10;
    element.step = 3;

    element.setValue(9.8);
    await settle();
    element.setValue(9.4);
    await settle();
    element.setValue(4.4);
    await settle();

    expect(written(value)).toEqual([10, 9, 3]);
  });

  it("reports a drag as it moves, and commits it once on release", async () => {
    const value = createMockCellHandle<number | undefined>(20);
    const element = sliderWith(value);
    const inputs = announcements(element, "cf-input");
    const changes = announcements(element, "cf-change");

    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(30);
    element.accessForTestingOnly.dragTo(40);
    element.accessForTestingOnly.endDrag();
    await settle();

    expect(written(value)).toEqual([30, 40]);
    expect(inputs.map((a) => a.detail)).toEqual([
      { value: 30, oldValue: 20 },
      { value: 40, oldValue: 30 },
    ]);
    expect(changes).toEqual([
      { detail: { value: 40, oldValue: 20 }, shown: 40 },
    ]);
  });

  it("commits what the drag wrote, not what another writer did meanwhile", async () => {
    const value = createMockCellHandle<number | undefined>(30);
    const element = sliderWith(value);
    const changes = announcements(element, "cf-change");

    // Pressed and held: someone else sets 60, and the person lets go.
    element.accessForTestingOnly.beginDrag();
    pushUpdate(value, 60);
    element.accessForTestingOnly.endDrag();
    // Dragged to 40; someone else sets 60; let go.
    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(40);
    pushUpdate(value, 60);
    element.accessForTestingOnly.endDrag();
    await settle();

    expect(changes.map((a) => a.detail)).toEqual([
      { value: 40, oldValue: 60 },
    ]);
  });

  it("commits nothing to a cell bound mid-drag, or from a removed slider", async () => {
    const first = createMockCellHandle<number | undefined>(30);
    const element = sliderWith(first);
    const changes = announcements(element, "cf-change");
    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(40);
    element.value = createMockCellHandle<number | undefined>(80, {
      path: ["other"],
    });
    element.accessForTestingOnly.update({ value: undefined });
    element.accessForTestingOnly.endDrag();

    // Removed mid-drag; a mouseup that still arrives commits nothing.
    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(50);
    element.disconnectedCallback();
    element.accessForTestingOnly.endDrag();
    await settle();

    expect(changes).toEqual([]);
  });

  it("stops a drag when another cell is bound", () => {
    const first = createMockCellHandle<number | undefined>(30);
    const element = sliderWith(first);
    element.accessForTestingOnly.beginDrag();

    element.value = createMockCellHandle<number | undefined>(80, {
      path: ["other"],
    });
    element.accessForTestingOnly.update({ value: first });

    expect(element.accessForTestingOnly.dragging).toBe(false);
  });

  it("commits a drag on a cell not yet read, even to the minimum", async () => {
    const value = createMockCellHandle<number | undefined>();
    holdReads(value);
    const element = sliderWith(value);
    const changes = announcements(element, "cf-change");

    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(0);
    element.accessForTestingOnly.endDrag();
    await settle();

    expect(written(value)).toEqual([0]);
    expect(changes.map((a) => a.detail)).toEqual([{ value: 0, oldValue: 0 }]);
  });

  it("keeps a drag across a fresh handle for the same cell", async () => {
    const value = createMockCellHandle<number | undefined>(30);
    const element = sliderWith(value);
    const changes = announcements(element, "cf-change");

    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(40);
    // Same id and path: the same persistent cell, as CFC label settling hands
    // over.
    const fresh = createMockCellHandle<number | undefined>(40);
    element.value = fresh;
    element.accessForTestingOnly.update({ value: value });
    element.accessForTestingOnly.dragTo(50);
    element.accessForTestingOnly.endDrag();
    await settle();

    // One cell: its writes may go through either handle.
    expect([...written(value), ...written(fresh)]).toEqual([40, 50]);
    expect(changes.map((a) => a.detail)).toEqual([
      { value: 50, oldValue: 30 },
    ]);
  });

  it("drops the moves still queued when the slider is removed", async () => {
    const value = createMockCellHandle<number | undefined>();
    const answer = holdReads(value);
    const element = sliderWith(value);
    const changes = announcements(element, "cf-change");
    press(element, "ArrowRight");
    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(70);

    element.disconnectedCallback();
    element.accessForTestingOnly.endDrag();
    answer({ value: 40 });
    await settle();

    expect(written(value)).not.toContain(70);
    expect(changes.map((a) => a.detail)).not.toContainEqual(
      expect.objectContaining({ value: 70 }),
    );
  });

  it("takes a key pressed mid-drag into the drag", async () => {
    const value = createMockCellHandle<number | undefined>(30);
    const element = sliderWith(value);
    const changes = announcements(element, "cf-change");

    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(40);
    press(element, "ArrowRight");
    element.accessForTestingOnly.endDrag();
    await settle();

    expect(written(value)).toEqual([40, 41]);
    expect(changes.map((a) => a.detail)).toEqual([
      { value: 41, oldValue: 30 },
    ]);
  });

  it("commits nothing for a drag released where it began", async () => {
    const value = createMockCellHandle<number | undefined>(20);
    const element = sliderWith(value);
    const changes = announcements(element, "cf-change");

    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(30);
    element.accessForTestingOnly.dragTo(20);
    element.accessForTestingOnly.endDrag();
    await settle();

    expect(written(value)).toEqual([30, 20]);
    expect(changes).toEqual([]);
  });

  it("announces nothing for a call from code", async () => {
    const value = createMockCellHandle<number | undefined>(30);
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
    const value = createMockCellHandle<number | undefined>(8);
    const element = sliderWith(value);
    element.max = 10;
    element.step = 4;

    press(element, "End");
    await settle();

    expect(written(value)).toEqual([10]);
  });

  it("shows an out-of-range cell clamped, and stays bound to it", () => {
    const value = createMockCellHandle<number | undefined>(150);
    const element = sliderWith(value);
    element.max = 120;
    element.accessForTestingOnly.update({ max: undefined });

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

  it("moves a value set out of bounds, and names it as it was", () => {
    const element = sliderWith(30);
    const announced = announcements(element);
    element.value = 200;

    press(element, "End");

    expect(element.value).toBe(100);
    expect(announced.map((a) => a.detail)).toEqual([
      { value: 100, oldValue: 200 },
    ]);
  });

  it("takes End to the maximum off the step", () => {
    const element = sliderWith(6);
    element.max = 10;
    element.step = 3;

    press(element, "End");

    expect(element.value).toBe(10);
  });

  it("commits a drag across the updates its own moves cause", () => {
    const element = sliderWith(30);
    const changes = announcements(element, "cf-change");

    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(40);
    // Each move sets value; Lit then updates with the value it replaced.
    element.accessForTestingOnly.update({ value: 30 });
    element.accessForTestingOnly.dragTo(50);
    element.accessForTestingOnly.update({ value: 40 });
    element.accessForTestingOnly.endDrag();

    expect(changes.map((a) => a.detail)).toEqual([
      { value: 50, oldValue: 30 },
    ]);
  });

  it("keeps a drag through its owner echoing values back", () => {
    // A controlled slider: the owner writes each value back, a beat late.
    const element = sliderWith(30);
    const changes = announcements(element, "cf-change");

    element.accessForTestingOnly.beginDrag();
    element.accessForTestingOnly.dragTo(40);
    element.accessForTestingOnly.update({ value: 30 });
    element.accessForTestingOnly.dragTo(50);
    element.accessForTestingOnly.update({ value: 40 });
    element.value = 40;
    element.accessForTestingOnly.update({ value: 50 });
    element.accessForTestingOnly.endDrag();

    expect(changes.map((a) => a.detail)).toEqual([
      { value: 50, oldValue: 30 },
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
    element.accessForTestingOnly.update({ max: undefined });

    expect(element.value).toBe(50);
  });

  it("snaps to a fractional step without binary noise", () => {
    const element = sliderWith(0);
    element.max = 1;
    element.step = 0.1;

    element.setValue(0.3);

    expect(element.value).toBe(0.3);
  });

  it("refuses a value that is not a finite number", () => {
    const value = createMockCellHandle<number | undefined>(40);
    const element = sliderWith(value);

    expect(() => element.setValue(NaN)).toThrow(RangeError);
    expect(writesSent(value)).toEqual([]);
  });

  it("steps by 1 when the step is not a positive number", () => {
    const element = sliderWith(30);
    element.step = NaN;

    press(element, "ArrowRight");

    expect(element.value).toBe(31);
  });

  it("keeps a finite value when the step is zero", () => {
    const element = sliderWith(30);
    element.step = 0;

    element.setValue(42);

    expect(element.value).toBe(42);
  });
});
