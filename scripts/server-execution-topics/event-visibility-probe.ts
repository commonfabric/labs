/**
 * Pins admitted-event visibility with real memory and a held subscription
 * refresh. A covered sync is contrasted with the replica's application signal.
 * This probe measures neither handler latency nor avoided backstop duration.
 */

import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  setServerExecutionConfig,
  streamEntriesDocId,
  type StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";
import { defer } from "@commonfabric/utils/defer";

import { Runtime } from "../../runtime/runner/src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../runtime/runner/src/storage/v2-emulate.ts";

setServerExecutionConfig(true);
const signer = await Identity.fromPassphrase("event visibility campaign");
const space = signer.did();
const server = newLoopbackServer({ subscriptionRefreshDelayMs: "manual" });
const manager = EmulatedStorageManager.connectTo(server, { as: signer });
const runtime = new Runtime({
  apiUrl: new URL(import.meta.url),
  storageManager: manager,
  servingPosture: true,
  experimental: { serverExecution: true },
});
const engine = await server.engineForSpace(space);
const stream = { id: "of:campaign-stream", path: [] };
const id = streamEntriesDocId(stream) as `of:${string}`;
const cell = runtime.getCellFromLink<StreamEventsDocValue | undefined>({
  space,
  id,
  scope: "space",
  path: [],
});
const replica = manager.open(space).replica;
try {
  await cell.sync();
  expect(cell.get()).toBeUndefined();
  const sessionsBefore = server.demandSetSizesForSpace(space);
  const arrived = defer<void>();
  let arrivals = 0;
  replica.speculationArrivalObserver = (docs) => {
    if (docs.some((doc) => doc.id === id)) {
      arrivals += 1;
      arrived.resolve();
    }
  };
  const admissions = [];
  for (
    const [index, eventId] of ["campaign-a", "campaign-b", "campaign-a"]
      .entries()
  ) {
    admissions.push(
      await server.commitDelegatedAppend({
        targetSpace: space,
        targetStream: id,
        targetStreamLink: stream,
        eventId,
        payload: { index },
        actingPrincipal: signer.did(),
        actingSession: "session:campaign-actor",
        capabilityRef: "cap:campaign-fixture",
        sessionId: "session:campaign-delivery",
        localSeq: index + 1,
      }),
    );
  }
  expect(admissions.map((result) => result.deduped)).toEqual([
    false,
    false,
    true,
  ]);
  const stored = Engine.read(engine, { id })?.value as StreamEventsDocValue;
  const entries = stored.entries ?? [];
  expect(entries.map((entry) => entry.eventId)).toEqual([
    "campaign-a",
    "campaign-b",
  ]);
  expect(entries.map((entry) => entry.seq)).toEqual(
    admissions.slice(0, 2).map((result) => result.seq),
  );
  expect(cell.get()).toBeUndefined();
  await cell.sync();
  expect(cell.get()).toBeUndefined();
  expect(arrivals).toBe(0);
  expect(server.demandSetSizesForSpace(space)).toEqual(sessionsBefore);

  await server.flushSessions();
  await arrived.promise;
  expect(cell.get()?.entries?.map((entry) => entry.eventId)).toEqual([
    "campaign-a",
    "campaign-b",
  ]);
  expect(cell.get()?.entries?.map((entry) => entry.seq)).toEqual(
    entries.map((entry) => entry.seq),
  );
  console.log(JSON.stringify({
    admissions,
    replicaAbsentAfterCoveredSync: true,
    applicationSignals: arrivals,
    visibleAfterApplicationSignal: true,
    sessionsBefore,
    handlerConsequenceMeasured: false,
    backstopAvoidanceMeasured: false,
  }));
} finally {
  replica.speculationArrivalObserver = undefined;
  try {
    await runtime.dispose();
  } finally {
    try {
      await manager.close();
    } finally {
      await server.close();
    }
  }
}
