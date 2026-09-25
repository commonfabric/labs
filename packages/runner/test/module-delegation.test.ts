import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { PreparedSourceUpdate } from "../src/pattern-manager.ts";
import type { JSONSchema, Pattern } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import {
  compiledDocKey,
  deriveModuleDelegations,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  type SourceDoc,
  sourceDocKey,
  stageModuleDelegations,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import {
  getPieceSourceSnapshot,
  type PieceSourceTransition,
  preparePieceSourceTransitionBaseline,
} from "../src/runner.ts";
import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";

await ensureCompilerStack();

const signer = await Identity.fromPassphrase("module delegation");
const space = signer.did();

const moduleProgram = (revision: string): RuntimeProgram => ({
  main: "/writer.ts",
  files: [{
    name: "/writer.ts",
    contents: `export const revision = ${JSON.stringify(revision)};`,
  }],
});

function moduleFor(program: RuntimeProgram): CacheableModule {
  return {
    identity: computeModuleHashes(program).get(program.main)!,
    filename: program.main,
    source: program.files[0].contents,
    js: "export const revision = 'compiled';",
    imports: [],
  };
}

/**
 * Seed a document whose `secret` field carries a confidentiality clause, so a
 * transaction reading it takes that clause into its flow join. This stands for
 * the piece argument a source transition reads on the same transaction that
 * stages the successor's delegation union.
 */
const seedLabeledSource = async (
  runtime: Runtime,
  name: string,
): Promise<void> => {
  const seed = runtime.edit();
  const id = runtime.getCell(space, name, {
    type: "object",
    properties: { secret: { type: "string" } },
  }).getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
    value: { secret: "s3cr3t" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: ["secret"] },
        }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

/** The persisted label-map entries on `id`, for pinning that a join landed. */
const replicaEntries = (
  storage: ReturnType<typeof StorageManager.emulate>,
  id: string,
): { label: { confidentiality?: string[] } }[] => {
  const replica = storage.open(space).replica as unknown as {
    getDocument(id: string): {
      cfc?: {
        labelMap?: { entries: { label: { confidentiality?: string[] } }[] };
      };
    } | undefined;
  };
  return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
};

const protectedSchema = {
  type: "object",
  properties: {
    value: {
      type: "string",
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            moduleIdentity: computeModuleHashes(moduleProgram("old")).get(
              "/writer.ts",
            )!,
            file: "/writer.ts",
            path: ["setValue"],
          },
        },
      },
    },
  },
  required: ["value"],
} as unknown as JSONSchema;

/**
 * A two-module program whose entry binds `name` to its own `setName`. `root`
 * is the directory the authored tree is grounded at, so the same tree can be
 * compiled as `/api/patterns/app/main.tsx` and as
 * `/packages/patterns/app/main.tsx`.
 */
const writerProgram = (version: string, root = ""): RuntimeProgram => ({
  main: `${root}/app/main.tsx`,
  files: [
    {
      name: `${root}/app/main.tsx`,
      contents: [
        "/// <cts-enable />",
        "import {",
        "  handler,",
        "  pattern,",
        "  type Stream,",
        "  Writable,",
        "  WriteAuthorizedBy,",
        '} from "commonfabric";',
        'import { revision } from "../shared/revision.ts";',
        "",
        "const setName = handler<",
        "  { name: string },",
        "  { name: Writable<string> }",
        ">((event, state) => {",
        '  state.name.set(revision + ":" + event.name);',
        "});",
        "",
        "// Declared, so the result document's own schema carries the claim",
        "// at `/name`, the way a profile's result schema carries its",
        "// owner-protected fields.",
        "type Output = {",
        "  name: WriteAuthorizedBy<string, typeof setName>;",
        "  setName: Stream<{ name: string }>;",
        "};",
        "",
        "export default pattern<{ seed?: string }, Output>(() => {",
        "  const name = new Writable<",
        "    WriteAuthorizedBy<string, typeof setName>",
        '  >("initial").for("name");',
        "  return { name, setName: setName({ name }) };",
        "});",
      ].join("\n"),
    },
    {
      name: `${root}/shared/revision.ts`,
      contents: `export const revision = ${JSON.stringify(version)};`,
    },
  ],
});

describe("module identity delegation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("filters invalid identities and pins each transaction's trust snapshot", () => {
    const otherSpace = "did:key:z6MkModuleDelegationOtherSpace";
    runtime.registerModuleDelegations(
      space,
      new Map([
        ["", new Set(["ignored-predecessor"])],
        ["successor", new Set(["predecessor"])],
        ["predecessor", new Set(["ancestor"])],
      ]),
    );
    runtime.registerModuleDelegations(
      otherSpace,
      new Map([["predecessor", new Set(["attacker"])]]),
    );

    const tx = runtime.edit();
    const spaceDelegations = tx.getCfcState().moduleDelegations.get(space)!;
    expect(spaceDelegations.has("")).toBe(false);
    expect(spaceDelegations.get("successor")).toEqual([
      "ancestor",
      "predecessor",
    ]);
    expect(
      tx.getCfcState().moduleDelegations.get(otherSpace)?.get("predecessor"),
    ).toEqual(["attacker"]);

    // The Runtime pins this trust snapshot when it creates the transaction.
    // Code that reaches the concrete transaction must not replace it later.
    const delegationSetter = tx as unknown as {
      setCfcModuleDelegations(
        delegations: ReadonlyMap<
          string,
          ReadonlyMap<string, readonly string[]>
        >,
      ): void;
    };
    delegationSetter.setCfcModuleDelegations(
      new Map([[space, new Map([["successor", ["attacker"]]])]]),
    );
    expect(
      tx.getCfcState().moduleDelegations.get(space)?.get("successor"),
    ).toEqual([
      "ancestor",
      "predecessor",
    ]);
    tx.abort?.("module-delegation snapshot pin test complete");
  });

  it("rejects an update when the predecessor source closure is unavailable", async () => {
    await expect(
      runtime.patternManager.prepareSourceUpdate(
        space,
        "missing-predecessor",
        "candidate",
      ),
    ).rejects.toThrow(
      "cannot authorize source update without verified source closures",
    );
  });

  it("refuses forged and mismatched source update preparations", async () => {
    const manager = runtime.patternManager;
    const forged = {} as PreparedSourceUpdate;
    expect(() => manager.sourceUpdateDelegations(forged))
      .toThrow("unrecognized source update preparation");
    const previous = moduleFor(moduleProgram("old"));
    const candidate = moduleFor(moduleProgram("new"));
    expect(
      (await runtime.editWithRetry((tx) => {
        writeSourceDocs(runtime, space, [previous], previous.identity, tx);
        writeSourceDocs(runtime, space, [candidate], candidate.identity, tx);
      })).error,
    ).toBeUndefined();
    const prepared = await manager.prepareSourceUpdate(
      space,
      previous.identity,
      candidate.identity,
    );
    const tx = runtime.edit({ sourceUpdate: prepared });
    try {
      for (
        const [proposal, targetSpace, predecessor, successor] of [
          [forged, space, previous.identity, candidate.identity],
          [prepared, signer.did(), candidate.identity, previous.identity],
          [
            prepared,
            "did:key:another-space",
            previous.identity,
            candidate.identity,
          ],
        ] as const
      ) {
        expect(() =>
          manager.stageSourceUpdate(
            proposal,
            targetSpace,
            predecessor,
            successor,
            tx,
          )
        )
          .toThrow("source update preparation does not match the transition");
      }
    } finally {
      tx.abort();
    }
    const storedTx = runtime.edit();
    try {
      const closure = await loadVerifiedSourceClosure(
        runtime,
        space,
        candidate.identity,
        storedTx,
      );
      expect(closure?.get(candidate.identity)?.delegatedModuleIdentities)
        .toBeUndefined();
      expect(
        storedTx.getCfcState().moduleDelegations.get(space)?.get(
          candidate.identity,
        ),
      ).toBeUndefined();
    } finally {
      storedTx.abort();
    }
  });

  for (const artifact of ["missing source", "untrusted compiled record"]) {
    it(`refuses a delegation update with ${artifact} without publishing staged authority`, async () => {
      const previous = moduleFor(moduleProgram("old"));
      const candidate = moduleFor(moduleProgram("new"));
      const version = "delegation-corrupt-cache";
      if (artifact === "untrusted compiled record") {
        expect(
          (await runtime.editWithRetry((tx) => {
            writeSourceDocs(
              runtime,
              space,
              [candidate],
              candidate.identity,
              tx,
            );
            runtime.getCell(
              space,
              compiledDocKey(version, candidate.identity),
              undefined,
              tx,
            )
              .set({
                identity: candidate.identity,
                kind: "compiled",
                code: "untrusted",
              });
          })).error,
        ).toBeUndefined();
      }
      const result = await runtime.editWithRetry((tx) => {
        stageModuleDelegations(
          runtime,
          space,
          new Map([[candidate.identity, new Set([previous.identity])]]),
          version,
          tx,
        );
      });
      expect(result.error?.message).toContain(
        artifact === "missing source" ? "is unavailable" : "is untrusted",
      );
      const tx = runtime.edit();
      try {
        const source = runtime.getCell<
          { delegatedModuleIdentities?: string[] }
        >(space, sourceDocKey(candidate.identity), undefined, tx).get();
        expect(source?.delegatedModuleIdentities).toBeUndefined();
        expect(
          tx.getCfcState().moduleDelegations.get(space)?.get(
            candidate.identity,
          ),
        ).toBeUndefined();
      } finally {
        tx.abort();
      }
    });
  }

  for (const artifact of ["source", "compiled"]) {
    it(`returns staged ${artifact} grants without publishing them after an abort`, async () => {
      const previous = moduleFor(moduleProgram("old"));
      const intermediate = moduleFor(moduleProgram("intermediate"));
      const candidate = moduleFor(moduleProgram("new"));
      const version = "delegation-staged-read";
      const committed = new Map([
        [candidate.identity, new Set([previous.identity])],
      ]);
      expect(
        (await runtime.editWithRetry((tx) => {
          writeSourceDocs(
            runtime,
            space,
            [candidate],
            candidate.identity,
            tx,
            committed,
          );
          writeCompiledDocs(runtime, space, [candidate], candidate.identity, {
            runtimeVersion: version,
            moduleDelegations: committed,
          }, tx);
        })).error,
      ).toBeUndefined();
      const staged = runtime.edit();
      try {
        stageModuleDelegations(
          runtime,
          space,
          new Map([[candidate.identity, new Set([intermediate.identity])]]),
          version,
          staged,
        );
        const closure = artifact === "source"
          ? await loadVerifiedSourceClosure(
            runtime,
            space,
            candidate.identity,
            staged,
          )
          : await loadCompiledClosure(runtime, space, candidate.identity, {
            runtimeVersion: version,
          }, staged);
        expect(closure?.get(candidate.identity)?.delegatedModuleIdentities)
          .toEqual(
            expect.arrayContaining([previous.identity, intermediate.identity]),
          );
      } finally {
        staged.abort();
      }
      const read = runtime.edit();
      try {
        expect(
          read.getCfcState().moduleDelegations.get(space)?.get(
            candidate.identity,
          ),
        )
          .toBeUndefined();
        const closure = artifact === "source"
          ? await loadVerifiedSourceClosure(
            runtime,
            space,
            candidate.identity,
            read,
          )
          : await loadCompiledClosure(runtime, space, candidate.identity, {
            runtimeVersion: version,
          }, read);
        expect(closure?.get(candidate.identity)?.delegatedModuleIdentities)
          .toEqual([previous.identity]);
      } finally {
        read.abort();
      }
      const reloaded = runtime.edit();
      try {
        expect(
          reloaded.getCfcState().moduleDelegations.get(space)?.get(
            candidate.identity,
          ),
        )
          .toEqual([previous.identity]);
      } finally {
        reloaded.abort();
      }
    });
  }

  it("matches canonical full paths and carries the predecessor chain", () => {
    const previous = new Map<string, SourceDoc>([
      ["old-a", {
        kind: "source",
        code: "export {};",
        filename: "/features/./writer.ts",
        imports: [],
        delegatedModuleIdentities: ["ancestor-a"],
      }],
      ["old-b", {
        kind: "source",
        code: "export {};",
        filename: "/other/writer.ts",
        imports: [],
      }],
    ]);
    const next: CacheableModule[] = [
      {
        identity: "new-a",
        filename: "/features/writer.ts",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
      {
        identity: "new-b",
        filename: "/other/writer.ts",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
    ];

    const delegations = deriveModuleDelegations(previous, next);
    expect(delegations.get("new-a")).toEqual(
      new Set(["ancestor-a", "old-a"]),
    );
    expect(delegations.get("new-b")).toEqual(new Set(["old-b"]));
  });

  it("skips ambiguous canonical filenames instead of delegating by basename", () => {
    const previous = new Map<string, SourceDoc>([
      ["old-a", {
        kind: "source",
        code: "export {};",
        filename: "/features/../writer.ts",
        imports: [],
      }],
      ["old-b", {
        kind: "source",
        code: "export {};",
        filename: "/writer.ts",
        imports: [],
      }],
    ]);
    const delegations = deriveModuleDelegations(previous, [{
      identity: "new",
      filename: "/writer.ts",
      source: "export {};",
      js: "export {};",
      imports: [],
    }]);

    expect(delegations.has("new")).toBe(false);
  });

  it("matches the entry pair, and the modules under the substituted root, when the successor spells the same tree under another root", () => {
    // One authored tree compiled twice: served over HTTP as
    // `/api/patterns/...`, and from a checkout grounded at the repository
    // root as `/packages/patterns/...`. The update names the two entries,
    // and the root each entry sits under is what carries every other
    // module across. A module outside that root keeps matching by its own
    // name.
    const previous = new Map<string, SourceDoc>([
      ["old-entry", {
        kind: "source",
        code: "export {};",
        filename: "/api/patterns/system/profile-home.tsx",
        imports: [],
        delegatedModuleIdentities: ["ancestor-entry"],
      }],
      ["old-shared", {
        kind: "source",
        code: "export {};",
        filename: "/api/patterns/shared/revision.ts",
        imports: [],
      }],
      ["old-mounted", {
        kind: "source",
        code: "export {};",
        filename: "/cf-mount/dep/util.ts",
        imports: [],
      }],
    ]);
    const next: CacheableModule[] = [
      {
        identity: "new-entry",
        filename: "/packages/patterns/system/profile-home.tsx",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
      {
        identity: "new-shared",
        filename: "/packages/patterns/shared/revision.ts",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
      {
        identity: "new-mounted",
        filename: "/cf-mount/dep/util.ts",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
    ];

    const delegations = deriveModuleDelegations(previous, next, {
      previous: "old-entry",
      next: "new-entry",
    });
    expect(delegations.get("new-entry")).toEqual(
      new Set(["ancestor-entry", "old-entry"]),
    );
    expect(delegations.get("new-shared")).toEqual(new Set(["old-shared"]));
    expect(delegations.get("new-mounted")).toEqual(new Set(["old-mounted"]));
  });

  it("matches a renamed entry to the entry it replaces, and nothing else across the rename", () => {
    // The update itself says which entry succeeds which, so the entry pair
    // matches whatever the two are called. With no root the two names
    // share, no other module is carried across on the entries' account.
    const previous = new Map<string, SourceDoc>([
      ["old-entry", {
        kind: "source",
        code: "export {};",
        filename: "/a/old-main.tsx",
        imports: [],
      }],
      ["old-shared", {
        kind: "source",
        code: "export {};",
        filename: "/a/shared.ts",
        imports: [],
      }],
    ]);
    const delegations = deriveModuleDelegations(previous, [
      {
        identity: "new-entry",
        filename: "/b/new-main.tsx",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
      {
        identity: "new-shared",
        filename: "/b/shared.ts",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
    ], { previous: "old-entry", next: "new-entry" });
    expect(delegations.get("new-entry")).toEqual(new Set(["old-entry"]));
    expect(delegations.has("new-shared")).toBe(false);
  });

  it("skips a module the substituted root would match ambiguously", () => {
    // The predecessor closure holds the shared module under both roots, so
    // the successor's one copy has two candidates; that is the same
    // ambiguity a duplicate canonical name is, and it fails closed the same
    // way.
    const previous = new Map<string, SourceDoc>([
      ["old-entry", {
        kind: "source",
        code: "export {};",
        filename: "/api/patterns/main.tsx",
        imports: [],
      }],
      ["old-shared-served", {
        kind: "source",
        code: "export {};",
        filename: "/api/patterns/shared.ts",
        imports: [],
      }],
      ["old-shared-checkout", {
        kind: "source",
        code: "export {};",
        filename: "/packages/patterns/shared.ts",
        imports: [],
      }],
    ]);
    const delegations = deriveModuleDelegations(previous, [
      {
        identity: "new-entry",
        filename: "/packages/patterns/main.tsx",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
      {
        identity: "new-shared",
        filename: "/packages/patterns/shared.ts",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
    ], { previous: "old-entry", next: "new-entry" });
    expect(delegations.get("new-entry")).toEqual(new Set(["old-entry"]));
    expect(delegations.has("new-shared")).toBe(false);
  });

  it("does not trust delegation metadata without compiler integrity", async () => {
    const oldIdentity = computeModuleHashes(moduleProgram("old")).get(
      "/writer.ts",
    )!;
    const successor = moduleFor(moduleProgram("new"));

    const sourceTx = runtime.edit();
    writeSourceDocs(runtime, space, [successor], successor.identity, sourceTx);
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    // A later ordinary write can mutate the Merkle-excluded metadata but must
    // not inherit the compiler-only attestation from the original cache write.
    const forgeTx = runtime.edit();
    const sourceCell = runtime.getCell<Record<string, unknown>>(
      space,
      sourceDocKey(successor.identity),
      undefined,
      forgeTx,
    );
    await sourceCell.sync();
    sourceCell.set({
      kind: "source",
      identity: successor.identity,
      code: successor.source,
      filename: successor.filename,
      imports: [],
      delegatedModuleIdentities: [oldIdentity],
    });
    runtime.prepareTxForCommit(forgeTx);
    expect((await forgeTx.commit()).error).toBeUndefined();

    const protectedCell = runtime.getCell<{ value: string }>(
      space,
      "module-delegation-untrusted-source",
      protectedSchema,
    );
    const seed = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: oldIdentity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "seed" });
    });
    expect(seed.error).toBeUndefined();

    const loadTx = runtime.edit();
    const closure = await loadVerifiedSourceClosure(
      runtime,
      space,
      successor.identity,
      loadTx,
    );
    loadTx.abort?.("untrusted module-delegation source load complete");
    expect(closure?.get(successor.identity)?.delegatedModuleIdentities)
      .toBeUndefined();

    const denied = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "forged" });
    }, 0);
    expect(denied.error?.message).toContain("writeAuthorizedBy failed");
  });

  it("allows a loaded successor module while keeping the binding path exact", async () => {
    const oldIdentity = computeModuleHashes(moduleProgram("old")).get(
      "/writer.ts",
    )!;
    const successor = moduleFor(moduleProgram("new"));

    const sourceTx = runtime.edit();
    writeSourceDocs(
      runtime,
      space,
      [successor],
      successor.identity,
      sourceTx,
      new Map([[successor.identity, new Set([oldIdentity])]]),
    );
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    const protectedCell = runtime.getCell<{ value: string }>(
      space,
      "module-delegation-protected-value",
      protectedSchema,
    );
    const seed = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: oldIdentity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "seed" });
    });
    expect(seed.error).toBeUndefined();

    const denied = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "before-load" });
    }, 0);
    expect(denied.error?.message).toContain("writeAuthorizedBy failed");

    const loadTx = runtime.edit();
    const closure = await loadVerifiedSourceClosure(
      runtime,
      space,
      successor.identity,
      loadTx,
    );
    loadTx.abort?.("module-delegation source load complete");
    expect(closure?.get(successor.identity)).toBeDefined();

    const allowed = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "after-load" });
    }, 0);
    expect(allowed.error).toBeUndefined();
    expect(protectedCell.get()).toEqual({ value: "after-load" });

    // Resolver-dependent source-file spelling is diagnostic once the
    // successor's authenticated delegation has established module authority.
    const differentFileAllowed = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/resolver-prefix/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "different-file" });
    }, 0);
    expect(differentFileAllowed.error).toBeUndefined();
    expect(protectedCell.get()).toEqual({ value: "different-file" });

    // Delegation grants only module authority; it must not relax which binding
    // inside that module may write the protected field.
    const wrongPathDenied = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["otherBinding"],
      });
      protectedCell.withTx(tx).set({ value: "wrong-binding" });
    }, 0);
    expect(wrongPathDenied.error?.message).toContain(
      "writeAuthorizedBy failed",
    );
    expect(protectedCell.get()).toEqual({ value: "different-file" });
  });

  it("does not import module authority from another space", async () => {
    const attacker = await Identity.fromPassphrase(
      "module delegation attacker space",
    );
    const attackerSpace = attacker.did();
    const oldIdentity = computeModuleHashes(moduleProgram("old")).get(
      "/writer.ts",
    )!;
    const successor = moduleFor(moduleProgram("new"));

    const sourceTx = runtime.edit();
    writeSourceDocs(
      runtime,
      attackerSpace,
      [successor],
      successor.identity,
      sourceTx,
      new Map([[successor.identity, new Set([oldIdentity])]]),
    );
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    const loadTx = runtime.edit();
    const closure = await loadVerifiedSourceClosure(
      runtime,
      attackerSpace,
      successor.identity,
      loadTx,
    );
    loadTx.abort?.("cross-space module-delegation source load complete");
    expect(closure?.get(successor.identity)).toBeDefined();

    const snapshotTx = runtime.edit();
    expect(
      snapshotTx.getCfcState().moduleDelegations.get(attackerSpace)?.get(
        successor.identity,
      ),
    ).toEqual([oldIdentity]);
    expect(snapshotTx.getCfcState().moduleDelegations.get(space))
      .toBeUndefined();
    snapshotTx.abort?.("cross-space module-delegation snapshot inspected");

    const protectedCell = runtime.getCell<{ value: string }>(
      space,
      "module-delegation-cross-space-value",
      protectedSchema,
    );
    const seed = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: oldIdentity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "seed" });
    });
    expect(seed.error).toBeUndefined();

    const denied = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "cross-space" });
    }, 0);
    expect(denied.error?.message).toContain("writeAuthorizedBy failed");
    expect(protectedCell.get()).toEqual({ value: "seed" });
  });

  describe("Runtime.grantsModuleDelegation()", () => {
    it("returns `true` for a direct or inherited predecessor in the registering space only", () => {
      const otherSpace = "did:key:z6MkModuleDelegationGrantOtherSpace";
      runtime.registerModuleDelegations(
        space,
        new Map([
          ["successor", new Set(["predecessor"])],
          ["predecessor", new Set(["ancestor", "successor"])],
        ]),
      );

      expect(runtime.grantsModuleDelegation(space, "successor", "predecessor"))
        .toBe(true);
      expect(runtime.grantsModuleDelegation(space, "successor", "ancestor"))
        .toBe(true);
      expect(runtime.grantsModuleDelegation(space, "ancestor", "successor"))
        .toBe(false);
      expect(runtime.grantsModuleDelegation(space, "successor", "stranger"))
        .toBe(false);
      expect(
        runtime.grantsModuleDelegation(otherSpace, "successor", "predecessor"),
      ).toBe(false);
    });
  });

  describe("PatternManager.readInheritedAuthority()", () => {
    const oldIdentity = computeModuleHashes(moduleProgram("old")).get(
      "/writer.ts",
    )!;
    const successor = moduleFor(moduleProgram("new"));

    const storeSuccessorSource = async (): Promise<void> => {
      const sourceTx = runtime.edit();
      writeSourceDocs(
        runtime,
        space,
        [successor],
        successor.identity,
        sourceTx,
        new Map([[successor.identity, new Set([oldIdentity])]]),
      );
      runtime.prepareTxForCommit(sourceTx);
      expect((await sourceTx.commit()).error).toBeUndefined();
    };

    it("returns `undefined` for a keyless identity, only itself as predecessor, or every predecessor already granted", () => {
      const pm = runtime.patternManager;
      expect(pm.readInheritedAuthority(space, "keyless:session", [oldIdentity]))
        .toBeUndefined();
      expect(pm.readInheritedAuthority(space, oldIdentity, [oldIdentity]))
        .toBeUndefined();
      expect(pm.readInheritedAuthority(space, oldIdentity, [])).toBeUndefined();

      runtime.registerModuleDelegations(
        space,
        new Map([[successor.identity, new Set([oldIdentity])]]),
      );
      expect(
        pm.readInheritedAuthority(space, successor.identity, [
          oldIdentity,
          successor.identity,
        ]),
      ).toBeUndefined();
    });

    it("returns a read when any predecessor is ungranted, though another is granted", async () => {
      runtime.registerModuleDelegations(
        space,
        new Map([[successor.identity, new Set([oldIdentity])]]),
      );

      const read = runtime.patternManager.readInheritedAuthority(
        space,
        successor.identity,
        [oldIdentity, "ungranted-predecessor"],
      );

      expect(read).toBeInstanceOf(Promise);
      await read;
    });

    it("registers the delegation the successor's stored source closure carries", async () => {
      await storeSuccessorSource();
      expect(
        runtime.grantsModuleDelegation(space, successor.identity, oldIdentity),
      ).toBe(false);

      const read = runtime.patternManager.readInheritedAuthority(
        space,
        successor.identity,
        [oldIdentity],
      );
      expect(read).toBeInstanceOf(Promise);
      await read;

      expect(
        runtime.grantsModuleDelegation(space, successor.identity, oldIdentity),
      ).toBe(true);
    });

    it("grants nothing when the space holds no source closure for the successor", async () => {
      await runtime.patternManager.readInheritedAuthority(
        space,
        successor.identity,
        [oldIdentity],
      );

      expect(
        runtime.grantsModuleDelegation(space, successor.identity, oldIdentity),
      ).toBe(false);
    });

    it("settles without a grant when reading the successor's closure fails", async () => {
      await storeSuccessorSource();

      {
        using _failingRead = stub(runtime, "getCell", () => {
          throw new Error("injected read failure");
        });
        await runtime.patternManager.readInheritedAuthority(
          space,
          successor.identity,
          [oldIdentity],
        );
      }

      expect(
        runtime.grantsModuleDelegation(space, successor.identity, oldIdentity),
      ).toBe(false);
    });
  });
  describe("a successor another runtime moved a piece to", () => {
    // `runtime` moves the piece from v1 to v2 through a source update.
    // `observer` shares its store and compiled v2 beforehand, so it resolves
    // the piece's new pattern from memory, without the closure load that
    // would register v2's grant from v1. Events queue in the runtime that
    // sends them, so the observer's own handler run is what is checked.
    let observer: Runtime;
    let v2: Pattern;
    let piece: Cell<any>;
    let observed: Cell<any>;

    beforeEach(async () => {
      observer = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      const v1 = await runtime.patternManager.compilePattern(
        writerProgram("v1"),
        { space },
      );
      v2 = await runtime.patternManager.compilePattern(writerProgram("v2"), {
        space,
      });
      await observer.patternManager.compilePattern(writerProgram("v2"), {
        space,
      });
      piece = runtime.getCell(
        space,
        "module-delegation-moved-piece",
        v1.resultSchema,
      );
      await runtime.runSynced(piece, v1, {});
      observed = observer.getCellFromLink(
        piece.getAsNormalizedFullLink(),
        v1.resultSchema,
      );
    });

    afterEach(async () => {
      // The storage manager belongs to `runtime`, which the outer
      // `afterEach` disposes after this one.
      await observer.dispose({ closeStorage: false });
    });

    const setName = async (
      target: Runtime,
      cell: Cell<any>,
      name: string,
    ): Promise<unknown> => {
      await target.editWithRetry((tx) =>
        cell.key("setName").withTx(tx).send({ name })
      );
      await target.idle();
      return await cell.key("name").pull();
    };

    const moveToV2 = async (): Promise<void> => {
      const expected = getPieceSourceSnapshot(
        piece,
        runtime.runner.sessionPatternPointerFor(piece),
      )!;
      const transition: PieceSourceTransition = {
        revisionId: crypto.randomUUID(),
        baseline: await preparePieceSourceTransitionBaseline(
          runtime,
          piece,
          expected,
        ),
        timestamp: Date.now(),
        operation: "edit",
        origin: null,
        expected,
      };
      await runtime.runSynced(piece, v2, {}, {
        expectedPatternIdentity: expected.pattern,
        pieceSourceTransition: transition,
      });
    };

    it("lets the successor write its predecessor's fields after swapping a running piece", async () => {
      await observer.start(observed);
      expect(await setName(observer, observed, "before")).toBe("v1:before");

      await moveToV2();
      await observer.idle();
      await observer.runner.idlePointerMaintenance();

      expect(await setName(observer, observed, "after")).toBe("v2:after");
    });

    it("lets the successor write its predecessor's fields after starting the piece", async () => {
      expect(await setName(runtime, piece, "before")).toBe("v1:before");
      await moveToV2();

      await observer.start(observed);

      expect(await setName(observer, observed, "after")).toBe("v2:after");
    });

    it("does not start a piece stopped while the authority read is in flight", async () => {
      await moveToV2();
      const entered = Promise.withResolvers<void>();
      const reading = Promise.withResolvers<void>();

      using _heldRead = stub(
        observer.patternManager,
        "readInheritedAuthority",
        () => {
          entered.resolve();
          return reading.promise;
        },
      );
      const started = observer.start(observed);
      await entered.promise;
      observer.runner.stop(observed);
      reading.resolve();

      expect(await started).toBe(false);
    });

    it("starts a piece whose source history is invalid without reading authority", async () => {
      const seed = runtime.edit();
      piece.withTx(seed).setMetaRaw("pieceSourceHistory", [{
        revisionId: "broken",
        timestamp: 42,
      }], rawMetaWriteAuthorization);
      expect((await seed.commit()).error).toBeUndefined();

      expect(await observer.start(observed)).toBe(true);

      expect(await setName(observer, observed, "after")).toBe("v1:after");
    });
  });

  for (
    const stage of [
      {
        name: "writes the closure",
        write: (
          runtime: Runtime,
          tx: ReturnType<Runtime["edit"]>,
          modules: readonly CacheableModule[],
          entryIdentity: string,
          predecessor: string,
          version: string,
        ) => {
          const delegations = new Map([
            [entryIdentity, new Set([predecessor])],
          ]);
          writeSourceDocs(
            runtime,
            space,
            modules,
            entryIdentity,
            tx,
            delegations,
          );
          writeCompiledDocs(runtime, space, modules, entryIdentity, {
            runtimeVersion: version,
            moduleDelegations: delegations,
          }, tx);
        },
      },
      {
        name: "stages a delegation union",
        write: (
          runtime: Runtime,
          tx: ReturnType<Runtime["edit"]>,
          _modules: readonly CacheableModule[],
          entryIdentity: string,
          predecessor: string,
          version: string,
        ) => {
          stageModuleDelegations(
            runtime,
            space,
            new Map([[entryIdentity, new Set([predecessor])]]),
            version,
            tx,
          );
        },
      },
    ]
  ) {
    it(`commits a cache write carrying a flow join when it ${stage.name}`, async () => {
      // A cache document is a store no pattern declares a policy on: its id is
      // a content address of module bytes. Measuring it refuses any
      // transaction that both reads labeled data and reaches a cache write,
      // which a piece's source transition does by construction. The assertion
      // is the COMMIT rather than the marker, so a write target the marker
      // does not reach fails this: the import edge below is stored in a
      // document of its own, which `anchorValueAsEntity` has to carry the
      // claim down to.
      const strict = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });
      try {
        const dependency = moduleFor(moduleProgram("dependency"));
        const previous = moduleFor(moduleProgram("old"));
        const entry = {
          ...moduleFor(moduleProgram("new")),
          imports: [{
            specifier: "./dependency.ts",
            targetIdentity: dependency.identity,
          }],
        };
        const modules = [entry, dependency];
        const version = "delegation-undeclarable-marker";
        // Staging reads the artifacts back, so both sets have to be there.
        expect(
          (await strict.editWithRetry((tx) => {
            writeSourceDocs(strict, space, modules, entry.identity, tx);
            writeCompiledDocs(strict, space, modules, entry.identity, {
              runtimeVersion: version,
            }, tx);
          })).error,
        ).toBeUndefined();
        await seedLabeledSource(strict, "module-delegation-secret");

        const tx = strict.edit();
        try {
          // The read that puts a confidentiality clause in the flow join,
          // standing for the piece argument a source transition reads.
          const secret = strict.getCell(
            space,
            "module-delegation-secret",
            undefined,
            tx,
          );
          expect((secret.getRaw() as { secret?: string }).secret)
            .toBe("s3cr3t");
          stage.write(
            strict,
            tx,
            modules,
            entry.identity,
            previous.identity,
            version,
          );
          tx.prepareCfc();
          const result = await tx.commit();
          expect(result.error?.message).toBeUndefined();
          // The commit is the assertion, and on its own it passes whether or
          // not the transaction ever carried a clause — so pin both halves.
          // The stamp on the record says the join reached this write, which
          // is the thing the old refusal was about; the stored value says the
          // write itself landed.
          const stamped = replicaEntries(
            storageManager,
            strict.getCell(space, sourceDocKey(entry.identity), undefined, tx)
              .getAsNormalizedFullLink().id,
          ).flatMap((label) => label.label.confidentiality ?? []);
          expect(stamped).toContain("secret");
          const readTx = strict.edit();
          try {
            const stored = strict.getCell<
              { delegatedModuleIdentities?: string[] }
            >(space, sourceDocKey(entry.identity), undefined, readTx).get();
            expect(stored?.delegatedModuleIdentities)
              .toContain(previous.identity);
          } finally {
            readTx.abort();
          }
        } finally {
          if (tx.status().status === "ready") tx.abort();
        }
      } finally {
        await strict.dispose();
      }
    });
  }
  describe("a successor compiled under another root", () => {
    // The piece runs the tree as the toolshed serves it, under
    // `/api/patterns`; the update supplies the same tree from a checkout
    // grounded at the repository root, under `/packages/patterns`. Every
    // module spells differently and so has a different identity, and the
    // successor's claims re-present each protected binding under its own
    // stamp. The update has to commit, and the successor has to be able to
    // write the field its predecessor stamped.
    const servedRoot = "/api/patterns";
    const checkoutRoot = "/packages/patterns";

    let v2: Pattern;
    let piece: Cell<any>;

    beforeEach(async () => {
      const v1 = await runtime.patternManager.compilePattern(
        writerProgram("v1", servedRoot),
        { space },
      );
      v2 = await runtime.patternManager.compilePattern(
        writerProgram("v2", checkoutRoot),
        { space },
      );
      piece = runtime.getCell(
        space,
        "module-delegation-rerooted-piece",
        v1.resultSchema,
      );
      await runtime.runSynced(piece, v1, {});
    });

    const setName = async (name: string): Promise<unknown> => {
      await runtime.editWithRetry((tx) =>
        piece.key("setName").withTx(tx).send({ name })
      );
      await runtime.idle();
      return await piece.key("name").pull();
    };

    it("commits the update and lets the successor write the field its predecessor stamped", async () => {
      expect(await setName("before")).toBe("v1:before");

      const expected = getPieceSourceSnapshot(
        piece,
        runtime.runner.sessionPatternPointerFor(piece),
      )!;
      const transition: PieceSourceTransition = {
        revisionId: crypto.randomUUID(),
        baseline: await preparePieceSourceTransitionBaseline(
          runtime,
          piece,
          expected,
        ),
        timestamp: Date.now(),
        operation: "edit",
        origin: null,
        expected,
      };
      await runtime.runSynced(piece, v2, {}, {
        expectedPatternIdentity: expected.pattern,
        pieceSourceTransition: transition,
      });

      expect(await setName("after")).toBe("v2:after");
    });
  });
});
