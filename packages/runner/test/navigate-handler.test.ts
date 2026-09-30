import { assert, assertEquals, assertThrows } from "@std/assert";
import { entityRefToString } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { refuseAtCommitBoundary } from "./refused-commit.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { navigateTo as rawNavigateTo } from "../src/builtins/navigate-to.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type TransactMessage = { requestId: string };
type TransactResponse = {
  type: "response";
  requestId: string;
  ok?: unknown;
  error?: { name: string; message: string };
};
type PublishTransactVerdict = (response: TransactResponse) => void;

function delayNextServerTransact(
  storageManager: ReturnType<typeof StorageManager.emulate>,
) {
  const server = (storageManager as unknown as {
    server(): {
      transact(
        message: TransactMessage,
        publishVerdict?: PublishTransactVerdict,
      ): Promise<TransactResponse>;
    };
  }).server();
  const original = server.transact.bind(server);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let shouldDelay = true;

  server.transact = async (message, publishVerdict) => {
    if (!shouldDelay) return await original(message, publishVerdict);
    shouldDelay = false;
    started.resolve();
    await release.promise;
    return await original(message, publishVerdict);
  };

  return {
    started: started.promise,
    confirm: () => release.resolve(),
    restore: () => {
      server.transact = original;
    },
  };
}

async function runNavigateHandlerTest(conditional: boolean): Promise<void> {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: (target) => {
      navigations.push(entityRefToString(target.entityId));
    },
  });

  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const {
      NAME,
      Writable,
      handler,
      ifElse,
      navigateTo,
      pattern,
    } = commonfabric;

    const Target = pattern(() => ({
      [NAME]: "📝 New Note",
    }));

    const openNote = handler(
      {
        type: "object",
        properties: {},
      },
      {
        type: "object",
        properties: {
          menuOpen: { type: "boolean", asCell: ["cell"] },
        },
        required: ["menuOpen"],
      },
      (_event, { menuOpen }) => {
        menuOpen.set(false);
        return navigateTo(Target({}));
      },
    );

    const Root = pattern(() => {
      const menuOpen = Writable.of(true);
      return {
        menuOpen,
        openNote: conditional
          ? ifElse(menuOpen, openNote({ menuOpen }), undefined)
          : openNote({ menuOpen }),
      };
    });

    const resultCell = runtime.getCell<{
      menuOpen: boolean;
      openNote?: unknown;
    }>(
      space,
      {
        navigateHandler: {
          conditional,
        },
      },
      undefined,
      tx,
    );

    const result = runtime.run(tx, Root, {}, resultCell);
    await tx.commit();
    await result.pull();

    result.key("openNote").send({});
    await runtime.settled();
    await result.pull();

    assert((result.key("menuOpen").get() as unknown) === false);
    assertEquals(navigations.length, 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
}

Deno.test("handler can update local state and still navigate", async () => {
  await runNavigateHandlerTest(false);
});

Deno.test("conditional handler still navigates after it hides itself", async () => {
  await runNavigateHandlerTest(true);
});

async function runCancelledDeferredNavigateTest(
  nested: boolean,
): Promise<void> {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    experimental: { commitPreconditions: true },
    navigateCallback: (target) => {
      navigations.push(entityRefToString(target.entityId));
    },
  });
  let tx: IExtendedStorageTransaction = runtime.edit();
  let gate: ReturnType<typeof delayNextServerTransact> | undefined;

  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, navigateTo, pattern } = commonfabric;
    const Target = pattern(() => ({ title: "cancelled target" }));
    const openTarget = handler(
      { type: "object", properties: {} },
      { type: "object", properties: {} },
      () => {
        const navigation = navigateTo(Target({}));
        return nested ? { navigation } : navigation;
      },
    );
    const Root = pattern(() => ({ openTarget: openTarget({}) }));
    const rootCell = runtime.getCell<{ openTarget: unknown }>(
      space,
      { cancelledDeferredNavigate: nested ? "nested" : "direct" },
      undefined,
      tx,
    );
    const root = runtime.run(tx, Root, {}, rootCell);
    await tx.commit();
    tx = runtime.edit();
    await root.pull();
    await runtime.scheduler.idleWithPendingCommits();

    gate = delayNextServerTransact(storageManager);
    root.key("openTarget").send({});
    await gate.started;

    // The navigate result is assembled, but both result shapes defer its
    // start until this handler commit succeeds. Stopping the parent must
    // tombstone that pending start before the commit callback can install it.
    runtime.runner.stop(rootCell);
    assertEquals(runtime.runner.cancels.size, 0);

    gate.confirm();
    await runtime.settled();

    assertEquals(navigations, []);
    assertEquals(runtime.runner.cancels.size, 0);
  } finally {
    gate?.confirm();
    gate?.restore();
    await tx.commit();
    await runtime.dispose();
    await storageManager.close();
  }
}

Deno.test(
  "stopping a parent tombstones a direct deferred navigateTo result",
  async () => await runCancelledDeferredNavigateTest(false),
);

Deno.test(
  "stopping a parent tombstones a nested deferred navigateTo result",
  async () => await runCancelledDeferredNavigateTest(true),
);

Deno.test("navigateTo is idempotent for one result cell", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const navigations: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: (target) => {
      navigations.push(entityRefToString(target.entityId));
    },
  });

  const tx: IExtendedStorageTransaction = runtime.edit();

  try {
    const resultCell = runtime.getCell(
      space,
      "navigateTo idempotent result cell",
      undefined,
      tx,
    );
    const targetOne = runtime.getCell(
      space,
      "navigateTo idempotent target one",
      undefined,
      tx,
    );
    targetOne.set({ title: "one" });
    const targetTwo = runtime.getCell(
      space,
      "navigateTo idempotent target two",
      undefined,
      tx,
    );
    targetTwo.set({ title: "two" });

    const inputsOne = runtime.getImmutableCell(
      space,
      targetOne.getAsLink(),
      undefined,
      tx,
    );
    const inputsTwo = runtime.getImmutableCell(
      space,
      targetTwo.getAsLink(),
      undefined,
      tx,
    );

    const sendResult = (
      resultTx: IExtendedStorageTransaction,
      result: unknown,
    ) => {
      assertEquals(
        (result as { getAsNormalizedFullLink(): { scope: string } })
          .getAsNormalizedFullLink().scope,
        "session",
      );
      resultCell.withTx(resultTx).key("result").set(result);
    };

    const first = rawNavigateTo(
      inputsOne,
      sendResult,
      () => {},
      [],
      resultCell,
      runtime,
    );
    const second = rawNavigateTo(
      inputsTwo,
      sendResult,
      () => {},
      [],
      resultCell,
      runtime,
    );

    first.action(tx);
    second.action(tx);
    await tx.commit();
    await runtime.settled();

    assertEquals(navigations.length, 1);
    assertEquals(navigations[0], entityRefToString(targetOne.entityId));
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test(
  "navigateTo retries navigation after a rejected post-commit transaction",
  async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const navigations: string[] = [];
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      navigateCallback: (target) => {
        navigations.push(entityRefToString(target.entityId));
      },
    });

    try {
      const setupTx: IExtendedStorageTransaction = runtime.edit();
      const resultCell = runtime.getCell(
        space,
        "navigateTo retry result cell",
        undefined,
        setupTx,
      );
      const target = runtime.getCell(
        space,
        "navigateTo retry target",
        undefined,
        setupTx,
      );
      target.set({ title: "retry target" });
      const inputs = runtime.getImmutableCell(
        space,
        target.getAsLink(),
        undefined,
        setupTx,
      );
      const setupResult = await setupTx.commit();
      assert(setupResult.ok !== undefined);

      const sendResult = (
        resultTx: IExtendedStorageTransaction,
        result: unknown,
      ) => {
        resultCell.withTx(resultTx).key("result").set(result);
      };

      const builtin = rawNavigateTo(
        inputs,
        sendResult,
        () => {},
        [],
        resultCell,
        runtime,
      );

      const rejectedTx = runtime.edit();
      refuseAtCommitBoundary(
        rejectedTx,
        space,
        "navigateTo retry regression",
      );
      builtin.action(rejectedTx);
      const rejectedResult = await rejectedTx.commit();
      assert(isCfcEnforcementRejection(rejectedResult.error));
      await runtime.settled();
      assertEquals(navigations.length, 0);

      const retryTx = runtime.edit();
      builtin.action(retryTx);
      const retryResult = await retryTx.commit();
      assert(retryResult.ok !== undefined);
      await runtime.settled();

      assertEquals(navigations.length, 1);
      assertEquals(navigations[0], entityRefToString(target.entityId));
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  },
);

Deno.test("navigateTo async callback is tracked by runtime.settled", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  let callbackCompleted = false;
  const callbackStart = Promise.withResolvers<void>();
  let releaseNavigation!: () => void;
  const navigationGate = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: async () => {
      callbackStart.resolve();
      await navigationGate;
      callbackCompleted = true;
    },
  });

  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, navigateTo, pattern } = commonfabric;
    const Target = pattern(() => ({ title: "tracked target" }));
    const openTarget = handler(
      { type: "object", properties: {} },
      { type: "object", properties: {} },
      () => navigateTo(Target({})),
    );
    const Root = pattern(() => ({ openTarget: openTarget({}) }));

    const setupTx: IExtendedStorageTransaction = runtime.edit();
    const rootCell = runtime.getCell(
      space,
      "navigateTo tracked root",
      undefined,
      setupTx,
    );
    const root = runtime.run(setupTx, Root, {}, rootCell);
    await setupTx.commit();
    await root.pull();

    root.key("openTarget").send({});
    // Start the barrier before the scheduler has dispatched the handler. This
    // pins the registration race: settled() must observe the eventual
    // post-commit navigation work, not return in the gap before its flush.
    let settledResolved = false;
    const settled = runtime.settled().then(() => {
      settledResolved = true;
    });
    await callbackStart.promise;
    await Promise.resolve();
    assertEquals(callbackCompleted, false);
    assertEquals(settledResolved, false);

    releaseNavigation();
    await settled;
    assertEquals(callbackCompleted, true);
  } finally {
    releaseNavigation();
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("navigateTo contains a rejected async callback", async () => {
  const storageManager = StorageManager.emulate({ as: signer });
  const failure = new Error("shell navigation failed");
  const logged: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    navigateCallback: () => Promise.reject(failure),
  });

  try {
    const { commonfabric } = createTrustedBuilder(runtime);
    const { handler, navigateTo, pattern } = commonfabric;
    const Target = pattern(() => ({ title: "rejected target" }));
    const openTarget = handler(
      { type: "object", properties: {} },
      { type: "object", properties: {} },
      () => navigateTo(Target({})),
    );
    const Root = pattern(() => ({ openTarget: openTarget({}) }));
    const setupTx = runtime.edit();
    const rootCell = runtime.getCell(
      space,
      "navigateTo rejected callback root",
      undefined,
      setupTx,
    );
    const root = runtime.run(setupTx, Root, {}, rootCell);
    await setupTx.commit();
    await root.pull();

    root.key("openTarget").send({});
    await runtime.settled();

    assertEquals(logged, [["navigateTo callback failed:", failure]]);
  } finally {
    console.error = originalConsoleError;
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test(
  "navigateTo's legacy arm refuses to run without a navigateCallback",
  async () => {
    // The OFF arm checks for the callback before it resolves the target or
    // records an attempt, so a runtime built without one gets the refusal
    // on the first run, from the guard itself, and not a navigation that
    // has nowhere to go.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const tx = runtime.edit();
    try {
      const resultCell = runtime.getCell(
        space,
        "navigateTo without a callback result cell",
        undefined,
        tx,
      );
      const target = runtime.getCell(
        space,
        "navigateTo without a callback target",
        undefined,
        tx,
      );
      target.set({ title: "unreachable" });
      const inputs = runtime.getImmutableCell(
        space,
        target.getAsLink(),
        undefined,
        tx,
      );
      const builtin = rawNavigateTo(
        inputs,
        (resultTx, result) => {
          resultCell.withTx(resultTx).key("result").set(result);
        },
        () => {},
        [],
        resultCell,
        runtime,
      );

      assertThrows(
        () => builtin.action(tx),
        Error,
        "navigateCallback is not set",
      );
    } finally {
      await tx.commit();
      await runtime.dispose();
      await storageManager.close();
    }
  },
);
