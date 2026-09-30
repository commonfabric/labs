/**
 * Unit tests for `isLegacyInjectedEnvelope` (CT-1838).
 *
 * Pre-#4158 pipelines persisted the helper-INJECTED pretransform form as the
 * source-of-record; the predicate byte-recognizes that envelope so the
 * runner's cold-load path can tolerate verified stored input without
 * weakening the authoring guard.
 *
 * The primary corpus sample is REAL: `corpus/legacy-envelope/
 * backlinks-index.stored.tsx.txt` is the byte-exact `code` field of a
 * poisoned `pattern:<identity>` source doc dumped read-only from the
 * production space that motivated CT-1838 (entry
 * `/api/patterns/system/backlinks-index.tsx`, identity
 * `7gWylhLo9YPt_8tNAfO7en-niMW3N5bj-SedSdlVl5U`). The vendored history that
 * WROTE that poison is grafted away, so this dump — not a reconstruction —
 * is what calibrates the predicate against history. Do not regenerate it
 * from current constants.
 *
 * NOTE: the export name and home of `isLegacyInjectedEnvelope`
 * (cf-helpers.ts) are a compatibility contract with downstream vendoring
 * gates; these tests double as the seam's regression pin.
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  injectCfHelpers,
  isLegacyInjectedEnvelope,
} from "../../src/core/cf-helpers.ts";

const REAL_DUMP = await Deno.readTextFile(
  new URL(
    "../corpus/legacy-envelope/backlinks-index.stored.tsx.txt",
    import.meta.url,
  ),
);

const HELPERS_STMT = 'import { __cfHelpers } from "commonfabric";';
const TS_TRAILER = "// @ts-ignore: Internals\n" +
  "function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }\n";
const JS_TRAILER = "// @ts-ignore: Internals\n" +
  "function h(...args) { return __cfHelpers.h.apply(null, args); }\n";

Deno.test("real poisoned production doc: shape assumptions hold byte-exactly", () => {
  // First line is exactly HELPERS_STMT.
  assertEquals(REAL_DUMP.split("\n")[0], HELPERS_STMT);
  // Trailer is "\n" + HELPERS_USED_STMT, INCLUDING the used-stmt's own
  // trailing newline — i.e. the doc ends with a newline, and the join("\n")
  // of [stmt, source, trailer] leaves a blank line between the authored
  // source's last line and the trailer comment.
  assert(REAL_DUMP.endsWith("\n" + TS_TRAILER));
  assert(REAL_DUMP.includes(";\n\n// @ts-ignore: Internals\nfunction h("));
});

Deno.test("accepts the real poisoned production doc", () => {
  assert(isLegacyInjectedEnvelope(REAL_DUMP));
});

Deno.test("accepts the real doc with the final newline stripped", () => {
  assert(REAL_DUMP.endsWith("\n"));
  assert(isLegacyInjectedEnvelope(REAL_DUMP.slice(0, -1)));
});

Deno.test("round-trip: injectCfHelpers output is recognized (ts and js)", () => {
  const authored = 'import { pattern } from "commonfabric";\n' +
    "export default pattern<{ v: number }>(({ v }) => ({ v }));\n";
  assert(isLegacyInjectedEnvelope(injectCfHelpers(authored, "/main.tsx")));
  const authoredJs = 'import { pattern } from "commonfabric";\n' +
    "export default pattern(({ v }) => ({ v }));\n";
  assert(isLegacyInjectedEnvelope(injectCfHelpers(authoredJs, "/main.jsx")));
});

Deno.test("accepts a hand-built envelope with the JS trailer", () => {
  const doc = HELPERS_STMT + "\n" + "export const x = 1;\n" + "\n" +
    JS_TRAILER;
  assert(isLegacyInjectedEnvelope(doc));
  assert(isLegacyInjectedEnvelope(doc.slice(0, -1)));
});

Deno.test("rejects authored source without the envelope", () => {
  assertFalse(isLegacyInjectedEnvelope(
    'import { pattern } from "commonfabric";\nexport default 1;\n',
  ));
});

Deno.test("rejects when the helper import is not on line 1", () => {
  assertFalse(isLegacyInjectedEnvelope("\n" + REAL_DUMP));
  assertFalse(isLegacyInjectedEnvelope("// hi\n" + REAL_DUMP));
  assertFalse(isLegacyInjectedEnvelope(" " + REAL_DUMP));
});

Deno.test("rejects a tampered trailer", () => {
  // Flip one byte in the trailer body.
  assertFalse(
    isLegacyInjectedEnvelope(REAL_DUMP.slice(0, -3) + "X}\n"),
  );
  // Trailing junk after the trailer.
  assertFalse(isLegacyInjectedEnvelope(REAL_DUMP + "\n// extra\n"));
});

Deno.test("rejects prefix-only and trailer-only documents", () => {
  assertFalse(isLegacyInjectedEnvelope(HELPERS_STMT + "\n"));
  assertFalse(isLegacyInjectedEnvelope("\n" + TS_TRAILER));
  // Degenerate: too short for prefix + trailer to coexist without overlap.
  assertFalse(isLegacyInjectedEnvelope(HELPERS_STMT + "\n" + "x"));
});

Deno.test("accepts the minimal legal envelope (empty authored body)", () => {
  // injectCfHelpers("") === [stmt, "", trailer].join("\n")
  assert(isLegacyInjectedEnvelope(injectCfHelpers("", "/main.tsx")));
});

Deno.test("interior __cfHelpers inside a VALID envelope matches (chosen behavior)", () => {
  // Prefix+suffix only, deliberately: `__cfHelpers` grants nothing beyond
  // what injection gives every pattern, and the runner applies tolerance
  // only to Merkle-verified stored input. Pinned so the behavior is chosen,
  // not accidental (appendix T4/L1-7).
  const doc = HELPERS_STMT + "\n" +
    "const also = __cfHelpers;\nexport const x = 1;\n" + "\n" + TS_TRAILER;
  assert(isLegacyInjectedEnvelope(doc));
});

Deno.test("interior __cfHelpers WITHOUT the envelope does not match", () => {
  assertFalse(isLegacyInjectedEnvelope(
    "const steal = __cfHelpers;\nexport const x = 1;\n",
  ));
});

Deno.test("the fallback-shim trailer for sources binding `h` at top level is not a legacy envelope", () => {
  // Such sources get the shim under the name `__cfHelpersShim`; that form
  // postdates #4158 and is never persisted, so the detector must not widen
  // to it.
  const authored = "export const h = [1];\nexport default h;\n";
  for (
    const [fileName, head] of [
      ["/main.tsx", "function __cfHelpersShim(...args: any[])"],
      ["/main.jsx", "function __cfHelpersShim(...args)"],
    ]
  ) {
    const injected = injectCfHelpers(authored, fileName);
    assert(injected.includes(head), fileName);
    assertFalse(isLegacyInjectedEnvelope(injected), fileName);
  }
});
