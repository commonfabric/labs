import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { Entity } from "@commonfabric/memory/interface";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { TYPE } from "../src/builder/types.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { storedCfcMetadataAppliesToPath } from "../src/cfc/metadata.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import {
  type ExperimentalOptions,
  Runtime,
  type RuntimeOptions,
} from "../src/runtime.ts";
import {
  ignoreReadForScheduling,
  txToReactivityLog,
} from "../src/scheduler.ts";
import type {
  Action,
  ErrorWithContext,
  EventHandler,
  ReactivityLog,
  TelemetryAnnotations,
} from "../src/scheduler.ts";
import { setSchedulerDependencies } from "../src/scheduler/dependency-updates.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
} from "../src/storage/interface.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

type SchedulerTestRuntime = {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  runtime: Runtime;
  tx: IExtendedStorageTransaction;
};

type SchedulerTestStorageManager = SchedulerTestRuntime["storageManager"];

function createSchedulerTestRuntime(
  apiUrl: string | URL,
  options: {
    experimental?: ExperimentalOptions;
    commitBackpressure?: RuntimeOptions["commitBackpressure"];
    cfcEnforcementMode?: RuntimeOptions["cfcEnforcementMode"];
    storageManager?: SchedulerTestStorageManager;
  } = {},
): SchedulerTestRuntime {
  const storageManager = options.storageManager ??
    StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: apiUrl instanceof URL ? apiUrl : new URL(apiUrl),
    storageManager,
    ...(options.experimental ? { experimental: options.experimental } : {}),
    ...(options.commitBackpressure
      ? { commitBackpressure: options.commitBackpressure }
      : {}),
    ...(options.cfcEnforcementMode
      ? { cfcEnforcementMode: options.cfcEnforcementMode }
      : {}),
  });

  return { storageManager, runtime, tx: runtime.edit() };
}

async function disposeSchedulerTestRuntime(
  testRuntime: SchedulerTestRuntime,
): Promise<void> {
  await testRuntime.tx.commit().settled;
  // The manager is the caller's — either handed in via `options.storageManager`
  // (shared with a sibling runtime that may outlive this one) or created here
  // and closed on the line below. Either way the runtime must not close it.
  await testRuntime.runtime?.dispose({ closeStorage: false });
  await testRuntime.storageManager?.close();
}

async function expectSemanticCommitNotifiesSynchronously(
  storageManager: SchedulerTestStorageManager,
  commit: () => Promise<unknown> | unknown,
): Promise<void> {
  let synchronousSemanticCommitNotifications = 0;
  const subscription: IStorageNotification = {
    next(notification) {
      if (notification.type === "commit") {
        for (const _change of notification.changes) {
          synchronousSemanticCommitNotifications++;
          break;
        }
      }
      return { done: false };
    },
  };

  storageManager.subscribe(subscription);
  try {
    const result = commit();
    expect(synchronousSemanticCommitNotifications).toBeGreaterThan(0);
    await result;
  } finally {
    storageManager.unsubscribe?.(subscription);
  }
}

type StaleSchedulerInternals = {
  pending: Set<Action>;
  isInvalid: (action: Action) => boolean;
  isDemandedPullComputation: (action: Action) => boolean;
  clearInvalid: (action: Action) => void;
  markDirty: (action: Action) => void;
  registerEffect: (action: Action) => void;
  setDependencies: (
    action: Action,
    log: ReactivityLog,
  ) => ReturnType<typeof setSchedulerDependencies>;
  updateDependents: (action: Action, log: ReactivityLog) => void;
};

function getStaleSchedulerInternals(
  scheduler: Runtime["scheduler"],
): StaleSchedulerInternals {
  const internal = scheduler.accessForTestingOnly;

  return {
    pending: internal.pending,
    isInvalid: (action) => {
      const record = internal.nodes.get(action);
      return record?.status === "invalid" || record?.status === "never-ran";
    },
    isDemandedPullComputation: (action) =>
      internal.isDemandedPullComputation(action),
    clearInvalid: (action) => {
      const record = internal.nodes.get(action);
      if (!record) return;
      if (record.status === "invalid") {
        internal.nodes.setStatus(action, "clean");
      }
      record.invalidCauses.clear();
    },
    markDirty: (action) => internal.markAndScheduleInvalidAction(action),
    registerEffect: (action) => {
      internal.nodes.register(action, "effect");
    },
    setDependencies: (action, log) =>
      setSchedulerDependencies(internal.dependencyUpdateState, action, log),
    updateDependents: (action, log) => internal.updateDependents(action, log),
  };
}

type EventPreflightMarker = Extract<
  RuntimeTelemetryMarker,
  { type: "scheduler.event.preflight" }
>;

export {
  afterEach,
  assertSpyCall,
  assertSpyCalls,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  expectSemanticCommitNotifiesSynchronously,
  getStaleSchedulerInternals,
  ignoreReadForScheduling,
  it,
  Runtime,
  space,
  spy,
  storedCfcMetadataAppliesToPath,
  toMemorySpaceAddress,
  txToReactivityLog,
  TYPE,
};
export type {
  Action,
  Cell,
  Entity,
  ErrorWithContext,
  EventHandler,
  EventPreflightMarker,
  IExtendedStorageTransaction,
  JSONSchema,
  ReactivityLog,
  RuntimeTelemetryMarker,
  SchedulerTestRuntime,
  SchedulerTestStorageManager,
  StaleSchedulerInternals,
  TelemetryAnnotations,
};
