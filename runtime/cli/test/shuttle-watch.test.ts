/**
 * Unit tests for a watch: what it is called, what it writes when the cell it
 * watches settles, and what stops it.
 *
 * Nothing here subscribes to anything. A settle is a call and a cancel is a
 * function, so every case drives the whole of it with no connection and no
 * terminal — which is what the module is shaped for.
 *
 * The cases that matter are the ones where a settle is *not* a change: the
 * first one, which is the baseline, and one that landed on the value the cell
 * already held. A watch that reported either would write a line for a change
 * nobody made, and that distinction is the whole of what the line claims —
 * it says the cell changed, not what it changed to.
 */

import { unicodeWidth } from "@std/cli/unicode-width";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { PiecePlace } from "../lib/shuttle/place.ts";
import { ArmedWatch, eventLine, watchEntries } from "../lib/shuttle/watch.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

/** How wide the screen is where a case is not asking about the width. */
const WIDE = 200;

/** Helper for the cases below, which is a place on a cell inside the piece. */
function at(...path: string[]): PiecePlace {
  return {
    position: { kind: "piece", space: SPACE, piece: HANDLE, path },
    scope: "space",
  };
}

/** What driving a watch produced: the lines it wrote, and the cancels it made. */
interface Driven {
  /** The watch itself. */
  readonly watch: ArmedWatch;

  /** Every line it wrote, in order. */
  readonly lines: string[];

  /** How many times the subscription it holds has been cancelled. */
  cancels: () => number;
}

/**
 * Helper for the cases below, which is a watch on `place` with its
 * subscription already handed over, recording what it writes.
 */
function driving(
  place: PiecePlace = at("replies"),
  columns = WIDE,
  input = false,
): Driven {
  const lines: string[] = [];
  let cancelled = 0;
  const watch = new ArmedWatch(
    { place, input },
    (line) => lines.push(line),
    () => columns,
  );
  watch.holding(() => cancelled++);
  return { watch, lines, cancels: () => cancelled };
}

describe("watch", () => {
  describe("ArmedWatch", () => {
    describe("instance members", () => {
      describe("label", () => {
        it("returns the cell written the short way the prompt writes a place", () => {
          expect(driving(at("replies")).watch.label)
            .toBe(`${HANDLE}/replies @space`);
        });

        it("carries the member where the cell watched is the piece's arguments", () => {
          // On the piece segment, where an operand selects it: written after
          // the path it would name the result key `replies#argument`.

          expect(driving(at("replies"), WIDE, true).watch.label)
            .toBe(`${HANDLE}#argument/replies @space`);
        });

        it("names a piece's two cells apart", () => {
          // What every surface that shows a watch rests on. The two are two
          // watches, so a name that named only the place would list them as
          // one line twice and open both their event lines the same way,
          // leaving a person nothing to tell them apart by.

          const place = at("replies");
          expect(driving(place, WIDE, false).watch.label)
            .not.toBe(driving(place, WIDE, true).watch.label);
        });
      });

      describe("key", () => {
        it("returns the complete reference of the cell it watches", () => {
          expect(driving(at("replies")).watch.key)
            .toBe(`/${HANDLE}@space/replies`);
        });

        it("holds a piece's two cells apart", () => {
          // The same reference under `#argument` is another cell, so a watch
          // on each is two watches rather than a second one on the first.

          const place = at("replies");
          const result = new ArmedWatch(
            { place, input: false },
            () => {},
            () => WIDE,
          );
          const input = new ArmedWatch(
            { place, input: true },
            () => {},
            () => WIDE,
          );
          expect(result.key === input.key).toBe(false);
        });

        it("holds the arguments cell apart from a result key spelled like it", () => {
          // A result key named `replies#argument` is a cell of its own. Kills a
          // key or a label that writes the member after the path, which gives
          // the two cells one key and one name.

          const argument = driving(at("replies"), WIDE, true).watch;
          const resultKey = driving(at("replies#argument"), WIDE, false).watch;
          expect({ key: argument.key, label: argument.label }).toEqual({
            key: `/${HANDLE}#argument@space/replies`,
            label: `${HANDLE}#argument/replies @space`,
          });
          expect(resultKey.key === argument.key).toBe(false);
          expect(resultKey.label === argument.label).toBe(false);
        });
      });

      describe("settled()", () => {
        it("writes nothing for the first settle, which is the baseline", () => {
          // The sink fires once on registration with what the cell already
          // holds. A watch reporting that would announce a change every time
          // one was armed.

          const driven = driving();
          driven.watch.settled(14);
          expect(driven.lines).toEqual([]);
        });

        it("writes one line naming the cell where it changed", () => {
          // What the line claims is that the cell moved, not what it moved to.
          // Reading the value out is `get`'s, and watching it move is the
          // lens's.

          const driven = driving(at("topics", "3"));
          driven.watch.settled({ title: "verb contracts", replies: 14 });
          driven.watch.settled({ title: "verb contracts", replies: 15 });
          expect(driven.lines).toEqual([
            `watch ${HANDLE}/topics/3 @space: changed`,
          ]);
        });

        it("opens the line with the name that says which of the two cells moved", () => {
          const driven = driving(at("replies"), WIDE, true);
          driven.watch.settled(14);
          driven.watch.settled(15);
          expect(driven.lines).toEqual([
            `watch ${HANDLE}#argument/replies @space: changed`,
          ]);
        });

        it("writes nothing for a settle that landed on the value already held", () => {
          // A recomputation that produced what was there is a settle and not a
          // change. This is what makes the line a report of a change rather
          // than of a settle, and it is the whole of what the line claims.
          //
          // Kills: reporting every settle after the first.

          const driven = driving();
          driven.watch.settled({ replies: 14 });
          driven.watch.settled({ replies: 14 });
          expect(driven.lines).toEqual([]);
        });

        it("writes one line for a settle that moved several members", () => {
          // One line per settled change, whatever the change turns out to be:
          // the members moved in one commit, and two lines would read as two.

          const driven = driving(at("topics"));
          driven.watch.settled({ title: "a", replies: 1 });
          driven.watch.settled({ title: "b", replies: 2 });
          expect(driven.lines).toEqual([
            `watch ${HANDLE}/topics @space: changed`,
          ]);
        });

        it("reports a change between two distinct byte sequences", () => {
          // The comparison is the whole of what decides whether a line is
          // written, so it has to be fabric-aware even with no leaf walk: a
          // `FabricSpecialObject` keeps its state in private fields and has no
          // enumerable own properties, so comparing by those reads two
          // distinct `FabricBytes` as equal and a cell whose bytes changed
          // would report nothing.
          //
          // Kills: comparing with `deepEqual`, which is silent for this pair.

          const driven = driving();
          driven.watch.settled(new FabricBytes(new Uint8Array([1, 2, 3])));
          driven.watch.settled(new FabricBytes(new Uint8Array([4, 5, 6])));
          expect(driven.lines).toEqual([
            `watch ${HANDLE}/replies @space: changed`,
          ]);
        });

        it("writes nothing for two byte sequences holding the same bytes", () => {
          // The other direction, and what stops the comparison reporting a
          // change every time the runtime hands back a fresh instance.
          //
          // Kills: comparing special objects by reference.

          const driven = driving();
          driven.watch.settled(new FabricBytes(new Uint8Array([1, 2, 3])));
          driven.watch.settled(new FabricBytes(new Uint8Array([1, 2, 3])));
          expect(driven.lines).toEqual([]);
        });

        it("writes nothing once it has been disarmed", () => {
          const driven = driving();
          driven.watch.settled(14);
          driven.watch.disarm();
          driven.watch.settled(15);
          expect(driven.lines).toEqual([]);
        });

        it("asks how wide the screen is for each line rather than once", () => {
          // A change arrives long after the line that armed the watch, so the
          // width the line is fitted to is the width the window has then.

          const asked: number[] = [];
          const lines: string[] = [];
          let columns = WIDE;
          const watch = new ArmedWatch(
            { place: at("replies"), input: false },
            (line) => lines.push(line),
            () => {
              asked.push(columns);
              return columns;
            },
          );
          watch.settled(1);
          watch.settled(2);
          columns = 4;
          watch.settled(3);
          expect(asked).toEqual([WIDE, 4]);
          // Four columns hold none of the label once the fixed text has taken
          // its room, so what is left is the sentence with nothing named.
          expect(lines[1]).toBe("watch : changed");
        });
      });

      describe("holding()", () => {
        it("cancels at once where the watch was disarmed while it was arming", () => {
          // Arming is a read, so the cancel exists only once that read has
          // come back. A line cancelled in between must not leave a
          // subscription nothing holds a cancel for.

          const watch = new ArmedWatch(
            { place: at("replies"), input: false },
            () => {},
            () => WIDE,
          );
          let cancelled = 0;
          watch.disarm();
          watch.holding(() => cancelled++);
          expect(cancelled).toBe(1);
        });
      });

      describe("disarm()", () => {
        it("cancels the subscription it was holding", () => {
          const driven = driving();
          driven.watch.disarm();
          expect(driven.cancels()).toBe(1);
        });

        it("cancels once however many times it is called", () => {
          const driven = driving();
          driven.watch.disarm();
          driven.watch.disarm();
          expect(driven.cancels()).toBe(1);
        });
      });

      describe("armed", () => {
        it("returns `true` before it is disarmed and `false` after", () => {
          const driven = driving();
          const before = driven.watch.armed;
          driven.watch.disarm();
          expect({ before, after: driven.watch.armed })
            .toEqual({ before: true, after: false });
        });
      });
    });
  });

  describe("eventLine()", () => {
    it("names the cell that changed, and says only that it changed", () => {
      // Which cell moved, so a reader knows where to look. What it moved to is
      // `get`'s to answer and the lens's to show.

      expect(eventLine("cell @space", WIDE)).toBe("watch cell @space: changed");
    });

    it("writes a label holding a newline on one line", () => {
      // The same holding every line above a prompt gets: a label that carried
      // a break would put the prompt a row further down each time one
      // arrived, and the transcript is append-only.
      //
      // Kills: composing the label into the line without `oneLine`.

      expect(eventLine("cell\nbroken @space", WIDE))
        .toBe("watch cell broken @space: changed");
    });

    it("fits the label to the room the line leaves it", () => {
      // The fixed text takes its room first, so what narrows is the label.
      // A line wider than the terminal wraps, and a wrapped line above a
      // prompt moves the prompt.
      //
      // Kills: composing the label at its full width whatever the terminal
      // has, which returns a line wider than the columns given.

      const narrow = eventLine("a-very-long-cell-name @space", 24);
      expect(unicodeWidth(narrow)).toBeLessThanOrEqual(24);
      expect(narrow.startsWith("watch ")).toBe(true);
      expect(narrow.endsWith(": changed")).toBe(true);
    });

    it("keeps the whole label where the terminal has room for it", () => {
      // The other direction of the fit, which a truncation that always cut
      // would pass.

      expect(eventLine("cell @space", 80)).toContain("cell @space");
    });
  });

  describe("watchEntries()", () => {
    it("returns the word for none where nothing is armed", () => {
      expect(watchEntries([]))
        .toEqual([{ label: "watches", value: "none" }]);
    });

    it("returns the cell each armed watch is armed on", () => {
      const first = driving(at("title")).watch;
      const second = driving(at("replies")).watch;
      expect(watchEntries([first, second])).toEqual([{
        label: "watches",
        value: `${HANDLE}/title @space, ${HANDLE}/replies @space`,
      }]);
    });

    it("tells a piece's two cells apart where both are watched", () => {
      // The record answers what this run is watching, and two entries a
      // person cannot tell apart is that question going unanswered.

      const place = at("title");
      const result = driving(place, WIDE, false).watch;
      const input = driving(place, WIDE, true).watch;
      expect(watchEntries([result, input])).toEqual([{
        label: "watches",
        value: `${HANDLE}/title @space, ${HANDLE}#argument/title @space`,
      }]);
    });
  });
});
