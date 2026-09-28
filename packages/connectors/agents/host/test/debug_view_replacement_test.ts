// Agent-sessions debug view: view replacement. Shared fixtures live in
// `debug_view_support.ts`; see there for why the suite spans several files.

import {
  defaultDebugPatternLocation,
  deployAgentSessionsDebugView,
} from "../src/debug-view.ts";
import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import {
  agentOwnerSchema,
  cellHasOwnerConfidentiality,
} from "@commonfabric/agents-connector/fabric-graph";
import { createSession } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  identity,
  installDefaultPattern,
  newSharedServer,
  registeredPieceIds,
  sessionSnapshot,
  SharedServerStorageManager,
  sourceDescriptor,
} from "./debug_view_support.ts";
import { setCfcImplementationIdentity } from "@commonfabric/runner/cfc/trust-authority";

Deno.test("debug replacement stops every superseded local runner", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-stop-failures-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const defaultPattern = await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const originalPieceId = await deployAgentSessionsDebugView(manager, target);
    const registration = runtime.getCell(
      session.space,
      `agent-sessions-debug-registration:${session.as.did()}`,
    );
    await registration.sync();
    const addRetiredResult = await runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: "commonfabric.agents-connector",
      });
      const cell = registration.withTx(tx).asSchema(
        agentOwnerSchema(session.as.did()),
      );
      const current = cell.getRawUntyped({ frozen: false });
      if (!isObjectOrArray(current)) {
        throw new Error("debug registration is missing");
      }
      if (
        !("cause" in current) || typeof current.cause !== "string" ||
        current.cause.length === 0
      ) {
        throw new Error("debug registration has no active cause");
      }
      cell.setRawUntyped({
        ...current,
        retiredCauses: ["agent-sessions-debug:retired-test-piece"],
      });
      tx.prepareCfc();
    });
    if (addRetiredResult.error) throw addRetiredResult.error;
    assertEquals(
      (registration.getRaw() as { retiredCauses?: string[] }).retiredCauses,
      ["agent-sessions-debug:retired-test-piece"],
    );
    assertEquals(
      cellHasOwnerConfidentiality(
        runtime.readTx(),
        registration,
        session.as.did(),
      ),
      true,
    );

    const originalStop = runtime.runner.stop;
    let stopCalls = 0;
    runtime.runner.stop = ((piece) => {
      stopCalls++;
      originalStop.call(runtime.runner, piece);
    }) as typeof runtime.runner.stop;
    try {
      const defaultLocation = defaultDebugPatternLocation();
      await deployAgentSessionsDebugView(manager, target, {
        rootPath: defaultLocation.rootPath,
        mainPath: fromFileUrl(
          new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
        ),
      });
    } finally {
      runtime.runner.stop = originalStop;
    }

    assertEquals(stopCalls, 2);
    assertEquals(
      (await registeredPieceIds(defaultPattern)).includes(
        originalPieceId,
      ),
      false,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug replacement preserves a piece owned by another runtime", async () => {
  const server = newSharedServer();
  const spaceName = `debug-cross-runtime-replacement-${crypto.randomUUID()}`;
  const firstSession = await createSession({ identity, spaceName });
  const firstStorage = SharedServerStorageManager.connectTo(server, {
    as: firstSession.as,
  });
  const firstRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: firstStorage,
  });
  try {
    const firstManager = new PiecesController(firstSession, firstRuntime);
    await firstManager.synced();
    await installDefaultPattern(firstManager);
    const firstTarget = await AgentFabricTarget.open({
      runtime: firstRuntime,
      spaceDid: firstSession.space,
      ownerDid: firstSession.as.did(),
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      firstManager,
      firstTarget,
    );
    await firstStorage.synced();

    const secondSession = await createSession({ identity, spaceName });
    const secondStorage = SharedServerStorageManager.connectTo(server, {
      as: secondSession.as,
    });
    const secondRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: secondStorage,
    });
    try {
      const secondManager = new PiecesController(secondSession, secondRuntime);
      await secondManager.synced();
      const secondTarget = await AgentFabricTarget.open({
        runtime: secondRuntime,
        spaceDid: secondSession.space,
        ownerDid: secondSession.as.did(),
      });
      const defaultLocation = defaultDebugPatternLocation();
      await deployAgentSessionsDebugView(secondManager, secondTarget, {
        rootPath: defaultLocation.rootPath,
        mainPath: fromFileUrl(
          new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
        ),
      });

      await firstTarget.publish([{
        source: sourceDescriptor(),
        sessions: [sessionSnapshot(1)],
        errors: [],
        complete: true,
      }]);
      await firstRuntime.settled();
      const originalPiece = await firstManager.get(originalPieceId, false);
      assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
      await firstStorage.synced();
      await secondStorage.synced();

      assertEquals(
        await deployAgentSessionsDebugView(secondManager, secondTarget),
        originalPieceId,
      );

      await deployAgentSessionsDebugView(secondManager, secondTarget, {
        rootPath: defaultLocation.rootPath,
        mainPath: fromFileUrl(
          new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
        ),
      });
      await firstTarget.publish([{
        source: sourceDescriptor(),
        sessions: [sessionSnapshot(1), sessionSnapshot(2)],
        errors: [],
        complete: true,
      }]);
      await firstRuntime.settled();
      assertEquals(await originalPiece.result.get(["sessionCount"]), 2);
      await firstStorage.synced();
      await secondStorage.synced();
      assertEquals(
        await deployAgentSessionsDebugView(secondManager, secondTarget),
        originalPieceId,
      );
    } finally {
      await secondRuntime.dispose();
      await secondStorage.close();
    }
  } finally {
    await firstRuntime.dispose();
    await firstStorage.close();
    await server.close();
  }
});
