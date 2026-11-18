import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { spy, stub } from "@std/testing/mock";
import type { FabricValue } from "@commonfabric/api";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  getPieceSourceSnapshot,
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
/**
 * `authorizedWriterProgram()`'s contract with the handler in a module of its
 * own, `/app/<file>`: `writer` picks that module's content and `entry` the
 * entry's, so an update can change one and leave the other as it was.
 */
function splitWriterProgram(
  writer: string,
  entry: string,
  file = "writer.ts",
): RuntimeProgram {
  return {
    main: "/app/main.tsx",
    files: [
      {
        name: "/app/main.tsx",
        contents: `/// <cts-enable />
import { pattern, Writable, WriteAuthorizedBy } from "commonfabric";
import { setName } from "./${file}";
export const entry = ${JSON.stringify(entry)};
export default pattern<{ seed?: string }>(() => {
  const name = new Writable<
    WriteAuthorizedBy<string, typeof setName>
  >("initial").for("name");
  return { name, setName: setName({ name }) };
});
`,
      },
      {
        name: `/app/${file}`,
        contents: `/// <cts-enable />
import { handler, Writable } from "commonfabric";
export const setName = handler<
  { name: string },
  { name: Writable<string> }
>((event, state) => {
  state.name.set(${JSON.stringify(writer)} + ":" + event.name);
});
`,
      },
    ],
  };
}

/**
 * `splitWriterProgram(writer, entry)` under a new entry, `/app/main2.tsx`,
 * that re-exports it, so that the old entry stays in the closure as a module
 * of it, and `tag` picks the new entry's content.
 */
function wrappedWriterProgram(
  writer: string,
  entry: string,
  tag: string,
): RuntimeProgram {
  return {
    main: "/app/main2.tsx",
    files: [
      {
        name: "/app/main2.tsx",
        contents: `/// <cts-enable />
import inner from "./main.tsx";
export const entry2 = ${JSON.stringify(tag)};
export default inner;
`,
      },
      ...splitWriterProgram(writer, entry).files,
    ],
  };
}

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

    // Every delegation list the closure of `identity` stores, by record: each
    // module's source record, and its compiled record for `runtimeVersion`
    // (this runtime's, by default).
    const closureRecords = async (
      identity: string,
      runtimeVersion?: string,
    ): Promise<Record<string, string[]>> => {
      await runtime.patternManager.flushCompileCacheWrites();
      await observer.patternManager.flushCompileCacheWrites();
      await pieces.synced();
      const version = runtimeVersion ??
        await runtime.patternManager.compileCacheRuntimeVersion({
          patternCoverage: false,
        });
      const tx = runtime.edit();
      try {
        const lists: Record<string, string[]> = {};
        const source = await loadVerifiedSourceClosure(
          runtime,
          pieces.getSpace(),
          identity,
          tx,
        );
        for (const [module, doc] of source ?? []) {
          lists[`source ${module}`] = [
            ...(doc.delegatedModuleIdentities ?? []),
          ];
        }
        const compiled = await loadCompiledClosure(
          runtime,
          pieces.getSpace(),
          identity,
          { runtimeVersion: version! },
          tx,
        );
        for (const [module, doc] of compiled) {
          lists[`compiled ${module}`] = [
            ...(doc.delegatedModuleIdentities ?? []),
          ];
        }
        return lists;
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
          edges: {
            identity: string;
            predecessors: {
              identity: string;
              at: number[];
              terminal: number[];
            }[];
          }[];
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

    it("authorizes the successor's writes for every earlier pattern in the piece's history from the piece's record alone, without preparing an update", async () => {
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

      // A start derives and closes nothing: both of the paths that compose a
      // record go unused, and the member stays as it was.
      using preparing = spy(observer.patternManager, "prepareSourceUpdate");
      using proposing = spy(
        observer.patternManager,
        "proposedSourceUpdateDelegations",
      );
      const observed = await observerPieces.get(piece.id, true);

      expect(await invokeSetName(observed, "after")).toBe("v2:after");
      expect(preparing.calls.length).toBe(0);
      expect(proposing.calls.length).toBe(0);
      expect(recordedMember(piece)).toEqual(recorded);
      // Every entry for a module of v2's closure is registered. The member
      // also carries v1's modules' entries, for a module that returns.
      const closureTx = runtime.edit();
      const v2Modules = new Set(
        (await loadVerifiedSourceClosure(
          runtime,
          pieces.getSpace(),
          v2,
          closureTx,
        ))?.keys(),
      );
      closureTx.abort();
      const registered = recorded!.delegations.filter(({ identity }) =>
        v2Modules.has(identity)
      );
      expect(registered.length).toBeGreaterThan(0);
      for (const { identity, predecessors } of registered) {
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
      // The observer's start wrote nothing.
      expect(await storedDelegations(v2)).toEqual([]);
    });

    it("stages what a failed staging missed with the piece's next committed update", async () => {
      const piece = await pieces.create(authorizedWriterProgram("v0"), {
        input: {},
      });
      const v0 = getPatternIdentityRef(piece.getCell())!.identity;
      const updater = await pieces.get(piece.id, true);
      expect(await invokeSetName(updater, "before")).toBe("v0:before");
      {
        using _noStaging = refuseDelegationStaging(runtime);
        await piece.setPattern(authorizedWriterProgram("v1"));
      }
      const v1 = getPatternIdentityRef(piece.getCell())!.identity;
      // Between the two updates the record lacks the grant, and the piece's
      // member holds it.
      expect(await storedDelegations(v1)).toEqual([]);
      const between = await observerPieces.get(piece.id, true);
      expect(await invokeSetName(between, "between")).toBe("v1:between");
      expect(await storedDelegations(v1)).toEqual([]);

      await piece.setPattern(authorizedWriterProgram("v2"));
      const v2 = getPatternIdentityRef(piece.getCell())!.identity;

      expect((await storedDelegations(v2)).sort()).toEqual([v0, v1].sort());
    });

    it("writes nothing to the cache records when it starts a piece, whatever the piece's member records", async () => {
      // A member planted with a predecessor no update granted: the start
      // registers it in the runtime that starts the piece, the residual the
      // conformance statement records, but it reaches no record.
      const piece = await pieces.create(authorizedWriterProgram("v1"), {
        input: {},
      });
      const v1 = getPatternIdentityRef(piece.getCell())!.identity;
      await piece.setPattern(authorizedWriterProgram("v2"));
      const v2 = getPatternIdentityRef(piece.getCell())!.identity;
      expect(await storedDelegations(v2)).toEqual([v1]);
      await replaceMember(piece, {
        identity: v2,
        delegations: [{ identity: v2, predecessors: [v1, "planted"] }],
      });
      const before = await closureRecords(v2);
      expect(Object.keys(before).length).toBeGreaterThan(1);

      await observerPieces.get(piece.id, true);

      expect(
        observer.grantsModuleDelegation(pieces.getSpace(), v2, "planted"),
      ).toBe(true);
      expect(await closureRecords(v2)).toEqual(before);

      // A runtime of another compile-cache version holds no compiled record
      // for v2, so its start compiles v2 and writes the compiled records
      // back, from the source records' lists.
      const coldVersion = "setsrc-module-delegation-cold-start";
      const cold = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      const restoreVersion = setCompileCacheRuntimeVersionForTesting(
        coldVersion,
      );
      try {
        const coldPieces = new PiecesController(
          createSession({ identity: signer, spaceDid: pieces.getSpace() }),
          cold,
        );
        await coldPieces.synced();
        await coldPieces.get(piece.id, true);
        await cold.patternManager.flushCompileCacheWrites();
        await coldPieces.synced();
        const written = await closureRecords(v2, coldVersion);
        const compiled = Object.entries(written).filter(([record]) =>
          record.startsWith("compiled ")
        );
        expect(compiled.length).toBeGreaterThan(0);
        expect(written[`compiled ${v2}`]).toEqual([v1]);
        for (const [record, list] of Object.entries(written)) {
          expect(list, record).not.toContain("planted");
        }
      } finally {
        restoreVersion();
        await cold.dispose({ closeStorage: false });
      }
    });

    it("refuses an update prepared before another runtime's update moved the piece, and writes nothing", async () => {
      // `observer` prepares v1 to v2b and is held there; `runtime` then
      // moves the piece from v1 to v2a. The held update is refused, and its
      // caller reports that; nothing retries it. The pointer's guard refuses
      // it first; the member's own guard, for a member that changed with the
      // pointer in place, is pinned in `pattern-source.test.ts`.
      const piece = await pieces.create(authorizedWriterProgram("v1"), {
        input: {},
      });
      const other = await observerPieces.get(piece.id, false);
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const prepare = observer.patternManager.prepareSourceUpdate.bind(
        observer.patternManager,
      );
      using _held = stub(
        observer.patternManager,
        "prepareSourceUpdate",
        async (...args) => {
          const prepared = await prepare(...args);
          entered.resolve();
          await released.promise;
          return prepared;
        },
      );
      const racing = other.setPattern(authorizedWriterProgram("v2b"));
      await entered.promise;
      await piece.setPattern(authorizedWriterProgram("v2a"));
      const v2a = getPatternIdentityRef(piece.getCell())!.identity;
      const member = recordedMember(piece);
      released.resolve();

      // Refused by the setup's own guard on a pointer that moved, before the
      // transition's: either names the piece as having changed.
      await expect(racing).rejects.toThrow(/changed while/);
      await observerPieces.synced();
      await pieces.synced();
      expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(v2a);
      expect(recordedMember(piece)).toEqual(member);
      expect(member?.identity).toBe(v2a);
    });

    it("keeps the recorded grant of a module an update leaves unchanged", async () => {
      // The writer module changes from v0 to v1 and stays as it is in v2.
      // v0 to v1's staging never lands, so only the member holds w1's grant
      // from w0 when a runtime that never started the piece makes the next
      // update.
      const fresh = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      try {
        const freshPieces = new PiecesController(
          createSession({ identity: signer, spaceDid: pieces.getSpace() }),
          fresh,
        );
        await freshPieces.synced();
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        const cold = await observerPieces.get(piece.id, false);
        await cold.setPattern(splitWriterProgram("w1", "e2"));
        await observer.patternManager.flushCompileCacheWrites();
        await observerPieces.synced();

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("keeps the recorded grant of a module that leaves the pattern and returns", async () => {
      // v1's writer module is gone from v2, which writes through a module of
      // another name, and back, byte for byte, in v3. v0 to v1's staging never
      // lands, so only the member, through v2, holds w1's grant from w0.
      const fresh = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      try {
        const freshPieces = new PiecesController(
          createSession({ identity: signer, spaceDid: pieces.getSpace() }),
          fresh,
        );
        await freshPieces.synced();
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        await piece.setPattern(splitWriterProgram("w2", "e2", "other.ts"));
        const cold = await observerPieces.get(piece.id, false);
        await cold.setPattern(splitWriterProgram("w1", "e3"));
        await observer.patternManager.flushCompileCacheWrites();
        await observerPieces.synced();

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("keeps the recorded grant of a module that returns after another module took its file", async () => {
      // v1's writer leaves in v2; v3 puts an unrelated writer at its file, and
      // v4 brings v1's back, byte for byte. Nothing at the file in v3 descends
      // from v1's writer, so only the member's own entry for it keeps its
      // grant from w0 once v0 to v1's staging failed.
      const fresh = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      try {
        const freshPieces = new PiecesController(
          createSession({ identity: signer, spaceDid: pieces.getSpace() }),
          fresh,
        );
        await freshPieces.synced();
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        await piece.setPattern(splitWriterProgram("w2", "e2", "other.ts"));
        await piece.setPattern(splitWriterProgram("unrelated", "e3"));
        const cold = await observerPieces.get(piece.id, false);
        await cold.setPattern(splitWriterProgram("w1", "e4"));
        await observer.patternManager.flushCompileCacheWrites();
        await observerPieces.synced();

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("keeps the recorded grant of a module across a transition that is no source update", async () => {
      // v0 to v1 changes the writer, and its staging never lands. v1 to v2
      // changes only the entry, through a transition whose baseline does not
      // retain v1, as for an update from an origin nobody gates. A writer's
      // cache record would keep its grant over that transition; so does the
      // member, re-keyed to v2. v2's entry gets nothing.
      const fresh = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      try {
        const freshPieces = new PiecesController(
          createSession({ identity: signer, spaceDid: pieces.getSpace() }),
          fresh,
        );
        await freshPieces.synced();
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const e0 = getPatternIdentityRef(piece.getCell())!.identity;
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        const e1 = getPatternIdentityRef(piece.getCell())!.identity;
        const cell = piece.getCell();
        const v2 = await runtime.patternManager.compilePattern(
          splitWriterProgram("w1", "e2"),
          { space: pieces.getSpace() },
        );
        const expected = getPieceSourceSnapshot(
          cell,
          runtime.runner.sessionPatternPointerFor(cell),
        )!;
        await runtime.runSynced(cell, v2, {}, {
          expectedPatternIdentity: expected.pattern,
          pieceSourceTransition: {
            revisionId: crypto.randomUUID(),
            baseline: { kind: "unavailable" },
            timestamp: Date.now(),
            operation: "edit",
            origin: null,
            expected,
          },
        });
        await pieces.synced();
        const e2 = getPatternIdentityRef(cell)!.identity;
        expect(e2).not.toBe(e1);

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
        expect(recordedMember(piece)?.identity).toBe(e2);
        for (const predecessor of [e0, e1]) {
          expect(
            fresh.grantsModuleDelegation(pieces.getSpace(), e2, predecessor),
          ).toBe(false);
        }
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    // A fresh runtime on the shared store, set up for the piece's space, and
    // the piece controller it starts pieces through.
    const freshController = async (): Promise<{
      on: Runtime;
      controller: PiecesController;
    }> => {
      const on = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      const controller = new PiecesController(
        createSession({ identity: signer, spaceDid: pieces.getSpace() }),
        on,
      );
      await controller.synced();
      return { on, controller };
    };

    it("keeps the recorded grant of a module whose replacement was granted nothing", async () => {
      // v0 to v1 changes the writer, and its staging never lands. v1 to v2
      // replaces the writer through a transition that is no source update,
      // so v2's writer holds none of w1's grant. v3 replaces it again by a
      // source update, and v4 brings w1 back, byte for byte. w1's edge to w0
      // stays in the member's edges throughout.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        const cell = piece.getCell();
        const v2 = await runtime.patternManager.compilePattern(
          splitWriterProgram("w2", "e2"),
          { space: pieces.getSpace() },
        );
        const expected = getPieceSourceSnapshot(
          cell,
          runtime.runner.sessionPatternPointerFor(cell),
        )!;
        await runtime.runSynced(cell, v2, {}, {
          expectedPatternIdentity: expected.pattern,
          pieceSourceTransition: {
            revisionId: crypto.randomUUID(),
            baseline: { kind: "unavailable" },
            timestamp: Date.now(),
            operation: "edit",
            origin: null,
            expected,
          },
        });
        await pieces.synced();
        await piece.setPattern(splitWriterProgram("w3", "e3"));
        const cold = await observerPieces.get(piece.id, false);
        await cold.setPattern(splitWriterProgram("w1", "e4"));
        await observer.patternManager.flushCompileCacheWrites();
        await observerPieces.synced();

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    for (const staging of ["landed", "failed"] as const) {
      it(`keeps the member's edges linear in derivations over updates that change every module, with every staging ${staging}`, async () => {
        // Each update replaces the entry and the writer. The edges gain one
        // direct edge per replaced module per update: where the stagings
        // land, the records' closed lists add none. The delegations hold one
        // entry per module of the running pattern, listing every earlier
        // version of it.
        using _staging = staging === "failed"
          ? refuseDelegationStaging(runtime)
          : undefined;
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        for (let update = 1; update <= 8; update++) {
          await piece.setPattern(
            splitWriterProgram(`w${update}`, `e${update}`),
          );
          await runtime.patternManager.flushCompileCacheWrites();
          const recorded = recordedMember(piece)!;
          expect(recorded.delegations.length).toBe(2);
          expect(
            recorded.delegations.map(({ predecessors }) => predecessors.length),
          ).toEqual([update, update]);
          expect(recorded.edges.length).toBe(2 * update);
          expect(
            recorded.edges.every(({ predecessors }) =>
              predecessors.length === 1 && predecessors[0].at.length === 1
            ),
          ).toBe(true);
        }
      });
    }

    it("keeps the grant of a module whose successor left before it returned", async () => {
      // v0 to v1's staging never lands. v2's writer succeeds w1, v3 drops
      // that writer, v4 puts an unrelated one at its file, and v5 brings w1
      // back: w1 derives only from the unrelated writer, and its own edge to
      // w0 still grants it, as `main`'s record of w1 does.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        await piece.setPattern(splitWriterProgram("w2", "e2"));
        await piece.setPattern(splitWriterProgram("w3", "e3", "other.ts"));
        await piece.setPattern(splitWriterProgram("unrelated", "e4"));
        await piece.setPattern(splitWriterProgram("w1", "e5"));
        await runtime.patternManager.flushCompileCacheWrites();
        await pieces.synced();

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("keeps the grant of a module a successor replaced, when a transition that is no source update reverts to it, and after a later update", async () => {
      // v0 to v1's staging never lands; v1 to v2 is a source update whose
      // staging lands, so w2 succeeds w1; a transition that is no source
      // update then reverts to v1. w1 keeps its grant from w0, and so does
      // the writer of a later honest update from v1.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        await piece.setPattern(splitWriterProgram("w2", "e2"));
        await moveWithoutUpdate(piece, splitWriterProgram("w1", "e1"));

        const reverted = await freshPieces.get(piece.id, true);
        expect(await invokeSetName(reverted, "b")).toBe("w1:b");

        await piece.setPattern(splitWriterProgram("w3", "e3"));
        const cold = await observerPieces.get(piece.id, true);
        expect(await invokeSetName(cold, "c")).toBe("w3:c");
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("keeps the grant of a module a successor replaced, when an ordinary update brings it back after its file was renamed away", async () => {
      // v0 to v1's staging never lands; w2 succeeds w1 at v2; v3 moves the
      // writer to another file, so no module has w1's; v4 is an ordinary
      // update back to v1's writer, which derives from nothing.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        await piece.setPattern(splitWriterProgram("w2", "e2"));
        await piece.setPattern(splitWriterProgram("w2", "e3", "other.ts"));
        await piece.setPattern(splitWriterProgram("w1", "e4"));
        await runtime.patternManager.flushCompileCacheWrites();
        await pieces.synced();

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    // The identity of the module at `filename` in the closure of `entry`.
    const moduleAt = async (entry: string, filename: string) => {
      await runtime.patternManager.flushCompileCacheWrites();
      await pieces.synced();
      const tx = runtime.edit();
      try {
        const closure = await loadVerifiedSourceClosure(
          runtime,
          pieces.getSpace(),
          entry,
          tx,
        );
        const found = [...(closure ?? [])].find(([, doc]) =>
          doc.filename === filename
        );
        expect(found, filename).toBeDefined();
        return found![0];
      } finally {
        tx.abort();
      }
    };

    // Moves `piece` to `next` through a transition that is no source update:
    // its baseline does not retain the running pattern, as for an update
    // from an origin nobody gates.
    const moveWithoutUpdate = async (
      piece: Piece,
      next: RuntimeProgram,
    ): Promise<void> => {
      await pieces.synced();
      const cell = piece.getCell();
      const compiled = await runtime.patternManager.compilePattern(next, {
        space: pieces.getSpace(),
      });
      const expected = getPieceSourceSnapshot(
        cell,
        runtime.runner.sessionPatternPointerFor(cell),
      )!;
      await runtime.runSynced(cell, compiled, {}, {
        expectedPatternIdentity: expected.pattern,
        pieceSourceTransition: {
          revisionId: crypto.randomUUID(),
          baseline: { kind: "unavailable" },
          timestamp: Date.now(),
          operation: "edit",
          origin: null,
          expected,
        },
      });
      await pieces.synced();
    };

    it("grants new modules nothing over transitions that are no source update, and keeps an unchanged module's grant", async () => {
      // v0 to v1 changes the writer, and its staging never lands. Two
      // transitions that are no source update follow: one to an unrelated
      // writer, and one back to v1's writer, byte for byte, under a new
      // entry. Only that writer's grant from w0 holds, as `main`'s records
      // of it would give.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const e0 = getPatternIdentityRef(piece.getCell())!.identity;
        const w0 = await moduleAt(e0, "/app/writer.ts");
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        const e1 = getPatternIdentityRef(piece.getCell())!.identity;
        const w1 = await moduleAt(e1, "/app/writer.ts");
        await moveWithoutUpdate(piece, splitWriterProgram("w9", "eC"));
        const eC = getPatternIdentityRef(piece.getCell())!.identity;
        const w9 = await moduleAt(eC, "/app/writer.ts");
        await moveWithoutUpdate(piece, splitWriterProgram("w1", "eC2"));
        const eC2 = getPatternIdentityRef(piece.getCell())!.identity;
        expect(await moduleAt(eC2, "/app/writer.ts")).toBe(w1);

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
        const space = pieces.getSpace();
        expect(fresh.grantsModuleDelegation(space, w1, w0)).toBe(true);
        for (
          const [module, predecessor] of [
            [eC2, e0],
            [eC2, e1],
            [eC2, eC],
            [w9, w0],
            [w1, w9],
          ]
        ) {
          expect(
            fresh.grantsModuleDelegation(space, module, predecessor),
            `${module} <- ${predecessor}`,
          ).toBe(false);
        }
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("grants a pattern a transition that is no source update reverts to nothing from the entries it carries", async () => {
      // v1 to v2 is a source update whose staging lands; a transition that
      // is no source update then reverts to v1. The member carries v2's
      // entries back, keyed by v2's modules, and v1's modules get none of
      // them: w1 keeps only what its own record grants.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const e0 = getPatternIdentityRef(piece.getCell())!.identity;
        const w0 = await moduleAt(e0, "/app/writer.ts");
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        await piece.setPattern(splitWriterProgram("w1", "e1"));
        const e1 = getPatternIdentityRef(piece.getCell())!.identity;
        const w1 = await moduleAt(e1, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("w2", "e2"));
        const e2 = getPatternIdentityRef(piece.getCell())!.identity;
        const w2 = await moduleAt(e2, "/app/writer.ts");
        await moveWithoutUpdate(piece, splitWriterProgram("w1", "e1"));
        expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(e1);
        expect(recordedMember(piece)?.identity).toBe(e1);

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
        const space = pieces.getSpace();
        expect(fresh.grantsModuleDelegation(space, w1, w0)).toBe(true);
        expect(fresh.grantsModuleDelegation(space, w1, w2)).toBe(false);
        expect(fresh.grantsModuleDelegation(space, e1, e2)).toBe(false);
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    // Each of these compares what a fresh runtime grants with what a fresh
    // `main` runtime grants from the records the same updates stage there.

    it("grants a pattern a transition that is no source update reverts to, after a cycle of updates, nothing it was granted later", async () => {
      // X to A to Y to X by source updates whose staging lands, then a move
      // back to A that is no source update. A's own record on `main` is [X]:
      // the edge X <- Y came after A was granted X.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("wX", "eX"), {
          input: {},
        });
        const eX = getPatternIdentityRef(piece.getCell())!.identity;
        const wX = await moduleAt(eX, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("wA", "eA"));
        const eA = getPatternIdentityRef(piece.getCell())!.identity;
        const wA = await moduleAt(eA, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("wY", "eY"));
        const eY = getPatternIdentityRef(piece.getCell())!.identity;
        const wY = await moduleAt(eY, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("wX", "eX"));
        await moveWithoutUpdate(piece, splitWriterProgram("wA", "eA"));
        expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(eA);

        await freshPieces.get(piece.id, true);

        const space = pieces.getSpace();
        expect(fresh.grantsModuleDelegation(space, wA, wX)).toBe(true);
        expect(fresh.grantsModuleDelegation(space, eA, eX)).toBe(true);
        expect(fresh.grantsModuleDelegation(space, wA, wY)).toBe(false);
        expect(fresh.grantsModuleDelegation(space, eA, eY)).toBe(false);
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("grants a pattern a source update reverts to, after a cycle of updates, what its predecessor holds then", async () => {
      // The same cycle, but the move back to A is a source update, which
      // grants A what X holds at that point, Y among it, as `main` stages.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("wX", "eX"), {
          input: {},
        });
        const eX = getPatternIdentityRef(piece.getCell())!.identity;
        const wX = await moduleAt(eX, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("wA", "eA"));
        const eA = getPatternIdentityRef(piece.getCell())!.identity;
        const wA = await moduleAt(eA, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("wY", "eY"));
        const eY = getPatternIdentityRef(piece.getCell())!.identity;
        const wY = await moduleAt(eY, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("wX", "eX"));
        await piece.setPattern(splitWriterProgram("wA", "eA"));

        await freshPieces.get(piece.id, true);

        const space = pieces.getSpace();
        for (
          const [module, predecessor] of [[wA, wX], [wA, wY], [eA, eX], [
            eA,
            eY,
          ]]
        ) {
          expect(
            fresh.grantsModuleDelegation(space, module, predecessor),
            `${module} <- ${predecessor}`,
          ).toBe(true);
        }
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("grants a pattern a transition that is no source update reverts to what its predecessor held when it was granted, though that edge was recorded again later", async () => {
      // X to A to B to X to A by source updates, then a move to B that is no
      // source update. B was granted A when A held X, and the edge A <- X is
      // recorded again after that: B keeps A and X, which `main`'s record of
      // B lists. A to B's staging never lands, so only the piece's record
      // can grant them here.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("wX", "eX"), {
          input: {},
        });
        const eX = getPatternIdentityRef(piece.getCell())!.identity;
        const wX = await moduleAt(eX, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("wA", "eA"));
        const eA = getPatternIdentityRef(piece.getCell())!.identity;
        const wA = await moduleAt(eA, "/app/writer.ts");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("wB", "eB"));
        }
        const eB = getPatternIdentityRef(piece.getCell())!.identity;
        const wB = await moduleAt(eB, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("wX", "eX"));
        await piece.setPattern(splitWriterProgram("wA", "eA"));
        await moveWithoutUpdate(piece, splitWriterProgram("wB", "eB"));
        expect(getPatternIdentityRef(piece.getCell())?.identity).toBe(eB);

        await freshPieces.get(piece.id, true);

        const space = pieces.getSpace();
        for (const [module, predecessor] of [[wB, wA], [wB, wX]]) {
          expect(
            fresh.grantsModuleDelegation(space, module, predecessor),
            `${module} <- ${predecessor}`,
          ).toBe(true);
        }
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("grants what another piece added to a predecessor's record only to a module that succeeded the predecessor after it", async () => {
      // Piece `a` goes X to Y. Piece `b` goes Q to X, so X's record lists Q
      // from then on. `a` goes Y to X to Y2: Y2 succeeds X after Q was
      // added, and gets Q, as `main`'s record of Y2 lists. A move that is no
      // source update then returns `a` to Y, which succeeded X before Q was
      // added: `main`'s record of Y does not list Q, and Y gets none of it.
      const { on: atY2, controller: atY2Pieces } = await freshController();
      const { on: atY, controller: atYPieces } = await freshController();
      try {
        const a = await pieces.create(splitWriterProgram("wX", "eX"), {
          input: {},
        });
        const eX = getPatternIdentityRef(a.getCell())!.identity;
        const wX = await moduleAt(eX, "/app/writer.ts");
        await a.setPattern(splitWriterProgram("wY", "eY"));
        const eY = getPatternIdentityRef(a.getCell())!.identity;
        const wY = await moduleAt(eY, "/app/writer.ts");
        const b = await pieces.create(splitWriterProgram("wQ", "eQ"), {
          input: {},
        });
        const eQ = getPatternIdentityRef(b.getCell())!.identity;
        const wQ = await moduleAt(eQ, "/app/writer.ts");
        await b.setPattern(splitWriterProgram("wX", "eX"));
        await a.setPattern(splitWriterProgram("wX", "eX"));
        {
          // Only the piece's record can grant Y2 what X's record lists.
          using _noStaging = refuseDelegationStaging(runtime);
          await a.setPattern(splitWriterProgram("wY2", "eY2"));
        }
        const eY2 = getPatternIdentityRef(a.getCell())!.identity;
        const wY2 = await moduleAt(eY2, "/app/writer.ts");
        const space = pieces.getSpace();

        await atY2Pieces.get(a.id, true);

        expect(atY2.grantsModuleDelegation(space, wY2, wQ)).toBe(true);
        expect(atY2.grantsModuleDelegation(space, eY2, eQ)).toBe(true);

        await moveWithoutUpdate(a, splitWriterProgram("wY", "eY"));
        expect(getPatternIdentityRef(a.getCell())?.identity).toBe(eY);

        await atYPieces.get(a.id, true);

        expect(atY.grantsModuleDelegation(space, wY, wX)).toBe(true);
        expect(atY.grantsModuleDelegation(space, eY, eX)).toBe(true);
        expect(atY.grantsModuleDelegation(space, wY, wQ)).toBe(false);
        expect(atY.grantsModuleDelegation(space, eY, eQ)).toBe(false);
      } finally {
        await atY.dispose({ closeStorage: false });
        await atY2.dispose({ closeStorage: false });
      }
    });

    it("grants a module a predecessor record's list as it was written, and nothing a listed module gained afterward", async () => {
      // Piece `b` goes L to P, so P's record lists L, as L stood then. Piece
      // `a` then goes M to L, so L gains M, and on to X; a move that is no
      // source update brings `a` to P, which `a`'s own history never derived
      // from L; and `a` goes P to S. S takes P's list in: L, and not M, which
      // L gained after P's record was written. `main`'s record of S lists P
      // and L.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const b = await pieces.create(splitWriterProgram("wL", "eL"), {
          input: {},
        });
        const eL = getPatternIdentityRef(b.getCell())!.identity;
        const wL = await moduleAt(eL, "/app/writer.ts");
        await b.setPattern(splitWriterProgram("wP", "eP"));
        const eP = getPatternIdentityRef(b.getCell())!.identity;
        const wP = await moduleAt(eP, "/app/writer.ts");
        const a = await pieces.create(splitWriterProgram("wM", "eM"), {
          input: {},
        });
        const eM = getPatternIdentityRef(a.getCell())!.identity;
        const wM = await moduleAt(eM, "/app/writer.ts");
        await a.setPattern(splitWriterProgram("wL", "eL"));
        await a.setPattern(splitWriterProgram("wX", "eX"));
        await moveWithoutUpdate(a, splitWriterProgram("wP", "eP"));
        await a.setPattern(splitWriterProgram("wS", "eS"));
        const eS = getPatternIdentityRef(a.getCell())!.identity;
        const wS = await moduleAt(eS, "/app/writer.ts");

        await freshPieces.get(a.id, true);

        const space = pieces.getSpace();
        expect(fresh.grantsModuleDelegation(space, wS, wP)).toBe(true);
        expect(fresh.grantsModuleDelegation(space, wS, wL)).toBe(true);
        expect(fresh.grantsModuleDelegation(space, wS, wM)).toBe(false);
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("grants a module nothing of a list its predecessor took in after the module succeeded it, nor stages it on later records", async () => {
      // Piece `b` goes L to P, so P's record lists L. Piece `a` goes S to T,
      // moves to P by a transition that is no source update, goes P to S,
      // where S takes P's list in, and moves back to T the same way. T
      // succeeded S before S took the list in: `main`'s record of T is [S].
      // Then `a` goes T to W, and a piece `c` goes W to V: neither W's
      // record nor V's lists L, as on `main`.
      const { on: atT, controller: atTPieces } = await freshController();
      const { on: atV, controller: atVPieces } = await freshController();
      try {
        const b = await pieces.create(splitWriterProgram("wL", "eL"), {
          input: {},
        });
        const eL = getPatternIdentityRef(b.getCell())!.identity;
        const wL = await moduleAt(eL, "/app/writer.ts");
        await b.setPattern(splitWriterProgram("wP", "eP"));
        const a = await pieces.create(splitWriterProgram("wS", "eS"), {
          input: {},
        });
        const eS = getPatternIdentityRef(a.getCell())!.identity;
        const wS = await moduleAt(eS, "/app/writer.ts");
        await a.setPattern(splitWriterProgram("wT", "eT"));
        const eT = getPatternIdentityRef(a.getCell())!.identity;
        const wT = await moduleAt(eT, "/app/writer.ts");
        await moveWithoutUpdate(a, splitWriterProgram("wP", "eP"));
        await a.setPattern(splitWriterProgram("wS", "eS"));
        await moveWithoutUpdate(a, splitWriterProgram("wT", "eT"));
        expect(getPatternIdentityRef(a.getCell())?.identity).toBe(eT);
        const space = pieces.getSpace();

        await atTPieces.get(a.id, true);

        expect(atT.grantsModuleDelegation(space, wT, wS)).toBe(true);
        expect(atT.grantsModuleDelegation(space, wT, wL)).toBe(false);
        expect(atT.grantsModuleDelegation(space, eT, eL)).toBe(false);

        await a.setPattern(splitWriterProgram("wW", "eW"));
        const eW = getPatternIdentityRef(a.getCell())!.identity;
        const wW = await moduleAt(eW, "/app/writer.ts");
        expect((await closureRecords(eW))[`source ${wW}`].sort()).toEqual(
          [wS, wT].sort(),
        );
        const c = await pieces.create(splitWriterProgram("wW", "eW"), {
          input: {},
        });
        await c.setPattern(splitWriterProgram("wV", "eV"));
        const eV = getPatternIdentityRef(c.getCell())!.identity;
        const wV = await moduleAt(eV, "/app/writer.ts");

        await atVPieces.get(c.id, true);

        expect(atV.grantsModuleDelegation(space, wV, wW)).toBe(true);
        expect(atV.grantsModuleDelegation(space, wV, wL)).toBe(false);
      } finally {
        await atV.dispose({ closeStorage: false });
        await atT.dispose({ closeStorage: false });
      }
    });

    it("grants a module that stays in the closure nothing another piece added to its predecessor's record after it succeeded it", async () => {
      // Piece `a` goes X to Y; piece `b` goes Q to X, so X's record lists Q;
      // `a` reverts to X and goes on to Z, a new entry over Y's, so Y stays
      // in the closure as a module. Z's new entry gets Q, through X, as
      // `main`'s record of it lists; Y, which succeeded X before Q was added,
      // does not.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const a = await pieces.create(splitWriterProgram("wX", "eX"), {
          input: {},
        });
        const eX = getPatternIdentityRef(a.getCell())!.identity;
        await a.setPattern(splitWriterProgram("wY", "eY"));
        const eY = getPatternIdentityRef(a.getCell())!.identity;
        const b = await pieces.create(splitWriterProgram("wQ", "eQ"), {
          input: {},
        });
        const eQ = getPatternIdentityRef(b.getCell())!.identity;
        await b.setPattern(splitWriterProgram("wX", "eX"));
        await a.setPattern(splitWriterProgram("wX", "eX"));
        await a.setPattern(wrappedWriterProgram("wY", "eY", "z"));
        const eZ = getPatternIdentityRef(a.getCell())!.identity;
        expect(await moduleAt(eZ, "/app/main.tsx")).toBe(eY);
        const space = pieces.getSpace();

        await freshPieces.get(a.id, true);

        for (
          const [module, predecessor, granted] of [
            [eY, eX, true],
            [eY, eQ, false],
            [eZ, eX, true],
            [eZ, eQ, true],
            [eZ, eY, true],
          ] as const
        ) {
          expect(
            fresh.grantsModuleDelegation(space, module, predecessor),
            `${module} <- ${predecessor}`,
          ).toBe(granted);
        }
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("keeps the grant of a module a source update reverts to after a successor replaced it", async () => {
      // v0 to v1's staging never lands; v2's writer succeeds w1; a source
      // update reverts to v1. w1 keeps w0, and gains w2, as `main` stages.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const e0 = getPatternIdentityRef(piece.getCell())!.identity;
        const w0 = await moduleAt(e0, "/app/writer.ts");
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        const e1 = getPatternIdentityRef(piece.getCell())!.identity;
        const w1 = await moduleAt(e1, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("w2", "e2"));
        const e2 = getPatternIdentityRef(piece.getCell())!.identity;
        const w2 = await moduleAt(e2, "/app/writer.ts");
        await piece.setPattern(splitWriterProgram("w1", "e1"));

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
        const space = pieces.getSpace();
        expect(fresh.grantsModuleDelegation(space, w1, w0)).toBe(true);
        expect(fresh.grantsModuleDelegation(space, w1, w2)).toBe(true);
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("loses a grant whose staging failed when a runtime from before the record makes the piece's next update", async () => {
      // TODO(danfuzz): This pins a loss `main` does not have (see the `TODO`
      // on `#stageCommittedDelegations()`). v0 to v1's staging never lands,
      // so only the piece's record holds w1's grant from w0. A runtime from
      // before the record then makes the next update: it reads no record
      // (as here, with the record removed), derives from w1's unstaged cache
      // record, and stages w2 inheriting w1 alone. The write is refused,
      // where `main`'s in-transaction staging would have kept w0. Flip the
      // expectation to `w2:b` if a staging that fails is ever repaired.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        await replaceMember(piece, undefined);
        await piece.setPattern(splitWriterProgram("w2", "e2"));
        await runtime.patternManager.flushCompileCacheWrites();
        await pieces.synced();

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w0:a");
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("loses a grant whose staging failed when a runtime from before the record moves the piece without a source update", async () => {
      // TODO(danfuzz): This pins a loss `main` does not have (see the `TODO`
      // on `#stageCommittedDelegations()`). v0 to v1's staging never lands.
      // A runtime from before the record then moves the piece to v2, which
      // keeps v1's writer, by a transition that is no source update, and
      // leaves the record naming v1 (as here, by putting it back). The record
      // then names another pattern and is ignored, and w1's unstaged cache
      // record decides: the write is refused, where `main`'s record of w1
      // grants it. Flip the expectation to `w1:b` if a staging that fails is
      // ever repaired.
      const { on: fresh, controller: freshPieces } = await freshController();
      try {
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        const left = recordedMember(piece);
        await moveWithoutUpdate(piece, splitWriterProgram("w1", "e2"));
        await replaceMember(piece, left as unknown as FabricValue);

        const observed = await freshPieces.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w0:a");
      } finally {
        await fresh.dispose({ closeStorage: false });
      }
    });

    it("keeps the recorded grant of a module two updates leave unchanged", async () => {
      const runtimes = [0, 1].map(() =>
        new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
        })
      );
      try {
        const [third, fresh] = await Promise.all(runtimes.map(async (on) => {
          const controller = new PiecesController(
            createSession({ identity: signer, spaceDid: pieces.getSpace() }),
            on,
          );
          await controller.synced();
          return controller;
        }));
        const piece = await pieces.create(splitWriterProgram("w0", "e0"), {
          input: {},
        });
        const updater = await pieces.get(piece.id, true);
        expect(await invokeSetName(updater, "a")).toBe("w0:a");
        {
          using _noStaging = refuseDelegationStaging(runtime);
          await piece.setPattern(splitWriterProgram("w1", "e1"));
        }
        {
          using _noStaging = refuseDelegationStaging(observer);
          const cold = await observerPieces.get(piece.id, false);
          await cold.setPattern(splitWriterProgram("w1", "e2"));
        }
        const coldAgain = await third.get(piece.id, false);
        await coldAgain.setPattern(splitWriterProgram("w1", "e3"));
        await runtimes[0].patternManager.flushCompileCacheWrites();
        await third.synced();

        const observed = await fresh.get(piece.id, true);

        expect(await invokeSetName(observed, "b")).toBe("w1:b");
      } finally {
        for (const on of runtimes) await on.dispose({ closeStorage: false });
      }
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
