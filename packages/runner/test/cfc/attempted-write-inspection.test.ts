import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../../src/builder/types.ts";
import { prepareBoundaryCommit } from "../../src/cfc/prepare.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-attempted-write-inspection");
const secret = "connector-row";

/** Prepares row policies through either document or space write inspection. */
async function prepareRows(
  indexed: boolean,
  closed: boolean,
  count: number,
  rootWrites = false,
) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });
  try {
    const seed = runtime.edit();
    const source = runtime.getCell<string>(
      signer.did(),
      "source",
      undefined,
      seed,
    );
    writeSeedEnvelopeDoc(seed, signer.did());
    seedStoredEnvelope(seed, source.getAsNormalizedFullLink(), {
      value: "message",
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: [secret] } }],
        },
      },
    });
    expect((await seed.commit()).error).toBeUndefined();

    const tx = runtime.edit();
    try {
      const content = source.withTx(tx).get();
      const field = {
        type: "string",
        ifc: {
          confidentiality: [secret],
          ...(closed ? { maxConfidentiality: [] } : {}),
        },
      } as const satisfies JSONSchema;
      const schema = {
        type: "object",
        properties: {
          content: field,
          channels: { type: "array", items: field },
        },
        required: ["content", "channels"],
      } as const satisfies JSONSchema;
      const rows = Array.from({ length: count }, (_, index) => {
        const row = runtime.getCell(signer.did(), `row-${index}`, schema, tx);
        const address = row.getAsNormalizedFullLink();
        const value = { content, channels: ["general", "releases"] };
        if (rootWrites) {
          tx.writeValueOrThrow(address, value);
          tx.recordCfcWritePolicyInput({
            kind: "schema",
            target: address,
            schema,
          });
        } else {
          row.set(value);
        }
        return address;
      });
      let spaceWriteVisits = 0;
      const view = new Proxy(tx, {
        get(target, property) {
          if (property === "getWriteDetailsForTarget" && !indexed) {
            return undefined;
          }
          if (property === "getWriteDetails") {
            return function* (space: MemorySpace) {
              for (const write of target.getWriteDetails?.(space) ?? []) {
                spaceWriteVisits++;
                yield write;
              }
            };
          }
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      const reasons = prepareBoundaryCommit(view);
      const documents = rows.map((row) => tx.readOrThrow({ ...row, path: [] }));
      return { reasons, documents, spaceWriteVisits };
    } finally {
      tx.abort();
    }
  } finally {
    await storageManager.synced();
    await runtime.dispose({ closeStorage: false });
    await storageManager.close();
  }
}

describe("CFC attempted-write inspection", () => {
  it("keeps row labels while bounding space-wide write inspection", async () => {
    const count = 24;
    const indexed = await prepareRows(true, false, count);
    const fallback = await prepareRows(false, false, count);
    expect(indexed.reasons).toEqual([]);
    expect(indexed.documents).toEqual(fallback.documents);
    expect(indexed.reasons).toEqual(fallback.reasons);
    expect(indexed.documents).toHaveLength(count);
    expect(indexed.documents[0]).toMatchObject({
      value: { content: "message", channels: ["general", "releases"] },
      cfc: {
        labelMap: {
          entries: expect.arrayContaining([
            expect.objectContaining({ label: { confidentiality: [secret] } }),
          ]),
        },
      },
    });
    // Boundary-wide joins still inspect the space a fixed number of times.
    // Per-field policy checks must not add a scan for each row.
    expect(indexed.spaceWriteVisits).toBeLessThan(count * 20);
    expect(fallback.spaceWriteVisits).toBeGreaterThan(indexed.spaceWriteVisits);
  });

  it("retains ceiling refusals with document and fallback inspection", async () => {
    const indexed = await prepareRows(true, true, 3);
    const fallback = await prepareRows(false, true, 3);
    expect(indexed.reasons).toHaveLength(3);
    expect(
      indexed.reasons.every((reason) => reason.includes("maxConfidentiality")),
    )
      .toBe(true);
    expect(indexed.reasons).toEqual(fallback.reasons);
    expect(indexed.documents).toEqual(fallback.documents);
  });

  it("bounds wildcard inspection for whole-document writes", async () => {
    const count = 24;
    const indexed = await prepareRows(true, false, count, true);
    const fallback = await prepareRows(false, false, count, true);
    expect(indexed.reasons).toEqual([]);
    expect(indexed.reasons).toEqual(fallback.reasons);
    expect(indexed.documents).toHaveLength(count);
    expect(indexed.documents).toEqual(fallback.documents);
    expect(indexed.spaceWriteVisits).toBeLessThan(count * 20);
    expect(fallback.spaceWriteVisits).toBeGreaterThan(indexed.spaceWriteVisits);
  });

  it("isolates concrete and wildcard policies by scope", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const target = runtime.getCell(signer.did(), "scoped-row", undefined)
        .getAsNormalizedFullLink();
      const field = {
        type: "string",
        ifc: { writeAuthorizedBy: ["trusted-handler"] },
      } as const satisfies JSONSchema;
      const schema = internSchema({
        type: "object",
        properties: {
          content: field,
          channels: { type: "array", items: field },
          title: { type: "string" },
        },
      }, true);
      const initial = {
        content: "existing",
        channels: ["general"],
        title: "draft",
      };
      const seed = runtime.edit();
      seedStoredEnvelope(seed, target, {
        value: initial,
        cfc: {
          version: 1,
          schemaHash: schema.taggedHashString,
          labelMap: {
            version: 1,
            entries: [
              { path: ["content"], label: {} },
              { path: ["channels", "*"], label: {} },
            ],
          },
        },
      });
      seed.writeOrThrow({
        ...target,
        id: `cid:${schema.taggedHashString}`,
      }, { value: schema.schema });
      expect((await seed.commit()).error).toBeUndefined();

      for (const indexed of [true, false]) {
        const tx = runtime.edit();
        try {
          const other = { ...target, scope: "user" } as const;
          const otherValue = { content: "changed", channels: ["releases"] };
          tx.writeValueOrThrow(other, otherValue);
          tx.writeValueOrThrow({ ...target, path: ["title"] }, "updated");
          tx.recordCfcWritePolicyInput({
            kind: "schema",
            target,
            schema: schema.schema,
          });
          const view = new Proxy(tx, {
            get(target, property) {
              if (property === "getWriteDetailsForTarget" && !indexed) {
                return undefined;
              }
              const member = Reflect.get(target, property, target);
              return typeof member === "function"
                ? member.bind(target)
                : member;
            },
          });
          expect(prepareBoundaryCommit(view)).toEqual([]);
          expect(tx.readValueOrThrow(target)).toEqual({
            ...initial,
            title: "updated",
          });
          expect(tx.readValueOrThrow(other)).toEqual(otherValue);
        } finally {
          tx.abort();
        }
      }
    } finally {
      await storageManager.synced();
      await runtime.dispose({ closeStorage: false });
      await storageManager.close();
    }
  });
});
