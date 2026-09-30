import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import type { CellScope, JSONSchema } from "../src/builder/types.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-reference-scope");
const space = signer.did();
const approved = "approved";
const floor = {
  type: "object",
  properties: {
    selected: { type: "string", ifc: { requiredIntegrity: [approved] } },
  },
} as const satisfies JSONSchema;

describe("cfc-reference-scope", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;
  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager: storage,
      apiUrl: new URL("https://example.com"),
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
    });
  });
  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  const seed = async (
    name: string,
    value: FabricValue,
    scope: CellScope = "space",
    entries: LabelMapEntry[] = [],
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, name, undefined, tx, scope);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    return cell.withTx(undefined);
  };

  const scopedChain = async () => {
    const session = await seed("session", "private session", "session", [{
      path: [],
      observes: "value",
      label: { integrity: [approved] },
    }]);
    return await seed("holder", session.getAsLink(), "space", [{
      path: [],
      origin: "link",
      observes: "followRef",
      referenceAcquisition: "complete",
      label: {},
    }]);
  };

  it("refuses direct cell and sigil writes that discard a retained scope cap", async () => {
    const holder = await scopedChain();
    const capped = holder.asSchema({ type: "string", scope: "space" })
      .asSchema({ type: "string", scope: "session" });
    expect(capped.get()).toBeUndefined();
    for (const value of [capped, capped.getAsLink({ includeSchema: true })]) {
      const tx = runtime.edit();
      const output = runtime.getCell(space, "output", undefined, tx);
      expect(() => output.set(value)).toThrow(
        "scope cap cannot be widened for storage",
      );
      tx.abort();
    }
    const tx = runtime.edit();
    const output = runtime.getCell(space, "safe-output", undefined, tx);
    output.set(holder.asSchema({ type: "string", scope: "space" }));
    expect((await tx.commit()).error).toBeUndefined();
    expect(output.withTx(undefined).get()).toBeUndefined();
    expect(holder.asSchema({ type: "string", scope: "session" }).get())
      .toBe("private session");
  });

  it("does not use scope-blocked content as linked write-floor evidence", async () => {
    const holder = await scopedChain();
    for (const scope of ["space", "session"] as const) {
      const tx = runtime.edit();
      const capped = holder.asSchema({ type: "string", scope });
      runtime.getCell(space, `floor-${scope}`, floor, tx).set({
        selected: capped,
      });
      const result = await tx.commit();
      if (scope === "space") {
        expect(result.error?.message).toContain(
          "linked content evidence is unavailable",
        );
      } else {
        expect(result.error).toBeUndefined();
      }
    }
  });

  it("projects child schema caps when a floor is below the receiving link", async () => {
    const holder = await scopedChain();
    const object = await seed(
      "object",
      { selected: holder.getAsLink() },
      "space",
      [{
        path: ["selected"],
        origin: "link",
        observes: "followRef",
        referenceAcquisition: "complete",
        label: {},
      }],
    );
    for (const scope of ["space", "session"] as const) {
      const tx = runtime.edit();
      const projected = object.asSchema({
        type: "object",
        properties: { selected: { type: "string", scope } },
      });
      runtime.getCell(space, `nested-floor-${scope}`, floor, tx).set(projected);
      const result = await tx.commit();
      if (scope === "space") {
        expect(result.error?.message).toContain(
          "linked content evidence is unavailable",
        );
      } else {
        expect(result.error).toBeUndefined();
      }
    }
  });
});
