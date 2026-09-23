import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { formatMemWriteTrace } from "./memwrite-trace.ts";

const vhashOf = (line: string) => line.match(/vhash=(\S+)/)?.[1];

describe("memwrite-trace", () => {
  describe("formatMemWriteTrace", () => {
    it("tags the connection and includes op/id/scope/vhash/paths", () => {
      const line = formatMemWriteTrace(
        { op: "set", id: "of:fid1:abc", scope: "space", value: { x: 1 } },
        3,
        false,
      );
      expect(line).toContain("c=3");
      expect(line).toContain("op=set");
      expect(line).toContain("vhash=");
      expect(line).toContain("paths=[]");
    });

    it("renders vhash as a fixed-length base64url prefix of the canonical hash", () => {
      const line = formatMemWriteTrace(
        { op: "set", id: "i", scope: "space", value: { x: 1 } },
        1,
        false,
      );
      // 12-char base64url display form; the full canonical hash is the source
      // of truth, this is only its truncation.
      expect(vhashOf(line)).toMatch(/^[A-Za-z0-9_-]{12}$/);
    });

    it("omits raw values by default and includes them only when asked", () => {
      const op = {
        op: "set",
        id: "i",
        scope: "space",
        value: { secret: "shh" },
      };
      const hashed = formatMemWriteTrace(op, 1, false);
      expect(hashed).not.toContain("val=");
      expect(hashed).not.toContain("shh"); // raw value never leaks by default
      const withValues = formatMemWriteTrace(op, 1, true);
      expect(withValues).toContain("val=");
      expect(withValues).toContain("shh");
    });

    it("hashes patch values (where op.value is absent) and extracts paths", () => {
      const op = {
        op: "patch",
        id: "i",
        scope: "space",
        patches: [{ path: "/a", value: 1 }, { path: "/b", value: 2 }],
      };
      const line = formatMemWriteTrace(op, 2, false);
      expect(line).toContain("paths=[/a,/b]");
      expect(line).not.toContain("vhash=--------"); // a value is present
    });

    it("marks a value-less op (e.g. delete) with the empty-hash sentinel", () => {
      const line = formatMemWriteTrace(
        { op: "delete", id: "i", scope: "space" },
        1,
        false,
      );
      expect(line).toContain("vhash=--------");
    });

    it("hashes equal content equally regardless of key order", () => {
      // The property the storm investigation leans on: two writes with the same
      // content get the same vhash, so a *different* vhash means a genuinely
      // divergent value, not just reordered keys.
      const a = formatMemWriteTrace(
        { op: "set", id: "i", scope: "space", value: { x: 1, y: 2 } },
        1,
        false,
      );
      const b = formatMemWriteTrace(
        { op: "set", id: "i", scope: "space", value: { y: 2, x: 1 } },
        1,
        false,
      );
      expect(vhashOf(a)).toBe(vhashOf(b));
    });

    //
    // Why the canonical hash, not a JSON round-trip
    //
    // The reason for using the canonical `FabricValue` hash over a JSON
    // round-trip: a JSON-derived hash collapses values that the runtime treats
    // as distinct, so the trace would report a false "same value" and hide a
    // real divergence.
    //

    it("distinguishes values a JSON round-trip would collapse (undefined fields)", () => {
      // `JSON.stringify` drops `undefined`-valued keys, so both would serialize
      // to `{}`; the canonical hash keys on the present `a` field.
      const withUndef = formatMemWriteTrace(
        { op: "set", id: "i", scope: "space", value: { a: undefined } },
        1,
        false,
      );
      const empty = formatMemWriteTrace(
        { op: "set", id: "i", scope: "space", value: {} },
        1,
        false,
      );
      expect(vhashOf(withUndef)).not.toBe(vhashOf(empty));
    });

    it("distinguishes values a JSON round-trip would collapse (non-finite numbers)", () => {
      // `JSON.stringify(Infinity)` is `null`, so a JSON hash can't tell these
      // apart; the canonical number encoding can.
      const inf = formatMemWriteTrace(
        { op: "set", id: "i", scope: "space", value: { n: Infinity } },
        1,
        false,
      );
      const nul = formatMemWriteTrace(
        { op: "set", id: "i", scope: "space", value: { n: null } },
        1,
        false,
      );
      expect(vhashOf(inf)).not.toBe(vhashOf(nul));
    });

    //
    // When the hasher refuses
    //
    // The cost of that choice, rather than a reason for it: a value the
    // canonical hasher cannot encode must not take the rest of the commit's
    // ops down with it.
    //

    it("never throws on a value the canonical hasher rejects", () => {
      // Not expected for a real FabricValue, but the trace must stay alive: a
      // value the hasher can't encode (here, a function) yields a sentinel
      // rather than an exception that would abort the rest of the commit's ops.
      const line = formatMemWriteTrace(
        // @ts-expect-error A function is not a `FabricValue`.
        { op: "set", id: "i", scope: "space", value: { fn: () => {} } },
        1,
        false,
      );
      expect(line).toContain("vhash=<unhashable>");
    });
  });
});
