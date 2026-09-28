/** Covers authorization and owner protection for debug-view deployment. */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";

import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import {
  AGENT_CONNECTOR_WRITER_ID,
  agentPrincipalSchema,
  cellHasOwnerConfidentiality,
  cellHasOwnerProtection,
} from "@commonfabric/agents-connector/fabric-graph";
import { createSession } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { commandWriterAuthorization } from "../src/command-authorization.ts";
import {
  defaultDebugPatternLocation,
  deployAgentSessionsDebugView,
  describeAgentFabricTarget,
} from "../src/debug-view.ts";
import {
  identity,
  installDefaultPattern,
  newSharedServer,
  registeredPieceIds,
  sessionSnapshot,
  SHALLOW_PIECE_SCHEMA,
  SharedServerStorageManager,
  sourceDescriptor,
} from "./debug_view_support.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "@commonfabric/runner/cfc/trust-authority";

Deno.test("debug command authorization resolves local schema definitions", () => {
  assertEquals(
    commandWriterAuthorization({
      resultSchema: {
        type: "object",
        properties: {
          commandAuthorization: { $ref: "#/$defs/CommandAuthorization" },
        },
        $defs: {
          CommandAuthorization: {
            ifc: { writeAuthorizedBy: ["verified-writer"] },
          },
        },
      },
    } as never),
    ["verified-writer"],
  );
  // A definition named with pointer-escaped characters resolves; a reference
  // reaching below one definition does not.
  assertEquals(
    commandWriterAuthorization({
      resultSchema: {
        type: "object",
        properties: {
          commandAuthorization: { $ref: "#/$defs/command~1authorization" },
        },
        $defs: {
          "command/authorization": {
            ifc: { writeAuthorizedBy: ["escaped-writer"] },
          },
        },
      },
    } as never),
    ["escaped-writer"],
  );
  assertEquals(
    commandWriterAuthorization({
      resultSchema: {
        type: "object",
        properties: {
          commandAuthorization: { $ref: "#/$defs/outer/inner" },
        },
        $defs: { outer: { inner: { ifc: { writeAuthorizedBy: ["nested"] } } } },
      },
    } as never),
    undefined,
  );
});

Deno.test("debug deployment requires verified command authorization", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-command-authorization-${crypto.randomUUID()}`,
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
    assertEquals(
      describeAgentFabricTarget(target, session.space).ownerDid,
      session.as.did(),
    );
    const defaultLocation = defaultDebugPatternLocation();
    await assertRejects(
      () =>
        deployAgentSessionsDebugView(manager, target, {
          rootPath: defaultLocation.rootPath,
          mainPath: fromFileUrl(
            new URL(
              "./fixtures/debug-view-without-command-authorization.tsx",
              import.meta.url,
            ),
          ),
        }),
      Error,
      "debug view has no verified command writer authorization",
    );
    assertEquals(target.commandsAreBound(), false);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment protects its result before starting", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-protection-failure-${crypto.randomUUID()}`,
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
    const originalSetupPersistent = manager.setupPersistent;
    const originalStartPiece = manager.startPiece;
    const originalEdit = runtime.edit;
    let rejectProtection = false;
    let startCount = 0;
    manager.setupPersistent = (async (...args) => {
      const piece = await originalSetupPersistent.apply(manager, args);
      rejectProtection = true;
      return piece;
    }) as typeof manager.setupPersistent;
    manager.startPiece = (async (...args) => {
      startCount++;
      return await originalStartPiece.apply(manager, args);
    }) as typeof manager.startPiece;
    runtime.edit = ((...args) => {
      if (rejectProtection) {
        throw new Error("debug result protection rejected");
      }
      return originalEdit.apply(runtime, args);
    }) as typeof runtime.edit;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "debug result protection rejected",
      );
    } finally {
      manager.setupPersistent = originalSetupPersistent;
      manager.startPiece = originalStartPiece;
      runtime.edit = originalEdit;
    }

    assertEquals(startCount, 0);
    assertEquals(await registeredPieceIds(defaultPattern), []);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment refuses a pre-created unprotected piece", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-piece-squatting-${crypto.randomUUID()}`,
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
    const originalSetupPersistent = manager.setupPersistent;
    let debugCause: string | undefined;
    manager.setupPersistent = ((...args) => {
      if (typeof args[2] === "string") debugCause = args[2];
      throw new Error("captured debug view cause");
    }) as typeof manager.setupPersistent;
    try {
      await assertRejects(
        () => deployAgentSessionsDebugView(manager, target),
        Error,
        "captured debug view cause",
      );
    } finally {
      manager.setupPersistent = originalSetupPersistent;
    }
    if (debugCause === undefined) {
      throw new Error("debug view cause was not set");
    }
    const squattedPiece = runtime.getCell(
      session.space,
      debugCause,
      SHALLOW_PIECE_SCHEMA,
    );
    const seed = runtime.edit();
    squattedPiece.withTx(seed).setRawUntyped({ spoofed: true });
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "refusing to adopt an unprotected debug view",
    );
    assertEquals(
      cellHasOwnerProtection(
        runtime.readTx(),
        squattedPiece,
        session.as.did(),
      ),
      false,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug deployment refuses an unprotected registration", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-registration-squatting-${crypto.randomUUID()}`,
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
    const registration = runtime.getCell(
      session.space,
      `agent-sessions-debug-registration:${session.as.did()}`,
    );
    const squattedRegistration = {
      cause: "agent-sessions-debug:squatted",
      pieceId: "fid1:squatted-debug-piece",
      patternIdentity: "fid1:squatted-debug-pattern",
      patternSymbol: "default",
      retiredCauses: [],
    };
    const seed = runtime.edit();
    registration.withTx(seed).setRawUntyped(squattedRegistration);
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "refusing to adopt an unprotected debug registration",
    );
    assertEquals(registration.getRaw(), squattedRegistration);
    assertEquals(
      cellHasOwnerProtection(
        runtime.readTx(),
        registration,
        session.as.did(),
      ),
      false,
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("debug registration rejects writes from another owner", async () => {
  const server = newSharedServer();
  const spaceName = `debug-registration-owner-${crypto.randomUUID()}`;
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
    const target = await AgentFabricTarget.open({
      runtime: readerRuntime,
      spaceDid: readerSession.space,
      ownerDid: readerSession.as.did(),
    });
    const debugPieceId = await deployAgentSessionsDebugView(
      readerManager,
      target,
    );
    await readerStorage.synced();
    assertEquals(await registeredPieceIds(defaultPattern), []);
    const registration = readerRuntime.getCell(
      readerSession.space,
      `agent-sessions-debug-registration:${readerSession.as.did()}`,
    );
    const originalRegistration = registration.getRaw();
    assertEquals(
      cellHasOwnerConfidentiality(
        readerRuntime.readTx(),
        registration,
        readerSession.as.did(),
      ),
      true,
    );
    const attack = readerRuntime.edit();
    setCfcTrustSnapshot(attack, {
      id: "principal:did:key:other-owner",
      actingPrincipal: "did:key:other-owner",
    });
    setCfcImplementationIdentity(attack, {
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    registration.withTx(attack).setRawUntyped({
      cause: "agent-sessions-debug:competing",
      pieceId: "fid1:competing-debug-piece",
      patternIdentity: "fid1:competing-debug-pattern",
      patternSymbol: "default",
      retiredCauses: [],
    });
    attack.prepareCfc();
    const result = await attack.commit();
    assertEquals(result.error !== undefined, true);

    const debugPiece = await readerManager.getPieceCell(
      debugPieceId,
      false,
      SHALLOW_PIECE_SCHEMA,
    );
    const runningPiece = await readerManager.get(debugPieceId, false);
    const argument = readerManager.getArgument(debugPiece);
    await argument.sync();
    assertEquals(
      cellHasOwnerProtection(
        readerRuntime.readTx(),
        argument,
        readerSession.as.did(),
      ),
      true,
    );
    const originalArgument = argument.getRaw();
    const argumentAttack = readerRuntime.edit();
    setCfcTrustSnapshot(argumentAttack, {
      id: "principal:did:key:other-owner",
      actingPrincipal: "did:key:other-owner",
    });
    setCfcImplementationIdentity(argumentAttack, {
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    argument.withTx(argumentAttack).setRawUntyped({
      ...(argument.getRaw() as Record<string, unknown>),
      ownerDid: "did:key:other-owner",
    });
    argumentAttack.prepareCfc();
    const argumentAttackResult = await argumentAttack.commit();
    assertEquals(argumentAttackResult.error !== undefined, true);
    assertEquals(argument.getRaw(), originalArgument);

    const ownerUpdate = readerRuntime.edit();
    setCfcImplementationIdentity(ownerUpdate, {
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    argument.withTx(ownerUpdate).setRawUntyped({
      ...(argument.getRaw() as Record<string, unknown>),
      ownerDid: "did:key:other-owner",
    });
    ownerUpdate.prepareCfc();
    const ownerUpdateResult = await ownerUpdate.commit();
    if (ownerUpdateResult.error) throw ownerUpdateResult.error;
    await assertRejects(
      () => deployAgentSessionsDebugView(readerManager, target),
      Error,
      "contains different owner inputs",
    );
    assertEquals(registration.getRaw(), originalRegistration);
    assertNotEquals(debugPiece.getRaw(), undefined);
    await target.publish([{
      source: sourceDescriptor(),
      sessions: [sessionSnapshot(1)],
      errors: [],
      complete: true,
    }]);
    await readerRuntime.settled();
    assertEquals(await runningPiece.result.get(["sessionCount"]), 1);
  } finally {
    await readerRuntime.dispose();
    await readerStorage.close();
    await server.close();
  }
});

Deno.test("debug registration rejects another owner-scoped writer", async () => {
  const session = await createSession({
    identity,
    spaceName: `debug-registration-writer-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  const otherWriter = "another-owner-scoped-pattern";
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    await installDefaultPattern(manager);
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const registration = runtime.getCell(
      session.space,
      `agent-sessions-debug-registration:${session.as.did()}`,
      agentPrincipalSchema(session.as.did(), [otherWriter]),
    );
    const seed = runtime.edit();
    setCfcImplementationIdentity(seed, {
      kind: "builtin",
      builtinId: otherWriter,
    });
    registration.withTx(seed).set({
      cause: "agent-sessions-debug:competing",
      pieceId: "fid1:competing-debug-piece",
      patternIdentity: "fid1:competing-debug-pattern",
      patternSymbol: "default",
      retiredCauses: [],
    });
    registration.withTx(seed).applyCfcSchemaToExistingValue();
    seed.prepareCfc();
    const seeded = await seed.commit();
    if (seeded.error) throw seeded.error;
    assertEquals(
      cellHasOwnerProtection(runtime.readTx(), registration, session.as.did()),
      true,
    );

    await assertRejects(
      () => deployAgentSessionsDebugView(manager, target),
      Error,
      "writeAuthorizedBy cannot be weakened",
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
