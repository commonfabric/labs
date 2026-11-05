/**
 * Unit tests for the session objects beside the place: what the last listing
 * numbered, what a rendering left for `more`, and which pieces the run has
 * started.
 *
 * The three are separate because different lines reset them, so the cases that
 * matter are the ones where one is written and another is asked. Nothing here
 * reads or writes outside itself, so every case drives the whole of it with no
 * connection, no place and no terminal.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";

import type { ListingHandles } from "../lib/shuttle/listing.ts";
import type { PiecePlace } from "../lib/shuttle/place.ts";
import { placeAtSpaceRoot } from "../lib/shuttle/place.ts";
import { ShuttleSession } from "../lib/shuttle/session.ts";
import { ArmedWatch } from "../lib/shuttle/watch.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;
const HANDLE = "of:fid1:abcdefghijklmnop";

/** Helper for the cases below, which is a table numbering `names`. */
function handles(...names: string[]): ListingHandles {
  return {
    place: placeAtSpaceRoot(SPACE),
    rows: names.map((name) => ({ name, kind: "value" as const })),
  };
}

/** What a watch a case armed was seen to do. */
interface Armed {
  /** The watch itself. */
  readonly watch: ArmedWatch;

  /** How many times its subscription has been cancelled. */
  cancels: () => number;
}

/**
 * Helper for the cases below, which is a watch on the cell `path` names,
 * already holding a subscription this case can see the cancel of.
 */
function armed(path: string): Armed {
  const place: PiecePlace = {
    position: { kind: "piece", space: SPACE, piece: HANDLE, path: [path] },
    scope: "space",
  };
  let cancelled = 0;
  const watch = new ArmedWatch({ place, input: false }, () => {}, () => 80);
  watch.holding(() => cancelled++);
  return { watch, cancels: () => cancelled };
}

describe("ShuttleSession", () => {
  describe("instance members", () => {
    describe("handles", () => {
      it("is nothing before a listing has run", () => {
        expect(new ShuttleSession().handles).toBeUndefined();
      });

      it("is what the last listing numbered", () => {
        const session = new ShuttleSession();
        const table = handles("title", "body");
        session.listed(table);
        expect(session.handles).toBe(table);
      });

      it("is the newest listing's, a listing resetting the numbering", () => {
        const session = new ShuttleSession();
        session.listed(handles("title"));
        session.listed(handles("topics"));
        expect(session.handles?.rows.map((row) => row.name))
          .toEqual(["topics"]);
      });

      it("survives a rendering that left lines behind", () => {
        // The two are reset by different lines, and this is the pair that
        // says so: a `get` past an `ls` takes over what `more` continues and
        // leaves `%3` naming the row the listing minted it for.

        const session = new ShuttleSession();
        session.listed(handles("title"));
        session.holding({ lines: ["a"] });
        expect(session.handles?.rows.map((row) => row.name))
          .toEqual(["title"]);
      });
    });

    describe("continuation", () => {
      it("is nothing before a rendering has run", () => {
        expect(new ShuttleSession().continuation).toBeUndefined();
      });

      it("is the lines a rendering left, in the order it composed them", () => {
        const session = new ShuttleSession();
        session.holding({ lines: ["a", "b"] });
        expect(session.continuation?.lines).toEqual(["a", "b"]);
      });

      it("carries the hint the rendering offered beside `more`", () => {
        const session = new ShuttleSession();
        session.holding({ lines: ["a"], hint: "--select narrows the read" });
        expect(session.continuation?.hint).toBe("--select narrows the read");
      });

      it("is nothing again once a rendering that fit whole has run", () => {
        // What stops `more` writing the tail of the line before last. A
        // rendering that fit says so by holding nothing, and the clearing is
        // that statement rather than an absence of one.

        const session = new ShuttleSession();
        session.holding({ lines: ["a"] });
        session.holding();
        expect(session.continuation).toBeUndefined();
      });

      it("survives a listing that numbered new rows", () => {
        // The other direction of the same split: numbering is reset by a
        // listing, and what `more` writes next is not.

        const session = new ShuttleSession();
        session.holding({ lines: ["a"] });
        session.listed(handles("title"));
        expect(session.continuation?.lines).toEqual(["a"]);
      });
    });
    describe("the warm set", () => {
      // What a start is remembered under is the whole of what decides which
      // piece runs, so the cases that matter are the ones where two warms
      // differ in one part of that key and are two pieces.

      it("says a piece nothing warmed has not been warmed", () => {
        expect(new ShuttleSession().hasWarmed("piece", "space")).toBe(false);
      });

      it("says a piece it recorded has been", () => {
        const session = new ShuttleSession();
        session.warmed("piece", "space");
        expect(session.hasWarmed("piece", "space")).toBe(true);
      });

      it("holds two pieces apart", () => {
        const session = new ShuttleSession();
        session.warmed("one", "space");
        expect(session.hasWarmed("two", "space")).toBe(false);
      });

      it("holds two scopes under one piece apart", () => {
        // The same id under two scopes is two documents, so a start under one
        // says nothing about the other.

        const session = new ShuttleSession();
        session.warmed("piece", "space");
        expect(session.hasWarmed("piece", "session")).toBe(false);
      });

      it("asks about the piece alone, whatever path reached it", () => {
        // What warms is a piece. The path an operand walked decided *which*
        // piece by being resolved, and by the time a start is recorded that
        // question is answered — so two lines writing two fields of one piece
        // ask one question and get one answer.

        const session = new ShuttleSession();
        session.warmed("piece", "space");
        expect(session.hasWarmed("piece", "space")).toBe(true);
      });

      it("survives a listing and a continuation, which reset the other two", () => {
        // A piece started stays started for the life of the process, so
        // nothing resets this one.

        const session = new ShuttleSession();
        session.warmed("piece", "space");
        session.listed(handles("title"));
        session.holding();
        expect(session.hasWarmed("piece", "space")).toBe(true);
      });
    });

    describe("the watches", () => {
      // A watch outlives the view that armed it, so the cases that matter are
      // the ones where something else about the session moved: only `unwatch`
      // and the run's end take one off.

      it("is empty before anything is armed", () => {
        expect(new ShuttleSession().watches).toEqual([]);
      });

      it("holds what was armed, in the order it was armed", () => {
        const session = new ShuttleSession();
        session.arm(armed("title").watch);
        session.arm(armed("body").watch);
        expect(session.watches.map((watch) => watch.label))
          .toEqual([`${HANDLE}/title @space`, `${HANDLE}/body @space`]);
      });

      it("survives a listing, a continuation and a warm", () => {
        const session = new ShuttleSession();
        session.arm(armed("title").watch);
        session.listed(handles("body"));
        session.holding({ lines: ["a"] });
        session.warmed("piece", "space");
        expect(session.watches.length).toBe(1);
      });

      describe("watching()", () => {
        it("returns the watch armed on the cell the key names", () => {
          const session = new ShuttleSession();
          const title = armed("title").watch;
          session.arm(title);
          expect(session.watching(title.key)).toBe(title);
        });

        it("returns nothing for a cell nothing is armed on", () => {
          const session = new ShuttleSession();
          session.arm(armed("title").watch);
          expect(session.watching(armed("body").watch.key)).toBeUndefined();
        });

        it("returns nothing for a watch that has been disarmed", () => {
          const session = new ShuttleSession();
          const title = armed("title").watch;
          session.arm(title);
          session.disarm(title);
          expect(session.watching(title.key)).toBeUndefined();
        });
      });

      describe("disarm()", () => {
        it("drops the watch and cancels its subscription", () => {
          // The two are one act, so there is no way to take a watch off the
          // list and leave its subscription running.

          const session = new ShuttleSession();
          const title = armed("title");
          session.arm(title.watch);
          const held = session.disarm(title.watch);
          expect({
            held,
            left: session.watches.length,
            cancels: title.cancels(),
          })
            .toEqual({ held: true, left: 0, cancels: 1 });
        });

        it("leaves every other watch armed", () => {
          const session = new ShuttleSession();
          const title = armed("title");
          const body = armed("body");
          session.arm(title.watch);
          session.arm(body.watch);
          session.disarm(title.watch);
          expect({
            left: session.watches.map((watch) => watch.label),
            cancels: body.cancels(),
          }).toEqual({ left: [`${HANDLE}/body @space`], cancels: 0 });
        });

        it("returns `false` for a watch this session was not holding", () => {
          const session = new ShuttleSession();
          const title = armed("title");
          expect(session.disarm(title.watch)).toBe(false);
          expect(title.cancels()).toBe(1);
        });
      });

      describe("disarmAll()", () => {
        it("cancels every watch and leaves none armed", () => {
          // What a run does on its way out: a subscription outliving the
          // connection it was taken over is a sink firing into a torn-down
          // runtime.

          const session = new ShuttleSession();
          const title = armed("title");
          const body = armed("body");
          session.arm(title.watch);
          session.arm(body.watch);
          session.disarmAll();
          expect({
            left: session.watches.length,
            cancels: [title.cancels(), body.cancels()],
          }).toEqual({ left: 0, cancels: [1, 1] });
        });

        it("disarms a watch armed after it, rather than holding one", () => {
          // The window between a subscription coming back and the session
          // adopting it. A line interrupted mid-`watch` is abandoned by the
          // prompt loop while its promise runs on, so the adoption can land
          // after the run has already torn every watch down — and a watch
          // held then is a sink over a closing connection that `watches`
          // cannot list and `unwatch` cannot name.
          //
          // Kills: arming unconditionally, which leaves the watch held and
          // its subscription running.

          const session = new ShuttleSession();
          const late = armed("late");
          session.disarmAll();
          session.arm(late.watch);
          expect({ left: session.watches.length, cancels: late.cancels() })
            .toEqual({ left: 0, cancels: 1 });
        });

        it("cancels nothing twice where a watch was already disarmed", () => {
          const session = new ShuttleSession();
          const title = armed("title");
          session.arm(title.watch);
          session.disarm(title.watch);
          session.disarmAll();
          expect(title.cancels()).toBe(1);
        });
      });
    });
  });
});
