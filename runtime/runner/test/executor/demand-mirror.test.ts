import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type {
  DemandedInstanceRow,
  SessionDemand,
} from "@commonfabric/memory/v2/server";

import { DemandMirror } from "../../src/executor/demand-mirror.ts";

/** A space-scoped row of `sessionId` for `id`, demanded by `principal`. */
const row = (
  id: string,
  sessionId: string,
  options: { root?: boolean; principal?: string } = {},
): DemandedInstanceRow => ({
  id,
  scope: "space",
  scopeKey: "space",
  identity: {
    ...(options.principal === undefined
      ? {}
      : { principal: options.principal }),
    sessionId,
  },
  root: options.root ?? false,
});

/** A session's share holding `rows`, keyed as the memory server keys them. */
const share = (
  sessionId: string,
  rows: DemandedInstanceRow[],
): SessionDemand => ({
  sessionId,
  rows: new Map(rows.map((entry) => [`space\0${entry.id}`, entry])),
});

describe("DemandMirror", () => {
  describe("instance members", () => {
    describe("update()", () => {
      it("returns every key of a first read", () => {
        const mirror = new DemandMirror();

        const changed = mirror.update([
          share("s1", [row("of:a", "s1"), row("of:b", "s1")]),
          share("s2", [row("of:b", "s2")]),
        ]);

        expect([...changed].toSorted()).toEqual(["space\0of:a", "space\0of:b"]);
        expect(mirror.rowCount).toBe(3);
      });

      it("returns no key for a read handing back the objects it holds", () => {
        const mirror = new DemandMirror();
        const first = share("s1", [row("of:a", "s1")]);
        const second = share("s2", [row("of:b", "s2")]);
        mirror.update([first, second]);

        expect([...mirror.update([first, second])]).toEqual([]);
        expect(mirror.rowCount).toBe(2);
      });

      it("returns no key for a rebuilt session whose rows are equal", () => {
        const mirror = new DemandMirror();
        mirror.update([share("s1", [row("of:a", "s1", { principal: "p" })])]);

        const changed = mirror.update([
          share("s1", [row("of:a", "s1", { principal: "p" })]),
        ]);

        expect([...changed]).toEqual([]);
      });

      it("returns the keys a rebuilt session added and removed", () => {
        const mirror = new DemandMirror();
        mirror.update([
          share("s1", [row("of:a", "s1"), row("of:b", "s1")]),
          share("s2", [row("of:b", "s2")]),
        ]);

        const changed = mirror.update([
          share("s1", [row("of:b", "s1"), row("of:c", "s1")]),
          share("s2", [row("of:b", "s2")]),
        ]);

        expect([...changed].toSorted()).toEqual(["space\0of:a", "space\0of:c"]);
        expect(mirror.rowsFor("space\0of:a")).toBeUndefined();
        expect([...mirror.rowsFor("space\0of:c")!.keys()]).toEqual(["s1"]);
        expect(mirror.rowCount).toBe(3);
      });

      it("returns a key whose row changed its root mark or its principal", () => {
        const mirror = new DemandMirror();
        mirror.update([
          share("s1", [row("of:a", "s1"), row("of:b", "s1")]),
        ]);

        const changed = mirror.update([
          share("s1", [
            row("of:a", "s1", { root: true }),
            row("of:b", "s1", { principal: "p" }),
          ]),
        ]);

        expect([...changed].toSorted()).toEqual(["space\0of:a", "space\0of:b"]);
        expect(mirror.rowsFor("space\0of:a")!.get("s1")!.root).toBe(true);
        expect(
          mirror.rowsFor("space\0of:b")!.get("s1")!.identity?.principal,
        ).toBe("p");
      });

      it("returns every key of a session absent from the read", () => {
        const mirror = new DemandMirror();
        const kept = share("s2", [row("of:b", "s2")]);
        mirror.update([
          share("s1", [row("of:a", "s1"), row("of:b", "s1")]),
          kept,
        ]);

        const changed = mirror.update([kept]);

        expect([...changed].toSorted()).toEqual(["space\0of:a", "space\0of:b"]);
        expect(mirror.rowsFor("space\0of:a")).toBeUndefined();
        expect([...mirror.rowsFor("space\0of:b")!.keys()]).toEqual(["s2"]);
        expect(mirror.rowCount).toBe(1);
      });
    });

    describe("keys()", () => {
      it("returns the keys at least one session demands", () => {
        const mirror = new DemandMirror();
        mirror.update([
          share("s1", [row("of:a", "s1")]),
          share("s2", [row("of:a", "s2"), row("of:b", "s2")]),
        ]);
        mirror.update([share("s1", [row("of:a", "s1")])]);

        expect([...mirror.keys()]).toEqual(["space\0of:a"]);
      });
    });

    describe("clear()", () => {
      it("returns every key again from the read after it", () => {
        const mirror = new DemandMirror();
        const held = share("s1", [row("of:a", "s1")]);
        mirror.update([held]);

        mirror.clear();

        expect(mirror.rowCount).toBe(0);
        expect([...mirror.update([held])]).toEqual(["space\0of:a"]);
      });
    });
  });
});
