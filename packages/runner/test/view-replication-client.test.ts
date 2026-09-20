import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import {
  resetServerExecutionConfig,
  setServerExecutionConfig,
} from "@commonfabric/memory/v2";

import type { Pattern } from "../src/builder/types.ts";
import { COMPONENT_READ_CONTRACT_VERSION } from "../src/component-read-contract.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { ViewPlanPublisher } from "../src/executor/view-plan-publisher.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { getPatternIdentityRef } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler/types.ts";
import type { ISpaceReplica } from "../src/storage/interface.ts";
import { LocalReadUnavailable } from "../src/storage/local-read-policy.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { viewNodeId } from "../src/view-replication.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("view replication client");
const space = signer.did();

describe("view replication client", () => {
  it("defers detached view planning while retaining observations for resumption", async () => {
    const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    const root = runtime.getCell(space, "publisher attachment", undefined);
    const interest = {
      handle: {
        sessionId: "viewer-session",
        sessionEpoch: "session-epoch",
        viewEpoch: "view-epoch",
        viewId: "screen",
        revision: 0,
      },
      principal: signer.did(),
      attached: true,
      view: {
        id: "screen",
        revision: 0,
        mode: "speculate" as const,
        componentContractVersion: COMPONENT_READ_CONTRACT_VERSION,
        query: {
          roots: [{
            id: root.getAsNormalizedFullLink().id,
            selector: { path: [], schema: false as const },
          }],
        },
      },
    };
    const interests = stub(server, "viewInterestsForSpace", () => [interest]);
    const publication = stub(
      server,
      "setViewSelection",
      () => Promise.resolve(true),
    );
    const observations = stub(
      runtime.scheduler,
      "viewExecutionNodes",
      () => [],
    );
    const consumers = spy(runtime.scheduler, "setViewConsumers");
    try {
      const publisher = new ViewPlanPublisher();
      await publisher.publish(runtime, server, space);
      expect(observations.calls).toHaveLength(1);
      interest.attached = false;
      await publisher.publish(runtime, server, space);
      expect(observations.calls).toHaveLength(1);
      expect(consumers.calls.at(-1)?.args).toEqual([space, [{
        principal: signer.did(),
        sessionId: "viewer-session",
      }]]);
      interest.attached = true;
      await publisher.publish(runtime, server, space);
      expect(observations.calls).toHaveLength(2);
    } finally {
      consumers.restore();
      observations.restore();
      publication.restore();
      interests.restore();
      await runtime.dispose();
      await server.close();
    }
  });

  it("preserves replacement runtime interests and revisions on a retained replica", async () => {
    setServerExecutionConfig(true);
    const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const first = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      clientClass: "web",
      experimental: { serverExecution: true, viewScopedReplication: true },
    });
    let second: Runtime | undefined;
    let firstDisposed = false;
    try {
      const root = first.getCell(space, "retained view", undefined);
      const cancelInitial = await first.viewReplication.mount(root, "screen");
      cancelInitial!();
      const cancelOld = await first.viewReplication.mount(root, "screen");
      expect(server.viewInterestsForSpace(space)[0].view.revision).toBe(1);
      second = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        clientClass: "web",
        experimental: { serverExecution: true, viewScopedReplication: true },
      });
      await second.viewReplication.enable(space);
      expect(server.viewInterestsForSpace(space)).toEqual([]);
      const cancelNew = await second.viewReplication.mount(
        second.getCellFromLink(root.getAsNormalizedFullLink()),
        "screen",
      );
      expect(first.viewReplication.active(space)).toBe(false);
      expect(server.viewInterestsForSpace(space)[0].view.revision).toBe(2);
      cancelOld!();
      await first.dispose({ closeStorage: false });
      firstDisposed = true;
      expect(server.viewInterestsForSpace(space)).toHaveLength(1);
      expect(second.viewReplication.active(space)).toBe(true);
      cancelNew!();
      await second.idle();
      expect(server.viewInterestsForSpace(space)).toEqual([]);
    } finally {
      if (!firstDisposed) await first.dispose({ closeStorage: false });
      await second?.dispose({ closeStorage: false });
      await manager.close();
      await server.close();
      resetServerExecutionConfig();
    }
  });

  it("installs a stored graph and previews only the visible admitted computation", async () => {
    const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const author = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    let viewer: Runtime | undefined;
    let cancelView: (() => void) | undefined;
    let cancelRender: (() => void) | undefined;
    let rendered: number | undefined;
    let visibleRuns = 0;
    let hiddenRuns = 0;
    let sideRuns = 0;
    try {
      author.scheduler.setViewConsumers(space, [author.scopeKeyIdentity]);
      const pattern: Pattern = {
        argumentSchema: {
          type: "object",
          properties: {
            input: { type: "number" },
            side: { type: "number" },
            hidden: { type: "string" },
          },
        },
        resultSchema: {},
        derivedInternalCells: [
          {
            partialCause: "hidden-stream",
            schema: { default: { $stream: true } },
            scope: "space",
          },
          ...["output", "side-output", "offscreen"].map((partialCause) => ({
            partialCause,
            schema: {},
            scope: "space" as const,
          })),
        ],
        result: {
          $UI: {
            type: "vnode",
            name: "cf-input",
            props: {
              $value: { $alias: { cell: "argument", path: ["input"] } },
            },
            children: [{ $alias: { partialCause: "output", path: [] } }],
          },
          offscreen: { $alias: { partialCause: "offscreen", path: [] } },
          offscreenEvent: {
            $alias: { partialCause: "hidden-stream", path: [] },
          },
        },
        nodes: [{
          module: {
            type: "javascript",
            implementation: (
              { input, side }: { input: number; side: number },
            ) => {
              visibleRuns++;
              return input * 2 + side;
            },
          },
          inputs: {
            input: { $alias: { cell: "argument", path: ["input"] } },
            side: { $alias: { partialCause: "side-output", path: [] } },
          },
          outputs: { $alias: { partialCause: "output", path: [] } },
        }, {
          module: {
            type: "javascript",
            implementation: (hidden: string) => {
              hiddenRuns++;
              return hidden.toUpperCase();
            },
          },
          inputs: { $alias: { cell: "argument", path: ["hidden"] } },
          outputs: { $alias: { partialCause: "offscreen", path: [] } },
        }, {
          module: {
            type: "javascript",
            implementation: (side: number) => {
              sideRuns++;
              return side * 2;
            },
          },
          inputs: { $alias: { cell: "argument", path: ["side"] } },
          outputs: { $alias: { partialCause: "side-output", path: [] } },
        }, {
          module: {
            type: "javascript",
            wrapper: "handler",
            argumentSchema: {
              type: "object",
              properties: { $event: true },
            },
            implementation: () => undefined,
          },
          inputs: {
            $event: { $alias: { partialCause: "hidden-stream", path: [] } },
          },
          outputs: {},
        }],
      };
      const state = author.getCell<{ input: number; side: number }>(
        space,
        "input",
        {
          type: "object",
          properties: { input: { type: "number" }, side: { type: "number" } },
        },
      );
      const input = state.key("input");
      const side = state.key("side");
      const hidden = author.getCell<string>(space, "hidden", {
        type: "string",
      });
      const result = author.getCell(space, "piece", undefined);
      author.patternManager.associatePatternIdentity(pattern, {
        identity: "view-replication-test",
        symbol: "default",
      });
      await author.editWithRetry((tx) => {
        state.withTx(tx).set({ input: 3, side: 2 });
        hidden.withTx(tx).set("unrelated");
        author.run(
          tx,
          author.unsafeTrustPattern(pattern, {
            reason: "view replication fixture",
          }),
          { input, side, hidden },
          result,
        );
      });
      await result.pull();
      await author.idle();
      await server.flushSessions();
      await author.storageManager.synced();
      const ref = getPatternIdentityRef(result);
      expect(ref).toBeDefined();
      const initialVisibleRuns = visibleRuns;
      const initialHiddenRuns = hiddenRuns;
      const initialSideRuns = sideRuns;
      setServerExecutionConfig(true);
      viewer = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: signer,
        }),
        clientClass: "web",
        experimental: { serverExecution: true, viewScopedReplication: true },
      });
      viewer.patternManager.associatePatternIdentity(
        viewer.unsafeTrustPattern(pattern, {
          reason: "view replication fixture",
        }),
        ref!,
      );
      const viewingResult = viewer.getCellFromLink(
        result.getAsNormalizedFullLink(),
      );
      const subscriptions = spy(viewer.scheduler, "subscribe");
      const handlers = spy(viewer.scheduler, "addEventHandler");
      const viewReplica = viewer.storageManager.open(space)
        .replica as Required<ISpaceReplica>;
      const subscribeCoverage = viewReplica.subscribeLocalCoverage!.bind(
        viewReplica,
      );
      let notifyCoverage: () => void = () => {};
      const coverage = stub(
        viewReplica,
        "subscribeLocalCoverage",
        (notify: Parameters<typeof subscribeCoverage>[0]) => {
          notifyCoverage = () => notify([]);
          return subscribeCoverage(notify);
        },
      );
      cancelView = await viewer.viewReplication.mount(viewingResult, "screen");
      coverage.restore();
      const planned = Promise.withResolvers<void>();
      const cancelPlans = viewer.storageManager.open(space).replica
        .subscribeViewPlans!((plans) => {
          if (
            plans.some((plan) => plan.id === "screen" && plan.generation === 1)
          ) planned.resolve();
        });
      cancelRender = viewingResult.key("$UI").key("children").key(0).asSchema({
        type: "number",
      }).sink((value) => {
        rendered = value;
      });
      expect(cancelView).toBeDefined();
      await new ViewPlanPublisher().publish(author, server, space);
      author.runner.stopAll();
      await server.flushSessions();
      await planned.promise;
      cancelPlans();
      await viewer.idle();
      const visibleId = viewNodeId(result.getAsNormalizedFullLink(), 0);
      const visibleBindings = () =>
        subscriptions.calls.filter((call) =>
          "viewNodeId" in call.args[0] &&
          call.args[0].viewNodeId === visibleId
        );
      expect(visibleBindings()).toHaveLength(1);
      // The handler registers on the stream its `$event` names without
      // reading the stream's document, so the stored graph installs whole at
      // mount, offscreen stream included.
      expect([...viewer.runner.cancels.values()][0].graphIsInstalled()).toBe(
        true,
      );
      expect(handlers.calls).toHaveLength(1);
      const runsBeforeCoverage = visibleRuns;
      notifyCoverage();
      await viewer.idle();
      expect(visibleBindings()).toHaveLength(1);
      expect(visibleRuns).toBe(runsBeforeCoverage);
      await viewer.getCellFromLink(
        result.key("offscreenEvent").resolveAsCell().getAsNormalizedFullLink(),
      ).sync();
      await viewer.idle();
      expect([...viewer.runner.cancels.values()][0].graphIsInstalled()).toBe(
        true,
      );
      expect(handlers.calls).toHaveLength(1);
      expect(handlers.calls[0].args[0].presyncInputs).toBeUndefined();
      expect(visibleBindings()).toHaveLength(1);
      expect(visibleRuns).toBe(runsBeforeCoverage);
      notifyCoverage();
      await viewer.idle();
      expect(handlers.calls).toHaveLength(1);
      expect(viewer.viewReplication.eligible(space, visibleId)).toBe(true);
      expect(
        viewer.viewReplication.eligible(
          space,
          viewNodeId(result.getAsNormalizedFullLink(), 1),
        ),
      ).toBe(false);
      expect(
        viewer.viewReplication.eligible(
          space,
          viewNodeId(result.getAsNormalizedFullLink(), 2),
        ),
      ).toBe(false);
      const replica = viewer.storageManager.open(space).replica;
      expect(
        replica.hasLocalDocumentCoverage?.(hidden.getAsNormalizedFullLink().id),
      ).toBe(false);
      expect(hiddenRuns).toBe(initialHiddenRuns);
      expect(visibleRuns).toBe(initialVisibleRuns);
      expect(rendered).toBe(10);
      expect(sideRuns).toBe(initialSideRuns);
      await viewer.editWithRetry((tx) =>
        viewer!.getCellFromLink(input.getAsNormalizedFullLink(), undefined, tx)
          .set(5)
      );
      await viewer.idle();
      expect(visibleRuns).toBe(initialVisibleRuns + 1);
      expect(rendered).toBe(14);
      expect(sideRuns).toBe(initialSideRuns);
      expect(hiddenRuns).toBe(initialHiddenRuns);
      await viewer.editWithRetry((tx) => {
        viewer!.getCellFromLink(side.getAsNormalizedFullLink(), undefined, tx)
          .set(4);
        viewer!.getCellFromLink(input.getAsNormalizedFullLink(), undefined, tx)
          .set(7);
      });
      await viewer.idle();
      expect(rendered).toBe(14);
      expect(sideRuns).toBe(initialSideRuns);
      await viewer.editWithRetry((tx) => {
        viewer!.getCellFromLink(side.getAsNormalizedFullLink(), undefined, tx)
          .set(2);
      });
      await viewer.idle();
      expect(rendered).toBe(18);
      const cachedHidden = viewer.getCellFromLink(
        hidden.getAsNormalizedFullLink(),
      );
      await cachedHidden.sync();
      expect(
        replica.hasLocalDocumentCoverage?.(hidden.getAsNormalizedFullLink().id),
      ).toBe(true);
      const action = Object.assign(() => {}, {
        viewNodeId: visibleId,
        viewPiece: result.getAsNormalizedFullLink(),
      }) as Action;
      const rejected = viewer.edit();
      viewer.scheduler.prepareViewAction(rejected, action);
      expect(() => cachedHidden.withTx(rejected).get()).toThrow(
        LocalReadUnavailable,
      );
      expect((await rejected.commit()).error?.name).toBe(
        "StorageTransactionAborted",
      );
      expect(rendered).toBe(18);
      await author.editWithRetry((tx) =>
        result.withTx(tx).setMetaRaw("patternIdentity", {
          identity: "replacement-view-test",
          symbol: "default",
        }, rawMetaWriteAuthorization)
      );
      await viewingResult.sync();
      const mismatched = viewer.edit();
      expect(() => viewer!.scheduler.prepareViewAction(mismatched, action))
        .toThrow(LocalReadUnavailable);
      mismatched.abort();
      cancelView!();
      cancelRender();
      cancelRender = undefined;
      cancelView = undefined;
      await viewer.idle();
      expect(server.viewInterestsForSpace(space)).toEqual([]);
      subscriptions.restore();
      handlers.restore();
    } finally {
      cancelRender?.();
      cancelView?.();
      await viewer?.dispose();
      await author.dispose();
      await server.close();
      resetServerExecutionConfig();
    }
  });
  it("publishes an unchanged remounted view through the serving loop", async () => {
    const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const author = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    const service = await Identity.fromPassphrase(
      "view replication serving fixture",
    );
    let host: ExecutorHost | undefined;
    let viewer: Runtime | undefined;
    let cancel: (() => void) | undefined;
    try {
      const compiled = await author.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
        import { computed, NAME, pattern, UI, Writable } from "commonfabric";
        export default pattern<{ input: Writable<number>; hidden: string }>(({ input, hidden }) => {
          const doubled = computed(() => input.get() * 2);
          const offscreen = computed(() => hidden.toUpperCase());
          return { [NAME]: "View test", [UI]: <cf-input $value={input}>{doubled}</cf-input>, offscreen };
        });
      `,
        }],
      }, { space });
      const input = author.getCell<number>(space, "served-input", undefined);
      const hidden = author.getCell<string>(space, "served-hidden", undefined);
      const result = author.getCell(
        space,
        "served-view",
        compiled.resultSchema,
      );
      await author.editWithRetry((tx) => {
        input.withTx(tx).set(3);
        hidden.withTx(tx).set("offscreen");
        author.run(tx, compiled, { input, hidden }, result);
      });
      await result.pull();
      await author.idle();
      await author.storageManager.synced();
      author.runner.stopAll();
      host = new ExecutorHost({
        server,
        serviceIdentity: service.did(),
        createRuntime: () => {
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: EmulatedStorageManager.connectTo(server, {
              as: service,
            }),
            servingPosture: true,
            experimental: { serverExecution: true },
          });
          return Promise.resolve({ runtime, dispose: () => runtime.dispose() });
        },
        policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      });
      viewer = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: EmulatedStorageManager.connectTo(server, {
          as: signer,
        }),
        clientClass: "web",
        experimental: { serverExecution: true, viewScopedReplication: true },
      });
      const root = viewer.getCellFromLink(result.getAsNormalizedFullLink());
      await viewer.viewReplication.enable(space);
      const replica = viewer.storageManager.open(space).replica;
      const awaitPlan = (revision: number) => {
        const received = Promise.withResolvers<void>();
        const stop = replica.subscribeViewPlans!((plans) => {
          if (
            plans.some((plan) =>
              plan.id === "warm-screen" && plan.revision === revision &&
              plan.eligibleActions.length > 0
            )
          ) received.resolve();
        });
        return { promise: received.promise, stop };
      };
      const first = awaitPlan(0);
      cancel = await viewer.viewReplication.mount(root, "warm-screen");
      await first.promise;
      first.stop();
      await viewer.idle();
      expect(
        replica.hasLocalDocumentCoverage?.(hidden.getAsNormalizedFullLink().id),
      ).toBe(false);
      expect(
        replica.hasLocalDocumentCoverage?.(input.getAsNormalizedFullLink().id),
      ).toBe(true);
      cancel!();
      await viewer.idle();
      const next = awaitPlan(1);
      cancel = await viewer.viewReplication.mount(root, "warm-screen");
      await next.promise;
      next.stop();
      await viewer.idle();
      expect(viewer.viewReplication.active(space)).toBe(true);
      expect(
        replica.hasLocalDocumentCoverage?.(hidden.getAsNormalizedFullLink().id),
      ).toBe(false);
    } finally {
      cancel?.();
      await host?.close();
      await viewer?.dispose();
      await author.dispose();
      await server.close();
      resetServerExecutionConfig();
    }
  });
});
