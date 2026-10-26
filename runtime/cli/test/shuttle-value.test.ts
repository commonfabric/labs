/**
 * Unit tests for how a value the fabric holds is written for a reader.
 *
 * Two verbs write one and each wants a different bound on it, so the cases
 * here drive the writer directly rather than through either: what is under
 * test is the form, and which verb asks for which bound is asked where that
 * verb is.
 *
 * The values are the ones a cell actually takes. The fabric's admission test
 * (`assertValidFabricValueLayer`) is what says which those are, so a case
 * reaching for a function or a unique symbol is reaching past what a read can
 * return, and says so where it does.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { UI } from "@commonfabric/runner";

import { safeStringify } from "../lib/render.ts";
import { renderValue } from "../lib/shuttle/value.ts";

describe("value", () => {
  describe("renderValue()", () => {
    it("returns indented JSON", () => {
      expect(renderValue({ title: "a" })).toBe('{\n  "title": "a"\n}');
    });

    it("returns `undefined` for a value nothing else can be written for", () => {
      // `JSON.stringify` returns no string at all for it, so a value the
      // fabric does not hold would otherwise print as nothing and read as a
      // line that produced none.

      expect(renderValue(undefined)).toBe("undefined");
    });

    it("returns a value's acted-on characters as the escapes JSON spells them with", () => {
      // `JSON.stringify` finishes C0 and leaves `DEL` and every C1 character
      // as it found them, so those are what is left to escape. The convention
      // is JSON's own rather than the glyphs a message gets, because this is a
      // value somebody may parse or paste rather than prose they read.

      expect(renderValue({ title: "a\u007fb\u009bc\u001bd" }))
        .toBe('{\n  "title": "a\\u007fb\\u009bc\\u001bd"\n}');
    });

    it("returns a value holding no acted-on character unchanged", () => {
      expect(renderValue({ title: "a b" })).toBe('{\n  "title": "a b"\n}');
    });

    it("leaves the line breaks the writer laid the value out with", () => {
      // A line feed still standing raw in that output is the pretty printer's
      // own formatting, because every C0 character a value held is escaped
      // before this sees it. Escaping it would fold the value onto one line.

      expect(renderValue({ a: 1, b: 2 })).toBe('{\n  "a": 1,\n  "b": 2\n}');
    });

    it("returns a line break inside a value as the escape, not as a break", () => {
      // The other side of the boundary the case above draws, and the two
      // together are the whole rule: the writer's own breaks are layout and
      // stay breaks, and a break the value holds is content, which is two
      // characters by the time this sees it — so the row it is written on is
      // still one row.

      expect(renderValue({ a: "x\ny" })).toBe('{\n  "a": "x\\ny"\n}');
    });

    it("returns a rendering that still parses back to the value it was", () => {
      // What the convention buys: the output is JSON, and reading it back
      // gives what the fabric held rather than what the escaping did to it.

      const held = { title: "a\u007fb\u009bc", nested: [1, "d\u0000e"] };
      const printed = renderValue(held);
      expect(/\p{Cc}/u.test(printed.replaceAll("\n", ""))).toBe(false);
      expect(JSON.parse(printed)).toEqual(held);
    });

    it("names the kind of a value JSON has no form for, rather than the word", () => {
      // `JSON.stringify` returns no string for a symbol and for a function
      // exactly as it does for `undefined`, and without throwing, so a reader
      // told `undefined` would be told the cell was empty when it is not —
      // and the caller would hand a non-string to the terminal, which ends the
      // session on the first one of these.
      //
      // The symbol is registry-interned because that is the kind a cell
      // takes: the fabric's admission test refuses a unique one
      // (`assertValidFabricValueLayer`). The function is the other side of
      // that same test, refused on the way in and so unreachable from a read
      // — it is here because the parameter is `unknown` and what a wrong
      // answer costs is the session.

      for (
        const [value, kind] of [
          [Symbol.for("cf.shuttle.written"), "symbol"],
          [() => {}, "function"],
        ] as const
      ) {
        expect(renderValue(value))
          .toBe(`The value is a ${kind}, which JSON has no way to write.`);
      }
    });

    it("drops a nested value JSON has no form for, and says nothing", () => {
      // The bound the doc comment on `renderValue` names, pinned so that it
      // is a measured property rather than a claim. A cell takes each of
      // these and hands it back: the fabric's admission test accepts
      // `undefined`, an array's hole, and a registry-interned symbol. What
      // JSON does to them differs by position, and the array is the worse
      // half — a key that vanishes reads as a key the fabric does not hold,
      // but an element rewritten to `null` reads as a value the fabric holds.

      const holed: (number | undefined)[] = [1, 2, 3];
      delete holed[1];

      for (
        const [held, printed] of [
          [{ a: 1, b: undefined }, '{\n  "a": 1\n}'],
          [{ a: 1, b: Symbol.for("cf.shuttle.nested") }, '{\n  "a": 1\n}'],
          [[1, undefined, 3], "[\n  1,\n  null,\n  3\n]"],
          [holed, "[\n  1,\n  null,\n  3\n]"],
        ] as const
      ) {
        expect(renderValue(held)).toBe(printed);
      }
    });

    it("returns a `bigint` the way `cf cell get` writes one", () => {
      // A `bigint` is a value a cell holds — it survives a cold replica in
      // the runner's `action-result-fabric-values.test.ts` — and the writer
      // throws on one rather than declining it, so with no arm for it a
      // reader is answered with the engine's own message.
      //
      // The form belongs to `cf cell get`, so this asks that printer for it
      // instead of restating its spelling: a change to either side reds here
      // rather than letting one question acquire two answers. The literal
      // below is what stops both sides drifting together.

      for (const held of [{ a: 1, b: 2n }, 9007199254740993n]) {
        expect(renderValue(held)).toBe(safeStringify(held));
      }
      expect(renderValue({ a: 1, b: 2n }))
        .toBe('{\n  "a": 1,\n  "b": {\n    "$bigint": "2"\n  }\n}');
    });

    it("raises what the writer raises for a value it cannot walk at all", () => {
      // A cycle is not something the writer can take. What a caller does
      // about it is the caller's — the prompt answers the line and reads the
      // next one — and what this pins is that the failure arrives as one.

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      expect(() => renderValue(cyclic)).toThrow("circular");
    });

    describe("the `$UI` node", () => {
      // A piece's rendering is a vnode tree with data URIs in it, hundreds of
      // lines wide, and it is the piece's picture of itself rather than state
      // to debug at this layer. The key is the runner's own rather than a
      // second spelling of it, so a fixture and the writer that meets it
      // cannot drift apart while both look right.

      it("returns a marker in place of it by default", () => {
        expect(renderValue({ [UI]: { type: "vnode" }, title: "a" })).toBe(
          `{\n  "${UI}": "<elided — \`get --select '$UI'\` reads it>",\n` +
            `  "title": "a"\n}`,
        );
      });

      it("returns the node itself where the rendering asks for it", () => {
        expect(renderValue({ [UI]: { type: "vnode" } }, { ui: true }))
          .toBe(`{\n  "${UI}": {\n    "type": "vnode"\n  }\n}`);
      });

      it("returns a marker for one nested under another key", () => {
        // A piece reached through a key carries its own rendering, so the
        // node is not only a key of the result's root. Standing in for it
        // wherever it sits is what bounds a read of a piece holding pieces.

        expect(renderValue({ topics: [{ [UI]: { type: "vnode" } }] }))
          .toContain("<elided");
      });

      it("returns the node whole where it is the value read", () => {
        // The elision is per key, so a read aimed at the node itself is a
        // read of a value with no such key in it and is written out. That is
        // what keeps the node reachable rather than merely narrower.

        expect(renderValue({ type: "vnode" }))
          .toBe('{\n  "type": "vnode"\n}');
      });

      it("returns a key of the same name in an ordinary object as a marker too", () => {
        // The bound the elision has and the doc comment states: it is a rule
        // about the key rather than about the piece, so a stored object
        // carrying that name is stood in for as well. Nothing distinguishes
        // the two in a read value, and a rule that guessed would guess wrong
        // in one direction or the other.

        expect(renderValue({ [UI]: "not a vnode" })).toContain("<elided");
      });
    });
  });
});
