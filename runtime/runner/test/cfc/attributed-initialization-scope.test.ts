import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { JSONSchema, Pattern } from "../../src/builder/types.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import type { NormalizedFullLink } from "../../src/link-utils.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";

const creator = await Identity.fromPassphrase(
  "attributed-initialization-scope-creator",
);
const stager = await Identity.fromPassphrase(
  "attributed-initialization-scope-stager",
);
const space = creator.did();
const writer = {
  __ctWriterIdentityOf: { file: "/trusted.tsx", path: ["setAgentRunner"] },
};

// The shape of an owner-bound field a pattern keeps in a cell of its own and
// projects into its result: represents the current principal, owner-bound,
// written through one handler.
const ownedField = (description: string): JSONSchema => ({
  type: "string",
  default: "",
  description,
  ifc: {
    ownerPrincipal: { __ctCurrentPrincipal: true },
    addIntegrity: [{
      kind: "represents-principal",
      subject: { __ctCurrentPrincipal: true },
    }],
    writeAuthorizedBy: writer,
  },
});

/**
 * A pattern whose result's `agentRunner` projects an owner-bound internal
 * cell. Each call returns a new object, so the next release's setup finds a
 * pattern other than the one stored and re-stages the projection; the
 * `description` stands in for the schema change a release brings.
 */
const release = (description: string): Pattern => ({
  argumentSchema: {
    type: "object",
    properties: { title: { type: "string" } },
  },
  resultSchema: {
    type: "object",
    properties: { agentRunner: ownedField(description) },
  },
  derivedInternalCells: [{
    partialCause: "agentRunner",
    schema: ownedField(description),
  }],
  result: {
    agentRunner: { $alias: { partialCause: "agentRunner", path: [] } },
  },
  nodes: [],
});

describe("attributed-initialization-scope", () => {
  let runtime: Runtime;
  // The principal each new transaction acts as.
  let actingPrincipal: string;

  beforeEach(() => {
    actingPrincipal = creator.did();
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: StorageManager.emulate({ as: creator }),
      trustSnapshotProvider: () => ({
        id: actingPrincipal,
        actingPrincipal,
      }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
  });

  /** Prepares and commits `tx`, and returns the refusal, if any. */
  async function commit(tx: IExtendedStorageTransaction) {
    runtime.prepareTxForCommit(tx);
    return (await tx.commit().settled).error?.message;
  }

  /** Sets up `pattern` on the result cell `name` in `tx`. */
  async function setUp(
    tx: IExtendedStorageTransaction,
    name: string,
    pattern: Pattern,
  ) {
    await runtime.runner.setup(
      tx,
      pattern,
      { title: name },
      runtime.getCell(space, name, undefined, tx),
      {},
    );
  }

  /** The principals the stored label at `link` says it represents. */
  function representedBy(link: NormalizedFullLink): string[] {
    const inspect = runtime.edit();
    const stored = readStoredCfcMetadata(inspect, link);
    inspect.abort();
    return (stored?.labelMap.entries ?? [])
      .flatMap((entry) => entry.label.integrity ?? [])
      .filter((atom) =>
        (atom as { kind?: string }).kind === "represents-principal"
      )
      .map((atom) => (atom as { subject: unknown }).subject as string)
      .sort();
  }

  /** The projected `agentRunner` field of the piece on result cell `name`. */
  function agentRunnerOf(name: string): NormalizedFullLink {
    return runtime.getCell(space, name).key("agentRunner")
      .getAsNormalizedFullLink();
  }

  /** The creator brings the piece `name` into being under the first release. */
  async function create(name: string) {
    const tx = runtime.edit();
    await setUp(tx, name, release("v1"));
    expect(await commit(tx)).toBeUndefined();
    expect(representedBy(agentRunnerOf(name))).toEqual([creator.did()]);
  }

  describe("a transaction that brings one piece into being", () => {
    it("binds the new piece's owner field to the acting principal", async () => {
      actingPrincipal = stager.did();
      const tx = runtime.edit();
      await setUp(tx, "fresh", release("v1"));
      expect(await commit(tx)).toBeUndefined();
      expect(representedBy(agentRunnerOf("fresh"))).toEqual([stager.did()]);
    });

    it("re-stages another principal's piece under a new release in the same transaction, leaving its owner", async () => {
      // The rapids shape: a release adds a child to a piece someone else
      // created, and whoever starts the piece next brings the child into
      // being in the transaction that re-stages the piece's own projection.
      // The projection's re-stage is nobody's act, however the transaction
      // attributes the child's initialization.

      await create("owned");
      actingPrincipal = stager.did();
      const tx = runtime.edit();
      await setUp(tx, "child", release("v1"));
      await setUp(tx, "owned", release("v2"));
      expect(await commit(tx)).toBeUndefined();
      expect(representedBy(agentRunnerOf("owned"))).toEqual([creator.did()]);
      expect(representedBy(agentRunnerOf("child"))).toEqual([stager.did()]);
    });

    it("re-stages another principal's piece under a new release before bringing the new piece into being, leaving its owner", async () => {
      await create("owned");
      actingPrincipal = stager.did();
      const tx = runtime.edit();
      await setUp(tx, "owned", release("v2"));
      await setUp(tx, "child", release("v1"));
      expect(await commit(tx)).toBeUndefined();
      expect(representedBy(agentRunnerOf("owned"))).toEqual([creator.did()]);
      expect(representedBy(agentRunnerOf("child"))).toEqual([stager.did()]);
    });
  });

  describe("a transaction that re-stages a piece and brings none into being", () => {
    it("leaves the owner of a re-staged projection", async () => {
      await create("owned");
      actingPrincipal = stager.did();
      const tx = runtime.edit();
      await setUp(tx, "owned", release("v2"));
      expect(await commit(tx)).toBeUndefined();
      expect(representedBy(agentRunnerOf("owned"))).toEqual([creator.did()]);
    });
  });
});
