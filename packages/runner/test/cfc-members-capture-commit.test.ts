import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { aclDocId } from "@commonfabric/memory/acl";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { LINK_V1_TAG } from "../src/sigil-types.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

// The spec §8.7.5 capture check end to end through prepare: an output that
// carries its owner's module-policy clause and declares `ifc.members` gains
// the authored clause `[User(owner) ∨ Members(list, subject)]`, and a write
// the check refuses does not commit.

const alice = await Identity.fromPassphrase("runner-members-capture-alice");
const eve = await Identity.fromPassphrase("runner-members-capture-eve");
const MODULE = "sha256:location-module";

const RESULT = "of:members-capture-result" as URI;
const INPUT = "of:members-capture-fix" as URI;
const OUTPUT = "of:members-capture-where" as URI;

/** The run's result: a list field owned by its writer, which it declares. */
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    liveList: {
      type: "array",
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: "/live.tsx", path: ["share"] },
        },
      },
    },
  },
} as const satisfies JSONSchema;

const policyRef = (subject: string) =>
  cfcAtom.modulePolicyRef(MODULE, "locationRules", "sha256:digest", subject);

/**
 * The output declares the owner's policy clause it carries, as a sealed
 * output does, and the list it is released to.
 */
const outputSchema = (owner: string): JSONSchema => ({
  type: "string",
  ifc: { confidentiality: [policyRef(owner)], members: "/liveList" },
});

const createRuntime = (as: Identity) => {
  const storageManager = StorageManager.emulate({ as });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
  });
  return { runtime, storageManager };
};

const writeSchemaDoc = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  schema: JSONSchema,
): string => {
  const hash = internSchemaAsTaggedHashString(schema);
  tx.writeOrThrow({
    space,
    scope: "space",
    id: `cid:${hash}` as URI,
    path: [],
  }, { value: schema });
  return hash;
};

/**
 * Seeds, in `space`: the run's result with an owner-bound list and the
 * module identity, the owner's fix labelled with her policy clause, and the
 * output document linked back to the result.
 */
const seedWorld = async (
  runtime: Runtime,
  space: MemorySpace,
  owner: string,
  module = MODULE,
  listOwner = owner,
) => {
  const tx = runtime.edit();
  // The Home space's genesis ACL, which a served space bootstraps and the
  // emulator does not: its user is its one owner.
  seedStoredEnvelope(tx, {
    space,
    scope: "space",
    id: aclDocId(space) as URI,
    path: [],
  }, { value: { [owner]: "OWNER" } });
  const resultHash = writeSchemaDoc(tx, space, RESULT_SCHEMA);
  const plainHash = writeSchemaDoc(tx, space, { type: "object" });
  seedStoredEnvelope(tx, { space, scope: "space", id: RESULT, path: [] }, {
    value: { liveList: [] },
    patternIdentity: { identity: module, symbol: "default" },
    cfc: {
      version: 1,
      schemaHash: resultHash,
      labelMap: {
        version: 1,
        entries: [{
          path: ["liveList"],
          label: {
            integrity: [{ kind: "represents-principal", subject: listOwner }],
          },
          origin: "declared",
        }],
      },
    },
  });
  seedStoredEnvelope(tx, { space, scope: "space", id: INPUT, path: [] }, {
    value: { city: "Lisbon" },
    cfc: {
      version: 1,
      schemaHash: plainHash,
      labelMap: {
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: [policyRef(owner)] },
        }],
      },
    },
  });
  seedStoredEnvelope(tx, { space, scope: "space", id: OUTPUT, path: [] }, {
    result: { "/": { [LINK_V1_TAG]: { id: RESULT, path: [] } } },
  });
  const { error } = await tx.commit().settled;
  if (error !== undefined) throw error;
};

/** As `actor`, reads the fix and writes the coarse city to the output. */
const writeOutput = async (
  runtime: Runtime,
  space: MemorySpace,
  actor: string,
  owner = actor,
) => {
  const tx = runtime.edit();
  tx.setCfcEnforcementMode("enforce-strict");
  setCfcTrustSnapshot(tx, { id: `trust-${actor}`, actingPrincipal: actor });
  setCfcImplementationIdentity(tx, {
    kind: "verified",
    moduleIdentity: MODULE,
    sourceFile: "/live.tsx",
    bindingPath: ["coarsen"],
  });
  const fix = runtime.getCellFromLink<{ city: string }>({
    space,
    id: INPUT,
    path: [],
    scope: "space",
  }, undefined, tx);
  const where = runtime.getCellFromLink<string>({
    space,
    id: OUTPUT,
    path: [],
    scope: "space",
  }, outputSchema(owner), tx);
  where.set(fix.get().city);
  tx.prepareCfc();
  return await tx.commit().settled;
};

const storedConfidentiality = (runtime: Runtime, space: MemorySpace) => {
  const tx = runtime.edit();
  const metadata = readStoredCfcMetadata(tx, {
    space,
    id: OUTPUT,
    path: [],
    scope: "space",
    type: "application/json",
  });
  tx.abort();
  return metadata?.labelMap.entries.flatMap((entry) =>
    entry.label.confidentiality ?? []
  ) ?? [];
};

describe("the Members capture check at commit (spec §8.7.5)", () => {
  it("adds the authored clause for the subject's sole owner", async () => {
    const { runtime, storageManager } = createRuntime(alice);
    try {
      const space = alice.did();
      await seedWorld(runtime, space, alice.did());
      const { error } = await writeOutput(runtime, space, alice.did());
      expect(error).toBeUndefined();
      expect(storedConfidentiality(runtime, space)).toContainEqual({
        anyOf: expect.arrayContaining([
          cfcAtom.user(alice.did()),
          cfcAtom.members(
            { space, id: RESULT, path: ["liveList"] },
            alice.did(),
          ),
        ]),
      });
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses the write for an actor who does not own the subject", async () => {
    const { runtime, storageManager } = createRuntime(alice);
    try {
      const space = alice.did();
      await seedWorld(runtime, space, alice.did());
      const { error } = await writeOutput(
        runtime,
        space,
        eve.did(),
        alice.did(),
      );
      expect(String(error?.message)).toMatch(/solely owns/);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses the write for a run of another module", async () => {
    const { runtime, storageManager } = createRuntime(alice);
    try {
      const space = alice.did();
      await seedWorld(runtime, space, alice.did(), "sha256:weather-module");
      const { error } = await writeOutput(runtime, space, alice.did());
      expect(String(error?.message)).toMatch(/run of the module/);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("refuses the write when the list is someone else's", async () => {
    const { runtime, storageManager } = createRuntime(alice);
    try {
      const space = alice.did();
      await seedWorld(runtime, space, alice.did(), MODULE, eve.did());
      const { error } = await writeOutput(runtime, space, alice.did());
      expect(String(error?.message)).toMatch(/owns that declares/);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
