/**
 * Tests for the display fit's atom-level helpers: whether one atom sits under
 * a render policy's ceiling, and the clauses a label view holds.
 */

import { assertEquals } from "@std/assert";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  canRenderConfidentialityAtom,
  confidentialityLabels,
} from "../src/worker/display-fit.ts";
import type { RenderPolicy } from "../src/worker/types.ts";

const secret = cfcAtom.builtin("secret");
const other = cfcAtom.builtin("other");
const caveat = cfcAtom.caveat("derived-from", cfcAtom.builtin("source"));

/** A render policy with nothing declassified and the given bounds. */
const policyWith = (bounds: Partial<RenderPolicy>): RenderPolicy => ({
  declassifyConfidentiality: [],
  ...bounds,
});

Deno.test("display fit - canRenderConfidentialityAtom", async (t) => {
  await t.step("admits any atom where no ceiling is active", () => {
    assertEquals(canRenderConfidentialityAtom(secret, policyWith({})), true);
  });

  await t.step("admits an atom the ceiling lists, and no other", () => {
    const policy = policyWith({ maxConfidentiality: [secret] });
    assertEquals(canRenderConfidentialityAtom(secret, policy), true);
    assertEquals(canRenderConfidentialityAtom(other, policy), false);
  });

  await t.step("admits a caveat only of a kind the allowance lists", () => {
    assertEquals(
      canRenderConfidentialityAtom(
        caveat,
        policyWith({
          maxConfidentiality: [],
          caveatKindAllow: ["derived-from"],
        }),
      ),
      true,
    );
    assertEquals(
      canRenderConfidentialityAtom(
        caveat,
        policyWith({
          maxConfidentiality: [],
          caveatKindAllow: ["other-kind"],
        }),
      ),
      false,
    );
    assertEquals(
      canRenderConfidentialityAtom(
        caveat,
        policyWith({ maxConfidentiality: [] }),
      ),
      false,
    );
  });
});

Deno.test("display fit - confidentialityLabels", async (t) => {
  await t.step("collects every entry's clauses once, at any path", () => {
    assertEquals(
      confidentialityLabels({
        version: 1,
        entries: [
          { path: [], label: { confidentiality: [secret] } },
          { path: ["a"], label: { confidentiality: [secret, other] } },
          { path: ["b"], label: { integrity: [other] } },
        ],
      }),
      [secret, other],
    );
  });
});
