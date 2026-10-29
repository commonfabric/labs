import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-schema-reference-flow");
const space = signer.did();
const textSchema = {
  type: "object",
  properties: { text: { type: "string" } },
} as const satisfies JSONSchema;

describe("cfc-schema-reference-flow", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
      experimental: { serverExecution: false },
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const seedDocument = (
    tx: IExtendedStorageTransaction,
    name: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
  ) => {
    const cell = runtime.getCell(space, name, undefined, tx);
    seedStoredEnvelope(tx, cell.getAsNormalizedFullLink(), {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    return cell;
  };

  const expectPublicWrite = async (
    tx: IExtendedStorageTransaction,
    value: FabricValue,
    expectedConfidentiality: string[],
  ) => {
    const flow = deriveFlowJoin(tx);
    const output = runtime.getCell(space, "public-output", undefined, tx);
    output.set(value);
    tx.prepareCfc();
    const result = await tx.commit().settled;
    if (expectedConfidentiality.length === 0) {
      expect(result.ok).toBeDefined();
      expect(output.withTx(undefined).get()).toEqual(value);
    } else {
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(output.withTx(undefined).get()).toBeUndefined();
    }
    expect(flow.confidentiality).toEqual(expectedConfidentiality);
  };

  for (const route of ["keyed", "schema-selected"] as const) {
    describe(route, () => {
      for (const confidential of [false, true]) {
        it(`${confidential ? "refuses" : "permits"} a public copy through a ${confidential ? "confidential" : "public"} reference`, async () => {
          const seed = runtime.edit();
          writeSeedEnvelopeDoc(seed, space);
          const target = seedDocument(seed, "target", {
            text: "selected text",
            unread: "hidden text",
          }, [{
            path: ["unread"],
            label: { confidentiality: ["unread-secret"] },
          }]);
          const source = seedDocument(
            seed,
            "source",
            {
              selected: target.getAsLink(),
            },
            confidential
              ? [{
                path: ["selected"],
                origin: "link",
                label: { confidentiality: ["reference-secret"] },
              }]
              : [],
          );
          expect((await seed.commit().settled).ok).toBeDefined();

          const tx = runtime.edit();
          const input = source.withTx(tx);
          const value = route === "keyed"
            ? input.key("selected", "text").get()
            : input.asSchema(
              {
                type: "object",
                properties: { selected: textSchema },
              } as const,
            ).get().selected?.text;
          expect(value).toBe("selected text");
          await expectPublicWrite(
            tx,
            value,
            confidential ? ["reference-secret"] : [],
          );
        });
      }
    });
  }

  it("consumes both reference restrictions and the selected leaf through a chain", async () => {
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    const target = seedDocument(seed, "target", { text: "selected text" }, [{
      path: ["text"],
      label: { confidentiality: ["leaf-secret"] },
    }]);
    const middle = seedDocument(seed, "middle", { next: target.getAsLink() }, [{
      path: ["next"],
      origin: "link",
      label: { confidentiality: ["inner-reference"] },
    }]);
    const source = seedDocument(seed, "source", {
      selected: middle.getAsLink(),
    }, [{
      path: ["selected"],
      origin: "link",
      label: { confidentiality: ["outer-reference"] },
    }]);
    expect((await seed.commit().settled).ok).toBeDefined();

    const tx = runtime.edit();
    const value = source.withTx(tx).asSchema(
      {
        type: "object",
        properties: {
          selected: { type: "object", properties: { next: textSchema } },
        },
      } as const,
    ).get().selected?.next?.text;
    expect(value).toBe("selected text");
    await expectPublicWrite(tx, value, [
      "outer-reference",
      "inner-reference",
      "leaf-secret",
    ]);
  });

  it("consumes each array item's reference restriction during plain schema traversal", async () => {
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    const first = seedDocument(seed, "first", { text: "first text" });
    const second = seedDocument(seed, "second", { text: "second text" });
    const source = seedDocument(
      seed,
      "source",
      {
        items: [first.getAsLink(), second.getAsLink()],
      },
      ["first-reference", "second-reference"].map((atom, index) => ({
        path: ["items", String(index)],
        origin: "link",
        label: { confidentiality: [atom] },
      })),
    );
    expect((await seed.commit().settled).ok).toBeDefined();

    const tx = runtime.edit();
    const value = source.withTx(tx).asSchema(
      {
        type: "object",
        properties: { items: { type: "array", items: textSchema } },
      } as const,
    ).get().items?.map((item) => item.text);
    expect(value).toEqual(["first text", "second text"]);
    await expectPublicWrite(tx, value, ["first-reference", "second-reference"]);
  });
});
