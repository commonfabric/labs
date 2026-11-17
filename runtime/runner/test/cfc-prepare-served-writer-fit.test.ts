import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { isVerdictReason } from "../src/cfc/verdict-reason.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-served-writer-fit",
);
const space = signer.did();

// A space that is not the one the target lives in.
const OTHER_SPACE = "did:key:z6MkfZ3gV6ZKqmyWLTPYnPYRUYQBqTHTNCJgqbCkNBzYqZ4H";

// The owner of the private data the served run copies.
const OWNER = {
  type: "https://commonfabric.org/cfc/atom/User",
  subject: "did:key:zOwner",
} as const;

const sourceSchema = {
  type: "object",
  properties: { secret: { type: "string" } },
} as const satisfies JSONSchema;

const targetSchema = {
  type: "object",
  properties: { copied: { type: "string" } },
  ifc: { confidentiality: [OWNER] },
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

  /** Prepares a served copy of the owner's labeled value into `targetSchema`. */
  const preparedServedCopy = async (
    sourceSpace: `did:${string}:${string}`,
    targetSchema: JSONSchema,
  ) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      servingPosture: true,
      experimental: { serverExecution: true },
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    const source = runtime.getCell(sourceSpace, "source", sourceSchema);
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, sourceSpace);
    seedStoredEnvelope(seed, {
      space: sourceSpace,
      scope: "space",
      id: parseLink(source.getAsLink()).id!,
      path: [],
    }, {
      value: { secret: "s3cr3t" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: ["secret"], label: { confidentiality: [OWNER] } }],
        },
      },
    });
    expect((await seed.commit().settled).error).toBeUndefined();

    const tx = runtime.edit();
    stampWaveRunContext(tx, {
      actionId: "test:copy",
      kind: "event-handler",
      scopeKeyIdentity: { principal: space, sessionId: "served-session" },
    });
    const read = source.withTx(tx).getRaw()?.secret;
    expect(read).toBe("s3cr3t");
    const target = runtime.getCell(space, "target", targetSchema, tx);
    target.set({ copied: read });
    tx.prepareCfc();
    const prepared = tx.getCfcState().prepare;
    tx.abort();
    return {
      targetId: target.getAsNormalizedFullLink().id,
      status: prepared.status,
      reasons: prepared.status === "invalidated"
        ? prepared.reasons.map((reason) => ({
          reason,
          verdict: isVerdictReason(reason),
        }))
        : [],
    };
  };

  describe("a served run's writes", () => {
    it("prepares a copy from another space where the target declares the owner's clause", async () => {
      const { status, reasons } = await preparedServedCopy(
        OTHER_SPACE,
        targetSchema,
      );
      expect(status).toBe("prepared");
      expect(reasons).toEqual([]);
    });

    it("prepares a copy from the same space where the target declares the owner's clause", async () => {
      const { status, reasons } = await preparedServedCopy(space, targetSchema);
      expect(status).toBe("prepared");
      expect(reasons).toEqual([]);
    });

    it("invalidates a copy from another space with a writer-fit verdict where the target declares no confidentiality", async () => {
      const { targetId, status, reasons } = await preparedServedCopy(
        OTHER_SPACE,
        { ...targetSchema, ifc: { confidentiality: [] } },
      );
      expect(status).toBe("invalidated");
      expect(reasons).toEqual([{
        reason: expect.stringContaining(
          `writer-fit confidentiality misfit for ${targetId} at / ` +
            `(canWrite, §8.12.4)`,
        ),
        verdict: true,
      }]);
    });
  });
});
