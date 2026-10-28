/** Value and existence measurements consumed by ordinary runtime readers. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-existence-reader-labels");
const space = signer.did();

/** A runtime measurement at one concrete payload path. */
const measurement = (
  path: string[],
  observes: "shape" | "value",
  confidentiality: string[],
): LabelMapEntry => ({
  path,
  origin: "derived",
  observes,
  label: { confidentiality },
});

describe("cfc-existence-reader-labels", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  const seed = async (value: FabricValue, entries: LabelMapEntry[]) => {
    const tx = runtime.edit();
    const source = runtime.getCell(space, "source");
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, source.getAsNormalizedFullLink(), {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit().settled).ok).toBeDefined();
  };

  const copy = async (
    read: (tx: ReturnType<Runtime["edit"]>) => unknown,
  ) => {
    const tx = runtime.edit();
    const value = read(tx);
    runtime.getCell(space, "sink", undefined, tx).set({
      copied: String(value),
    });
    tx.prepareCfc();
    return { value, result: await tx.commit().settled };
  };

  for (const value of ["private", 42, true, null, undefined]) {
    it(`consumes the value label when \`Cell.get()\` returns \`${String(value)}\``, async () => {
      await seed(value, [
        measurement([], "shape", []),
        measurement([], "value", ["secret"]),
      ]);
      const observed = await copy((tx) =>
        runtime.getCell(space, "source", undefined, tx).get()
      );
      expect(observed.value).toBe(value);
      expect(observed.result.error?.message).toContain('"secret"');
    });
  }

  it("consumes current value confidentiality beyond its frozen birth label", async () => {
    await seed("private", [
      measurement([], "shape", ["birth"]),
      measurement([], "value", ["secret"]),
    ]);
    const tx = runtime.edit();
    const value = runtime.getCell<string>(space, "source", undefined, tx).get();
    expect(value).toBe("private");
    runtime.getCell(space, "sink", {
      type: "string",
      ifc: { confidentiality: ["birth"] },
    }, tx).set(value);
    tx.prepareCfc();
    expect((await tx.commit().settled).error?.message).toContain('"secret"');
  });

  for (
    const [ancestor, descendant] of [
      ["value", "shape"],
      ["shape", "value"],
    ] as const
  ) {
    it(`keeps a secret ancestor ${ancestor} label beside a public descendant ${descendant} label`, async () => {
      await seed({ child: "private" }, [
        measurement([], ancestor, ["secret"]),
        measurement(["child"], descendant, []),
      ]);
      // A direct value read isolates label resolution from proxy journaling.
      const observed = await copy((tx) =>
        tx.readValueOrThrow({
          ...runtime.getCell(space, "source").getAsNormalizedFullLink(),
          path: ["child"],
        })
      );
      expect(observed.value).toBe("private");
      expect(observed.result.error?.message).toContain('"secret"');
    });
  }

  it("keeps legacy covering labels beside public existence evidence", async () => {
    await seed({ child: "private" }, [
      { path: [], origin: "derived", label: { confidentiality: ["secret"] } },
      measurement(["child"], "shape", []),
    ]);
    const observed = await copy((tx) =>
      runtime.getCell<{ child: string }>(space, "source", undefined, tx)
        .key("child").get()
    );
    expect(observed.value).toBe("private");
    expect(observed.result.error?.message).toContain('"secret"');
  });

  it("keeps an explicit empty value refinement within its own class", async () => {
    await seed({ child: "public" }, [
      measurement([], "value", ["secret"]),
      measurement(["child"], "value", []),
      measurement(["child"], "shape", []),
    ]);
    const observed = await copy((tx) =>
      runtime.getCell<{ child: string }>(space, "source", undefined, tx)
        .key("child").get()
    );
    expect(observed.value).toBe("public");
    expect(observed.result.ok).toBeDefined();
  });

  it("consumes only public existence for a shape-only observation", async () => {
    await seed({ child: "private" }, [
      measurement([], "shape", []),
      measurement([], "value", ["secret"]),
    ]);
    const observed = await copy((tx) => {
      const value = tx.readValueOrThrow(
        runtime.getCell(space, "source").getAsNormalizedFullLink(),
        { nonRecursive: true },
      );
      return value !== undefined;
    });
    expect(observed.value).toBe(true);
    expect(observed.result.ok).toBeDefined();
  });
});
