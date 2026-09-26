/** Covers debug-view deployment lifecycle and concurrency behavior. */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";

import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import {
  AGENT_CONNECTOR_WRITER_ID,
  agentOwnerSchema,
} from "@commonfabric/agents-connector/fabric-graph";
import { createSession } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  type IExtendedStorageTransaction,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { Cell } from "../../../../runner/src/builder/types.ts";
import {
  defaultDebugPatternLocation,
  deployAgentSessionsDebugView,
} from "../src/debug-view.ts";
import {
  identity,
  installDefaultPattern,
  newSharedServer,
  registeredPieceIds,
  sessionSnapshot,
  SHALLOW_PIECE_LIST_SCHEMA,
  SHALLOW_PIECE_SCHEMA,
  SharedServerStorageManager,
  sourceDescriptor,
} from "./debug_view_support.ts";
import { setCfcImplementationIdentity } from "@commonfabric/runner/cfc/trust-authority";

Deno.test("debug deployment replaces a view when its pattern identity changes", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-pattern-replacement-${crypto.randomUUID()}`,
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
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const [originalPieceId, alternatePieceId] = await Promise.all([
      deployAgentSessionsDebugView(manager, target),
      deployAgentSessionsDebugView(manager, target, alternateLocation),
    ]);

    assertNotEquals(alternatePieceId, originalPieceId);
    assertEquals(
      await deployAgentSessionsDebugView(
        manager,
        target,
        alternateLocation,
      ),
      alternatePieceId,
    );
    const registeredIds = await registeredPieceIds(defaultPattern);
    assertEquals(registeredIds, []);
    const originalPiece = await manager.getPieceCell(
      originalPieceId,
      false,
      SHALLOW_PIECE_SCHEMA,
    );
    assertNotEquals(originalPiece.getRaw(), undefined);
    assertNotEquals(originalPiece.getMetaRaw("patternIdentity"), undefined);
    const alternatePiece = await manager.get(
      alternatePieceId,
      false,
    );
    assertEquals(alternatePiece.name(), "Alternate agent sessions");
    const reinsertResult = await runtime.editWithRetry((tx) => {
      const registry = defaultPattern.asSchema(undefined).key("pieceRegistry")
        .resolveAsCell().asSchema(SHALLOW_PIECE_LIST_SCHEMA) as Cell<
          Cell<unknown>[]
        >;
      const registryWithTx = registry.withTx(tx);
      const current = registryWithTx.getRawUntyped({ frozen: false });
      if (!Array.isArray(current)) {
        throw new Error("pieceRegistry is not an array");
      }
      current.push(originalPiece.getAsLink({
        base: registryWithTx,
        includeSchema: true,
      }));
      registryWithTx.setRawUntyped(current);
    });
    if (reinsertResult.error) throw reinsertResult.error;
    assertEquals(
      await deployAgentSessionsDebugView(manager, target, alternateLocation),
      alternatePieceId,
    );
    assertEquals(
      (await registeredPieceIds(defaultPattern)).includes(originalPieceId),
      false,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment starts and restarts its registered view", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-start-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const debugPieceId = await deployAgentSessionsDebugView(manager, target);
    const piece = await manager.get(debugPieceId, false);

    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 1);

    await manager.stopPiece(piece.getCell());
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 1);

    assertEquals(
      await deployAgentSessionsDebugView(manager, target),
      debugPieceId,
    );
    await runtime.settled();
    assertEquals(await piece.result.get(["sessionCount"]), 2);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment removes a view that fails to start", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-start-failure-${crypto.randomUUID()}`,
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
    const originalStartPiece = manager.startPiece;
    manager.startPiece = (() =>
      Promise.reject(
        new Error("debug start rejected"),
      )) as typeof manager.startPiece;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "debug start rejected",
      );
    } finally {
      manager.startPiece = originalStartPiece;
    }

    assertEquals(
      await registeredPieceIds(defaultPattern),
      [],
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment preserves a view when its replacement fails", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-replacement-start-failure-${crypto.randomUUID()}`,
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
    const originalPieceId = await deployAgentSessionsDebugView(
      manager,
      target,
    );
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const originalStartPiece = manager.startPiece;
    manager.startPiece = (() =>
      Promise.reject(
        new Error("replacement start rejected"),
      )) as typeof manager.startPiece;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target, alternateLocation),
        Error,
        "replacement start rejected",
      );
    } finally {
      manager.startPiece = originalStartPiece;
    }

    assertEquals(
      await registeredPieceIds(defaultPattern),
      [],
    );
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    const originalPiece = await manager.get(originalPieceId, false);
    assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rolls back an aborted registration", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-aborted-registration-${crypto.randomUUID()}`,
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
    const originalPieceId = await deployAgentSessionsDebugView(
      manager,
      target,
    );
    const registration = runtime.getCell(
      session.space,
      `agent-sessions-debug-registration:${session.as.did()}`,
    );
    const originalRegistration = registration.getRaw();
    const defaultLocation = defaultDebugPatternLocation();
    const alternateLocation = {
      rootPath: defaultLocation.rootPath,
      mainPath: fromFileUrl(
        new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
      ),
    };
    const abortRegistration = async (
      location: ReturnType<typeof defaultDebugPatternLocation>,
      options: {
        abortAfterCommit?: boolean;
        interceptPrivateRegistration?: boolean;
      } = {},
    ): Promise<{ candidateWasStopped: boolean }> => {
      const commitEntered = Promise.withResolvers<void>();
      const releaseCommit = Promise.withResolvers<void>();
      const controller = new AbortController();
      const originalStartPiece = manager.startPiece;
      const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
      const originalStop = runtime.runner.stop.bind(runtime.runner);
      // The registration carries the owner's `User` label, which a read of it
      // inside a transaction joins onto everything that transaction writes.
      // This wrapper adds nothing to the read set of what it observes.
      const registrationLink = registration.getAsNormalizedFullLink();
      const wroteRegistration = (
        transaction: IExtendedStorageTransaction,
      ): boolean => {
        const writes = transaction.getWriteDetails?.(registrationLink.space);
        if (writes === undefined) {
          throw new Error("transaction does not report its write set");
        }
        for (const write of writes) {
          if (write.address.id === registrationLink.id) return true;
        }
        return false;
      };
      let candidatePiece: Cell<unknown> | undefined;
      let candidateWasStopped = false;
      let interceptRegistrationCommit = false;
      let commitCount = 0;
      manager.startPiece =
        (async (piece: Parameters<typeof originalStartPiece>[0]) => {
          await originalStartPiece.call(manager, piece);
          if (typeof piece !== "string") candidatePiece = piece;
          interceptRegistrationCommit = true;
        }) as typeof manager.startPiece;
      runtime.runner.stop = ((piece) => {
        if (piece === candidatePiece) candidateWasStopped = true;
        return originalStop(piece);
      }) as typeof runtime.runner.stop;
      runtime.editWithRetry = (async (action, maxRetries) => {
        if (interceptRegistrationCommit) commitCount++;
        let shouldIntercept = false;
        const result = await originalEditWithRetry((transaction) => {
          const result = action(transaction);
          shouldIntercept = interceptRegistrationCommit &&
            (options.interceptPrivateRegistration
              ? wroteRegistration(transaction)
              : commitCount === 1);
          if (shouldIntercept) {
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              const result = await originalCommit();
              if (options.abortAfterCommit) {
                controller.abort(new Error("debug deployment cancelled"));
              }
              return result;
            };
          }
          return result;
        }, maxRetries);
        return result;
      }) as typeof runtime.editWithRetry;
      try {
        const deployment = deployAgentSessionsDebugView(
          manager,
          target,
          location,
          controller.signal,
        );
        await commitEntered.promise;
        if (!options.abortAfterCommit) {
          controller.abort(new Error("debug deployment cancelled"));
        }
        releaseCommit.resolve();
        await assertRejects(
          () => deployment,
          Error,
          "debug deployment cancelled",
        );
      } finally {
        releaseCommit.resolve();
        manager.startPiece = originalStartPiece;
        runtime.runner.stop = originalStop;
        runtime.editWithRetry = originalEditWithRetry;
      }
      return { candidateWasStopped };
    };

    const originalPiece = await manager.get(originalPieceId, false);
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await abortRegistration(alternateLocation, {
      abortAfterCommit: true,
    });
    assertEquals(
      await registeredPieceIds(defaultPattern),
      [],
    );
    assertEquals(await originalPiece.result.get(["sessionCount"]), 1);

    const abortedPrivateRegistration = await abortRegistration(
      alternateLocation,
      {
        abortAfterCommit: true,
        interceptPrivateRegistration: true,
      },
    );
    assertEquals(abortedPrivateRegistration.candidateWasStopped, true);
    assertEquals(registration.getRaw(), originalRegistration);
    assertEquals(
      await registeredPieceIds(defaultPattern),
      [],
    );
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await originalPiece.result.get(["sessionCount"]), 2);

    assertEquals(
      await deployAgentSessionsDebugView(manager, target),
      originalPieceId,
    );
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1), sessionSnapshot(2)],
      errors: [],
      complete: true,
    }]);
    await runtime.settled();
    assertEquals(await originalPiece.result.get(["sessionCount"]), 2);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment rejects stale registration across runtimes", async () => {
  const server = newSharedServer();
  const spaceName = `debug-registration-race-${crypto.randomUUID()}`;
  const readerSession = await createSession({ identity, spaceName });
  const readerStorage = SharedServerStorageManager.connectTo(server, {
    as: readerSession.as,
  });
  const readerRuntime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: readerStorage,
  });
  try {
    const readerManager = new PiecesController(readerSession, readerRuntime);
    await readerManager.synced();
    const defaultPattern = await installDefaultPattern(readerManager);
    const ownerDid = readerSession.as.did();
    const target = await AgentFabricTarget.open({
      runtime: readerRuntime,
      spaceDid: readerSession.space,
      ownerDid,
    });
    const originalPieceId = await deployAgentSessionsDebugView(
      readerManager,
      target,
    );
    await readerStorage.synced();

    const writerSession = await createSession({ identity, spaceName });
    const writerStorage = SharedServerStorageManager.connectTo(server, {
      as: writerSession.as,
    });
    const writerRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: writerStorage,
    });
    try {
      const writerManager = new PiecesController(writerSession, writerRuntime);
      await writerManager.synced();
      const registration = writerRuntime.getCell(
        writerSession.space,
        `agent-sessions-debug-registration:${ownerDid}`,
      );
      await registration.sync();
      const competingRegistration = {
        cause: "agent-sessions-debug:competing",
        pieceId: "fid1:competing-debug-piece",
        patternIdentity: "fid1:competing-debug-pattern",
        patternSymbol: "default",
        retiredCauses: [],
      };
      const commitEntered = Promise.withResolvers<void>();
      const releaseCommit = Promise.withResolvers<void>();
      const originalStartPiece = readerManager.startPiece;
      const originalEditWithRetry = readerRuntime.editWithRetry.bind(
        readerRuntime,
      );
      let interceptRegistrationCommit = false;
      let intercepted = false;
      readerManager.startPiece =
        (async (piece: Parameters<typeof originalStartPiece>[0]) => {
          await originalStartPiece.call(readerManager, piece);
          interceptRegistrationCommit = true;
        }) as typeof readerManager.startPiece;
      readerRuntime.editWithRetry = ((action, maxRetries) =>
        originalEditWithRetry((transaction) => {
          const result = action(transaction);
          if (interceptRegistrationCommit && !intercepted) {
            intercepted = true;
            const originalCommit = transaction.commit.bind(transaction);
            transaction.commit = async () => {
              commitEntered.resolve();
              await releaseCommit.promise;
              return await originalCommit();
            };
          }
          return result;
        }, maxRetries)) as typeof readerRuntime.editWithRetry;
      try {
        const defaultLocation = defaultDebugPatternLocation();
        const deployment = deployAgentSessionsDebugView(
          readerManager,
          target,
          {
            rootPath: defaultLocation.rootPath,
            mainPath: fromFileUrl(
              new URL("./fixtures/alternate-debug-view.tsx", import.meta.url),
            ),
          },
        );
        await commitEntered.promise;
        const competingResult = await writerRuntime.editWithRetry((tx) => {
          setCfcImplementationIdentity(tx, {
            kind: "builtin",
            builtinId: AGENT_CONNECTOR_WRITER_ID,
          });
          registration.withTx(tx).asSchema(agentOwnerSchema(ownerDid))
            .setRawUntyped(competingRegistration);
        });
        if (competingResult.error) {
          throw competingResult.error;
        }
        releaseCommit.resolve();

        await assertRejects(
          () =>
            deployment,
          Error,
          "debug view registration changed during deployment",
        );
        assertEquals(registration.getRaw(), competingRegistration);
        assertEquals(
          await registeredPieceIds(defaultPattern),
          [],
        );
        await target.publish([{
          source: sourceDescriptor(),
          sessions: [sessionSnapshot(1)],
          errors: [],
          complete: true,
        }]);
        await readerRuntime.settled();
        const originalPiece = await readerManager.get(originalPieceId, false);
        assertEquals(await originalPiece.result.get(["sessionCount"]), 1);
      } finally {
        releaseCommit.resolve();
        readerManager.startPiece = originalStartPiece;
        readerRuntime.editWithRetry = originalEditWithRetry;
      }
    } finally {
      await writerRuntime.dispose();
      await writerStorage.close();
    }
  } finally {
    await readerRuntime.dispose();
    await readerStorage.close();
    await server.close();
  }
});
