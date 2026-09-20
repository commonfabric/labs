/**
 * Exercises profile readiness across cold replicas, failed loads,
 * cancellation, replica reset, and CFC flow-label propagation.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { defer } from "@commonfabric/utils/defer";

import type { JSONSchema } from "../../src/builder/types.ts";
import { wish } from "../../src/builtins/wish.ts";
import {
  createWishProfileReadiness,
  WishProfilePending,
} from "../../src/builtins/wish-profile-readiness.ts";
import type { Cell } from "../../src/cell.ts";
import { canonicalizeCfcLabel } from "../../src/cfc/canonical.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { rawMetaWriteAuthorization } from "../../src/meta-seam.ts";
import { Runtime } from "../../src/runtime.ts";
import type { IStorageNotification } from "../../src/storage/interface.ts";
import { StorageNotificationRelay } from "../../src/storage/subscription.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import type { SessionFactory } from "../../src/storage/v2.ts";
import { TestStorageManager } from "../memory-v2-test-utils.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const user = await Identity.fromPassphrase("local profile cold-link consumer");
const board = await Identity.fromPassphrase("local profile cold-link board");
const persona = await Identity.fromPassphrase(
  "local profile cold-link persona",
);

const profileSchema: JSONSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    avatar: { type: "string" },
    initialNameApplied: { type: "string" },
  },
  required: ["name", "avatar"],
  ifc: { confidentiality: ["local-profile"] },
};

/** Helper for cold reads, which uses explicit CFC enforcement on a client. */
const makeRuntime = (storageManager: Runtime["storageManager"]) =>
  new Runtime({
    apiUrl: new URL("https://example.invalid"),
    storageManager,
    experimental: {
      serverExecution: false,
      computedCellIds: true,
      lazyMaterialization: true,
      contentAddressedSchemas: true,
      readerSchemaPrecedence: true,
      modernCellRep: false,
      commitPreconditions: true,
      plainResultReceipts: true,
    },
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "off",
    cfcWriteFloor: "off",
    cfcTriggerReadGating: false,
    cfcDecomposedEnvelopes: false,
    cfcPolicyEvaluation: "off",
    cfcLabelMetadataProtection: "off",
    cfcDeclaredMonotonicity: "off",
  });

describe("wish-profile-readiness", () => {
  it("carries the profile document's existence label into the derived result", async () => {
    const manager = EmulatedStorageManager.emulate({ as: user });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.invalid"),
      storageManager: manager,
      cfcFlowLabels: "persist",
    });
    const cancels: (() => void)[] = [];
    try {
      const profile = runtime.getCell(user.did(), "labeled-profile");
      const address = profile.getAsNormalizedFullLink();
      const confidentiality = [{
        anyOf: ["profile-presence", cfcAtom.space(user.did())],
      }];
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, user.did());
      seedStoredEnvelope(seed, { ...address, path: [] }, {
        value: { name: "Labeled profile" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{ path: [], label: { confidentiality } }],
          },
        },
      });
      expect((await seed.commit()).error).toBeUndefined();
      const readiness = createWishProfileReadiness(
        runtime,
        (cancel) => cancels.push(cancel),
      );
      const tx = runtime.edit();
      const output = runtime.getCell(user.did(), "profile-presence-result");
      const present = readiness.requireDocument(profile, tx);
      expect(present).toBe(true);
      output.withTx(tx).set({ present });
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const inspect = runtime.edit();
      try {
        const metadata = readStoredCfcMetadata(
          inspect,
          output.getAsNormalizedFullLink(),
        );
        expect(
          metadata?.labelMap?.entries.find((entry) =>
            entry.origin === "derived"
          )?.label.confidentiality,
        )
          .toEqual(canonicalizeCfcLabel({ confidentiality }).confidentiality);
      } finally {
        inspect.abort();
      }
    } finally {
      cancels.forEach((cancel) => cancel());
      await manager.synced();
      await runtime.idle();
      await runtime.dispose();
    }
  });

  for (const asCell of [false, true]) {
    it(`waits for a cold profile alias before publishing it (asCell=${asCell})`, async () => {
      const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
      const seedManager = EmulatedStorageManager.connectTo(server, {
        as: user,
      });
      const seed = makeRuntime(seedManager);
      const requested = defer<void>();
      const released = defer<void>();
      let held = true;
      const factory: SessionFactory = {
        async create(space, signer, options = {}) {
          const base = loopback(server);
          const client = await connect({
            transport: {
              ...base,
              async send(payload) {
                const message = decodeMemoryBoundary(payload) as {
                  type: string;
                };
                if (
                  held && space === persona.did() &&
                  ["session.watch.add", "session.watch.set", "graph.query"]
                    .includes(message.type)
                ) {
                  requested.resolve();
                  await released.promise;
                }
                await base.send(payload);
              },
            },
          });
          const session = await client.mount(
            space,
            options,
            (_space, _session, context) => ({
              invocation: {
                aud: context.audience,
                challenge: context.challenge.value,
              },
              authorization: { principal: signer?.did() },
            }),
          );
          return { client, session };
        },
      };
      const manager = TestStorageManager.create({
        as: user,
        memoryHost: new URL("memory://"),
      }, factory);
      const runtime = makeRuntime(manager);
      const cancels: (() => void)[] = [];
      try {
        const profile = seed.getCell(persona.did(), "profile-result");
        const alias = seed.getCell(persona.did(), "profile-alias");
        {
          const tx = seed.edit();
          profile.withTx(tx).asSchema(profileSchema).set({
            name: "Synthetic profile",
            avatar: "",
            initialNameApplied: "Synthetic profile",
          });
          profile.withTx(tx).setMetaRaw(
            "schema",
            profileSchema,
            rawMetaWriteAuthorization,
          );
          // A legacy alias has no producer schema or CFC envelope of its own.
          const address = alias.getAsNormalizedFullLink();
          tx.writeOrThrow({ ...address, path: ["value"] }, profile.getAsLink());
          seed.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
        }
        const homeDefault = seed.getCell(user.did(), "home-result");
        {
          const tx = seed.edit();
          homeDefault.withTx(tx).setRaw({ profiles: [alias.getAsLink()] });
          seed.getHomeSpaceCell(tx).asSchema(undefined).setRaw({
            defaultPattern: homeDefault.getAsLink(),
          });
          seed.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
        }
        const parent = seed.getCell(board.did(), "consumer");
        const inputs = seed.getCell(board.did(), "wish-inputs");
        const state = seed.getCell(board.did(), { wish: { state: [parent] } });
        {
          const tx = seed.edit();
          parent.withTx(tx).set({});
          inputs.withTx(tx).set({
            query: "#profile",
            headless: true,
            schema: {
              ...(asCell ? { asCell: ["cell"] } : {}),
              type: "object",
              properties: {
                name: { type: "string" },
                avatar: { type: "string" },
              },
            },
          });
          seed.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
        }
        // A successful warm wish leaves the labeled state a cold client revisits.
        const seedAction = wish(
          inputs as Cell<[unknown, unknown]>,
          () => {},
          (cancel) => cancels.push(cancel),
          [parent],
          parent,
          seed,
        );
        const seedWish = seed.edit();
        seedAction.action(
          seedWish,
        );
        seed.prepareTxForCommit(seedWish);
        expect((await seedWish.commit()).error).toBeUndefined();
        await seedManager.synced();
        const input = runtime.getCellFromLink(inputs.getAsNormalizedFullLink());
        const owner = runtime.getCellFromLink(parent.getAsNormalizedFullLink());
        const stateCell = runtime.getCellFromLink({
          ...state.getAsNormalizedFullLink(),
          scope: "user",
        });
        await Promise.all([
          input.sync(),
          owner.sync(),
          stateCell.sync(),
          runtime.getHomeSpaceCell().sync(),
          runtime.getCellFromLink(homeDefault.getAsNormalizedFullLink()).sync(),
        ]);
        const inspect = runtime.edit();
        expect(
          readStoredCfcMetadata(inspect, stateCell.getAsNormalizedFullLink()),
        )
          .toBeDefined();
        inspect.abort();
        let output: Cell<unknown> | undefined;
        const action = wish(
          input as Cell<[unknown, unknown]>,
          (_tx, value) => {
            output = value as Cell<unknown>;
          },
          (cancel) => cancels.push(cancel),
          [owner],
          owner,
          runtime,
        );
        const firstAttempt = defer<void>();
        const published = defer<void>();
        const attempts: { error?: string; sources: string[] }[] = [];
        const scheduled = (
          tx: Parameters<typeof runtime.prepareTxForCommit>[0],
        ) => {
          action.action(tx);
          const sources = tx.getCfcState().writePolicyInputs
            .filter((input) => input.kind === "link-write")
            .map((input) => input.source.id);
          tx.addVerdictCallback((_tx, result) => {
            attempts.push({ error: result.error?.name, sources });
            firstAttempt.resolve();
            if (
              !result.error && output !== undefined
            ) {
              published.resolve();
            }
          });
        };
        action.onActionRegistered?.(scheduled);
        cancels.push(
          runtime.scheduler.subscribe(scheduled, { isEffect: true }),
        );
        await firstAttempt.promise;
        await requested.promise;
        expect(attempts[0].error).toBeUndefined();
        expect(attempts[0].sources).toEqual([]);
        expect(output).toBeUndefined();
        held = false;
        released.resolve();
        await published.promise;
        await runtime.scheduler.idleWithPendingCommits();
        expect(attempts.every((attempt) => attempt.error === undefined)).toBe(
          true,
        );
        expect(output).toBeDefined();
        const result = output!.withTx(undefined).key("result").resolveAsCell()
          .asSchema(undefined).key("name");
        await result.sync();
        expect(result.get()).toBe("Synthetic profile");
        expect(output!.withTx(undefined).key("error").get()).toBeUndefined();
        const sourceCheck = runtime.edit();
        expect(
          readStoredCfcMetadata(sourceCheck, alias.getAsNormalizedFullLink()),
        )
          .toBeUndefined();
        expect(
          readStoredCfcMetadata(sourceCheck, profile.getAsNormalizedFullLink()),
        )
          .toBeDefined();
        sourceCheck.abort();
      } finally {
        held = false;
        released.resolve();
        cancels.forEach((cancel) => cancel());
        await runtime.dispose();
        await seed.dispose();
        await server.close();
      }
    });
  }

  for (const outcome of ["absent", "failed", "cancelled"] as const) {
    const description = {
      absent:
        "keeps profile creation closed when the referenced profile is absent",
      failed: "keeps profile creation closed when the profile load fails",
      cancelled: "publishes nothing after cancellation during a profile load",
    }[outcome];
    it(description, async () => {
      const manager = EmulatedStorageManager.emulate({ as: user });
      const runtime = makeRuntime(manager);
      const cancels: (() => void)[] = [];
      const release = defer<void>();
      const originalSync = manager.syncCell.bind(manager);
      try {
        const profile = runtime.getCell(persona.did(), "missing-profile");
        const owner = runtime.getCell(board.did(), "consumer");
        const inputs = runtime.getCell(board.did(), "wish-inputs");
        let tx = runtime.edit();
        runtime.getHomeSpaceCell(tx).asSchema(undefined).setRaw({
          defaultPattern: { profiles: [profile.getAsLink()] },
        });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        tx = runtime.edit();
        owner.withTx(tx).set({});
        inputs.withTx(tx).set({ query: "#profile", headless: true });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        manager.syncCell = async (cell, options) => {
          if (cell.space === persona.did()) {
            await release.promise;
            if (outcome === "failed") throw new Error("Profile load failed");
          }
          return originalSync(cell, options);
        };
        let output: Cell<unknown> | undefined;
        let publications = 0;
        const result = wish(
          inputs as Cell<[unknown, unknown]>,
          (_tx, value) => {
            output = value as Cell<unknown>;
            publications++;
          },
          (cancel) => cancels.push(cancel),
          [owner],
          owner,
          runtime,
        );
        const attempted = defer<void>();
        const scheduled = (runTx: ReturnType<Runtime["edit"]>) => {
          result.action(runTx);
          runTx.addVerdictCallback((_tx, verdict) => {
            expect(verdict.error).toBeUndefined();
            attempted.resolve();
          });
        };
        cancels.push(
          runtime.scheduler.subscribe(scheduled, { isEffect: true }),
        );
        result.onActionRegistered?.(scheduled);
        await attempted.promise;
        expect(output).toBeUndefined();
        if (outcome === "cancelled") {
          cancels.splice(0).forEach((cancel) => cancel());
        }
        release.resolve();
        await manager.synced();
        await runtime.idle();
        if (outcome === "cancelled") {
          const arrived = runtime.edit();
          profile.withTx(arrived).set({
            name: "Profile arriving after cancel",
          });
          runtime.prepareTxForCommit(arrived);
          expect((await arrived.commit()).error).toBeUndefined();
          const lateAttempt = runtime.edit();
          try {
            result.action(lateAttempt);
            expect(lateAttempt.getCfcState().writePolicyInputs).toEqual([]);
          } finally {
            lateAttempt.abort();
          }
          expect(publications).toBe(0);
        } else {
          expect(output).toBeDefined();
          const state = output!.withTx(undefined);
          expect(String(state.key("error").get())).toContain(
            outcome === "failed"
              ? "Could not load profile selection data"
              : "Profile data is unavailable",
          );
          expect(
            state.key("$UI").key("props").key("data-profile-create-ui").get(),
          ).toBeUndefined();
          expect([...runtime.runner.cancels.keys()]).toHaveLength(0);
          // Arrival remains a wake source after either terminal result.
          manager.syncCell = originalSync;
          const arrived = runtime.edit();
          profile.withTx(arrived).set({ name: "Recovered profile" });
          runtime.prepareTxForCommit(arrived);
          expect((await arrived.commit()).error).toBeUndefined();
          await runtime.idle();
          expect(output!.withTx(undefined).key("error").get()).toBeUndefined();
          expect(output!.withTx(undefined).key("result").key("name").get())
            .toBe("Recovered profile");
        }
      } finally {
        release.resolve();
        cancels.forEach((cancel) => cancel());
        manager.syncCell = originalSync;
        await manager.synced();
        await runtime.idle();
        await runtime.dispose();
      }
    });
  }

  for (
    const document of ["Home root", "default pattern", "roster", "profile"]
  ) {
    it(`keeps profile creation closed when the ${document} provider reports a load error`, async () => {
      const manager = EmulatedStorageManager.emulate({ as: user });
      const runtime = makeRuntime(manager);
      const cancels: (() => void)[] = [];
      const home = runtime.getHomeSpaceCell().asSchema(undefined);
      const defaultPattern = runtime.getCell(user.did(), "default-pattern");
      const roster = runtime.getCell(user.did(), "profile-roster");
      const profile = runtime.getCell(persona.did(), "missing-profile");
      const missing = document === "Home root"
        ? home
        : document === "default pattern"
        ? defaultPattern
        : document === "roster"
        ? roster
        : profile;
      const provider = manager.open(missing.space);
      const originalSync = provider.sync.bind(provider);
      let reportedFailures = 0;
      try {
        const owner = runtime.getCell(board.did(), "consumer");
        const inputs = runtime.getCell(board.did(), "wish-inputs");
        let tx = runtime.edit();
        if (document !== "Home root") {
          home.withTx(tx).setRaw({
            defaultPattern: defaultPattern.getAsLink(),
          });
        }
        if (document === "roster" || document === "profile") {
          defaultPattern.withTx(tx).setRaw({ profiles: roster.getAsLink() });
        }
        if (document === "profile") {
          roster.withTx(tx).setRaw([profile.getAsLink()]);
        }
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        tx = runtime.edit();
        owner.withTx(tx).set({});
        inputs.withTx(tx).set({ query: "#profile", headless: true });
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await manager.synced();
        provider.sync = (id, ...rest) => {
          if (id === missing.getAsNormalizedFullLink().id) {
            reportedFailures++;
            return Promise.resolve({
              error: new Error("Provider load failed"),
            });
          }
          return originalSync(id, ...rest);
        };
        let output: Cell<unknown> | undefined;
        const result = wish(
          inputs as Cell<[unknown, unknown]>,
          (_tx, value) => output = value as Cell<unknown>,
          (cancel) => cancels.push(cancel),
          [owner],
          owner,
          runtime,
        );
        result.onActionRegistered?.(result.action);
        cancels.push(
          runtime.scheduler.subscribe(result.action, { isEffect: true }),
        );
        await runtime.idle();
        expect(reportedFailures).toBeGreaterThan(0);
        expect(output).toBeDefined();
        const state = output!.withTx(undefined);
        expect(state.key("error").get()).toBe(
          "Error: Could not load profile selection data",
        );
        expect(
          state.key("$UI").key("props").key("data-profile-create-ui").get(),
        )
          .toBeUndefined();
        expect([...runtime.runner.cancels.keys()]).toHaveLength(0);

        // Arriving data wakes the existing subscription after a provider error.
        provider.sync = originalSync;
        const arrivedProfile = runtime.edit();
        profile.withTx(arrivedProfile).set({ name: "Recovered profile" });
        runtime.prepareTxForCommit(arrivedProfile);
        expect((await arrivedProfile.commit()).error).toBeUndefined();
        const arrived = runtime.edit();
        home.withTx(arrived).setRaw({
          defaultPattern: defaultPattern.getAsLink(),
        });
        defaultPattern.withTx(arrived).setRaw({ profiles: roster.getAsLink() });
        roster.withTx(arrived).setRaw([profile.getAsLink()]);
        runtime.prepareTxForCommit(arrived);
        expect((await arrived.commit()).error).toBeUndefined();
        await runtime.idle();
        expect(output!.withTx(undefined).key("error").get()).toBeUndefined();
        expect(output!.withTx(undefined).key("result").key("name").get())
          .toBe("Recovered profile");
        expect([...runtime.runner.cancels.keys()]).toHaveLength(0);
      } finally {
        provider.sync = originalSync;
        cancels.forEach((cancel) => cancel());
        await manager.synced();
        await runtime.idle();
        await runtime.dispose();
      }
    });
  }

  it("retires cancelled readiness subscriptions when storage has no unsubscribe", async () => {
    const manager = EmulatedStorageManager.emulate({ as: user });
    const runtime = makeRuntime(manager);
    const cancels: (() => void)[] = [];
    const release = defer<void>();
    const relay = new StorageNotificationRelay();
    const originalSync = manager.syncCell.bind(manager);
    const originalSubscribe = manager.subscribe.bind(manager);
    try {
      manager.syncCell = async (cell) => {
        await release.promise;
        return cell;
      };
      manager.subscribe = (subscription) => relay.subscribe(subscription);
      Object.defineProperty(manager, "unsubscribe", {
        value: undefined,
        configurable: true,
      });
      const readiness = createWishProfileReadiness(
        runtime,
        (cancel) => cancels.push(cancel),
      );
      const tx = runtime.edit();
      try {
        expect(() => readiness.requireDocument(runtime.getHomeSpaceCell(), tx))
          .toThrow(WishProfilePending);
      } finally {
        tx.abort();
      }
      expect(relay.hasSubscribers()).toBe(true);
      cancels.splice(0).forEach((cancel) => cancel());
      relay.next({ type: "reset", space: user.did() });
      expect(relay.hasSubscribers()).toBe(false);
    } finally {
      release.resolve();
      cancels.forEach((cancel) => cancel());
      manager.syncCell = originalSync;
      manager.subscribe = originalSubscribe;
      Reflect.deleteProperty(manager, "unsubscribe");
      await runtime.dispose();
    }
  });

  it("requires fresh confirmation after a replica reset during a load", async () => {
    const manager = EmulatedStorageManager.emulate({ as: user });
    const runtime = makeRuntime(manager);
    const cancels: (() => void)[] = [];
    const loads: ReturnType<typeof defer<void>>[] = [];
    const subscriptions: IStorageNotification[] = [];
    const originalSync = manager.syncCell.bind(manager);
    const originalSubscribe = manager.subscribe.bind(manager);
    try {
      const cell = runtime.getCell(user.did(), "missing-home");
      manager.syncCell = async (target) => {
        const load = defer<void>();
        loads.push(load);
        await load.promise;
        return target;
      };
      manager.subscribe = (subscription) => {
        subscriptions.push(subscription);
        originalSubscribe(subscription);
      };
      const readiness = createWishProfileReadiness(
        runtime,
        (cancel) => cancels.push(cancel),
      );
      let runs = 0;
      const registered = () => {
        runs++;
      };
      readiness.onActionRegistered(registered);
      cancels.push(
        runtime.scheduler.subscribe(registered, { isEffect: true }),
      );
      await runtime.scheduler.idleWithPendingCommits();
      expect(runs).toBe(1);
      const requireDocument = () => {
        const tx = runtime.edit();
        try {
          return readiness.requireDocument(cell, tx);
        } finally {
          tx.abort();
        }
      };
      expect(requireDocument).toThrow(WishProfilePending);
      expect(loads).toHaveLength(1);
      runtime.scheduler.setDebounce(registered, 60_000);
      const resetAt = performance.now();
      subscriptions.forEach((subscription) =>
        subscription.next({ type: "reset", space: user.did() })
      );
      await runtime.scheduler.idleWithPendingCommits();
      expect(runs).toBe(2);
      expect(performance.now() - resetAt).toBeLessThan(60_000);
      loads[0].resolve();
      await manager.crossSpaceSettled();
      // The old epoch's completion must not confirm the new replica.
      expect(requireDocument).toThrow(WishProfilePending);
      expect(loads).toHaveLength(2);
      loads[1].resolve();
      await manager.crossSpaceSettled();
      expect(requireDocument()).toBe(false);
    } finally {
      loads.forEach((load) => load.resolve());
      cancels.forEach((cancel) => cancel());
      manager.syncCell = originalSync;
      manager.subscribe = originalSubscribe;
      await runtime.dispose();
    }
  });
});
