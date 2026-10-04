/**
 * OW50 (server-execution v2, verification-coverage.md §3; seat S-J): a crash
 * inside CFC commit-prep must surface as a FAILED COMMIT, never as an escaped
 * throw that kills the action without settling its transaction.
 *
 * The live shape (first-on-ci-gate.md row 3 / on-render-stall-rootcause.md
 * §4a): the wish builtin's /result declaration is
 * `anyOf: [{type:"undefined"}, <requested schema>]`, and when the requested
 * schema carries ifc (the profile consumer view), a SECOND writer's
 * commit-prep against the STORED envelope walks into
 * `mergeCfcSchemaEnvelopes`, whose entry assert
 * (`assertNoDivergentIfcBranches`) THROWS "ifc inside divergent anyOf
 * branches is unsupported at /result". Under ON the serving loop is the first
 * writer and the browser's raw:wish is the second, so the client action dies
 * at prep: the throw escaped `prepareCfc`, the transaction never settled (no
 * rollback callbacks), the scheduler's run promise never resolved, the resolve
 * re-entry threw AGAIN into an unhandled rejection (the logged
 * SES_UNHANDLED_REJECTION), and the wish UI silently never mounted.
 *
 * Contract pinned here (red before the fix):
 *  1. `prepareCfc()` does not throw on a prep crash — it records the crash as
 *     an invalidation reason (fail-closed, same as every modeled refusal).
 *  2. `commit()` then rejects through the standard pre-storage-rejection
 *     path: the caller gets `{error}` naming the crash, and commit callbacks
 *     fire with that error (rollback observers run).
 *  3. The scheduler survives: an action whose commit-prep crashes fails like
 *     any refused commit — the error is observable, no unhandled rejection,
 *     and unrelated actions keep running.
 *
 * The divergence assert itself (cfc/schema-merge.ts) is DELIBERATELY not
 * touched: whether ifc-under-anyOf becomes mergeable is the CFC owner's call
 * (register row OW49). This file pins only detectability — the S-J seat.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import {
  isSurfacableWishCommitFailure,
  wishCommitFailureMessage,
} from "../src/builtins/wish.ts";
import { RetryImmediately } from "../src/scheduler/retry-immediately.ts";
import { resolveLink } from "../src/link-resolution.ts";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cfc prepare crash surfacing");
const space = signer.did();

// Two envelope fixtures, either side of RULING 5 (CFC owner, 2026-08-21):
//
// - The live wish shape (mirroring the schema doc the
//   serving loop persisted, cid:fid1:-3unxof…): ONE ifc-carrying branch
//   (`result.anyOf[1]`) whose sibling `{type:"undefined"}` is syntactically
//   type-disjoint — is the ruled ADMITTED shape; its merge pin lives in
//   cfc-schema-merge.test.ts, and its two-writer clean journey below runs
//   through the REAL wish builtin (the profile-embed lift condition).
// - `ambiguousWishShapedSchema` keeps the CRASH class alive for the OW50
//   detectability pins: TWO ifc-carrying branches is genuine ambiguity, which
//   the narrowed assert still refuses. The `candidates.items` position (plain
//   properties/items) is what makes the doc cfc-relevant, the metadata apply,
//   and the candidate schema recordable; a confidentiality label needs no
//   write authority, so the FIRST writer's commit lands, poisoning the stored
//   envelope for every later merging writer.
const profileViewSchema: JSONSchema = {
  type: "object",
  properties: {
    name: { type: "string", ifc: { confidentiality: ["secret"] } },
  },
} as JSONSchema;

const altProfileViewSchema: JSONSchema = {
  type: "string",
  ifc: { confidentiality: ["other"] },
} as JSONSchema;

// The document each wish target is seeded into. Its root declares the
// confidentiality its `name` carries. A second seeding transaction has already
// read the first secret, and the writer-fit check reads this declaration when
// that transaction writes a new profile here.
const secretProfileDocSchema: JSONSchema = {
  ...(profileViewSchema as Record<string, unknown>),
  ifc: { confidentiality: ["secret"] },
} as JSONSchema;

const ambiguousWishShapedSchema: JSONSchema = {
  type: "object",
  properties: {
    result: {
      anyOf: [
        profileViewSchema,
        altProfileViewSchema,
      ],
    },
    candidates: { type: "array", items: profileViewSchema },
  },
} as JSONSchema;

describe("wish commit-prep failure surfacing (OW50 seat S-J)", () => {
  describe("CFC prepare crash becomes a failed commit", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    /** Seed the doc so its STORED envelope carries the AMBIGUOUS divergent
     * shape — the class RULING 5's narrowing still refuses (the first writer
     * never merges — nothing is stored yet — so this commit lands). The
     * labeled VALUE under `candidates.items.name` is what makes the label
     * metadata persist. */
    async function seedStoredEnvelope(
      rt: Runtime,
      id: string,
    ): Promise<void> {
      const tx = rt.edit();
      const cell = rt.getCell(space, id, ambiguousWishShapedSchema, tx);
      cell.set({ candidates: [{ name: "Bob" }] });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    }

    /** A second-writer transaction reproducing the raw:wish shape: a full-doc
     * write through the schema-carrying cell whose /result now holds a LINK.
     * Its prep meets the stored envelope + a link write and walks into the
     * divergence assert. */
    function secondWriterTx(
      rt: Runtime,
      id: string,
    ): IExtendedStorageTransaction {
      const tx = rt.edit();
      const cell = rt.getCell(space, id, ambiguousWishShapedSchema, tx);
      // The link SOURCE carries the ifc-labeled view (as the live resolved
      // profile does), so the /result link write is CFC-recorded.
      const resolved = rt.getCell<{ name: string }>(
        space,
        `${id}-resolved`,
        profileViewSchema,
        tx,
      );
      resolved.set({ name: "Ada" });
      cell.set({ result: resolved, candidates: [] });
      return tx;
    }

    it("a prep crash is a failed commit, not an escaped throw", async () => {
      const id = "wish-shaped-prep-crash";
      await seedStoredEnvelope(runtime, id);

      const tx = secondWriterTx(runtime, id);
      // (1) The prep boundary must not throw.
      runtime.prepareTxForCommit(tx);
      // (2) The commit rejects with the crash as its reason...
      const observed: unknown[] = [];
      tx.addCommitCallback((_tx, result) => {
        observed.push(result.error);
      });
      const result = await tx.commit();
      expect(result.error?.name).toBe("CommitPreparationError");
      expect(String(result.error?.message)).toMatch(/divergent anyOf/);
      // ...and commit callbacks observed the same failure (rollback ran).
      expect(observed.length).toBe(1);
      expect(String((observed[0] as Error)?.message)).toMatch(
        /divergent anyOf/,
      );
    });

    it("observe mode's in-commit prepare fallback survives the crash instead of throwing", async () => {
      // Observe mode is the subject, so this test runs on its own runtime.
      // The commit below runs with no prepare call, and
      // `expect(result.error).toBeUndefined()` reads back that observe records
      // the prep crash and lets the commit through.
      const observeManager = StorageManager.emulate({ as: signer });
      const observeRuntime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager: observeManager,
        cfcEnforcementMode: "observe",
      });
      try {
        const id = "wish-shaped-commit-crash";
        await seedStoredEnvelope(observeRuntime, id);

        // In observe mode, commit() runs the in-line prepare fallback itself
        // (enforcing modes reject unprepared-but-relevant outright and never
        // reach prep here). Observe never rejects on CFC grounds — so the
        // contract on a prep crash is: no throw, the commit proceeds, the
        // crash is recorded. Today the crash escapes commit() as a thrown
        // error.
        const tx = secondWriterTx(observeRuntime, id);
        const result = await tx.commit();
        expect(result.error).toBeUndefined();
      } finally {
        await observeRuntime.dispose();
        await observeManager.close();
      }
    });

    it("the crash report reaches the console even with the module logger disabled (labs#4772 shape)", async () => {
      const id = "wish-shaped-console-crash";
      await seedStoredEnvelope(runtime, id);

      // The transaction module's own logger is constructed disabled, so the
      // crash record must NOT ride it: pin the unconditional console.error
      // (the `reportDroppedCfcRejectedWrite` pattern) under the DEFAULT
      // configuration.
      const seen: string[] = [];
      const realConsoleError = console.error;
      console.error = (...args: unknown[]) => {
        seen.push(args.map((a) => String(a)).join(" "));
      };
      try {
        const tx = secondWriterTx(runtime, id);
        runtime.prepareTxForCommit(tx);
        const result = await tx.commit();
        expect(result.error?.name).toBe("CommitPreparationError");
      } finally {
        console.error = realConsoleError;
      }
      expect(seen.some((line) => /commit-prep crashed/.test(line))).toBe(true);
    });

    it("the scheduler survives an action whose commit-prep crashes", async () => {
      const id = "wish-shaped-scheduler-crash";
      await seedStoredEnvelope(runtime, id);

      // The crashing action: re-does the second-writer write inside a
      // scheduled action, so prep runs on the scheduler's commit path.
      let crashingRuns = 0;
      const crashingAction = (actionTx: IExtendedStorageTransaction) => {
        crashingRuns++;
        const cell = runtime.getCell(
          space,
          id,
          ambiguousWishShapedSchema,
          actionTx,
        );
        const resolved = runtime.getCell<{ name: string }>(
          space,
          `${id}-resolved`,
          profileViewSchema,
          actionTx,
        );
        resolved.set({ name: "Ada" });
        cell.set({ result: resolved, candidates: [] });
      };
      runtime.scheduler.subscribe(crashingAction, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await runtime.scheduler.idle();
      expect(crashingRuns).toBeGreaterThanOrEqual(1);

      // The scheduler is still alive: an unrelated action runs and commits.
      const healthy = runtime.getCell<number>(
        space,
        `${id}-healthy`,
        undefined,
      );
      let healthyRuns = 0;
      const healthyAction = (actionTx: IExtendedStorageTransaction) => {
        healthyRuns++;
        healthy.withTx(actionTx).set(42);
      };
      runtime.scheduler.subscribe(healthyAction, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await runtime.scheduler.idle();
      expect(healthyRuns).toBeGreaterThanOrEqual(1);
      expect(healthy.get()).toBe(42);
    });
  });

  describe("the wish surfaces its refused commit", () => {
    // The wish-surface half of OW50: when the wish action's own commit is
    // REFUSED, the failure must land in the wish UI — `error` + `[UI]` on the
    // wish state doc — instead of dying with the transaction (the state the
    // profile-embed test observes as "the wish UI silently never mounts").
    //
    // The flow reproduces the live served-wish mechanism end to end, on the
    // live two-writer topology (one shared memory server, two runtimes — the
    // serving loop and the browser client in the CI shape): the wish requests
    // an ifc-carrying schema, so its own state schema is `result:
    // anyOf[undefined, <ifc view>]` (built by `wishStateSchemaForResult`);
    // writer A's run commits and persists that envelope; the wish target is
    // then repointed, and writer B's run writes a DIFFERENT /result link
    // against the stored envelope — commit-prep walks into the divergence
    // assert and the commit is refused (surfaced as a modeled rejection by the
    // prepareCfc fix above). The wish must then SHOW that refusal.

    const makeServer = () =>
      newSharedServer({
        sessions: new MemoryV2Server.SessionRegistry({ ttlMs: 600_000 }),
        subscriptionRefreshDelayMs: 0,
      });

    type Journey = {
      makeRuntime: () => {
        manager: EmulatedStorageManager;
        runtime: Runtime;
        close: () => Promise<void>;
      };
      runWishOnce: (
        prePullLink?: { id: string; scope: string | undefined },
      ) => Promise<string>;
      seedTarget: (cellName: string, name: string) => Promise<void>;
      resolveStateDocLink: () => Promise<
        { id: string; scope: string | undefined }
      >;
    };

    /** One journey per shared in-process server: two runtimes at a time is
     * the live two-writer topology (the serving loop and the browser). */
    const makeJourney = (): Journey => {
      const server = makeServer();
      const makeRuntime = () => {
        const manager = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: manager,
        });
        return {
          manager,
          runtime,
          close: async () => {
            await runtime.dispose();
            await manager.close();
          },
        };
      };

      const runWish = async (
        prePullLink?: { id: string; scope: string | undefined },
      ): Promise<
        { state: string; stateLink: { id: string; scope: string | undefined } }
      > => {
        const rt = makeRuntime();
        try {
          // The live ordering: the served doc (and its label metadata) is in
          // the client's replica BEFORE the client's own wish action preps.
          if (prePullLink !== undefined) {
            const pre = rt.runtime.getCellFromLink(
              {
                id: prePullLink.id,
                space,
                scope: prePullLink.scope,
                path: [],
              } as never,
              undefined,
              undefined,
            );
            await pre.pull();
          }
          const { commonfabric } = createTrustedBuilder(rt.runtime);
          const { wish, pattern } = commonfabric;
          const tx = rt.runtime.edit();
          const wishPattern = pattern(() => ({
            secretWish: wish({
              query: "/secret",
              schema: profileViewSchema as Record<string, unknown>,
            }),
          }));
          const resultCell = rt.runtime.getCell<{ secretWish?: unknown }>(
            space,
            "ow50 wish surfacing result",
            undefined,
            tx,
          );
          const result = rt.runtime.run(tx, wishPattern, {}, resultCell);
          rt.runtime.prepareTxForCommit(tx);
          await tx.commit();
          await result.pull().catch(() => {});
          await rt.runtime.idle();
          // Let the failure-surfacing bookkeeping transaction (spawned from a
          // commit callback, with its own bounded retries) land. This file is
          // on the REAL clock (clock-preload.ts realClockFiles): the
          // two-writer journey drives live cross-runtime storage transport,
          // the class the fake clock's auto-advance mode cannot pace.
          await new Promise((resolve) => setTimeout(resolve, 200));
          await rt.runtime.idle();
          const readTx = rt.runtime.edit();
          const fieldLink = result.key("secretWish").getAsNormalizedFullLink();
          const resolved = resolveLink(rt.runtime, readTx, fieldLink);
          readTx.abort();
          return {
            state: JSON.stringify(result.key("secretWish").get() ?? null),
            stateLink: { id: resolved.id, scope: resolved.scope },
          };
        } finally {
          await rt.close();
        }
      };

      const seedTarget = async (cellName: string, name: string) => {
        const rt = makeRuntime();
        try {
          const spaceCell = rt.runtime.getCell<{ secret?: unknown }>(
            space,
            space,
          );
          await spaceCell.pull();
          const tx = rt.runtime.edit();
          const secretCell = rt.runtime.getCell(
            space,
            cellName,
            secretProfileDocSchema,
            tx,
          );
          secretCell.set({ name });
          spaceCell.withTx(tx).key("secret").set(secretCell.withTx(tx));
          rt.runtime.prepareTxForCommit(tx);
          const res = await tx.commit();
          expect(res.error).toBeUndefined();
          await rt.runtime.idle();
        } finally {
          await rt.close();
        }
      };

      let lastLink: { id: string; scope: string | undefined } | undefined;
      return {
        makeRuntime,
        runWishOnce: async (
          prePullLink?: { id: string; scope: string | undefined },
        ) => {
          const { state, stateLink } = await runWish(prePullLink);
          lastLink = stateLink;
          return state;
        },
        seedTarget,
        resolveStateDocLink: () => {
          if (lastLink === undefined) {
            throw new Error("run the wish before resolving its state doc");
          }
          return Promise.resolve(lastLink);
        },
      };
    };

    it("the ruled wish shape merges cleanly across two writers (RULING 5 flip)", async () => {
      // Red-first for the narrowing: before RULING 5 this journey's second
      // writer was refused at commit-prep (the crash this suite pinned) and
      // the state froze at writer A\'s value with a surfaced error. Under the
      // ruling the single-carrier presence union merges, so writer B\'s
      // changed /result link LANDS — the profile-embed lift condition.
      const journey = makeJourney();
      await journey.seedTarget("ow50-secret-a", "classified");
      const stateA = await journey.runWishOnce();
      expect(stateA).toContain("classified");

      await journey.seedTarget("ow50-secret-b", "still classified");
      const stateB = await journey.runWishOnce();
      expect(stateB).toContain("still classified");
      expect(stateB).not.toContain('"error"');
    });

    it("a genuinely-ambiguous stored envelope still refuses — and the wish surfaces it", async () => {
      // Discovery pass (its own server): the wish-state doc id is
      // content-derived from (space, pattern, result-cell id), so a fresh
      // server reproduces the same id.
      const discovery = makeJourney();
      await discovery.seedTarget("ow50-secret-a", "classified");
      await discovery.runWishOnce();
      const stateDoc = await discovery.resolveStateDocLink();

      // The live journey: seed the AMBIGUOUS envelope at that id FIRST (the
      // first writer never merges, so it lands and poisons the doc), then run
      // the real wish — its state commit meets the stored ambiguous envelope,
      // the narrowed assert still refuses (two ifc carriers), and the OW50
      // surfacing writes the reason into the state doc.
      const journey = makeJourney();
      await journey.seedTarget("ow50-secret-a", "classified");
      {
        const rt = journey.makeRuntime();
        try {
          const tx = rt.runtime.edit();
          const cell = rt.runtime.getCellFromLink(
            {
              id: stateDoc.id,
              space,
              scope: stateDoc.scope,
              path: [],
            } as never,
            ambiguousWishShapedSchema,
            tx,
          );
          cell.set({ candidates: [{ name: "Bob" }] });
          rt.runtime.prepareTxForCommit(tx);
          const res = await tx.commit();
          expect(res.error).toBeUndefined();
          await rt.runtime.idle();
        } finally {
          await rt.close();
        }
      }
      await journey.runWishOnce(stateDoc);

      // Read the state DOC directly: the refused wish commit also carried the
      // piece-result link write, so the result field never resolves — the
      // surfaced error lives on the doc itself.
      {
        const rt = journey.makeRuntime();
        try {
          const cell = rt.runtime.getCellFromLink(
            {
              id: stateDoc.id,
              space,
              scope: stateDoc.scope,
              path: [],
            } as never,
            undefined,
            undefined,
          );
          await cell.pull();
          const value = JSON.stringify(cell.get() ?? null);
          expect(value).toMatch(/divergent anyOf|commit-prep crashed/);
          expect(value).toContain('"error"');
          expect(value).toContain("$UI");
        } finally {
          await rt.close();
        }
      }
    });
  });

  describe("surfacability filter", () => {
    // The failure observer's admission filter and its surfaced text
    // (verification-coverage OW50): deliberate control-flow aborts must NOT
    // paint a red error over converging control flow — `RetryImmediately`
    // (run.ts's rescheduleActionForImmediateRetry aborts the transaction and
    // immediately re-runs the action, which lands the good state) is the
    // confirmed benign class. Killing mutation: removing the RetryImmediately
    // exclusion from `isSurfacableWishCommitFailure` flips the first pin red.

    it("excludes RetryImmediately-reasoned aborts (benign control flow)", () => {
      expect(isSurfacableWishCommitFailure({
        name: "StorageTransactionAborted",
        reason: new RetryImmediately(),
      })).toBe(false);
    });

    it("excludes the conflict and inconsistency classes (the scheduler converges them)", () => {
      expect(isSurfacableWishCommitFailure({ name: "ConflictError" })).toBe(
        false,
      );
      expect(
        isSurfacableWishCommitFailure({
          name: "StorageTransactionInconsistent",
        }),
      ).toBe(false);
    });

    it("surfaces CFC-modeled refusals and genuine crash-backstop aborts", () => {
      expect(isSurfacableWishCommitFailure({
        name: "StorageTransactionAborted",
        message: "CFC enforcement rejected commit: relevant transaction was " +
          "not prepared: CFC commit-prep crashed: boom",
      } as { name?: string; reason?: unknown })).toBe(true);
      expect(isSurfacableWishCommitFailure({
        name: "StorageTransactionAborted",
        message: "Transaction was aborted",
        reason: new Error("synthetic prep crash"),
      } as { name?: string; reason?: unknown })).toBe(true);
    });

    it("surfaces the informative layer, not the debug dump", () => {
      // A plain abort's own message is generic; the cause rides `reason`.
      expect(wishCommitFailureMessage({
        message: "Transaction was aborted",
        reason: new Error("synthetic prep crash"),
      })).toBe("synthetic prep crash");
      // A CFC-modeled rejection carries everything in `message`.
      const modeled = "CFC enforcement rejected commit: relevant transaction " +
        "was not prepared: CFC commit-prep crashed: ifc inside divergent " +
        "anyOf branches is unsupported at /result";
      expect(wishCommitFailureMessage({ message: modeled })).toBe(modeled);
    });
  });

  describe("scheduler prep-throw backstop", () => {
    // Backstop: the scheduler must survive ANY throw escaping
    // `prepareTxForCommit` — not only the CFC-prep class the boundary catch
    // above models. Before the fix, a prep throw left the action's transaction
    // unsettled, re-entered the finalize path from the run promise's rejection
    // handler, threw AGAIN, and escaped as an unhandled rejection with the run
    // promise never resolving.

    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    it("an arbitrary prepareTxForCommit throw fails the action's commit instead of wedging the run", async () => {
      const errors: Error[] = [];
      runtime.scheduler.onError((e) => {
        errors.push(e);
      });

      // Throw for every prep while the crashing action is the writer — a
      // deterministic crash re-throws on the finalize re-entry too, which is
      // what wedged the run promise before the fix.
      const realPrepare = runtime.prepareTxForCommit.bind(runtime);
      let crashPrep = false;
      (runtime as { prepareTxForCommit: Runtime["prepareTxForCommit"] })
        .prepareTxForCommit = (tx) => {
          if (crashPrep) {
            throw new Error("synthetic prep crash");
          }
          return realPrepare(tx);
        };

      const target = runtime.getCell<number>(
        space,
        "prep-throw-backstop-target",
        undefined,
      );
      let runs = 0;
      const action = (actionTx: IExtendedStorageTransaction) => {
        runs++;
        crashPrep = true;
        target.withTx(actionTx).set(runs);
      };
      runtime.scheduler.subscribe(action, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await runtime.scheduler.idle();
      expect(runs).toBeGreaterThanOrEqual(1);
      // Stop crashing before the healthy probe below.
      crashPrep = false;

      // The scheduler is alive: a later action still runs and commits (the
      // stub has reverted to the real prepare).
      const healthy = runtime.getCell<number>(
        space,
        "prep-throw-backstop-healthy",
        undefined,
      );
      let healthyRuns = 0;
      const healthyAction = (actionTx: IExtendedStorageTransaction) => {
        healthyRuns++;
        healthy.withTx(actionTx).set(7);
      };
      runtime.scheduler.subscribe(healthyAction, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, { isEffect: true });
      await runtime.scheduler.idle();
      expect(healthyRuns).toBeGreaterThanOrEqual(1);
      expect(healthy.get()).toBe(7);
    });
  });
});
