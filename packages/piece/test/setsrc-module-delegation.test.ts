import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  resolveEntryIdentity,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { readStoredCfcMetadata } from "@commonfabric/runner/cfc";
import {
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  setCompileCacheRuntimeVersionForTesting,
  sourceDocKey,
} from "../../runner/src/compilation-cache/cell-cache.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("setsrc module delegation");

function authorizedWriterProgram(version: string): RuntimeProgram {
  return {
    main: "/app/main.tsx",
    files: [
      {
        name: "/app/main.tsx",
        contents: `/// <cts-enable />
import {
  handler,
  pattern,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import { revision } from "../shared/revision.ts";

const setName = handler<
  { name: string },
  { name: Writable<string> }
>((event, state) => {
  state.name.set(revision + ":" + event.name);
});

export default pattern<{ seed?: string }>(() => {
  const name = new Writable<
    WriteAuthorizedBy<string, typeof setName>
  >("initial").for("name");
  return { name, setName: setName({ name }) };
});
`,
      },
      {
        name: "/shared/revision.ts",
        contents: `/// <cts-enable />
export const revision = ${JSON.stringify(version)};
`,
      },
    ],
  };
}

/**
 * The same contract in two revisions, with a confidential argument. The label
 * is what makes the piece's argument document CFC-relevant, so a transaction
 * reading it carries that clause in its flow join; the two revisions declare
 * the same label, so nothing about the swap itself weakens anything.
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
  class: "SetsrcDelegationCheck",
  subject: "did:example:owner",
} as const;
type Label = readonly [typeof ATOM];
interface Args { seed: Confidential<string, Label>; }
export default pattern<Args, { label: string }>(({ seed }) => ({
  [NAME]: "Delegation check",
  label: ${JSON.stringify(version)} + ":" + seed,
}));
`,
    }],
  };
}

describe("setsrc module delegation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("keeps a preview and a rejected setup from publishing successor authority", async () => {
    const piece = await pieces.create(authorizedWriterProgram("v1"), {
      input: {},
    });
    const previous = getPatternIdentityRef(piece.getCell())!;
    const next = authorizedWriterProgram("v2");
    const report = await piece.checkPattern(next);
    expect(report.compatible).toBe(true);
    const delegated = () => {
      const tx = runtime.edit();
      try {
        return tx.getCfcState().moduleDelegations.get(pieces.getSpace())
          ?.get(report.candidate.identity) ?? [];
      } finally {
        tx.abort();
      }
    };
    expect(delegated()).not.toContain(previous.identity);

    const prepare = runtime.prepareTxForCommit.bind(runtime);
    let refusedSetup = false;
    {
      using _rejectSetup = stub(runtime, "prepareTxForCommit", (tx) => {
        const staged = getPatternIdentityRef(piece.getCell().withTx(tx));
        if (staged?.identity === report.candidate.identity) {
          refusedSetup = true;
          expect(
            tx.getCfcState().moduleDelegations.get(pieces.getSpace())
              ?.get(report.candidate.identity),
          ).toContain(previous.identity);
          expect(delegated()).not.toContain(previous.identity);
          tx.abort("injected setup refusal");
          throw new Error("injected setup refusal");
        }
        prepare(tx);
      });
      await expect(piece.setPattern(next)).rejects.toThrow(
        "injected setup refusal",
      );
    }
    expect(refusedSetup).toBe(true);
    expect(getPatternIdentityRef(piece.getCell())).toEqual(previous);
    expect(delegated()).not.toContain(previous.identity);
    const tx = runtime.edit();
    try {
      const closure = await loadVerifiedSourceClosure(
        runtime,
        pieces.getSpace(),
        report.candidate.identity,
        tx,
      );
      expect(
        closure?.get(report.candidate.identity)?.delegatedModuleIdentities ??
          [],
      )
        .not.toContain(previous.identity);
    } finally {
      tx.abort();
    }
    expect(delegated()).not.toContain(previous.identity);

    await piece.setPattern(next);
    expect(delegated()).toContain(previous.identity);
    const result = await piece.result.getCell();
    result.key("setName").send({ name: "accepted" });
    await result.pull();
    expect(await piece.result.get(["name"])).toBe("v2:accepted");
  });

  it("publishes authority only after an incompatible source change is confirmed", async () => {
    const program = (version: string, seedType: string): RuntimeProgram => ({
      main: "/api/patterns/confirm-authority.tsx",
      files: [{
        name: "/api/patterns/confirm-authority.tsx",
        contents: `/// <cts-enable />
import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
const setName = handler<{name: string}, {name: Writable<string>}>(
  (event, state) => state.name.set(${
          JSON.stringify(version)
        } + ":" + event.name)
);
export default pattern<{seed?: ${seedType}}>(() => {
  const name = new Writable<WriteAuthorizedBy<string, typeof setName>>("initial").for("name");
  return {name, setName: setName({name})};
});`,
      }],
    });
    const piece = await pieces.create(program("old", "string"), { input: {} });
    const previous = getPatternIdentityRef(piece.getCell())!;
    const candidate = program("confirmed", "number");
    // Serves the candidate, and answers `?identity` with the identity a host
    // advertises for it.
    using _fetch = stub(globalThis, "fetch", async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return new Response(
        url.searchParams.has("identity")
          ? await resolveEntryIdentity(
            candidate.main,
            () => Promise.resolve(candidate.files[0].contents),
          )
          : candidate.files[0].contents,
        { headers: { "content-type": "text/typescript-jsx" } },
      );
    });
    const action = {
      kind: "repoint" as const,
      url: "system:confirm-authority.tsx",
    };
    const warning = await piece.changeSource(action);
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected compatibility confirmation");
    }
    const delegated = () => {
      const tx = runtime.edit();
      try {
        return tx.getCfcState().moduleDelegations.get(pieces.getSpace())
          ?.get(warning.prepared.candidate.identity) ?? [];
      } finally {
        tx.abort();
      }
    };
    expect(delegated()).not.toContain(previous.identity);
    expect(
      (await piece.changeSource(action, { confirmedChange: warning.prepared }))
        .status,
    )
      .toBe("applied");
    expect(delegated()).toContain(previous.identity);
    const result = await piece.result.getCell();
    result.key("setName").send({ name: "accepted" });
    await result.pull();
    expect(await piece.result.get(["name"])).toBe("confirmed:accepted");
  });

  it("preserves both predecessor chains when concurrent updates share a successor", async () => {
    const first = await pieces.create(authorizedWriterProgram("a"), {
      input: {},
    });
    const second = await pieces.create(authorizedWriterProgram("b"), {
      input: {},
    });
    const predecessors = [first, second].map((piece) =>
      getPatternIdentityRef(piece.getCell())!.identity
    );
    await Promise.all([
      first.setPattern(authorizedWriterProgram("shared")),
      second.setPattern(authorizedWriterProgram("shared")),
    ]);
    const successor = getPatternIdentityRef(first.getCell())!;
    expect(getPatternIdentityRef(second.getCell())).toEqual(successor);
    const tx = runtime.edit();
    try {
      const source = await loadVerifiedSourceClosure(
        runtime,
        pieces.getSpace(),
        successor.identity,
        tx,
      );
      for (const predecessor of predecessors) {
        expect(source?.get(successor.identity)?.delegatedModuleIdentities)
          .toContain(predecessor);
      }
    } finally {
      tx.abort();
    }
    for (const piece of [first, second]) {
      const result = await piece.result.getCell();
      result.key("setName").send({ name: "accepted" });
      await result.pull();
      expect(await piece.result.get(["name"])).toBe("shared:accepted");
    }
  });

  describe("in a runtime that evaluated the successor before another runtime updated the source", () => {
    // `runtime` performs the update. `observer` shares its store but
    // evaluated the successor for a piece of its own first, so it resolves
    // the updated piece's pattern from memory rather than from storage.
    let observer: Runtime;
    let observerPieces: PiecesController;

    beforeEach(async () => {
      observer = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      observerPieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: pieces.getSpace(),
        }),
        observer,
      );
      await observerPieces.synced();
      await observerPieces.create(authorizedWriterProgram("v2"), {
        input: {},
      });
    });

    afterEach(async () => {
      // The storage manager belongs to `runtime`, which the outer `afterEach`
      // disposes after this one.
      await observer.dispose({ closeStorage: false });
    });

    const invokeSetName = async (
      piece: Awaited<ReturnType<PiecesController["get"]>>,
      name: string,
    ): Promise<unknown> => {
      const result = await piece.result.getCell();
      result.key("setName").send({ name });
      await result.pull();
      return await piece.result.get(["name"]);
    };

    it("authorizes the successor's writes to a piece it swaps over", async () => {
      const piece = await pieces.create(authorizedWriterProgram("v1"), {
        input: {},
      });
      const observed = await observerPieces.get(piece.id, true);
      expect(await invokeSetName(observed, "before")).toBe("v1:before");

      await piece.setPattern(authorizedWriterProgram("v2"));
      await observer.idle();
      // The swap waits on the read of the successor's authority, which the
      // watcher tracks apart from the scheduler.
      await observer.runner.idlePointerMaintenance();

      expect(await invokeSetName(observed, "after")).toBe("v2:after");
    });

    it("authorizes the successor's writes to a piece it starts afterwards", async () => {
      const piece = await pieces.create(authorizedWriterProgram("v1"), {
        input: {},
      });
      const updater = await pieces.get(piece.id, true);
      expect(await invokeSetName(updater, "before")).toBe("v1:before");
      await piece.setPattern(authorizedWriterProgram("v2"));
      await pieces.synced();

      const observed = await observerPieces.get(piece.id, true);

      expect(await invokeSetName(observed, "after")).toBe("v2:after");
    });

    it("authorizes the successor's writes for every earlier pattern in the piece's history, not just the latest", async () => {
      // `observer` first registers v2's grant from v1 through one piece. A
      // second piece then goes v0 → v1 → v2, which extends v2's stored
      // grants to v0 as well; its field is still bound to v0.
      const first = await pieces.create(authorizedWriterProgram("v1"), {
        input: {},
      });
      await first.setPattern(authorizedWriterProgram("v2"));
      await pieces.synced();
      const firstObserved = await observerPieces.get(first.id, true);
      expect(await invokeSetName(firstObserved, "first")).toBe("v2:first");

      const second = await pieces.create(authorizedWriterProgram("v0"), {
        input: {},
      });
      const updater = await pieces.get(second.id, true);
      expect(await invokeSetName(updater, "before")).toBe("v0:before");
      await second.setPattern(authorizedWriterProgram("v1"));
      await second.setPattern(authorizedWriterProgram("v2"));
      await pieces.synced();

      const observed = await observerPieces.get(second.id, true);

      expect(await invokeSetName(observed, "after")).toBe("v2:after");
    });
  });

  it("merges predecessor chains into an already-stored successor closure", async () => {
    const first = await pieces.create(authorizedWriterProgram("v1"), {
      input: {},
    });
    const second = await pieces.create(authorizedWriterProgram("v4"), {
      input: {},
    });

    const firstRef = getPatternIdentityRef(first.getCell())!;
    const secondRef = getPatternIdentityRef(second.getCell())!;

    const invokeSetName = async (
      piece: typeof first,
      name: string,
    ): Promise<string> => {
      const result = await piece.result.getCell();
      result.key("setName").send({ name });
      await result.pull();
      return await piece.result.get(["name"]) as string;
    };

    expect(await invokeSetName(first, "before")).toBe("v1:before");

    await first.setPattern(authorizedWriterProgram("v2"));
    const intermediateRef = getPatternIdentityRef(first.getCell())!;
    expect(await invokeSetName(first, "middle")).toBe("v2:middle");
    await first.setPattern(authorizedWriterProgram("v3"));
    expect(await invokeSetName(first, "after")).toBe("v3:after");
    const successorRef = getPatternIdentityRef(first.getCell())!;

    await runtime.patternManager.flushCompileCacheWrites();
    await pieces.synced();
    const patternSpace = pieces.getSpace();

    const loadClosure = async (targetRuntime: Runtime, identity: string) => {
      const tx = targetRuntime.edit();
      try {
        return await loadVerifiedSourceClosure(
          targetRuntime,
          patternSpace,
          identity,
          tx,
        );
      } finally {
        tx.abort();
      }
    };
    const freshRuntimes: Runtime[] = [];
    try {
      const createFreshRuntime = () => {
        const freshRuntime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
        });
        // Runtime.dispose() closes the shared emulated storage manager, so all
        // cold-start runtimes stay alive until the assertions are complete.
        freshRuntimes.push(freshRuntime);
        return freshRuntime;
      };
      const createFreshPieces = async (freshRuntime: Runtime) => {
        const freshSession = createSession({
          identity: signer,
          spaceDid: patternSpace,
        });
        const freshPieces = new PiecesController(freshSession, freshRuntime);
        await freshPieces.synced();
        return freshPieces;
      };

      // Restart before the second pattern converges on the already-stored
      // successor. Use a fresh compiled-cache variant so the source document
      // contributes the first pattern's chain while the second update
      // contributes the new chain. Both sets must persist their authenticated
      // union, and that committed union must be installed in this runtime.
      const bumpedRuntimeVersion = "setsrc-delegation-shared-successor";
      const restoreRuntimeVersion = setCompileCacheRuntimeVersionForTesting(
        bumpedRuntimeVersion,
      );
      try {
        const mergeRuntime = createFreshRuntime();
        const mergePieces = await createFreshPieces(mergeRuntime);
        const mergeSecond = await mergePieces.get(second.id, true);
        await mergeSecond.setPattern(authorizedWriterProgram("v3"));
        expect(getPatternIdentityRef(mergeSecond.getCell())).toEqual(
          successorRef,
        );

        const registeredTx = mergeRuntime.edit();
        const registeredDelegations = registeredTx.getCfcState()
          .moduleDelegations.get(patternSpace)?.get(successorRef.identity) ??
          [];
        registeredTx.abort();
        expect(registeredDelegations).toContain(firstRef.identity);
        expect(registeredDelegations).toContain(intermediateRef.identity);
        expect(registeredDelegations).toContain(secondRef.identity);

        // This resolves through the successor module already evaluated for
        // mergeSecond. It therefore depends on save-time registration of the
        // complete A+B union; reloading a closure cannot rescue a partial map.
        const mergeFirst = await mergePieces.get(first.id, true);
        expect(await invokeSetName(mergeFirst, "merged")).toBe("v3:merged");

        await mergeRuntime.patternManager.flushCompileCacheWrites();
        await mergePieces.synced();

        const firstClosure = await loadClosure(mergeRuntime, firstRef.identity);
        const intermediateClosure = await loadClosure(
          mergeRuntime,
          intermediateRef.identity,
        );
        const secondClosure = await loadClosure(
          mergeRuntime,
          secondRef.identity,
        );
        const successorClosure = await loadClosure(
          mergeRuntime,
          successorRef.identity,
        );
        const byName = (closure: NonNullable<typeof firstClosure>) =>
          new Map(
            [...closure].map(([identity, doc]) => [doc.filename, identity]),
          );
        const firstByName = byName(firstClosure!);
        const intermediateByName = byName(intermediateClosure!);
        const secondByName = byName(secondClosure!);

        for (const [identity, doc] of successorClosure!) {
          if (!doc.filename.startsWith("/")) continue;
          const delegated = doc.delegatedModuleIdentities ?? [];
          expect(delegated).toContain(firstByName.get(doc.filename));
          expect(delegated).toContain(intermediateByName.get(doc.filename));
          expect(delegated).toContain(secondByName.get(doc.filename));
          expect(delegated).not.toContain(identity);
        }

        const compiledTx = mergeRuntime.edit();
        try {
          const compiledClosure = await loadCompiledClosure(
            mergeRuntime,
            patternSpace,
            successorRef.identity,
            { runtimeVersion: bumpedRuntimeVersion },
            compiledTx,
          );
          for (const [identity, sourceDoc] of successorClosure!) {
            expect(compiledClosure.get(identity)?.delegatedModuleIdentities)
              .toEqual(sourceDoc.delegatedModuleIdentities);
          }
        } finally {
          compiledTx.abort();
        }

        // A later cold runtime can warm-hit only the repaired compiled set;
        // both predecessor chains still have to authorize the first pattern.
        const coldRuntime = createFreshRuntime();
        const coldPieces = await createFreshPieces(coldRuntime);
        const coldPiece = await coldPieces.get(
          first.id,
          true,
        );
        expect(await invokeSetName(coldPiece, "cold")).toBe("v3:cold");

        const recoveredVersion = "setsrc-delegation-source-recovery";
        const restoreRecoveredVersion = setCompileCacheRuntimeVersionForTesting(
          recoveredVersion,
        );
        try {
          const recoveredRuntime = createFreshRuntime();
          const recoveredPieces = await createFreshPieces(recoveredRuntime);
          const recoveredPiece = await recoveredPieces.get(first.id, true);
          expect(await invokeSetName(recoveredPiece, "recovered"))
            .toBe("v3:recovered");
          await recoveredRuntime.patternManager.flushCompileCacheWrites();
          const recoveredTx = recoveredRuntime.edit();
          try {
            const compiled = await loadCompiledClosure(
              recoveredRuntime,
              patternSpace,
              successorRef.identity,
              { runtimeVersion: recoveredVersion },
              recoveredTx,
            );
            for (const [identity, sourceDoc] of successorClosure!) {
              expect(compiled.get(identity)?.delegatedModuleIdentities)
                .toEqual(sourceDoc.delegatedModuleIdentities);
            }
          } finally {
            recoveredTx.abort();
          }
        } finally {
          restoreRecoveredVersion();
        }
      } finally {
        restoreRuntimeVersion();
      }
    } finally {
      for (const freshRuntime of freshRuntimes.reverse()) {
        await freshRuntime.dispose();
      }
    }
  });

  it("updates a piece whose argument carries a confidentiality label", async () => {
    // The source transition stages the successor's delegation union on the
    // same transaction that moves the piece's source pointer, so that the
    // authority and the pointer land together. That transaction also reads the
    // piece's argument. Where the argument carries a label, the join reaches
    // the cache document the union is staged on, and measuring that write
    // against the ceiling a content-addressed cache document declares — none —
    // refuses the commit. At the strict rung that is a refused pattern update
    // for exactly the pieces a confidentiality label is written for.
    const strictStorage = StorageManager.emulate({ as: signer });
    const strictRuntime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: strictStorage,
      cfcEnforcementMode: "enforce-strict",
      cfcFlowLabels: "persist",
    });
    try {
      const strictPieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: await strictRuntime.createSpace(),
        }),
        strictRuntime,
      );
      await strictPieces.synced();
      const piece = await strictPieces.create(
        confidentialArgumentProgram("v1"),
        { input: { seed: "hello" } },
      );
      await strictRuntime.idle();
      const previous = getPatternIdentityRef(piece.getCell())!;

      await piece.setPattern(confidentialArgumentProgram("v2"));
      await strictRuntime.idle();

      // The swap happened, the argument survived it, and the successor
      // inherited the predecessor's writer authority.
      expect(await piece.result.get(["label"])).toBe("v2:hello");
      const successor = getPatternIdentityRef(piece.getCell())!;
      expect(successor.identity).not.toBe(previous.identity);
      const tx = strictRuntime.edit();
      try {
        const closure = await loadVerifiedSourceClosure(
          strictRuntime,
          strictPieces.getSpace(),
          successor.identity,
          tx,
        );
        expect(closure?.get(successor.identity)?.delegatedModuleIdentities)
          .toContain(previous.identity);
        // The skip decides which store the value may land in, not whether the
        // join follows it: the successor's record carries the argument's
        // clause. Without this the case would pass equally if the label had
        // stopped reaching the write at all, which is what the refusal was
        // about.
        const recordId = strictRuntime.getCell(
          strictPieces.getSpace(),
          sourceDocKey(successor.identity),
          undefined,
          tx,
        ).getAsNormalizedFullLink().id;
        const stamped = readStoredCfcMetadata(tx, {
          space: strictPieces.getSpace(),
          id: recordId,
        })?.labelMap.entries ?? [];
        expect(
          stamped.flatMap((entry) => entry.label.confidentiality ?? []),
        ).toContainEqual({
          type: "https://commonfabric.org/cfc/atom/Resource",
          class: "SetsrcDelegationCheck",
          subject: "did:example:owner",
        });
      } finally {
        tx.abort();
      }
    } finally {
      await strictRuntime.dispose();
      await strictStorage.close();
    }
  });
});
