/**
 * `frameAnchorIds()`: the id source a cell's write anchors plain array-element
 * objects with, chosen by the frame the cell was made in.
 */

import { expect } from "@std/expect";
import { describe, it } from "@commonfabric/test-support/test";
import { makeFrame } from "../src/builder/pattern.ts";
import { frameAnchorIds } from "../src/cell.ts";

describe("frameAnchorIds()", () => {
  it("gives no id source for a cell made under no frame", () => {
    expect(frameAnchorIds(undefined, [{ a: 1 }])).toBeUndefined();
    expect(frameAnchorIds(makeFrame(), [{ a: 1 }])).toBeDefined();
  });

  it("draws ids from the frame's counter outside a builtin's run", () => {
    const frame = makeFrame({ generatedIdCounter: 5 });
    const next = frameAnchorIds(frame, [{ a: 1 }])!;

    expect([next(), next()]).toEqual([5, 6]);
    expect(frame.generatedIdCounter).toBe(7);
  });

  it("seeds ids from the write under a builtin's run", () => {
    const frame = makeFrame({ builtinRun: true, cause: "node" });
    const ids = (written: unknown) => {
      const next = frameAnchorIds(frame, written)!;
      return [next(), next()];
    };

    const first = ids([{ a: 1 }]);
    expect(first).toEqual(ids([{ a: 1 }]));
    expect(first[0]).not.toEqual(first[1]);
    expect(ids([{ a: 2 }])).not.toContain(first[0]);
    expect(frame.generatedIdCounter).toBe(0);
  });
});
