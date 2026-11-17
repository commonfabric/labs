import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import type { FabricPlainObject, FabricValue } from "@commonfabric/api";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import {
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { readStoredCfcMetadata } from "@commonfabric/runner/cfc";
import {
  compiledDocKey,
  loadVerifiedSourceClosure,
  sourceDocKey,
  writeSourceDocs,
} from "../../runner/src/compilation-cache/cell-cache.ts";
import type { CacheableModule } from "../../runner/src/harness/types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  storedFields,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { servedInstantiatePiece } from "../src/ops/served-lifecycle.ts";

const signer = await Identity.fromPassphrase("compile-cache record labels");

/** A label the programs below do not declare: their owner's bare DID. */
const UNDECLARED_ATOM = signer.did();

/**
 * A program whose argument is confidential under a `Resource` atom it
 * declares, so that a setup of it is prepared and measures what it writes.
 */
function confidentialArgumentProgram(version: string): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [{
      name: "/main.tsx",
      contents: `/// <cts-enable />
import { Confidential, NAME, pattern } from "commonfabric";
const ATOM = {
  type: "https://commonfabric.org/cfc/atom/Resource",
  class: "CompileCacheRecordLabels",
  subject: "did:example:owner",
} as const;
type Label = readonly [typeof ATOM];
interface Args { seed: Confidential<string, Label>; }
export default pattern<Args, { label: string }>(({ seed }) => ({
  [NAME]: "Record labels",
  label: ${JSON.stringify(version)} + ":" + seed,
}));
`,
    }],
  };
}

/** A program that declares no policy on anything it writes. */
const PLAIN_PROGRAM: RuntimeProgram = {
  main: "/plain.tsx",
  files: [{
    name: "/plain.tsx",
    contents: `/// <cts-enable />
import { NAME, pattern } from "commonfabric";
export default pattern<{ seed: string }, { label: string }>(({ seed }) => ({
  [NAME]: "Plain",
  label: "plain:" + seed,
}));
`,
  }],
};

describe("compile-cache-record-labels", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtimes: Runtime[];
  let space: MemorySpace;

  /** A runtime at the strict rung with flow labels persisted. */
  const strictRuntime = (): Runtime => {
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    runtimes.push(runtime);
    return runtime;
  };

  /** A controller for `space` on `runtime`, synchronized. */
  const controllerOn = async (runtime: Runtime): Promise<PiecesController> => {
    const controller = new PiecesController(
      createSession({ identity: signer, spaceDid: space }),
      runtime,
    );
    await controller.synced();
    return controller;
  };

  /**
   * The id of the record `key` names, and every confidentiality atom its
   * stored label holds.
   */
  const recordConfidentiality = (runtime: Runtime, key: string) => {
    const tx = runtime.edit();
    try {
      const id = runtime.getCell(space, key, undefined, tx)
        .getAsNormalizedFullLink().id;
      return {
        id,
        atoms: (readStoredCfcMetadata(tx, { space, id })?.labelMap.entries ??
          []).flatMap((entry) => entry.label.confidentiality ?? []),
      };
    } finally {
      tx.abort();
    }
  };

  /** Adds `entries` to the label stored on the document `id`. */
  const plantEntries = async (
    runtime: Runtime,
    id: URI,
    entries: readonly FabricValue[],
  ): Promise<void> => {
    const tx = runtime.edit();
    const address = { space, scope: "space" as const, id, path: [] };
    const stored = storedFields(tx, address) as FabricPlainObject & {
      cfc?: FabricPlainObject & {
        labelMap: FabricPlainObject & { entries: FabricValue[] };
      };
    };
    if (stored.cfc === undefined) writeSeedEnvelopeDoc(tx, space);
    const cfc = stored.cfc ?? {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: { version: 1, entries: [] },
    };
    seedStoredEnvelope(tx, address, {
      ...stored,
      cfc: {
        ...cfc,
        labelMap: {
          ...cfc.labelMap,
          entries: [...cfc.labelMap.entries, ...entries],
        },
      },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtimes = [];
    space = await strictRuntime().createSpace();
  });

  afterEach(async () => {
    for (const runtime of runtimes.reverse()) await runtime.dispose();
    await storage.close();
  });

  it("commits a fresh setup of a successor whose update read a label the program does not declare", async () => {
    // The native client's case: a piece whose stored argument carries a label
    // its program does not declare is updated, the successor's records are
    // written back once more by a session that knows another predecessor, and
    // then a new piece is set up from the successor in the same space. Its
    // setup reads the successor's records; had they taken the update's join,
    // its argument write would misfit at `/seed`.

    const first = strictRuntime();
    const firstPieces = await controllerOn(first);
    const piece = await firstPieces.create(
      confidentialArgumentProgram("v1"),
      { input: { seed: "a" } },
    );
    await first.idle();
    const predecessor = getPatternIdentityRef(piece.getCell())!.identity;
    const argument = (await piece.input.getCell()).getAsNormalizedFullLink();
    await plantEntries(first, argument.id, [{
      path: ["seed"],
      label: { confidentiality: [UNDECLARED_ATOM] },
    }]);

    await piece.setPattern(confidentialArgumentProgram("v2"));
    await first.idle();
    const successor = getPatternIdentityRef(piece.getCell())!.identity;
    expect(successor).not.toBe(predecessor);
    await first.patternManager.flushCompileCacheWrites();
    await firstPieces.synced();

    // A write-back of the successor's source records that differs from what
    // is stored, on a transaction that reads nothing labeled of its own.
    const second = strictRuntime();
    await controllerOn(second);
    const loadTx = second.edit();
    const closure = await loadVerifiedSourceClosure(
      second,
      space,
      successor,
      loadTx,
    );
    loadTx.abort();
    expect(closure).toBeDefined();
    const modules = [...closure!.entries()].map(([identity, doc]) => ({
      identity,
      filename: doc.filename,
      source: doc.code,
      js: doc.code,
      imports: doc.imports.map((imp) => ({
        specifier: imp.specifier,
        targetIdentity: imp.identity,
      })),
    } satisfies CacheableModule));
    const { error } = await second.editWithRetry((tx) => {
      writeSourceDocs(
        second,
        space,
        modules,
        successor,
        tx,
        new Map([[successor, new Set([predecessor, "another-predecessor"])]]),
      );
    });
    expect(error).toBeUndefined();

    const third = strictRuntime();
    const thirdPieces = await controllerOn(third);
    const fresh = await thirdPieces.create(confidentialArgumentProgram("v2"), {
      input: { seed: "c" },
    });
    await third.idle();
    expect(await fresh.result.get(["label"])).toBe("v2:c");
    expect(getPatternIdentityRef(fresh.getCell())!.identity).toBe(successor);
    const version = await third.patternManager.compileCacheRuntimeVersion({
      patternCoverage: false,
    });
    for (
      const key of [
        sourceDocKey(successor),
        compiledDocKey(version!, successor),
      ]
    ) {
      expect(recordConfidentiality(third, key).atoms, key).toEqual([]);
    }
  });

  describe("with the successor's records storing a label an earlier runtime left", () => {
    // A runtime that staged a source update's delegations in the transition's
    // own transaction left the piece data's label on the successor's records,
    // and a later write-back of a record moved part of it to the root. The
    // entries planted here are the ones such a runtime was measured to leave.
    // A setup that reads them consumes the label, and its argument write
    // misfits, unless the load ahead of it repairs the records.

    /** The confidentiality entries a source update's staging left. */
    const updateStamp = (atom: unknown): FabricValue[] =>
      ([
        [["delegatedModuleIdentities"], "structure", "enumerate"],
        [["delegatedModuleIdentities"], "structure", "shape"],
        [["delegatedModuleIdentities", "*"], "structure", "followRef"],
        [["delegatedModuleIdentities", "*"], "structure", "shape"],
        [["delegatedModuleIdentities", "*"], "structure", "value"],
        [["delegatedModuleIdentities", "0"], "derived", "shape"],
        [["delegatedModuleIdentities", "0"], "derived", "value"],
      ] as const).map(([path, origin, observes]) => ({
        path: [...path],
        origin,
        observes,
        label: { confidentiality: [atom as FabricValue] },
      }));

    /**
     * The confidentiality entries a write-back of a record carrying
     * {@link updateStamp} left: its root's, the compile-cache writer's
     * transformation on the value entry, and the existence entries the
     * write kept.
     */
    const writeBackStamp = (atom: unknown): FabricValue[] => [
      {
        path: [],
        origin: "derived",
        observes: "shape",
        label: { confidentiality: [atom as FabricValue] },
      },
      {
        path: [],
        origin: "derived",
        observes: "value",
        label: {
          confidentiality: [atom as FabricValue],
          integrity: [{
            type: "https://commonfabric.org/cfc/atom/TransformedBy",
            identity: { kind: "builtin", builtinId: "compile-cache" },
          }],
        },
      },
      ...updateStamp(atom).filter((entry) =>
        (entry as { observes: string }).observes === "shape"
      ),
    ];

    /**
     * The root pair alone, as measured on the source records of a real space
     * whose records a write-back left stamped: {@link writeBackStamp} without
     * the existence entries at the delegation list.
     */
    const rootPairStamp = (atom: unknown): FabricValue[] =>
      writeBackStamp(atom).filter((entry) =>
        (entry as { path: unknown[] }).path.length === 0
      );

    /**
     * Updates a piece onto `confidentialArgumentProgram("v2")` and plants
     * `entries` on the successor's source record and, unless `sourceOnly`,
     * its compiled record, and returns the keys of both.
     */
    const stampedSuccessor = async (
      entries: FabricValue[],
      sourceOnly = false,
    ): Promise<string[]> => {
      const first = strictRuntime();
      const firstPieces = await controllerOn(first);
      const piece = await firstPieces.create(
        confidentialArgumentProgram("v1"),
        {
          input: { seed: "a" },
        },
      );
      await first.idle();
      await piece.setPattern(confidentialArgumentProgram("v2"));
      await first.idle();
      const successor = getPatternIdentityRef(piece.getCell())!.identity;
      await first.patternManager.flushCompileCacheWrites();
      await firstPieces.synced();
      const version = await first.patternManager.compileCacheRuntimeVersion({
        patternCoverage: false,
      });
      const keys = [
        sourceDocKey(successor),
        compiledDocKey(version!, successor),
      ];
      for (const key of sourceOnly ? keys.slice(0, 1) : keys) {
        await plantEntries(
          first,
          recordConfidentiality(first, key).id,
          entries,
        );
      }
      return keys;
    };

    for (
      const [left, entries, sourceOnly] of [
        ["a source update", updateStamp(UNDECLARED_ATOM), false],
        ["a write-back", writeBackStamp(UNDECLARED_ATOM), false],
        [
          "a write-back at the source record's root",
          rootPairStamp(UNDECLARED_ATOM),
          true,
        ],
      ] as const
    ) {
      it(`commits a fresh setup of the successor over the label ${left} left, and leaves no label stored`, async () => {
        const keys = await stampedSuccessor(entries, sourceOnly);
        const second = strictRuntime();
        const secondPieces = await controllerOn(second);
        const fresh = await secondPieces.create(
          confidentialArgumentProgram("v2"),
          { input: { seed: "c" } },
        );
        await second.idle();

        expect(await fresh.result.get(["label"])).toBe("v2:c");
        for (const key of keys) {
          expect(recordConfidentiality(second, key).atoms, key).toEqual([]);
        }
      });
    }

    it("commits a served instantiation, its receipt included, of a program whose source record a write-back stamped at its root", async () => {
      // The instantiation writes its receipt in the setup's transaction,
      // under a schema that declares no policy, so a clause the setup
      // consumed from a stamped record misfits the receipt even where the
      // program itself declares nothing.

      const first = strictRuntime();
      const firstPieces = await controllerOn(first);
      const created = await firstPieces.create(PLAIN_PROGRAM, {
        input: { seed: "a" },
      });
      await first.idle();
      const identity = getPatternIdentityRef(created.getCell())!.identity;
      await first.patternManager.flushCompileCacheWrites();
      await firstPieces.synced();
      await plantEntries(
        first,
        recordConfidentiality(first, sourceDocKey(identity)).id,
        rootPairStamp(UNDECLARED_ATOM),
      );

      const second = strictRuntime();
      const receipt = await servedInstantiatePiece(await controllerOn(second), {
        requestKey: "compile-cache-record-labels-receipt",
        argument: { seed: "c" },
        source: { pattern: { identity, symbol: "default" } },
        actingUser: signer.did(),
      });

      expect(receipt.requestKey).toBe("compile-cache-record-labels-receipt");
      expect(recordConfidentiality(second, sourceDocKey(identity)).atoms)
        .toEqual([]);
    });
  });
});
