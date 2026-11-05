/**
 * Unit tests for what a `%n` operand names: the row a listing numbered, and
 * the place that listing was read at.
 *
 * The claims divide in two. One is about the spelling — which tokens are a
 * handle at all — and it is closed by the digits: a listing prints `%3` and
 * nothing else, so every other spelling names no row. The other is about the
 * lookup, and what it turns on is that the row and the place come back
 * together, since a row's name is a name inside a place and neither alone
 * names a cell.
 *
 * Nothing here reads or walks, so every case drives the whole of it with no
 * connection and no fabric.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { MemorySpace } from "@commonfabric/memory/interface";

import { resolveHandle } from "../lib/shuttle/handles.ts";
import type { ListingHandles, ListingRow } from "../lib/shuttle/listing.ts";
import { placeAtSpaceRoot } from "../lib/shuttle/place.ts";

const SPACE = "did:key:z6MkConnectedSpace" as MemorySpace;

/** Helper for the cases below, which is the place a listing was read at. */
const AT = placeAtSpaceRoot(SPACE);

/** Helper for the cases below, which is a listing numbering `rows`. */
function listed(...rows: ListingRow[]): ListingHandles {
  return { place: AT, rows };
}

/** Helper for the cases below, which is one row called `name`. */
function row(name: string, kind: ListingRow["kind"] = "value"): ListingRow {
  return { name, kind, operand: name };
}

/**
 * Helper for the cases below, which is the row a reading found, and the reason
 * where it found none.
 */
function found(reading: ReturnType<typeof resolveHandle>): unknown {
  return reading.kind === "row" ? reading.row.name : reading.reason;
}

describe("handles", () => {
  describe("resolveHandle()", () => {
    it("returns the row the number names, counting from one", () => {
      const reading = resolveHandle(listed(row("a"), row("b")), "%2");
      expect(found(reading)).toBe("b");
    });

    it("returns the place the listing was read at, beside the row", () => {
      // The pair is what makes a handle a bound reference rather than a row
      // number: a row's name is a name inside that place, so a reading
      // carrying one and not the other names nothing.

      const reading = resolveHandle(listed(row("a")), "%1");
      expect(reading.kind === "row" ? reading.at : undefined).toEqual(AT);
    });

    it("returns a row the listing offered no operand for, rather than refusing", () => {
      // Whether a row is somewhere to stand is the asking verb's question. A
      // callable is a row `cd` has nothing to walk to and `call` invokes, so
      // the lookup hands it over and says nothing about it.

      const reading = resolveHandle(
        listed({ name: "search", kind: "callable" }),
        "%1",
      );
      expect(reading.kind === "row" ? reading.row.kind : undefined)
        .toBe("callable");
    });

    it("refuses a token whose digits name no number a listing prints", () => {
      expect(found(resolveHandle(listed(row("a")), "%3x"))).toBe(
        "`%3x` names no handle. A handle is `%` and the number a listing " +
          "printed beside a row, as in `%3`.",
      );
    });

    it("refuses a leading-zero spelling, which is no number a listing printed", () => {
      // `%03` and `%3` would name one row, and a listing prints one of them.
      // Reading both would make the printed handle one spelling of several
      // rather than the thing a person read off the screen.

      expect(found(resolveHandle(listed(row("a"), row("b"), row("c")), "%03")))
        .toBe(
          "`%03` names no handle. A handle is `%` and the number a listing " +
            "printed beside a row, as in `%3`.",
        );
    });

    it("refuses the sigil on its own", () => {
      expect(found(resolveHandle(listed(row("a")), "%"))).toBe(
        "`%` names no handle. A handle is `%` and the number a listing " +
          "printed beside a row, as in `%3`.",
      );
    });

    it("refuses a token that does not open with the sigil at all", () => {
      // The operand grammar never hands one over — it reads the sigil at the
      // head of an operand and nowhere else — but this is a door of its own,
      // and a bare number reaching it would otherwise be read as the row of
      // that name with its first digit taken for the sigil.

      expect(found(resolveHandle(listed(row("a"), row("b"), row("c")), "33")))
        .toBe(
          "`33` names no handle. A handle is `%` and the number a listing " +
            "printed beside a row, as in `%3`.",
        );
    });

    it("refuses a number where no listing has numbered a row", () => {
      expect(found(resolveHandle(undefined, "%1"))).toBe(
        "`%1` names no row: no listing has numbered one yet. `ls` lists what " +
          "stands here and numbers what it lists.",
      );
    });

    it("refuses a number past the last row, naming the range there is", () => {
      expect(found(resolveHandle(listed(row("a"), row("b")), "%3"))).toBe(
        "`%3` names no row: the listing numbered `%1` to `%2`.",
      );
    });

    it("refuses a number where the listing numbered nothing, saying so", () => {
      // A range is what a person checks their number against, and `%1` to
      // `%0` is no range. An empty listing is told apart from a number past
      // the end because the two are different mistakes.

      expect(found(resolveHandle(listed(), "%1"))).toBe(
        "`%1` names no row: the listing numbered none.",
      );
    });
  });
});
