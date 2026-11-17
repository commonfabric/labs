import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-staged-reference",
);
const space = signer.did();

const ADMIN_ATOM = "admin-approved";

// A space that is not the one the linking documents live in.
const OTHER_SPACE = "did:key:z6MkfZ3gV6ZKqmyWLTPYnPYRUYQBqTHTNCJgqbCkNBzYqZ4H";

const FLOOR_SCHEMA = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // Stages, in one transaction, `a.next` as a reference to `b.next`, and
  // `b.next` as what `bNext` makes of `a`, then links `a.next` into the
  // floored slot of another document. Both stores endorse their contents.
  // Returns the reasons the preparation refused it for.
  const stageChain = (
    bNext: (a: ReturnType<Runtime["getCell"]>) => unknown,
  ) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcWriteFloor: "enforce",
    });
    const endorsed = {
      type: "object",
      ifc: { integrity: [ADMIN_ATOM] },
    } as JSONSchema;
    const tx = runtime.edit();
    const a = runtime.getCell(space, "a", endorsed, tx);
    const b = runtime.getCell(space, "b", endorsed, tx);
    a.set({ next: b.key("next") } as never);
    b.set({ next: bNext(a) } as never);
    runtime.getCell(space, "sink", FLOOR_SCHEMA, tx).set(
      { out: a.key("next") } as never,
    );
    tx.prepareCfc();
    const prepared = tx.getCfcState().prepare;
    tx.abort();
    return prepared.status === "invalidated" ? prepared.reasons : [];
  };

  describe("a link through references staged in the same transaction", () => {
    it("meets the floor with the endorsement at the end of the chain", () => {
      expect(stageChain(() => "endorsed")).toEqual([]);
    });

    it("fails the floor where the references lead back to the linked one", () => {
      // A pointer loop has no value at its end, so no endorsement reaches
      // the slot.

      expect(stageChain((a) => a.key("next"))).toEqual([
        expect.stringContaining("write floor failed at /out"),
      ]);
    });
  });

  describe("a link through a staged reference into another space", () => {
    // A hop out of the target's space sees the source's labels in the form
    // they persist across spaces, which carries the same endorsement.

    // Seeds `b` in another space, labeled with `integrity`, stages `a.next`
    // as a reference to it, and links `a.next` into the floored slot of
    // another document, with label metadata protection enforced. Returns the
    // reasons the preparation refused it for.
    const linkAcrossSpaces = async (integrity: readonly string[]) => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcWriteFloor: "enforce",
        cfcLabelMetadataProtection: "enforce",
      });
      const b = runtime.getCell(OTHER_SPACE, "b");
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, OTHER_SPACE);
      seedStoredEnvelope(seed, { ...b.getAsNormalizedFullLink(), path: [] }, {
        value: { next: "endorsed" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { integrity: [...integrity] } }],
          },
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();
      const tx = runtime.edit();
      const a = runtime.getCell(space, "a", undefined, tx);
      a.set({ next: b.withTx(tx).key("next") } as never);
      runtime.getCell(space, "sink", FLOOR_SCHEMA, tx).set(
        { out: a.key("next") } as never,
      );
      tx.prepareCfc();
      const prepared = tx.getCfcState().prepare;
      tx.abort();
      return prepared.status === "invalidated" ? prepared.reasons : [];
    };

    it("meets the floor with the endorsement the other space's document holds", async () => {
      expect(await linkAcrossSpaces([ADMIN_ATOM])).toEqual([]);
    });

    it("fails the floor where that document holds none", async () => {
      expect(await linkAcrossSpaces([])).toEqual([
        expect.stringContaining("write floor failed at /out"),
      ]);
    });
  });

  describe("an ancestor link through references staged in the same transaction", () => {
    // A floor beneath the slot an ancestor link fills is met by the label
    // the link's source holds at the floored position.

    const NESTED_FLOOR_SCHEMA = {
      type: "object",
      properties: {
        out: {
          type: "object",
          properties: {
            x: { type: "string", ifc: { requiredIntegrity: [ADMIN_ATOM] } },
          },
        },
      },
      required: ["out"],
    } as JSONSchema;

    // Stages `a.next` as a reference to `b.next`, and `b.next` as what
    // `bNext` makes of `a`, then links `a.next` into the slot above the
    // floored position of another document. Returns the reasons the
    // preparation refused it for.
    const stageAncestorChain = (
      bNext: (a: ReturnType<Runtime["getCell"]>) => unknown,
    ) => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcWriteFloor: "enforce",
      });
      const endorsed = {
        type: "object",
        ifc: { integrity: [ADMIN_ATOM] },
      } as JSONSchema;
      const tx = runtime.edit();
      const a = runtime.getCell(space, "a", endorsed, tx);
      const b = runtime.getCell(space, "b", endorsed, tx);
      a.set({ next: b.key("next") } as never);
      b.set({ next: bNext(a) } as never);
      runtime.getCell(space, "sink", NESTED_FLOOR_SCHEMA, tx).set(
        { out: a.key("next") } as never,
      );
      tx.prepareCfc();
      const prepared = tx.getCfcState().prepare;
      tx.abort();
      return prepared.status === "invalidated" ? prepared.reasons : [];
    };

    it("meets the floor with the endorsement at the end of the chain", () => {
      expect(stageAncestorChain(() => ({ x: "endorsed" }))).toEqual([]);
    });

    it("fails the floor where the references lead back to the linked one", () => {
      expect(stageAncestorChain((a) => a.key("next"))).toEqual([
        expect.stringContaining("write floor failed at /out/x"),
      ]);
    });
  });
});
