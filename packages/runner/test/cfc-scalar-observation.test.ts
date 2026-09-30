/** Pins value-label consumption when reactive readers materialize atomic data. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-scalar-observation");
const space = signer.did();

describe("cfc-scalar-observation", () => {
  let runtime: Runtime;
  let storage: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
      cfcEnforcementMode: "enforce-strict",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  const seed = async (value: FabricValue, labeledPath: string[] = []) => {
    const tx = runtime.edit();
    const source = runtime.getCell(space, "source", undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...source.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: labeledPath,
            origin: "derived",
            observes: "value",
            label: { confidentiality: ["secret-context"] },
          }],
        },
      },
    });
    runtime.getCell(space, "sink", undefined, tx).set("public");
    expect((await tx.commit()).error).toBeUndefined();
  };

  const refusePublicCopy = async (
    tx: ReturnType<Runtime["edit"]>,
    result: unknown,
  ) => {
    expect(deriveFlowJoin(tx).confidentiality).toEqual(["secret-context"]);
    runtime.getCell(space, "sink", undefined, tx).set(result);
    expect((await tx.commit()).error?.message).toContain(
      "writer-fit confidentiality misfit",
    );
  };

  for (const lazy of [false, true]) {
    for (
      const [type, value] of [
        ["string", "secret"],
        ["number", 41],
        ["boolean", false],
        ["null", null],
      ] as const
    ) {
      for (const typed of [false, true]) {
        it(`refuses a public copy of a ${typed ? "typed" : "schema-less"} ${type} through ${lazy ? "lazy" : "eager"} get`, async () => {
          await seed(value);
          const tx = runtime.edit();
          tx.markLazyMaterialize(lazy);
          const cell = runtime.getCell(
            space,
            "source",
            typed ? { type } : undefined,
            tx,
          );
          const result = cell.get();
          expect(result).toBe(value);
          await refusePublicCopy(tx, result);
        });
      }
    }

    const cases: {
      name: string;
      value: FabricValue;
      path: string[];
      schema: JSONSchema | undefined;
      select: (value: unknown) => unknown;
    }[] = [
      {
        name: "a proxy property",
        value: { secret: "secret" },
        path: ["secret"],
        schema: undefined,
        select: (value) => (value as { secret: string }).secret,
      },
      {
        name: "a typed property",
        value: { secret: "secret", public: "public" },
        path: ["secret"],
        schema: {
          type: "object",
          properties: { secret: { type: "string" } },
        },
        select: (value) => (value as { secret: string }).secret,
      },
      {
        name: "an array scalar",
        value: ["secret"],
        path: ["0"],
        schema: { type: "array", items: { type: "string" } },
        select: (value) => (value as string[])[0],
      },
      {
        name: "a plain-schema array record",
        value: [{ secret: "secret" }],
        path: ["0", "secret"],
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: { secret: { type: "string" } },
          },
        },
        select: (value) => (value as { secret: string }[])[0].secret,
      },
    ];
    for (const fixture of cases) {
      it(`refuses a public copy of ${fixture.name} through ${lazy ? "lazy" : "eager"} get`, async () => {
        await seed(fixture.value, fixture.path);
        const tx = runtime.edit();
        tx.markLazyMaterialize(lazy);
        const result = fixture.select(
          runtime.getCell(space, "source", fixture.schema, tx).get(),
        );
        expect(result).toBe("secret");
        await refusePublicCopy(tx, result);
      });
    }

    it(`leaves an unselected sibling's value label out of a ${lazy ? "lazy" : "eager"} projection`, async () => {
      await seed({ public: "public", secret: "secret" }, ["secret"]);
      const tx = runtime.edit();
      tx.markLazyMaterialize(lazy);
      const result = runtime.getCell<{ public: string }>(space, "source", {
        type: "object",
        properties: { public: { type: "string" } },
      }, tx).get().public;
      expect(result).toBe("public");
      expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
      runtime.getCell(space, "sink", undefined, tx).set(result);
      expect((await tx.commit()).error).toBeUndefined();
    });
  }

  for (const mode of ["proxy", "required", "optional"] as const) {
    it(`leaves value labels out of ${mode} key and presence probes`, async () => {
      await seed({ secret: "secret" }, ["secret"]);
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      const value = runtime.getCell<Record<string, unknown>>(
        space,
        "source",
        mode === "proxy" ? undefined : {
          type: "object",
          properties: { secret: { type: "string" } },
          ...(mode === "required" ? { required: ["secret"] } : {}),
        },
        tx,
      ).get();
      expect(Reflect.ownKeys(value)).toEqual(["secret"]);
      expect(Object.keys(value)).toEqual(["secret"]);
      expect("secret" in value).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(value, "secret")!;
      expect(descriptor.enumerable).toBe(true);
      expect(descriptor.value).toBeUndefined();
      expect(descriptor.get).toBeDefined();
      expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
      const result = descriptor.get!.call(value);
      expect(result).toBe("secret");
      await refusePublicCopy(tx, result);
    });
  }

  it("excludes a mismatched optional scalar using only its shape", async () => {
    await seed({ secret: 41 }, ["secret"]);
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    const value = runtime.getCell<Record<string, unknown>>(space, "source", {
      type: "object",
      properties: { secret: { type: "string" } },
    }, tx).get();
    expect(Object.keys(value)).toEqual([]);
    expect("secret" in value).toBe(false);
    expect(Object.getOwnPropertyDescriptor(value, "secret")).toBeUndefined();
    expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
    tx.abort();
  });

  for (
    const [type, secret] of [
      ["string", "secret"],
      ["number", 1],
      ["number", 1.5],
      ["boolean", false],
      ["null", null],
      ["undefined", undefined],
    ] as const
  ) {
    it(`checks optional ${type} presence without consuming payload ${String(secret)}`, async () => {
      await seed({ secret }, ["secret"]);
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      const value = runtime.getCell<Record<string, unknown>>(space, "source", {
        type: "object",
        properties: { secret: { type } },
      }, tx).get();
      expect(Object.keys(value)).toEqual(["secret"]);
      expect("secret" in value).toBe(true);
      expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
      runtime.getCell(space, "sink", undefined, tx).set("present");
      expect((await tx.commit()).error).toBeUndefined();
    });
  }

  for (const secret of [1, 1.5]) {
    it(`refuses a public integer-presence result for secret ${secret}`, async () => {
      await seed({ secret }, ["secret"]);
      const tx = runtime.edit();
      tx.markLazyMaterialize(true);
      const value = runtime.getCell<Record<string, unknown>>(space, "source", {
        type: "object",
        properties: { secret: { type: "integer" } },
      }, tx).get();
      const present = "secret" in value;
      expect(present).toBe(secret === 1);
      const confidentiality = deriveFlowJoin(tx).confidentiality;
      runtime.getCell(space, "sink", undefined, tx).set(present);
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(confidentiality).toEqual(["secret-context"]);
    });
  }

  it("retains value observations for presence projections outside exact scalar types", async () => {
    await seed({ secret: "secret" }, ["secret"]);
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    const value = runtime.getCell<Record<string, unknown>>(space, "source", {
      type: "object",
      properties: { secret: { type: "string", enum: ["secret"] } },
    }, tx).get();
    expect(Object.keys(value)).toEqual(["secret"]);
    await refusePublicCopy(tx, "present");
  });

  it("defers a lazy array element's value observation until its descriptor getter runs", async () => {
    await seed(["secret"], ["0"]);
    const tx = runtime.edit();
    tx.markLazyMaterialize(true);
    const value = runtime.getCell<string[]>(space, "source", {
      type: "array",
      items: { type: "string" },
    }, tx).get();
    expect(Object.keys(value)).toEqual(["0"]);
    const descriptor = Object.getOwnPropertyDescriptor(value, "0")!;
    expect(descriptor.get).toBeDefined();
    expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
    const result = descriptor.get!.call(value);
    expect(result).toBe("secret");
    await refusePublicCopy(tx, result);
  });
});
