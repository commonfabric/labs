/**
 * Tests for the display fit's atom-level helpers: whether one atom sits under
 * a render policy's ceiling, and the clauses a label view holds; and for the
 * label sources it reads for a cell.
 */

import { assertEquals } from "@std/assert";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { cfcLabelViewSourceForCell } from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { test } from "@commonfabric/test-support/test";
import {
  canRenderConfidentialityAtom,
  cellLabelSources,
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

test("display fit - canRenderConfidentialityAtom", async (t) => {
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

test("display fit - confidentialityLabels", async (t) => {
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

test("display fit - cellLabelSources", async (t) => {
  const signer = await Identity.fromPassphrase("display fit label sources");
  const space = signer.did();
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  try {
    const tx = runtime.edit();
    const plain = runtime.getCell(space, "plain", undefined, tx);
    plain.setRaw({ note: "hello" });
    const holder = runtime.getCell(space, "holder", undefined, tx);
    holder.setRaw(plain.getAsLink());
    const loopA = runtime.getCell(space, "loop-a", undefined, tx);
    const loopB = runtime.getCell(space, "loop-b", undefined, tx);
    loopA.setRaw(loopB.getAsLink());
    loopB.setRaw(loopA.getAsLink());
    await tx.commit().settled;

    await t.step(
      "reads only the cell's own label where it resolves to itself",
      () => {
        const cell = plain.withTx(undefined);
        assertEquals(cellLabelSources(cell), [cfcLabelViewSourceForCell(cell)]);
      },
    );

    await t.step("adds the target's label where the cell holds a link", () => {
      const cell = holder.withTx(undefined);
      assertEquals(cellLabelSources(cell), [
        cfcLabelViewSourceForCell(cell),
        cfcLabelViewSourceForCell(plain.withTx(undefined)),
      ]);
    });

    await t.step("reads none where the cell's links cannot be resolved", () => {
      assertEquals(cellLabelSources(loopA.withTx(undefined)), undefined);
    });
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
