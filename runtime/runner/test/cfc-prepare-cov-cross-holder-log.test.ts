import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import { isVerdictReason } from "../src/cfc/verdict-reason.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { captureLogs } from "./support/captured-logs.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-cross-holder-log",
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

  // Seeds a source in `sourceSpace` whose `secret` the owner's clause labels,
  // then prepares a served event handler that copies it into a target of this
  // space declaring that clause. Returns the target's id, the prepare
  // decision, and what the `cfc` logger printed under
  // `writer-fit-cross-holder` meanwhile.
  const preparedServedCopy = async (
    sourceSpace: `did:${string}:${string}`,
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

    using logs = captureLogs("cfc");
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
      logged: logs.textsOf("writer-fit-cross-holder"),
    };
  };

  describe("a served run's write of a clause read from another space", () => {
    it("invalidates the write with a cross-holder misfit verdict, and logs it, at the target's root", async () => {
      const { targetId, status, reasons, logged } = await preparedServedCopy(
        OTHER_SPACE,
      );
      expect(status).toBe("invalidated");
      expect(reasons).toEqual([{
        reason: expect.stringContaining(
          `writer-fit confidentiality misfit for ${targetId} at / ` +
            `(cross-holder`,
        ),
        verdict: true,
      }]);
      expect(logged).toEqual([`cross-holder misfit for ${targetId} at /`]);
    });

    it("prepares the write, and logs no misfit, where the clause was read from the target's own space", async () => {
      const { status, logged } = await preparedServedCopy(space);
      expect(status).toBe("prepared");
      expect(logged).toEqual([]);
    });
  });
});
