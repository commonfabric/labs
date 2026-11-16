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

  it("refuses a fresh setup of a program whose records already store a label, and leaves that label stored", async () => {
    // Records an earlier runtime stamped, at the delegation field and at the
    // root, as a labeled transition and a later write-back leave them. A setup
    // reading them consumes the label, and its argument write misfits.
    // TODO(danfuzz): This pins a refusal that is wrong for the setup (see the
    // `TODO` on `stageModuleDelegations()`): flip it to a committed setup once
    // a repair drops the stamps the compile-cache builtin's writes left.

    const first = strictRuntime();
    const firstPieces = await controllerOn(first);
    const program = confidentialArgumentProgram("v2");
    const existing = await firstPieces.create(program, {
      input: { seed: "b" },
    });
    await first.idle();
    const identity = getPatternIdentityRef(existing.getCell())!.identity;
    await first.patternManager.flushCompileCacheWrites();
    await firstPieces.synced();
    const version = await first.patternManager.compileCacheRuntimeVersion({
      patternCoverage: false,
    });
    const keys = [sourceDocKey(identity), compiledDocKey(version!, identity)];
    for (const key of keys) {
      const { id } = recordConfidentiality(first, key);
      await plantEntries(
        first,
        id,
        [["delegatedModuleIdentities"], []].flatMap((path) => [
          {
            path,
            origin: "derived",
            observes: "shape",
            label: { confidentiality: [UNDECLARED_ATOM] },
          },
          {
            path,
            origin: "derived",
            observes: "value",
            label: { confidentiality: [UNDECLARED_ATOM] },
          },
        ]),
      );
    }

    const second = strictRuntime();
    const secondPieces = await controllerOn(second);
    await expect(secondPieces.create(program, { input: { seed: "c" } }))
      .rejects.toThrow("writer-fit confidentiality misfit");
    for (const key of keys) {
      expect(recordConfidentiality(second, key).atoms, key).toContain(
        UNDECLARED_ATOM,
      );
    }
  });
});
