import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { Result, Unit, URI } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { Runtime } from "../src/runtime.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
} from "../src/storage/interface.ts";
import type { Cell } from "../src/cell.ts";
import type { EventHandler } from "../src/scheduler/types.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  buildCfcPolicyArtifactManifest,
  cfcPolicyManifestDocId,
} from "../src/cfc/policy.ts";
import { isRetryableCommitRejection } from "../src/storage/rejection.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";

const signer = await Identity.fromPassphrase("shared manifest install");
const space = signer.did();

const artifact = buildCfcPolicyArtifactManifest({
  formatVersion: 1,
  moduleIdentity: "sha256:shared-install-module",
  symbol: "rules",
  template: {
    templateVersion: 1,
    exchangeRules: [],
    dependencies: { authorityOnly: [], dataBearing: [] },
    integrityRequirements: {},
  },
});

// A different artifact stored under `artifact`'s digest: what a forged or
// colliding manifest at that content address looks like.
const collidingArtifact = buildCfcPolicyArtifactManifest({
  ...artifact.manifest,
  symbol: "otherRules",
});

const policyOfSchema = {
  type: "string",
  ifc: {
    confidentiality: [{
      type: CFC_ATOM_TYPE.Policy,
      policyRefKind: "module",
      moduleIdentity: artifact.manifest.moduleIdentity,
      symbol: artifact.manifest.symbol,
      policyDigest: artifact.policyDigest,
      subject: { __ctOwningSpace: true },
    }],
  },
} as const;

describe("cfc-policy-manifest-shared-install", () => {
  // Two runtimes on one server model two participants of a shared space.
  // Each writes a value labeled with the same PolicyOf, so each installs the
  // same content-addressed manifest document beside its value. The second
  // runtime has never loaded that document when it writes.
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    server = newSharedServer();
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
    rtA.registerCfcPolicyManifests(undefined, [artifact]);
    rtB.registerCfcPolicyManifests(undefined, [artifact]);
  });

  afterEach(async () => {
    // A rejected commit leaves its catch-up load in flight; let it land
    // rather than failing against a closed client.
    await storageB.synced();
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  // A labeled write the way a retrying writer makes it: a retryable
  // rejection runs the transaction again once storage has caught up.
  const writeLabeled = (runtime: Runtime, name: string) =>
    runtime.editWithRetry((tx) => {
      runtime.getCell(space, name, policyOfSchema, tx).set(`${name} secret`);
    });

  // What the server holds, read through a runtime that has loaded nothing,
  // so no replica left behind by the writers can answer instead.
  const serverValue = async (id: string, schema?: JSONSchema) => {
    const storage = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const cell = runtime.getCellFromEntityId(space, id, [], schema);
      await cell.sync();
      return cell.get();
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  };

  const briefId = (name: string) =>
    rtA.getCell(space, name, policyOfSchema).getAsNormalizedFullLink().id;

  const manifestId = cfcPolicyManifestDocId(artifact.policyDigest);

  it("reports a stale absence of the installed manifest as a retryable conflict", async () => {
    expect((await writeLabeled(rtA, "a-brief")).error).toBeUndefined();
    // The second runtime holds no subscription covering the manifest, so the
    // first runtime's install is not fanned out to it: its replica has never
    // held the document.
    const replicaB = storageB.open(space).replica as unknown as {
      getDocument(id: string): unknown;
    };
    expect(replicaB.getDocument(manifestId)).toBeUndefined();

    const tx = rtB.edit();
    rtB.getCell(space, "b-brief", policyOfSchema, tx).set("b-brief secret");
    rtB.prepareTxForCommit(tx);
    const committed = await tx.commit({ resolveAt: "verdict" });

    // The guard is the transaction's confirmed read of the absent manifest:
    // the rejection names that document, which is what the retry catches up.
    expect(committed.error).toMatchObject({
      name: "ConflictError",
      conflict: { of: manifestId },
    });
    expect(isRetryableCommitRejection(committed.error!)).toBe(true);
  });

  // This case and the event case below prove only that the write lands: a
  // blind overwrite of identical bytes would pass them too. The retryable
  // conflict above and the collision case at the end are what show an
  // install never overwrites.
  it("commits a second participant's first write once the manifest is already installed", async () => {
    expect((await writeLabeled(rtA, "a-brief")).error).toBeUndefined();

    const committed = await writeLabeled(rtB, "b-brief");

    expect(committed.error).toBeUndefined();
    expect(await serverValue(briefId("b-brief"))).toBe("b-brief secret");
    expect(await serverValue(manifestId)).toEqual(artifact);
  });

  it("handles a second participant's first event that writes a labeled value", async () => {
    expect((await writeLabeled(rtA, "a-brief")).error).toBeUndefined();
    const stream = rtB.getCell<unknown>(space, "b-submit");
    const brief = rtB.getCell(space, "b-brief", policyOfSchema);
    const submit: EventHandler = (tx) => {
      brief.withTx(tx).set("b-brief secret");
    };
    rtB.scheduler.addEventHandler(submit, stream.getAsNormalizedFullLink());

    // The first participant watches for the write, so only a committed
    // value can satisfy the wait: the second participant's own replica shows
    // its optimistic write before the commit settles either way.
    const observed = rtA.getCell(space, "b-brief", policyOfSchema);
    await observed.sync();

    rtB.scheduler.queueEvent(stream.getAsNormalizedFullLink(), {});

    await waitForCellValue<string>(
      rtA,
      observed,
      (value) => value === "b-brief secret",
      { stuckLabel: "the second participant's labeled event write" },
    );
  });

  // A piece another participant set up is run here the way a shared setup
  // is joined: the run names the stored piece and starts it in a transaction
  // of its own once that name lands. That start re-stages the argument, whose
  // labeled field installs the manifest this runtime has never loaded.
  describe("a second participant's run of a shared piece whose argument is labeled", () => {
    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import { Confidential, pattern } from "commonfabric";
          import type { PolicyOf } from "commonfabric/cfc";
          import {
            cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
          } from "commonfabric/cfc";
          export const release = exchangeRule({
            appliesTo: THIS_POLICY,
            pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
            post: { addAlternatives: [cfcPattern.user(v("user"))] },
          });
          export const rules = exchangeRules([release]);
          type Brief = Confidential<string, [PolicyOf<typeof rules>]>;
          export default pattern<{ brief: Brief }, { brief: Brief }>(
            ({ brief }) => ({ brief }),
          );
        `,
      }],
    };

    const runShared = async (runtime: Runtime, brief: string) => {
      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const tx = runtime.edit();
      const piece = runtime.getCell<{ brief: string }>(
        space,
        "shared-piece",
        undefined,
        tx,
      );
      await piece.sync();
      runtime.run(tx, compiled, { brief }, piece);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      return piece.withTx();
    };

    const setUpByFirstParticipant = async () => {
      const piece = await runShared(rtA, "a-piece secret");
      await rtA.idle();
      await storageA.synced();
      return piece;
    };

    const observeStartFailures = () => {
      const failures: unknown[] = [];
      rtB.pieceStartCommitFailureObserver = ({ error }) => failures.push(error);
      return failures;
    };

    // Resolves with which comes first: `step`, or a reported start failure.
    // A case waiting on a step the start never reaches then fails on its
    // assertion rather than on the pending wait.
    const firstOf = (step: Promise<void>) => {
      const failed = Promise.withResolvers<"failed">();
      const observe = rtB.pieceStartCommitFailureObserver;
      rtB.pieceStartCommitFailureObserver = (failure) => {
        observe?.(failure);
        failed.resolve("failed");
      };
      return Promise.race([step.then(() => "step" as const), failed.promise]);
    };

    // Reports the start commits the second runtime makes as refused with what
    // `refusal` returns for each attempt, counting from 1, and passes the
    // commit's own verdict through where it returns nothing. A refused commit
    // still goes through, so what the start installed stands as it would
    // behind a real stale-read refusal, which leaves the install in place for
    // the re-run: what these cases measure is how the start answers the
    // verdict.
    const refuseStarts = (
      refusal: (
        attempt: number,
        resultCell: Cell<unknown>,
      ) => CommitError | undefined,
    ) => {
      const attempts = { count: 0 };
      rtB.runner.accessForTestingOnly.deferredStartCommitter = async (
        _tx,
        resultCell,
        commit,
      ) => {
        attempts.count++;
        const verdict = await commit();
        const error = refusal(attempts.count, resultCell);
        return error === undefined ? verdict : { error };
      };
      return attempts;
    };

    const staleReadOf = (id: string, readyToRetry?: () => Promise<void>) =>
      ({
        name: "ConflictError",
        message: `stale confirmed read: ${id} at seq 0 conflicted with seq 1`,
        conflict: { space, the: "application/json", of: id },
        conflicts: [{ space, the: "application/json", of: id }],
        ...(readyToRetry === undefined ? {} : { readyToRetry }),
      }) as unknown as CommitError;

    afterEach(() => {
      rtB.runner.accessForTestingOnly.deferredStartCommitter = undefined;
    });

    it("starts it once the manifest another participant installed is read", async () => {
      const pieceA = await setUpByFirstParticipant();
      const failures = observeStartFailures();

      await runShared(rtB, "b-piece secret");
      // The start has its verdict once the runtime is idle, so a refused
      // start fails here rather than leaving the wait below pending.
      await rtB.idle();
      expect(failures).toEqual([]);

      await waitForCellValue<string>(
        rtA,
        pieceA.key("brief"),
        (value) => value === "b-piece secret",
        { stuckLabel: "the second participant's piece start" },
      );
      await rtB.idle();
      expect(failures).toEqual([]);
    });

    it("preserves new arguments after a stale read of the piece's own documents", async () => {
      const pieceA = await setUpByFirstParticipant();
      const failures = observeStartFailures();
      let attempts = 0;
      const starts = new WeakSet<object>();
      rtB.runner.accessForTestingOnly.deferredStartCommitter = (
        tx,
        _cell,
        commit,
      ) => {
        attempts++;
        starts.add(tx.tx);
        return commit();
      };
      const replica = storageB.open(space).replica as unknown as {
        commitNative: (...args: unknown[]) => unknown;
      };
      const original = replica.commitNative;
      let refused = false;
      replica.commitNative = function (...args: unknown[]) {
        const candidate = args[1] as { tx?: object };
        if (
          !refused &&
          (starts.has(candidate) || starts.has(candidate.tx ?? candidate))
        ) {
          refused = true;
          return Promise.resolve({
            error: staleReadOf(
              pieceA.getAsNormalizedFullLink().id,
              () => Promise.resolve(),
            ),
          });
        }
        return Reflect.apply(original, this, args);
      };
      try {
        await runShared(rtB, "b-piece secret");
        await rtB.idle();
        expect(attempts).toBeGreaterThanOrEqual(2);
        expect(
          await serverValue(pieceA.getAsNormalizedFullLink().id, {
            type: "object",
            properties: { brief: { type: "string" } },
          }),
        ).toEqual({ brief: "b-piece secret" });
        expect(failures).toEqual([]);
      } finally {
        replica.commitNative = original;
      }
    });

    it("reports a start still refused over the manifest once its retries are spent", async () => {
      await setUpByFirstParticipant();
      const failures = observeStartFailures();
      const attempts = refuseStarts(() => staleReadOf(manifestId));

      await runShared(rtB, "b-piece secret");
      await rtB.idle();

      expect(attempts.count).toBe(6);
      expect(failures).toHaveLength(1);
    });

    it("drops the retry without a report when the start is stopped while it waits", async () => {
      await setUpByFirstParticipant();
      const failures = observeStartFailures();
      const waiting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const attempts = refuseStarts(() =>
        staleReadOf(manifestId, () => {
          waiting.resolve();
          return release.promise;
        })
      );

      const piece = await runShared(rtB, "b-piece secret");
      expect(await firstOf(waiting.promise)).toBe("step");
      rtB.runner.stop(piece);
      release.resolve();
      await rtB.idle();

      expect(attempts.count).toBe(1);
      expect(failures).toEqual([]);
    });

    it("runs it again after a local inconsistency at the manifest", async () => {
      const pieceA = await setUpByFirstParticipant();
      const failures = observeStartFailures();
      const attempts = refuseStarts((attempt) =>
        attempt === 1
          ? {
            name: "StorageTransactionInconsistent",
            message: `${manifestId} changed while the start read it`,
            address: {
              space,
              id: manifestId,
              type: "application/json",
              path: ["value"],
            },
          } as unknown as CommitError
          : undefined
      );

      await runShared(rtB, "b-piece secret");
      await rtB.idle();
      expect(failures).toEqual([]);

      await waitForCellValue<string>(
        rtA,
        pieceA.key("brief"),
        (value) => value === "b-piece secret",
        { stuckLabel: "the second participant's retried piece start" },
      );
      await rtB.idle();
      expect(attempts.count).toBe(2);
      expect(failures).toEqual([]);
    });

    it("reports a refusal that is not a conflict without running it again", async () => {
      await setUpByFirstParticipant();
      const failures = observeStartFailures();
      const attempts = refuseStarts(() =>
        ({
          name: "TransactionError",
          message: `${manifestId}: the commit failed`,
        }) as unknown as CommitError
      );

      await runShared(rtB, "b-piece secret");
      await rtB.idle();

      expect(attempts.count).toBe(1);
      expect(failures).toHaveLength(1);
    });

    it("reports a manifest refusal whose start was stopped before its verdict", async () => {
      await setUpByFirstParticipant();
      const failures = observeStartFailures();
      const attempts = refuseStarts((_attempt, resultCell) => {
        rtB.runner.stop(resultCell);
        return staleReadOf(manifestId);
      });

      await runShared(rtB, "b-piece secret");
      await rtB.idle();

      expect(attempts.count).toBe(1);
      expect(failures).toHaveLength(1);
    });

    it("reports a manifest refusal whose piece another start took while it waited", async () => {
      await setUpByFirstParticipant();
      const failures = observeStartFailures();
      const waiting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const attempts = refuseStarts(() =>
        staleReadOf(manifestId, () => {
          waiting.resolve();
          return release.promise;
        })
      );

      const piece = await runShared(rtB, "b-piece secret");
      expect(await firstOf(waiting.promise)).toBe("step");
      expect(await rtB.start(piece)).toBe(true);
      release.resolve();
      await rtB.idle();

      expect(attempts.count).toBe(1);
      expect(failures).toHaveLength(1);
    });
  });

  describe("a second participant's start of a piece whose per-user part is labeled", () => {
    // A participant who did not set the piece up opens it under an identity
    // of its own, the way any later visitor does: its runtime loads the
    // stored piece and starts it. The piece hands a labeled cell to a part it
    // instantiates per user, so this participant's start writes the first
    // instance of that part, and the link to the labeled cell in it requires
    // the policy manifest the first participant's setup installed. Nothing in
    // the piece links to that manifest.

    const program = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import {
            computed, Confidential, handler, pattern, Writable,
          } from "commonfabric";
          import type { PolicyOf } from "commonfabric/cfc";
          import {
            cfcPattern, exchangeRule, exchangeRules, THIS_POLICY, v,
          } from "commonfabric/cfc";
          export const release = exchangeRule({
            appliesTo: THIS_POLICY,
            pre: { integrity: [cfcPattern.hasRole(v("user"), THIS_POLICY.subject, "reader")] },
            post: { addAlternatives: [cfcPattern.user(v("user"))] },
          });
          export const rules = exchangeRules([release]);
          type Brief = Confidential<string, [PolicyOf<typeof rules>]>;
          const mark = handler<
            { seen: boolean },
            { seen: Writable<boolean | null> }
          >((event, { seen }) => seen.set(event.seen));
          const Reader = pattern<{ brief: Brief }, {
            brief: Brief;
            known: boolean;
            mark: ReturnType<typeof mark>;
          }>(({ brief }) => {
            const seen = new Writable.perUser<boolean | null>(null);
            const known = computed(() => seen.get() !== null);
            return { brief, known, mark: mark({ seen }) };
          });
          export default pattern<
            Record<string, never>,
            { brief: Writable<Brief>; reader: { brief: Brief; known: boolean } }
          >(() => {
            const brief = new Writable.perSpace<Brief>("the brief");
            const reader = Reader.asScope("user")({ brief });
            return { brief, reader };
          });
        `,
      }],
    };

    let storageV: EmulatedStorageManager;
    let rtV: Runtime;

    beforeEach(async () => {
      const visitor = await Identity.fromPassphrase("shared manifest visitor");
      storageV = EmulatedStorageManager.connectTo(server, { as: visitor });
      rtV = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storageV,
      });
    });

    afterEach(async () => {
      // Stopping a piece whose per-user part runs starts a load of that
      // part's result, which a storage closed under it reports as failed, so
      // both participants stop their pieces and let the loads land first.
      for (
        const [runtime, storage] of [[rtV, storageV], [rtA, storageA]] as const
      ) {
        runtime.runner.stopAll();
        await runtime.idle();
        await storage.synced();
      }
      await rtV.dispose();
      await storageV.close();
    });

    // The digest of the first module policy a schema in `value` names.
    const policyDigestIn = (value: unknown): string | undefined => {
      if (typeof value !== "object" || value === null) return undefined;
      if (
        "type" in value && value.type === CFC_ATOM_TYPE.Policy &&
        "policyDigest" in value && typeof value.policyDigest === "string"
      ) {
        return value.policyDigest;
      }
      for (const entry of Object.values(value)) {
        const digest = policyDigestIn(entry);
        if (digest !== undefined) return digest;
      }
      return undefined;
    };

    // Sets the piece up as its first participant, and returns the id of the
    // policy manifest that setup installed.
    const setUpByFirstParticipant = async (): Promise<URI> => {
      const compiled = await rtA.patternManager.compilePattern(program, {
        space,
      });
      const digest = policyDigestIn(compiled.resultSchema);
      if (digest === undefined) throw new Error("the piece names no policy");
      const tx = rtA.edit();
      const piece = rtA.getCell(space, "per-user-piece", undefined, tx);
      await piece.sync();
      rtA.run(tx, compiled, {}, piece);
      rtA.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await rtA.idle();
      await storageA.synced();
      return cfcPolicyManifestDocId(digest);
    };

    // What the server holds at `id`, and the seq of the last write to it the
    // server accepted, read through a replica that has loaded nothing else.
    const stored = async (id: URI) => {
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      try {
        const provider = storage.open(space);
        await provider.sync(id, { path: [], schema: false });
        return {
          seq: provider.replica.confirmedDocumentSeq(id),
          value: provider.replica.getDocument(id)?.value,
        };
      } finally {
        await storage.close();
      }
    };

    // Records the verdict of each instantiation commit the start makes, in
    // order. `refuse` may answer an attempt, counting from 1, with a refusal
    // in place of committing it.
    const instantiationVerdicts = (
      refuse: (attempt: number) => CommitError | undefined = () => undefined,
    ) => {
      const instantiations = new WeakSet<IExtendedStorageTransaction>();
      const verdicts: (CommitError | undefined)[] = [];
      const stamp = rtV.stampServerRun.bind(rtV);
      const edit = rtV.edit.bind(rtV);
      const stamps = stub(rtV, "stampServerRun", (tx, info) => {
        if (info.actionId.startsWith("piece-instantiate/")) {
          instantiations.add(tx);
        }
        stamp(tx, info);
      });
      const edits = stub(rtV, "edit", (options) => {
        const tx = edit(options);
        const commit = tx.commit.bind(tx);
        stub(tx, "commit", async (commitOptions) => {
          if (!instantiations.has(tx)) return await commit(commitOptions);
          const refusal = refuse(verdicts.length + 1);
          if (refusal !== undefined) {
            verdicts.push(refusal);
            tx.abort(refusal.message);
            return { error: refusal };
          }
          const result = await commit(commitOptions);
          verdicts.push(result.error);
          return result;
        });
        return tx;
      });
      return {
        verdicts,
        [Symbol.dispose]() {
          edits.restore();
          stamps.restore();
        },
      };
    };

    // Answers this participant's loads of the manifest with nothing until the
    // start's catch-up asks for it, as when another participant installs the
    // manifest after the start's own loads have answered. The catch-up's
    // load is answered by `catchUp`, or by the server.
    const manifestInstalledAfterTheStartLoads = (
      installedId: URI,
      catchUp?: () => Promise<Result<Unit, Error>>,
    ) => {
      const provider = storageV.open(space);
      const sync = provider.sync.bind(provider);
      let caughtUp = false;
      const syncs = stub(provider, "sync", (id, selector, scope, instance) => {
        if (id !== installedId) return sync(id, selector, scope, instance);
        if (!caughtUp) return Promise.resolve({ ok: {} });
        return catchUp?.() ?? sync(id, selector, scope, instance);
      });
      const awaitReadiness = rtV.awaitCommitRetryReadiness.bind(rtV);
      const readiness = stub(
        rtV,
        "awaitCommitRetryReadiness",
        (error, signal) => {
          caughtUp = true;
          return awaitReadiness(error, signal);
        },
      );
      return {
        [Symbol.dispose]() {
          readiness.restore();
          syncs.restore();
        },
      };
    };

    const startAsVisitor = async () => {
      const failures: unknown[] = [];
      rtV.pieceStartCommitFailureObserver = ({ error }) => failures.push(error);
      const piece = rtV.getCell(space, "per-user-piece");
      await piece.sync();
      await rtV.start(piece);
      await rtV.idle();
      await rtV.runner.idlePieceInstantiationSettlements();
      return { piece, failures };
    };

    it("starts it and leaves the manifest the first participant installed as it was", async () => {
      const installedId = await setUpByFirstParticipant();
      const before = await stored(installedId);
      expect(before.seq).toBeGreaterThan(0);

      const { piece, failures } = await startAsVisitor();

      expect(failures).toEqual([]);
      expect(rtV.runner.isRunning(piece)).toBe(true);
      expect(await stored(installedId)).toEqual(before);
    });

    it("commits the start at its first attempt, having loaded the manifest", async () => {
      await setUpByFirstParticipant();
      using commits = instantiationVerdicts();

      const { failures } = await startAsVisitor();

      expect(failures).toEqual([]);
      expect(commits.verdicts).toEqual([undefined]);
    });

    it("starts it once when the manifest arrives after the start's loads", async () => {
      // The first attempt reads the manifest as absent and loses its install.
      // A stored manifest keeps each of its rules in a document of its own,
      // which only the catch-up's load of the manifest brings in, and the
      // retry verifies the whole artifact before accepting it.

      const installedId = await setUpByFirstParticipant();
      const before = await stored(installedId);
      using _late = manifestInstalledAfterTheStartLoads(installedId);
      using commits = instantiationVerdicts();

      const { piece, failures } = await startAsVisitor();

      expect(failures).toEqual([]);
      expect(rtV.runner.isRunning(piece)).toBe(true);
      expect(commits.verdicts).toHaveLength(2);
      expect(commits.verdicts[0]).toMatchObject({
        name: "ConflictError",
        conflict: { of: installedId },
      });
      expect(commits.verdicts[1]).toBeUndefined();
      expect(await stored(installedId)).toEqual(before);
    });

    it("serves consumers bound before the start the values the retried graph computes", async () => {
      // The first attempt's writes are rolled back when its commit is
      // refused, and the retry writes the same documents again. A sink bound
      // to the per-user part before the start, through the link the part's
      // instance holds, sees the retried graph's values, and a computed in
      // that part runs on a later event.

      const installedId = await setUpByFirstParticipant();
      using _late = manifestInstalledAfterTheStartLoads(installedId);
      using commits = instantiationVerdicts();
      const failures: unknown[] = [];
      rtV.pieceStartCommitFailureObserver = ({ error }) => failures.push(error);
      const piece = rtV.getCell<{ reader: { brief: string; known: boolean } }>(
        space,
        "per-user-piece",
      );
      await piece.sync();
      const reader = piece.key("reader");
      const briefs: unknown[] = [];
      const knowns: unknown[] = [];
      const cancelBriefs = reader.key("brief").sink((brief) => {
        briefs.push(brief);
      });
      const cancelKnowns = reader.key("known").sink((known) => {
        knowns.push(known);
      });

      await rtV.start(piece);
      await rtV.idle();
      await rtV.runner.idlePieceInstantiationSettlements();

      expect(commits.verdicts).toHaveLength(2);
      expect(failures).toEqual([]);
      expect(briefs.at(-1)).toBe("the brief");
      expect(knowns.at(-1)).toBe(false);

      const stream = rtV.getCellFromLink(
        reader.key("mark").resolveAsCell().getAsNormalizedFullLink(),
      );
      rtV.scheduler.queueEvent(stream.getAsNormalizedFullLink(), {
        seen: false,
      });
      await waitForCellValue<boolean>(
        rtV,
        reader.key("known"),
        (known) => known === true,
        { stuckLabel: "the per-user part's computed after the retry" },
      );
      expect(knowns.at(-1)).toBe(true);
      cancelBriefs();
      cancelKnowns();
    });

    it("reports a catch-up that could not load the manifest, with its reason", async () => {
      const installedId = await setUpByFirstParticipant();
      const unreachable = new Error("the memory server is unreachable");
      using _late = manifestInstalledAfterTheStartLoads(
        installedId,
        () => Promise.resolve({ error: unreachable }),
      );
      using commits = instantiationVerdicts();

      const { piece, failures } = await startAsVisitor();

      expect(commits.verdicts).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        message: expect.stringContaining(installedId),
        cause: unreachable,
      });
      expect(rtV.runner.isRunning(piece)).toBe(false);
    });

    it("reports a refusal over the piece's own documents beside the manifest without running it again", async () => {
      // With server execution off, a stale read over the piece's own
      // documents is terminal, and naming the manifest beside them does not
      // change that.

      const installedId = await setUpByFirstParticipant();
      const ownId = rtV.getCell(space, "per-user-piece")
        .getAsNormalizedFullLink().id;
      using commits = instantiationVerdicts((attempt) =>
        attempt === 1
          ? {
            name: "ConflictError",
            message: `stale confirmed read: ${ownId} at seq 0 conflicted ` +
              "with seq 1",
            conflict: { space, the: "application/json", of: ownId },
            conflicts: [
              { space, the: "application/json", of: installedId },
              { space, the: "application/json", of: ownId },
            ],
          } as unknown as CommitError
          : undefined
      );

      const { piece, failures } = await startAsVisitor();

      expect(commits.verdicts).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(rtV.runner.isRunning(piece)).toBe(false);
    });

    it("starts it again for the participant who set it up when the manifest cannot be loaded", async () => {
      // A manifest that cannot be loaded does not stop the start. A commit
      // that needs the manifest still reads it as absent and fails, and says
      // so, as the part's own start does here.

      const installedId = await setUpByFirstParticipant();
      const storage = EmulatedStorageManager.connectTo(server, { as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
      try {
        const provider = storage.open(space);
        const sync = provider.sync.bind(provider);
        using _unreachable = stub(
          provider,
          "sync",
          (id, selector, scope, instance) =>
            id === installedId
              ? Promise.reject(new Error("the memory server is unreachable"))
              : sync(id, selector, scope, instance),
        );
        const piece = runtime.getCell(space, "per-user-piece");
        await piece.sync();

        expect(await runtime.start(piece)).toBe(true);
        await runtime.idle();
        await runtime.runner.idlePieceInstantiationSettlements();

        expect(runtime.runner.isRunning(piece)).toBe(true);
      } finally {
        runtime.runner.stopAll();
        await runtime.idle();
        await storage.synced();
        await runtime.dispose();
        await storage.close();
      }
    });

    it("refuses to start it over a different manifest stored at the digest", async () => {
      // The refusal leaves the stored manifest as it was: the start reads
      // the manifest that is there, and never replaces it.

      const installedId = await setUpByFirstParticipant();
      const forge = storageA.edit();
      forge.write({
        space,
        id: installedId,
        type: "application/json",
        path: ["value"],
      }, collidingArtifact);
      expect((await forge.commit()).ok).toBeDefined();
      const forged = await stored(installedId);
      expect(forged.value).toEqual(collidingArtifact);

      const { piece, failures } = await startAsVisitor();

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        message: expect.stringContaining("immutable destination collision"),
      });
      expect(rtV.runner.isRunning(piece)).toBe(false);
      expect(await stored(installedId)).toEqual(forged);
    });
  });

  it("refuses a second participant's write when a different manifest holds the digest", async () => {
    const forge = storageA.edit();
    forge.write({
      space,
      id: manifestId,
      type: "application/json",
      path: ["value"],
    }, collidingArtifact as never);
    expect((await forge.commit()).ok).toBeDefined();

    const committed = await writeLabeled(rtB, "b-brief");

    expect(committed.error?.message).toContain(
      "immutable destination collision",
    );
    expect(await serverValue(briefId("b-brief"))).toBeUndefined();
    expect(await serverValue(manifestId)).toEqual(collidingArtifact);
  });
});
