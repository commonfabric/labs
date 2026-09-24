import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import type { ImplementationIdentity } from "../src/cfc/mod.ts";
import { buildCfcPolicyArtifactManifest } from "../src/cfc/policy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("cfc structure stamp attribution");
const space = signer.did();

const MODULE = "sha256:ballot-module";

// Drops this policy's clause from a value `tally` of the policy's own module
// computed, and from nothing else.
const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: MODULE,
  symbol: "ballotRules",
  template: {
    templateVersion: 1,
    exchangeRules: [{
      name: "releaseTally",
      preCondition: {
        confidentiality: [{ thisPolicy: true }],
        integrity: [{
          type: CFC_ATOM_TYPE.TransformedBy,
          identity: {
            kind: "verified",
            moduleIdentity: { thisPolicyField: "moduleIdentity" },
            symbol: "tally",
          },
        }],
      },
      postCondition: { confidentiality: [], integrity: [] },
    }],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

const briefSchema = {
  type: "object",
  properties: { vote: { type: "string" }, note: { type: "string" } },
  required: ["vote", "note"],
  ifc: {
    confidentiality: [{
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: MODULE,
      symbol: "ballotRules",
      policyDigest: artifact.policyDigest,
      subject: { __ctOwningSpace: true },
    }],
  },
} as const satisfies JSONSchema;

const publicCountsSchema = {
  type: "object",
  properties: { approve: { type: "number" }, reject: { type: "number" } },
  ifc: { maxConfidentiality: [] },
} as const satisfies JSONSchema;

const publicTextSchema = {
  type: "string",
  ifc: { maxConfidentiality: [] },
} as const satisfies JSONSchema;

const verified = (moduleIdentity: string, symbol: string) =>
  ({
    kind: "verified",
    moduleIdentity,
    symbol,
    codeHash: `code:${symbol}`,
  }) satisfies ImplementationIdentity;

const TALLY = verified(MODULE, "tally");
const HAND_COUNT = verified(MODULE, "handCount");
const PUBLISH = verified("sha256:room-module", "publish");

type Counts = { approve: number; reject: number };

describe("TransformedBy on the stamps of an object a function wrote", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // The counts documents stand in for a lift's result document, which
      // takes the join its lift wrote without declaring a ceiling for it.
      cfcEnforcementMode: "enforce-explicit",
    });
    runtime.registerCfcPolicyManifests(space, [artifact]);
    const seed = runtime.edit();
    runtime.getCell(space, "brief", briefSchema, seed).set({
      vote: "approve",
      note: "secret-note",
    });
    expect((await seed.commit()).error).toBeUndefined();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  // Reads the brief and writes the counts, the way a lift over the briefs
  // fills its result document the first time: the empty object at the root,
  // then each field. The root write is a pure-link structure, so the object
  // node is labeled by membership stamps and each field by its own stamp.
  const tallyInto = async (
    cause: string,
    identity: ImplementationIdentity,
  ): Promise<void> => {
    const setup = runtime.edit();
    runtime.getCell<unknown>(space, cause, undefined, setup).set(null);
    expect((await setup.commit()).error).toBeUndefined();

    const tx = runtime.edit();
    tx.setCfcImplementationIdentity(identity);
    const brief = runtime.getCell(space, "brief", briefSchema, tx).get();
    const id = runtime.getCell(space, cause, undefined, tx)
      .getAsNormalizedFullLink().id;
    const at = (...path: string[]) => ({
      space,
      scope: "space" as const,
      id,
      path: ["value", ...path],
    });
    tx.writeOrThrow(at(), {});
    tx.writeOrThrow(at("approve"), brief.vote === "approve" ? 1 : 0);
    tx.writeOrThrow(at("reject"), brief.vote === "reject" ? 1 : 0);
    expect((await tx.commit()).error).toBeUndefined();
  };

  // Sets one key of the counts under `identity`, having read the brief.
  const writeKeyAs = async (
    identity: ImplementationIdentity,
    cause: string,
    key: (note: string) => string,
  ): Promise<void> => {
    const tx = runtime.edit();
    tx.setCfcImplementationIdentity(identity);
    const brief = runtime.getCell(space, "brief", briefSchema, tx).get();
    runtime.getCell<Record<string, number>>(space, cause, undefined, tx)
      .key(key(brief.note)).set(2);
    expect((await tx.commit()).error).toBeUndefined();
  };

  // Copies the counts field by field into a public-only store, observing
  // the object node first the way a handler's argument proxy does; returns
  // whether the gated write committed.
  const publishCounts = async (cause: string): Promise<boolean> => {
    const tx = runtime.edit();
    tx.setCfcImplementationIdentity(PUBLISH);
    const counts = runtime.getCell<Counts>(space, cause, undefined, tx);
    counts.getRaw({ nonRecursive: true });
    const approve = counts.key("approve").get();
    const reject = counts.key("reject").get();
    runtime.getCell(space, `public-${cause}`, publicCountsSchema, tx).set({
      approve,
      reject,
    });
    return (await tx.commit()).error === undefined;
  };

  // Copies the object's key set, and nothing under it, into a public-only
  // store; returns whether the gated write committed.
  const publishKeys = async (cause: string): Promise<boolean> => {
    const tx = runtime.edit();
    tx.setCfcImplementationIdentity(PUBLISH);
    const node = runtime.getCell<Record<string, number>>(
      space,
      cause,
      undefined,
      tx,
    ).getRaw({ nonRecursive: true }) as Record<string, unknown>;
    runtime.getCell(space, `public-keys-${cause}`, publicTextSchema, tx).set(
      Object.keys(node).join(","),
    );
    return (await tx.commit()).error === undefined;
  };

  it("releases an object written field by field by the named function", async () => {
    await tallyInto("counts", TALLY);
    expect(await publishCounts("counts")).toBe(true);
    expect(await publishKeys("counts")).toBe(true);
  });

  it("releases an object after the named function writes a field again", async () => {
    await tallyInto("counts", TALLY);
    await writeKeyAs(TALLY, "counts", () => "approve");
    expect(await publishCounts("counts")).toBe(true);
  });

  it("refuses an object written by another function of the same module", async () => {
    await tallyInto("counts", HAND_COUNT);
    expect(await publishCounts("counts")).toBe(false);
    expect(await publishKeys("counts")).toBe(false);
  });

  it("refuses an object whose transaction wrote under two identities", async () => {
    const setup = runtime.edit();
    runtime.getCell<unknown>(space, "counts", undefined, setup).set(null);
    expect((await setup.commit()).error).toBeUndefined();

    const tx = runtime.edit();
    tx.setCfcImplementationIdentity(TALLY);
    runtime.getCell(space, "brief", briefSchema, tx).get();
    const id = runtime.getCell(space, "counts", undefined, tx)
      .getAsNormalizedFullLink().id;
    const at = (...path: string[]) => ({
      space,
      scope: "space" as const,
      id,
      path: ["value", ...path],
    });
    tx.writeOrThrow(at(), {});
    tx.writeOrThrow(at("approve"), 1);
    tx.setCfcImplementationIdentity(HAND_COUNT);
    tx.writeOrThrow(at("reject"), 0);
    expect((await tx.commit()).error).toBeUndefined();

    expect(await publishCounts("counts")).toBe(false);
    expect(await publishKeys("counts")).toBe(false);
  });

  it("refuses the key set of an object another function added a key to", async () => {
    await tallyInto("counts", TALLY);
    await writeKeyAs(HAND_COUNT, "counts", (note) => note);
    expect(await publishKeys("counts")).toBe(false);
  });

  // The tally writes the whole object at once, so one derived value entry at
  // the root labels the object and everything under it; a writer that read
  // nothing then adds a key below that entry. Its transaction carries no
  // labels, which is the case the persist loop used to skip.
  const tallyWholeObject = async (cause: string): Promise<void> => {
    const tx = runtime.edit();
    tx.setCfcImplementationIdentity(TALLY);
    const brief = runtime.getCell(space, "brief", briefSchema, tx).get();
    runtime.getCell<Counts>(space, cause, undefined, tx).set({
      approve: brief.vote === "approve" ? 1 : 0,
      reject: brief.vote === "reject" ? 1 : 0,
    });
    expect((await tx.commit()).error).toBeUndefined();
  };

  const addKeyReadingNothing = async (
    identity: ImplementationIdentity | undefined,
    cause: string,
  ): Promise<void> => {
    const id = runtime.getCell(space, cause, undefined, runtime.edit())
      .getAsNormalizedFullLink().id;
    const tx = runtime.edit();
    if (identity !== undefined) tx.setCfcImplementationIdentity(identity);
    tx.writeOrThrow({
      space,
      scope: "space",
      id,
      path: ["value", "added"],
    }, 2);
    expect((await tx.commit()).error).toBeUndefined();
  };

  it("releases the key set of an object the named function wrote whole", async () => {
    await tallyWholeObject("counts");
    expect(await publishKeys("counts")).toBe(true);
  });

  it("refuses the key set of an object another function that read nothing added a key to", async () => {
    await tallyWholeObject("counts");
    await addKeyReadingNothing(HAND_COUNT, "counts");
    expect(await publishKeys("counts")).toBe(false);
  });

  it("refuses the key set of an object a writer with no identity added a key to", async () => {
    await tallyWholeObject("counts");
    await addKeyReadingNothing(undefined, "counts");
    expect(await publishKeys("counts")).toBe(false);
  });

  it("refuses an object another function has overwritten a field of", async () => {
    await tallyInto("counts", TALLY);
    await writeKeyAs(HAND_COUNT, "counts", () => "reject");
    expect(await publishCounts("counts")).toBe(false);
  });
});
