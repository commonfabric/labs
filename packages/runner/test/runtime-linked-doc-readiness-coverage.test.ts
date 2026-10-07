/// <reference path="./clock.d.ts" />

import type { Cell } from "../src/cell.ts";
import type {
  IExtendedStorageTransaction,
  StorageConnectionState,
} from "../src/storage/interface.ts";
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
} from "./scheduler-test-utils.ts";
import type { SchedulerTestStorageManager } from "./scheduler-test-utils.ts";

describe("linked-document readiness lifecycle", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("rejects a completion token after a branch stops reading its target", () => {
    const action = () => {};
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    });
    try {
      const token = runtime.scheduler.withExecutingAction(
        action,
        () => runtime.scheduler.getExecutingActionToken(),
      );
      expect(token).toBeDefined();
      if (token === undefined) {
        throw new Error("expected executing action token");
      }
      runtime.scheduler.withExecutingAction(action, () => {});
      expect(runtime.scheduler.scheduleExternalDependencySettlement(token))
        .toBe(false);
    } finally {
      runtime.scheduler.unsubscribe(action);
    }
  });

  it("keeps a completion token current across a nested action context", () => {
    const action = () => {};
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    });
    try {
      runtime.scheduler.withExecutingAction(action, () => {
        const token = runtime.scheduler.getExecutingActionToken();
        if (token === undefined) {
          throw new Error("expected executing action token");
        }
        runtime.scheduler.withExecutingAction(action, () => {});
        expect(runtime.scheduler.scheduleExternalDependencySettlement(token))
          .toBe(true);
      });
    } finally {
      runtime.scheduler.unsubscribe(action);
    }
  });

  it("retains a provider result error with its diagnostic message", async () => {
    const target = runtime.getCell(space, "linked-doc-provider-result-error");
    const provider = storageManager.open(space);
    const originalSync = provider.sync.bind(provider);
    provider.sync = () =>
      Promise.resolve({
        error: { name: "AuthorizationError", message: "READ denied" },
      });
    try {
      expect(runtime.ensureLinkedDocLoaded(target.getAsNormalizedFullLink()))
        .toBe("pending");
      await storageManager.crossSpaceSettled();
      expect(runtime.ensureLinkedDocLoaded(target.getAsNormalizedFullLink()))
        .toBe("error");
      expect(
        runtime.linkedDocLoadError(target.getAsNormalizedFullLink())?.message,
      ).toBe("READ denied");
    } finally {
      provider.sync = originalSync;
    }
  });

  it("retains a terminal failure until the connection is restored", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-no-waiter-retry",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let attempts = 0;
    storageManager.syncCell = <T>(_cell: Cell<T>): Promise<Cell<T>> => {
      attempts++;
      return Promise.reject(new Error(`sync failed ${attempts}`));
    };

    try {
      expect(runtime.ensureLinkedDocLoaded(target.getAsNormalizedFullLink()))
        .toBe("pending");
      await storageManager.crossSpaceSettled();
      expect(attempts).toBe(1);

      expect(runtime.ensureLinkedDocLoaded(target.getAsNormalizedFullLink()))
        .toBe("error");
      expect(attempts).toBe(1);
      await storageManager.crossSpaceSettled();
    } finally {
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("allows disposal while a load failure is settling", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-cancel-retry",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    storageManager.syncCell = <T>(_cell: Cell<T>): Promise<Cell<T>> =>
      Promise.reject(new Error("sync failed before disposal"));

    try {
      expect(runtime.ensureLinkedDocLoaded(target.getAsNormalizedFullLink()))
        .toBe("pending");
      await Promise.resolve();
      await runtime.dispose();
      await storageManager.crossSpaceSettled();
    } finally {
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("waits through a disconnect and retries after the space is restored", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-reconnect-retry",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let connectionState: StorageConnectionState = {
      status: "ready",
      epoch: 1,
    };
    let connectionListener:
      | ((state: StorageConnectionState) => void)
      | undefined;
    storageManager.subscribeConnectionState = (_space, callback) => {
      connectionListener = callback;
      callback(connectionState);
      return () => {
        if (connectionListener === callback) connectionListener = undefined;
      };
    };

    let attempts = 0;
    const firstAttemptStarted = Promise.withResolvers<void>();
    const secondAttemptStarted = Promise.withResolvers<void>();
    let rejectFirstAttempt: ((cause: Error) => void) | undefined;
    storageManager.syncCell = <T>(cell: Cell<T>): Promise<Cell<T>> => {
      attempts++;
      if (attempts === 1) {
        firstAttemptStarted.resolve();
        return new Promise<Cell<T>>((_resolve, reject) => {
          rejectFirstAttempt = reject;
        });
      }
      secondAttemptStarted.resolve();
      if (connectionState.status === "disconnected") {
        return Promise.reject(new Error("storage remains disconnected"));
      }
      return Promise.resolve(cell);
    };

    let status: ReturnType<Runtime["ensureLinkedDocLoaded"]> | undefined;
    const consumer = () => {
      status = runtime.ensureLinkedDocLoaded(
        target.getAsNormalizedFullLink(),
      );
    };

    try {
      runtime.scheduler.subscribe(consumer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
      });
      runtime.scheduler.queueExecution();
      await firstAttemptStarted.promise;
      if (rejectFirstAttempt === undefined) {
        throw new Error("first linked-document attempt did not install reject");
      }

      connectionState = {
        status: "disconnected",
        epoch: 1,
        cause: new Error("synthetic disconnect"),
      };
      connectionListener?.(connectionState);
      rejectFirstAttempt(connectionState.cause);
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();

      expect(attempts).toBe(1);
      expect(status).toBe("pending");

      connectionState = { status: "ready", epoch: 2 };
      connectionListener?.(connectionState);
      await secondAttemptStarted.promise;
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();
      expect(attempts).toBe(2);
      expect(status).toBe("settled");
    } finally {
      runtime.scheduler.unsubscribe(consumer);
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("keeps a close terminal when an in-flight attempt later rejects", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-close-during-attempt",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let connectionListener:
      | ((state: StorageConnectionState) => void)
      | undefined;
    storageManager.subscribeConnectionState = (_space, callback) => {
      connectionListener = callback;
      callback({ status: "ready", epoch: 1 });
      return () => {
        if (connectionListener === callback) connectionListener = undefined;
      };
    };

    let attempts = 0;
    const attemptStarted = Promise.withResolvers<void>();
    let rejectAttempt: ((cause: Error) => void) | undefined;
    storageManager.syncCell = <T>(_cell: Cell<T>): Promise<Cell<T>> => {
      attempts++;
      attemptStarted.resolve();
      return new Promise<Cell<T>>((_resolve, reject) => {
        rejectAttempt = reject;
      });
    };

    let status: ReturnType<Runtime["ensureLinkedDocLoaded"]> | undefined;
    const consumer = () => {
      status = runtime.ensureLinkedDocLoaded(
        target.getAsNormalizedFullLink(),
      );
    };
    const closeCause = new Error("synthetic close during attempt");

    try {
      runtime.scheduler.subscribe(consumer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
      });
      runtime.scheduler.queueExecution();
      await attemptStarted.promise;

      connectionListener?.({
        status: "closed",
        epoch: 1,
        cause: closeCause,
      });
      rejectAttempt?.(new Error("late attempt rejection"));
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();

      expect(attempts).toBe(1);
      expect(status).toBe("error");
      expect(runtime.linkedDocLoadError(target.getAsNormalizedFullLink()))
        .toBe(closeCause);
    } finally {
      runtime.scheduler.unsubscribe(consumer);
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("preserves the close cause after a load has already failed", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-close-during-retry-delay",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let connectionListener:
      | ((state: StorageConnectionState) => void)
      | undefined;
    storageManager.subscribeConnectionState = (_space, callback) => {
      connectionListener = callback;
      callback({ status: "ready", epoch: 1 });
      return () => {
        if (connectionListener === callback) connectionListener = undefined;
      };
    };

    let attempts = 0;
    const attemptStarted = Promise.withResolvers<void>();
    let rejectAttempt: ((cause: Error) => void) | undefined;
    storageManager.syncCell = <T>(_cell: Cell<T>): Promise<Cell<T>> => {
      attempts++;
      attemptStarted.resolve();
      return new Promise<Cell<T>>((_resolve, reject) => {
        rejectAttempt = reject;
      });
    };

    let status: ReturnType<Runtime["ensureLinkedDocLoaded"]> | undefined;
    const consumer = () => {
      status = runtime.ensureLinkedDocLoaded(
        target.getAsNormalizedFullLink(),
      );
    };
    const closeCause = new Error("synthetic close during retry delay");

    try {
      runtime.scheduler.subscribe(consumer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
      });
      runtime.scheduler.queueExecution();
      await attemptStarted.promise;
      rejectAttempt?.(new Error("attempt rejection before close"));
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();

      connectionListener?.({
        status: "closed",
        epoch: 1,
        cause: closeCause,
      });
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();

      expect(attempts).toBe(1);
      expect(status).toBe("error");
      expect(runtime.linkedDocLoadError(target.getAsNormalizedFullLink()))
        .toBe(closeCause);
    } finally {
      runtime.scheduler.unsubscribe(consumer);
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("does not invalidate an in-flight load on initial connection", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-initial-connection",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let connectionState: StorageConnectionState = {
      status: "idle",
      epoch: 0,
    };
    let connectionListener:
      | ((state: StorageConnectionState) => void)
      | undefined;
    storageManager.subscribeConnectionState = (_space, callback) => {
      connectionListener = callback;
      callback(connectionState);
      return () => {
        if (connectionListener === callback) connectionListener = undefined;
      };
    };

    let attempts = 0;
    const firstAttemptStarted = Promise.withResolvers<void>();
    let resolveFirstAttempt: (() => void) | undefined;
    storageManager.syncCell = <T>(cell: Cell<T>): Promise<Cell<T>> => {
      attempts++;
      firstAttemptStarted.resolve();
      return new Promise<Cell<T>>((resolve) => {
        resolveFirstAttempt = () => resolve(cell);
      });
    };

    let status: ReturnType<Runtime["ensureLinkedDocLoaded"]> | undefined;
    const consumer = () => {
      status = runtime.ensureLinkedDocLoaded(
        target.getAsNormalizedFullLink(),
      );
    };

    try {
      runtime.scheduler.subscribe(consumer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
      });
      runtime.scheduler.queueExecution();
      await firstAttemptStarted.promise;

      connectionState = { status: "ready", epoch: 1 };
      connectionListener?.(connectionState);
      await runtime.scheduler.idle();
      expect(attempts).toBe(1);
      expect(status).toBe("pending");

      expect(resolveFirstAttempt).toBeDefined();
      resolveFirstAttempt?.();
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();
      expect(status).toBe("settled");
    } finally {
      runtime.scheduler.unsubscribe(consumer);
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("invalidates a terminal linked-document error on a newer ready generation", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-terminal-reconnect",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let connectionState: StorageConnectionState = {
      status: "ready",
      epoch: 1,
    };
    let connectionListener:
      | ((state: StorageConnectionState) => void)
      | undefined;
    storageManager.subscribeConnectionState = (_space, callback) => {
      connectionListener = callback;
      callback(connectionState);
      return () => {
        if (connectionListener === callback) connectionListener = undefined;
      };
    };

    let attempts = 0;
    const firstAttemptStarted = Promise.withResolvers<void>();
    const secondAttemptStarted = Promise.withResolvers<void>();
    let allowSuccess = false;
    storageManager.syncCell = <T>(cell: Cell<T>): Promise<Cell<T>> => {
      attempts++;
      if (attempts === 1) firstAttemptStarted.resolve();
      if (attempts === 2) secondAttemptStarted.resolve();
      return allowSuccess
        ? Promise.resolve(cell)
        : Promise.reject(new Error(`sync failed ${attempts}`));
    };

    let status: ReturnType<Runtime["ensureLinkedDocLoaded"]> | undefined;
    const consumer = () => {
      status = runtime.ensureLinkedDocLoaded(
        target.getAsNormalizedFullLink(),
      );
    };

    try {
      runtime.scheduler.subscribe(consumer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
      });
      runtime.scheduler.queueExecution();
      await firstAttemptStarted.promise;
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();
      expect(status).toBe("error");

      connectionState = {
        status: "closed",
        epoch: 1,
        cause: new Error("synthetic terminal session"),
      };
      connectionListener?.(connectionState);
      allowSuccess = true;
      connectionState = { status: "ready", epoch: 2 };
      connectionListener?.(connectionState);

      await secondAttemptStarted.promise;
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();
      expect(status).toBe("settled");
    } finally {
      runtime.scheduler.unsubscribe(consumer);
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("does not reserve a same-space pull when its connection is closed", () => {
    const target = runtime.getCell(
      space,
      "linked-doc-closed-without-reservation",
    );
    const link = target.getAsNormalizedFullLink();
    const cause = new Error("synthetic closed connection");
    let reservationCalls = 0;

    storageManager.subscribeConnectionState = (_space, callback) => {
      callback({ status: "closed", epoch: 1, cause });
      return () => {};
    };
    storageManager.shouldPullDoc = () => {
      reservationCalls++;
      return true;
    };

    expect(runtime.ensureLinkedDocLoaded(link, space)).toBe("error");
    expect(runtime.linkedDocLoadError(link)).toBe(cause);
    expect(reservationCalls).toBe(0);
  });
});
