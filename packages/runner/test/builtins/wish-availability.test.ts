import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type ClientMessage,
  decodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import { connect, loopback } from "@commonfabric/memory/v2/client";
import { defer } from "@commonfabric/utils/defer";

import { NAME } from "../../src/builder/types.ts";
import { wish } from "../../src/builtins/wish.ts";
import { useCancelGroup } from "../../src/cancel.ts";
import type { Cell } from "../../src/cell.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import type { SessionFactory } from "../../src/storage/v2.ts";
import { TestStorageManager } from "../memory-v2-test-utils.ts";

const user = await Identity.fromPassphrase("generic wish availability");
const candidateSpace = await Identity.fromPassphrase("generic wish candidate");
const fieldSpace = await Identity.fromPassphrase("generic wish linked field");

function makeRuntime(storageManager: Runtime["storageManager"]): Runtime {
  return new Runtime({
    apiUrl: new URL("https://example.invalid"),
    storageManager,
    experimental: { serverExecution: false },
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "off",
    cfcWriteFloor: "off",
    cfcTriggerReadGating: false,
    cfcDecomposedEnvelopes: false,
    cfcPolicyEvaluation: "off",
    cfcLabelMetadataProtection: "off",
    cfcDeclaredMonotonicity: "off",
  });
}

describe("wish-availability", () => {
  for (
    const scenario of [
      {
        name: "a shared search has only absent candidates",
        query: "#notebook",
        scope: ["."],
        headless: true,
        error: "No mentionables found",
      },
      {
        name: "a direct search has only absent candidates",
        query: "#notebook",
        scope: ["."],
        headless: false,
        error: "No mentionables found",
      },
      {
        name: "a profile has no discovery collection",
        query: "#notebook",
        scope: ["profile"],
        headless: false,
        error: "No profile found matching",
      },
      {
        name: "the root target has no supported scope",
        query: "/",
        scope: ["profile"],
        headless: false,
        error: 'Wish target "/" is not recognized',
      },
    ]
  ) {
    it(`publishes a terminal error when ${scenario.name}`, async () => {
      const manager = EmulatedStorageManager.emulate({ as: user });
      const runtime = makeRuntime(manager);
      const [cancel, addCancel] = useCancelGroup();
      try {
        const inputs = runtime.getCell(user.did(), "inputs");
        const owner = runtime.getCell(user.did(), "owner");
        const missing = runtime.getCell(candidateSpace.did(), "absent");
        const profile = runtime.getCell(fieldSpace.did(), "profile");
        const profileTx = runtime.edit();
        profile.withTx(profileTx).set({ initialNameApplied: "Tester" });
        runtime.prepareTxForCommit(profileTx);
        expect((await profileTx.commit()).error).toBeUndefined();
        const tx = runtime.edit();
        runtime.getHomeSpaceCell(tx).asSchema(undefined).set({
          defaultPattern: {
            profiles: [profile],
            defaultProfile: profile,
            backlinksIndex: { mentionable: [missing] },
          },
        });
        inputs.withTx(tx).set({
          query: scenario.query,
          scope: scenario.scope,
          headless: scenario.headless,
        });
        owner.withTx(tx).set({});
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await manager.synced();
        let output: Cell<unknown> | undefined;
        const completed = defer<void>();
        const resolver = wish(
          inputs as Cell<[unknown, unknown]>,
          (_tx, value) => {
            output = runtime.getCellFromLink(value as Cell<unknown>);
            addCancel(
              output.withTx(undefined).key("error").asSchema<string>({
                type: "string",
              }).sink((error) => {
                if (error !== undefined) completed.resolve();
              }),
            );
          },
          addCancel,
          [owner],
          owner,
          runtime,
        );
        resolver.onActionRegistered?.(resolver.action);
        addCancel(
          runtime.scheduler.subscribe(resolver.action, { isEffect: true }),
        );
        await completed.promise;
        await runtime.scheduler.idleWithPendingCommits();
        expect(output).toBeDefined();
        const state = output!.withTx(undefined);
        expect(state.key("error").get()).toContain(scenario.error);
        expect(state.key("candidates").get()).toEqual([]);
        expect(state.key("result").get()).toBeUndefined();
      } finally {
        cancel();
        await manager.synced();
        await runtime.dispose();
      }
    });
  }

  it("resolves while an unrelated document is still loading", async () => {
    const manager = EmulatedStorageManager.emulate({ as: user });
    const runtime = makeRuntime(manager);
    const [cancel, addCancel] = useCancelGroup();
    const requested = defer<void>();
    const release = defer<void>();
    const unrelated = runtime.getCell(candidateSpace.did(), "unrelated");
    const provider = manager.open(candidateSpace.did());
    const originalSync = provider.sync.bind(provider);
    try {
      const inputs = runtime.getCell(user.did(), "inputs");
      const owner = runtime.getCell(user.did(), "owner");
      const candidate = runtime.getCell(user.did(), "available-candidate");
      const tx = runtime.edit();
      candidate.withTx(tx).set({ [NAME]: "notebook", body: "Available" });
      runtime.getHomeSpaceCell(tx).asSchema(undefined).set({
        defaultPattern: { backlinksIndex: { mentionable: [candidate] } },
      });
      inputs.withTx(tx).set({ query: "#notebook", scope: ["."] });
      owner.withTx(tx).set({});
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await manager.synced();
      provider.sync = async (...args) => {
        requested.resolve();
        await release.promise;
        return originalSync(...args);
      };
      manager.trackUntilSettled(unrelated.sync());
      await requested.promise;
      let output: Cell<unknown> | undefined;
      const resolver = wish(
        inputs as Cell<[unknown, unknown]>,
        (_tx, value) => {
          output = runtime.getCellFromLink(value as Cell<unknown>);
        },
        addCancel,
        [owner],
        owner,
        runtime,
      );
      const resolving = runtime.edit();
      resolver.action(resolving);
      runtime.prepareTxForCommit(resolving);
      expect((await resolving.commit()).error).toBeUndefined();
      expect(output).toBeDefined();
      expect(output!.withTx(undefined).key("result").key("body").get()).toBe(
        "Available",
      );
    } finally {
      release.resolve();
      cancel();
      provider.sync = originalSync;
      await manager.synced();
      await runtime.dispose();
    }
  });

  for (
    const { outcome, target } of (["index", "candidate"] as const).flatMap(
      (target) =>
        (["absent", "failed", "cancelled"] as const).map((outcome) => ({
          outcome,
          target,
        })),
    )
  ) {
    const candidateLabel = target === "candidate" ? " candidate" : "";
    it(`finishes a shared resolver's ${outcome}${candidateLabel} load without a storage write`, async () => {
      const manager = EmulatedStorageManager.emulate({ as: user });
      const runtime = makeRuntime(manager);
      const [cancel, addCancel] = useCancelGroup();
      const requested = defer<void>();
      const release = defer<void>();
      const missing = runtime.getCell(
        candidateSpace.did(),
        `missing-${target}`,
      );
      const provider = manager.open(candidateSpace.did());
      const originalSync = provider.sync.bind(provider);
      try {
        const inputs = runtime.getCell(user.did(), "inputs");
        const owner = runtime.getCell(user.did(), "owner");
        const tx = runtime.edit();
        runtime.getHomeSpaceCell(tx).asSchema(undefined).set({
          defaultPattern: {
            backlinksIndex: target === "index"
              ? missing
              : { mentionable: [missing] },
          },
        });
        inputs.withTx(tx).set({
          query: "#notebook",
          scope: ["."],
          headless: true,
        });
        owner.withTx(tx).set({});
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit()).error).toBeUndefined();
        await manager.synced();
        provider.sync = async (id, ...rest) => {
          if (id === missing.getAsNormalizedFullLink().id) {
            requested.resolve();
            await release.promise;
            if (outcome === "failed") {
              return { error: new Error("Load failed") };
            }
          }
          return originalSync(id, ...rest);
        };
        let output: Cell<unknown> | undefined;
        const completed = defer<void>();
        const resolver = wish(
          inputs as Cell<[unknown, unknown]>,
          (_tx, value) => {
            output = runtime.getCellFromLink(value as Cell<unknown>);
            addCancel(
              output.withTx(undefined).key("error").asSchema<string>({
                type: "string",
              }).sink((error) => {
                if (error !== undefined) completed.resolve();
              }),
            );
          },
          addCancel,
          [owner],
          owner,
          runtime,
        );
        resolver.onActionRegistered?.(resolver.action);
        addCancel(
          runtime.scheduler.subscribe(resolver.action, { isEffect: true }),
        );
        await requested.promise;
        await runtime.scheduler.idleWithPendingCommits();
        expect(output).toBeDefined();
        const state = output!.withTx(undefined);
        expect(state.key("candidates").get()).toBeUndefined();
        if (outcome === "cancelled") cancel();
        release.resolve();
        if (outcome !== "cancelled") await completed.promise;
        await manager.synced();
        await runtime.scheduler.idleWithPendingCommits();
        if (outcome === "cancelled") {
          expect(state.get()).toBeUndefined();
        } else {
          expect(state.key("error").get()).toContain(
            outcome === "failed"
              ? "Could not load document"
              : "No mentionables found",
          );
          expect(state.key("candidates").get()).toEqual([]);
        }
      } finally {
        release.resolve();
        cancel();
        provider.sync = originalSync;
        await manager.synced();
        await runtime.dispose();
      }
    });
  }

  for (const kind of ["shared", "direct", "favorites"] as const) {
    for (
      const heldDocument of ["root", "index", "candidate", "field"] as const
    ) {
      it(`withholds incomplete selections while ${kind} loads its ${heldDocument}`, async () => {
        const server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
        const seed = makeRuntime(
          EmulatedStorageManager.connectTo(server, { as: user }),
        );
        const root = seed.getHomeSpaceCell().asSchema(undefined);
        const home = seed.getCell(user.did(), "home");
        const index = seed.getCell(user.did(), "index");
        const candidate = seed.getCell(candidateSpace.did(), "candidate");
        const field = seed.getCell(fieldSpace.did(), "field");
        const inputs = seed.getCell(user.did(), "inputs");
        const owner = seed.getCell(user.did(), "owner");
        const heldId = { root, index, candidate, field }[heldDocument]
          .getAsNormalizedFullLink().id;
        const requested = defer<void>();
        const release = defer<void>();
        let held = true;
        const factory: SessionFactory = {
          async create(space, signer, options = {}) {
            const base = loopback(server);
            const client = await connect({
              transport: {
                ...base,
                async send(payload) {
                  const message = decodeMemoryBoundary(
                    payload,
                  ) as ClientMessage;
                  const roots = message.type === "graph.query"
                    ? message.query.roots
                    : message.type === "session.watch.add" ||
                        message.type === "session.watch.set"
                    ? message.watches.flatMap((watch) =>
                      watch.kind === "operation" ? [] : watch.query.roots
                    )
                    : [];
                  if (held && roots.some((entry) => entry.id === heldId)) {
                    requested.resolve();
                    await release.promise;
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
        const runtime = makeRuntime(
          TestStorageManager.create({
            as: user,
            memoryHost: new URL("memory://"),
          }, factory),
        );
        const [cancel, addCancel] = useCancelGroup();
        try {
          const fieldTx = seed.edit();
          field.withTx(fieldTx).set(
            kind === "favorites" ? ["notebook"] : "notebook",
          );
          seed.prepareTxForCommit(fieldTx);
          expect((await fieldTx.commit()).error).toBeUndefined();
          const candidateTx = seed.edit();
          candidate.withTx(candidateTx).set({
            [NAME]: kind === "favorites" ? "notebook" : field,
            body: "Existing notebook",
          });
          seed.prepareTxForCommit(candidateTx);
          expect((await candidateTx.commit()).error).toBeUndefined();
          const tx = seed.edit();
          index.withTx(tx).set(
            kind === "favorites"
              ? [{ cell: candidate, userTags: field }]
              : { mentionable: [candidate] },
          );
          home.withTx(tx).set(
            kind === "favorites"
              ? { favorites: index }
              : { backlinksIndex: index },
          );
          root.withTx(tx).set({ defaultPattern: home });
          inputs.withTx(tx).set({
            query: "#notebook",
            scope: [kind === "favorites" ? "~" : "."],
            headless: kind !== "direct",
            schema: {
              type: "object",
              properties: { body: { type: "string" } },
            },
          });
          owner.withTx(tx).set({});
          seed.prepareTxForCommit(tx);
          expect((await tx.commit()).error).toBeUndefined();
          await seed.storageManager.synced();

          const coldInputs = runtime.getCellFromLink(
            inputs.getAsNormalizedFullLink(),
          );
          const coldOwner = runtime.getCellFromLink(
            owner.getAsNormalizedFullLink(),
          );
          await Promise.all([coldInputs.sync(), coldOwner.sync()]);
          let output: Cell<unknown> | undefined;
          const published = defer<void>();
          const resolver = wish(
            coldInputs as Cell<[unknown, unknown]>,
            (_tx, value) => {
              output = runtime.getCellFromLink(value as Cell<unknown>);
              addCancel(
                output.withTx(undefined).key("result").key("body").asSchema<
                  string
                >({ type: "string" }).sink(
                  (body) => {
                    if (body === "Existing notebook") published.resolve();
                  },
                ),
              );
            },
            addCancel,
            [coldOwner],
            coldOwner,
            runtime,
          );
          resolver.onActionRegistered?.(resolver.action);
          addCancel(
            runtime.scheduler.subscribe(resolver.action, { isEffect: true }),
          );
          await requested.promise;
          await runtime.scheduler.idleWithPendingCommits();
          // A shared resolver can publish its reference immediately; neither
          // path may publish an empty candidate list or a no-match error.
          expect(output?.withTx(undefined).key("candidates").get())
            .toBeUndefined();
          expect(output?.withTx(undefined).key("error").get()).toBeUndefined();
          held = false;
          release.resolve();
          await published.promise;
          await runtime.scheduler.idleWithPendingCommits();
          expect(output).toBeDefined();
          const state = output!.withTx(undefined);
          expect(state.key("error").get()).toBeUndefined();
          expect(state.key("result").key("body").get()).toBe(
            "Existing notebook",
          );
          expect(state.key("candidates").get()).toHaveLength(1);
        } finally {
          held = false;
          release.resolve();
          cancel();
          await runtime.storageManager.synced();
          await runtime.dispose();
          await seed.dispose();
          await server.close();
        }
      });
    }
  }
});
