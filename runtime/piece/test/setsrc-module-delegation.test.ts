import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";
import type { FabricValue } from "@commonfabric/api";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
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
import { rawMetaWriteAuthorization } from "../../runner/src/meta-seam.ts";
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
    using _fetch = stub(globalThis, "fetch", () =>
      Promise.resolve(
        new Response(candidate.files[0].contents, {
          headers: { "content-type": "text/typescript-jsx" },
        }),
      ));
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

    // Fails the staging that follows each source update's commit in `on`, as
    // a runtime that stops between the two commits leaves it: the transition
    // lands, and the cache records carry no delegation.
    const refuseDelegationStaging = (on: Runtime) => {
      const stamp = on.stampServerRun.bind(on);
      return stub(on, "stampServerRun", (tx, info) => {
        if (info.actionId.startsWith("compile-cache/delegation-staging/")) {
          throw new Error("injected delegation staging failure");
        }
        stamp(tx, info);
      });
    };

    // What the successor's own cache record says it inherits, once every
    // staging either runtime started has settled.
    const storedDelegations = async (identity: string): Promise<string[]> => {
      await runtime.patternManager.flushCompileCacheWrites();
      await observer.patternManager.flushCompileCacheWrites();
      await pieces.synced();
      const tx = runtime.edit();
      try {
        const closure = await loadVerifiedSourceClosure(
          runtime,
          pieces.getSpace(),
          identity,
          tx,
        );
        return [...(closure?.get(identity)?.delegatedModuleIdentities ?? [])];
      } finally {
        tx.abort();
      }
    };

    type Piece = Awaited<ReturnType<PiecesController["get"]>>;

    // The piece's `pieceSourceDelegations` member, as stored.
    const recordedMember = (piece: Piece) =>
      piece.getCell().getMetaRaw("pieceSourceDelegations") as
        | {
          identity: string;
          delegations: { identity: string; predecessors: string[] }[];
        }
        | undefined;

    // Replaces the piece's `pieceSourceDelegations` member through the meta
    // seam; `undefined` removes it, as for a piece updated before the member.
    const replaceMember = async (
      piece: Piece,
      member: FabricValue | undefined,
    ): Promise<void> => {
      const tx = runtime.edit();
      piece.getCell().withTx(tx).setMetaRaw(
        "pieceSourceDelegations",
        member,
        rawMetaWriteAuthorization,
      );
      expect((await tx.commit().settled).error).toBeUndefined();
      await pieces.synced();
    };

    // For each transaction `on` prepares that moves `piece` off `from`, the
    // pattern it moves it to and the delegations the transaction is pinned
    // to for that pattern.
    const pinnedDelegations = (on: Runtime, piece: Piece, from: string) => {
      const pinned: { identity: string; delegations: string[] }[] = [];
      const prepare = on.prepareTxForCommit.bind(on);
      const restore = stub(on, "prepareTxForCommit", (tx) => {
        const staged = getPatternIdentityRef(
          on.getCellFromLink(piece.getCell().getAsNormalizedFullLink())
            .withTx(tx),
        );
        if (staged !== undefined && staged.identity !== from) {
          pinned.push({
            identity: staged.identity,
            delegations: [
              ...(tx.getCfcState().moduleDelegations.get(pieces.getSpace())
                ?.get(staged.identity) ?? []),
            ],
          });
        }
        prepare(tx);
      });
      return { pinned, [Symbol.dispose]: () => restore.restore() };
    };

    it("authorizes the successor's writes for every earlier pattern in the piece's history from the piece's record alone, without preparing an update, and stages them again", async () => {
      using _noStaging = refuseDelegationStaging(runtime);
      const piece = await pieces.create(authorizedWriterProgram("v0"), {
        input: {},
      });
      const v0 = getPatternIdentityRef(piece.getCell())!.identity;
      const updater = await pieces.get(piece.id, true);
      expect(await invokeSetName(updater, "before")).toBe("v0:before");
      await piece.setPattern(authorizedWriterProgram("v1"));
      const v1 = getPatternIdentityRef(piece.getCell())!.identity;
      await piece.setPattern(authorizedWriterProgram("v2"));
      const v2 = getPatternIdentityRef(piece.getCell())!.identity;
      expect(await storedDelegations(v2)).toEqual([]);
      const recorded = recordedMember(piece);
      expect(recorded?.identity).toBe(v2);
      expect(
        recorded?.delegations.find((entry) => entry.identity === v2)
          ?.predecessors,
      ).toEqual([v0, v1].sort());

      using preparing = spy(observer.patternManager, "prepareSourceUpdate");
      const observed = await observerPieces.get(piece.id, true);

      expect(await invokeSetName(observed, "after")).toBe("v2:after");
      expect(preparing.calls.length).toBe(0);
      for (const { identity, predecessors } of recorded!.delegations) {
        for (const predecessor of predecessors) {
          expect(
            observer.grantsModuleDelegation(
              pieces.getSpace(),
              identity,
              predecessor,
            ),
          ).toBe(true);
        }
      }
      // The observer's start staged them on the records again.
      expect((await storedDelegations(v2)).sort()).toEqual([v0, v1].sort());
    });

    it("authorizes the successor's writes from its cache records when the piece holds no record of its delegations", async () => {
      const piece = await pieces.create(authorizedWriterProgram("v1"), {
        input: {},
      });
      const v1 = getPatternIdentityRef(piece.getCell())!.identity;
      const updater = await pieces.get(piece.id, true);
      expect(await invokeSetName(updater, "before")).toBe("v1:before");
      await piece.setPattern(authorizedWriterProgram("v2"));
      const v2 = getPatternIdentityRef(piece.getCell())!.identity;
      expect(await storedDelegations(v2)).toContain(v1);
      await replaceMember(piece, undefined);

      const observed = await observerPieces.get(piece.id, true);

      expect(await invokeSetName(observed, "after")).toBe("v2:after");
    });

    it("refuses the successor's writes when neither the piece nor its cache records hold its delegations", async () => {
      using _noStaging = refuseDelegationStaging(runtime);
      const piece = await pieces.create(authorizedWriterProgram("v1"), {
        input: {},
      });
      const updater = await pieces.get(piece.id, true);
      expect(await invokeSetName(updater, "before")).toBe("v1:before");
      await piece.setPattern(authorizedWriterProgram("v2"));
      const v2 = getPatternIdentityRef(piece.getCell())!.identity;
      expect(await storedDelegations(v2)).toEqual([]);
      await replaceMember(piece, undefined);

      const observed = await observerPieces.get(piece.id, true);

      expect(await invokeSetName(observed, "after")).toBe("v1:before");
    });

    it("registers nothing from a record that names another pattern, as a runtime from before the record leaves it, and falls back to the cache records", async () => {
      // A runtime from before the member updates the piece from v2 to v3,
      // staging on the records in its own transaction, and leaves the member
      // naming v2. The entry planted for v3 stands for anything such a stale
      // member could hold.
      const piece = await pieces.create(authorizedWriterProgram("v1"), {
        input: {},
      });
      const updater = await pieces.get(piece.id, true);
      expect(await invokeSetName(updater, "before")).toBe("v1:before");
      await piece.setPattern(authorizedWriterProgram("v2"));
      const v2 = getPatternIdentityRef(piece.getCell())!.identity;
      const left = recordedMember(piece)!;
      expect(left.identity).toBe(v2);
      await piece.setPattern(authorizedWriterProgram("v3"));
      const v3 = getPatternIdentityRef(piece.getCell())!.identity;
      expect(await storedDelegations(v3)).toContain(v2);
      await replaceMember(piece, {
        identity: v2,
        delegations: [...left.delegations, {
          identity: v3,
          predecessors: ["planted-predecessor"],
        }],
      });

      const observed = await observerPieces.get(piece.id, true);

      expect(await invokeSetName(observed, "after")).toBe("v3:after");
      expect(
        observer.grantsModuleDelegation(
          pieces.getSpace(),
          v3,
          "planted-predecessor",
        ),
      ).toBe(false);
    });

    it("pins a later update made by a runtime that never started the piece to the earlier update's delegations as well", async () => {
      // `runtime` moves the piece from v0 to v1, and its staging never lands.
      // `observer`, which has not started the piece and so has registered
      // nothing for it, then moves it to v2.
      const piece = await pieces.create(authorizedWriterProgram("v0"), {
        input: {},
      });
      const v0 = getPatternIdentityRef(piece.getCell())!.identity;
      {
        using _noStaging = refuseDelegationStaging(runtime);
        await piece.setPattern(authorizedWriterProgram("v1"));
      }
      const v1 = getPatternIdentityRef(piece.getCell())!.identity;
      expect(await storedDelegations(v1)).toEqual([]);
      const cold = await observerPieces.get(piece.id, false);

      using pins = pinnedDelegations(observer, cold, v1);
      await cold.setPattern(authorizedWriterProgram("v2"));

      const v2 = getPatternIdentityRef(cold.getCell())!.identity;
      expect(v2).not.toBe(v1);
      expect(pins.pinned.length).toBeGreaterThan(0);
      for (const pinned of pins.pinned) {
        expect(pinned.identity).toBe(v2);
        expect(pinned.delegations.sort()).toEqual([v0, v1].sort());
      }
      expect(
        recordedMember(cold)?.delegations.find((entry) => entry.identity === v2)
          ?.predecessors,
      ).toEqual([v0, v1].sort());
    });

    it("pins a third update, made by a runtime that never started the piece, to both earlier updates' delegations", async () => {
      const piece = await pieces.create(authorizedWriterProgram("v0"), {
        input: {},
      });
      const v0 = getPatternIdentityRef(piece.getCell())!.identity;
      let v1: string;
      {
        using _noStaging = refuseDelegationStaging(runtime);
        await piece.setPattern(authorizedWriterProgram("v1"));
        v1 = getPatternIdentityRef(piece.getCell())!.identity;
        await piece.setPattern(authorizedWriterProgram("v2"));
      }
      const v2 = getPatternIdentityRef(piece.getCell())!.identity;
      expect(await storedDelegations(v2)).toEqual([]);
      const cold = await observerPieces.get(piece.id, false);

      using pins = pinnedDelegations(observer, cold, v2);
      await cold.setPattern(authorizedWriterProgram("v3"));

      const v3 = getPatternIdentityRef(cold.getCell())!.identity;
      expect(v3).not.toBe(v2);
      expect(pins.pinned.length).toBeGreaterThan(0);
      for (const pinned of pins.pinned) {
        expect(pinned.identity).toBe(v3);
        expect(pinned.delegations.sort()).toEqual([v0, v1, v2].sort());
      }
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

        // The bumped version, with the variant `mergeRuntime` compiles under.
        const mergeVersion = await mergeRuntime.patternManager
          .compileCacheRuntimeVersion({ patternCoverage: false });
        const compiledTx = mergeRuntime.edit();
        try {
          const compiledClosure = await loadCompiledClosure(
            mergeRuntime,
            patternSpace,
            successorRef.identity,
            { runtimeVersion: mergeVersion! },
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
          // The recovered version, with the variant `recoveredRuntime`
          // compiles under.
          const recoveredCacheVersion = await recoveredRuntime.patternManager
            .compileCacheRuntimeVersion({ patternCoverage: false });
          const recoveredTx = recoveredRuntime.edit();
          try {
            const compiled = await loadCompiledClosure(
              recoveredRuntime,
              patternSpace,
              successorRef.identity,
              { runtimeVersion: recoveredCacheVersion! },
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
    // The source transition reads the piece's argument, so where the argument
    // carries a label, the transition's join carries its clause. The
    // transition writes no cache record: the successor's delegation union is
    // staged on its records once the transition commits, on a transaction
    // that reads only cache records. So the update lands at the strict rung,
    // and the successor's record takes no clause from the piece's data, which
    // every later setup of the module reads.
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
      await strictRuntime.patternManager.flushCompileCacheWrites();

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
        // The delegation union above is on the record, and the argument's
        // clause is not.
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
        ).not.toContainEqual({
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
