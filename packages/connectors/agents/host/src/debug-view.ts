import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import {
  AGENT_CONNECTOR_WRITER_ID,
  agentOwnerSchema,
  cellHasOwnerProtection,
  stableCellId,
} from "@commonfabric/agents-connector/fabric-graph";
import type { FabricPlainObject, FabricValue } from "@commonfabric/data-model";
import { internSchema } from "@commonfabric/data-model-schema";
import { pieceId } from "@commonfabric/piece";
import type { PiecesController } from "@commonfabric/piece/ops";
import {
  areLinksSame,
  asPatternIdentityRef,
  type Cell,
  compileAndSavePattern,
  deepEqual,
  type Pattern,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { dirname, fromFileUrl, join, resolve } from "@std/path";
import type { AgentsHostTargetDescription } from "./host.ts";
import {
  commandWriterAuthorization,
  recordValue,
} from "./command-authorization.ts";
import type { BoundCommandProducer } from "./command-producers.ts";
import { setCfcImplementationIdentity } from "@commonfabric/runner/cfc/trust-authority";

const AGENT_SESSIONS_DEBUG_CAUSE_PREFIX = "agent-sessions-debug";
const SHALLOW_PIECE_LINK_LIST_SCHEMA = internSchema({
  type: "array",
  items: { type: "unknown" },
  default: [],
});
const SHALLOW_DEBUG_PIECE_SCHEMA = internSchema({
  type: "object",
  properties: {},
});

async function protectOwnerDebugCells(
  manager: PiecesController,
  cells: readonly Cell<unknown>[],
  ownerDid: string,
  expectedDocuments?: ReadonlyMap<Cell<unknown>, unknown>,
): Promise<void> {
  const tx = manager.runtime.edit();
  setCfcImplementationIdentity(tx, {
    kind: "builtin",
    builtinId: AGENT_CONNECTOR_WRITER_ID,
  });
  try {
    for (const cell of cells) {
      const expectedDocument = expectedDocuments?.get(cell);
      if (
        expectedDocuments?.has(cell) &&
        !deepEqual(readDocumentRootWithTx(tx, cell), expectedDocument)
      ) {
        throw new Error("debug view changed before owner protection");
      }
      cell.withTx(tx).asSchema(agentOwnerSchema(ownerDid))
        .applyCfcSchemaToExistingValue();
    }
    tx.prepareCfc();
  } catch (error) {
    tx.abort(error);
    throw error;
  }
  const committed = await tx.commit();
  if (committed.error) {
    throw new Error(
      `could not protect the owner debug result: ${committed.error.message}`,
      { cause: committed.error },
    );
  }
}

export function protectOwnerDebugResult(
  manager: PiecesController,
  result: Cell<unknown>,
  ownerDid: string,
): Promise<void> {
  return protectOwnerDebugCells(manager, [result], ownerDid);
}
const DEBUG_REGISTRATION_SCHEMA = internSchema({
  type: "object",
  properties: {
    cause: { type: "string" },
    pieceId: { type: "string" },
    patternIdentity: { type: "string" },
    patternSymbol: { type: "string" },
    deploymentId: { type: "string" },
    retiredCauses: {
      type: "array",
      items: { type: "string" },
      default: [],
    },
  },
  required: [
    "cause",
    "pieceId",
    "patternIdentity",
    "patternSymbol",
    "retiredCauses",
  ],
});

interface DebugRegistration extends FabricPlainObject {
  cause: string;
  pieceId: string;
  patternIdentity: string;
  patternSymbol: string;
  deploymentId?: string;
  retiredCauses: string[];
}

const EMPTY_DEBUG_REGISTRATION: DebugRegistration = {
  cause: "",
  pieceId: "",
  patternIdentity: "",
  patternSymbol: "",
  retiredCauses: [],
};

interface DebugRegistrationState {
  link: ReturnType<Cell<unknown>["getAsNormalizedFullLink"]>;
  value: DebugRegistration | undefined;
}

const debugDeploymentTails = new Map<string, Promise<void>>();

async function serializeDebugDeployment<T>(
  key: string,
  deploy: () => Promise<T>,
): Promise<T> {
  const preceding = debugDeploymentTails.get(key) ?? Promise.resolve();
  const gate = Promise.withResolvers<void>();
  const tail = preceding.then(() => gate.promise);
  debugDeploymentTails.set(key, tail);
  await preceding;
  try {
    return await deploy();
  } finally {
    gate.resolve();
    if (debugDeploymentTails.get(key) === tail) {
      debugDeploymentTails.delete(key);
    }
  }
}

function debugPieceCause(ownerDid: string, patternRef: {
  identity: string;
  symbol: string;
}): string {
  return `${AGENT_SESSIONS_DEBUG_CAUSE_PREFIX}:${ownerDid}:` +
    `${patternRef.identity}:` +
    encodeURIComponent(patternRef.symbol);
}

function debugRegistrationCause(ownerDid: string): string {
  return `agent-sessions-debug-registration:${ownerDid}`;
}

async function syncDocumentRoot(
  manager: PiecesController,
  cell: Cell<unknown>,
): Promise<void> {
  const link = cell.getAsNormalizedFullLink();
  const { error } = await manager.runtime.storageManager.open(link.space).sync(
    link.id,
    { path: [], schema: false },
    link.scope,
  );
  if (error) throw error;
}

function readDocumentValue(
  manager: PiecesController,
  cell: Cell<unknown>,
): FabricValue {
  const tx = manager.runtime.readTx();
  return tx.readValueOrThrow(cell.getAsNormalizedFullLink());
}

function readDocumentRootWithTx(
  tx: ReturnType<PiecesController["runtime"]["readTx"]>,
  cell: Cell<unknown>,
): unknown {
  const link = cell.getAsNormalizedFullLink();
  return tx.readOrThrow({
    space: link.space,
    id: link.id,
    path: [],
    ...(link.scope !== undefined && { scope: link.scope }),
  });
}

function readDocumentRoot(
  manager: PiecesController,
  cell: Cell<unknown>,
): unknown {
  return readDocumentRootWithTx(manager.runtime.readTx(), cell);
}

function readDocumentMeta(
  manager: PiecesController,
  cell: Cell<unknown>,
  field: string,
): FabricValue {
  const link = cell.getAsNormalizedFullLink();
  const tx = manager.runtime.readTx();
  return tx.readOrThrow({
    space: link.space,
    id: link.id,
    path: [field],
    ...(link.scope !== undefined && { scope: link.scope }),
  });
}

async function currentDebugPiece(
  manager: PiecesController,
  pattern: Pattern,
  cause: string,
  ownerDid: string,
  expectedArguments: Record<string, unknown>,
): Promise<Cell<unknown> | undefined> {
  const expectedPattern = manager.runtime.patternManager.getArtifactEntryRef(
    pattern,
  );
  if (!expectedPattern) return undefined;
  const shallowPiece = manager.runtime.getCell(
    manager.getSpace(),
    cause,
    SHALLOW_DEBUG_PIECE_SCHEMA,
  );
  await syncDocumentRoot(manager, shallowPiece);
  const initialPattern = readDocumentMeta(
    manager,
    shallowPiece,
    "patternIdentity",
  );
  const initialArgument = readDocumentMeta(manager, shallowPiece, "argument");
  if (
    initialPattern === undefined && initialArgument === undefined &&
    readDocumentValue(manager, shallowPiece) === undefined
  ) {
    return undefined;
  }
  if (
    !cellHasOwnerProtection(manager.runtime.readTx(), shallowPiece, ownerDid)
  ) {
    throw new Error(
      `refusing to adopt an unprotected debug view for ${ownerDid}`,
    );
  }
  await protectOwnerDebugCells(manager, [shallowPiece], ownerDid);
  const storedPattern = asPatternIdentityRef(
    readDocumentMeta(manager, shallowPiece, "patternIdentity"),
  );
  const argument = readDocumentMeta(manager, shallowPiece, "argument");
  if (
    storedPattern === undefined ||
    storedPattern.identity !== expectedPattern.identity ||
    storedPattern.symbol !== expectedPattern.symbol ||
    argument === undefined
  ) {
    throw new Error(
      `debug view cause ${cause} contains a different prepared piece`,
    );
  }
  const argumentCell = manager.getArgument(shallowPiece);
  await argumentCell.sync();
  if (
    !cellHasOwnerProtection(manager.runtime.readTx(), argumentCell, ownerDid)
  ) {
    throw new Error(
      `refusing to adopt unprotected debug view arguments for ${ownerDid}`,
    );
  }
  await protectOwnerDebugCells(manager, [argumentCell], ownerDid);
  const storedArguments = recordValue(argumentCell.getRaw());
  if (
    storedArguments === undefined ||
    Object.entries(expectedArguments).some(([name, expected]) => {
      const stored = storedArguments[name];
      return typeof expected === "string"
        ? stored !== expected
        : !areLinksSame(stored, expected, argumentCell);
    })
  ) {
    throw new Error(
      `debug view cause ${cause} contains different owner inputs`,
    );
  }
  return shallowPiece.asSchema(pattern.resultSchema);
}

function asDebugRegistration(
  value: FabricValue,
): DebugRegistration | undefined {
  if (value === undefined) return undefined;
  if (!isObjectNotArray(value)) {
    throw new Error("debug view registration is malformed");
  }
  const candidate = value as unknown as Record<string, unknown>;
  if (
    typeof candidate.cause !== "string" ||
    typeof candidate.pieceId !== "string" ||
    typeof candidate.patternIdentity !== "string" ||
    typeof candidate.patternSymbol !== "string" ||
    (candidate.deploymentId !== undefined &&
      typeof candidate.deploymentId !== "string") ||
    !Array.isArray(candidate.retiredCauses) ||
    candidate.retiredCauses.some((cause) => typeof cause !== "string")
  ) {
    throw new Error("debug view registration is malformed");
  }
  if (
    candidate.cause === "" && candidate.pieceId === "" &&
    candidate.patternIdentity === "" && candidate.patternSymbol === "" &&
    candidate.deploymentId === undefined &&
    candidate.retiredCauses.length === 0
  ) {
    return undefined;
  }
  return {
    cause: candidate.cause,
    pieceId: candidate.pieceId,
    patternIdentity: candidate.patternIdentity,
    patternSymbol: candidate.patternSymbol,
    ...(typeof candidate.deploymentId === "string" && {
      deploymentId: candidate.deploymentId,
    }),
    retiredCauses: candidate.retiredCauses as string[],
  };
}

function debugRegistrationsMatch(
  left: DebugRegistration | undefined,
  right: DebugRegistration | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.cause === right.cause &&
    left.pieceId === right.pieceId &&
    left.patternIdentity === right.patternIdentity &&
    left.patternSymbol === right.patternSymbol &&
    left.deploymentId === right.deploymentId &&
    left.retiredCauses.length === right.retiredCauses.length &&
    left.retiredCauses.every((cause, index) =>
      cause === right.retiredCauses[index]
    );
}

function debugRegistrationTargets(
  registration: DebugRegistration | undefined,
  cause: string,
  candidatePieceId: string | undefined,
  patternRef: { identity: string; symbol: string },
): boolean {
  return registration?.cause === cause &&
    registration.pieceId === candidatePieceId &&
    registration.patternIdentity === patternRef.identity &&
    registration.patternSymbol === patternRef.symbol;
}

function isPieceRunningLocally(
  manager: PiecesController,
  piece: Cell<unknown>,
): boolean {
  const { space, id, scope } = piece.getAsNormalizedFullLink();
  const key = `${space}/${scope}/${id}`;
  for (const runningKey of manager.runtime.runner.cancels.keys()) {
    if (runningKey === key) return true;
  }
  return false;
}

async function stopAndDrainPieces(
  manager: PiecesController,
  pieces: Iterable<Cell<unknown>>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const piece of pieces) {
    try {
      manager.runtime.runner.stop(piece);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await manager.runtime.idle();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "debug view runner cleanup failed");
  }
}

async function debugRegistration(
  manager: PiecesController,
  ownerDid: string,
): Promise<DebugRegistrationState> {
  const registration = manager.runtime.getCell<DebugRegistration>(
    manager.getSpace(),
    debugRegistrationCause(ownerDid),
    DEBUG_REGISTRATION_SCHEMA,
  );
  await syncDocumentRoot(manager, registration);
  const tx = manager.runtime.edit();
  setCfcImplementationIdentity(tx, {
    kind: "builtin",
    builtinId: AGENT_CONNECTOR_WRITER_ID,
  });
  try {
    const protectedRegistration = registration.withTx(tx);
    const value = tx.readValueOrThrow(registration.getAsNormalizedFullLink());
    if (value === undefined) {
      protectedRegistration.setRawUntyped(EMPTY_DEBUG_REGISTRATION);
    } else if (!cellHasOwnerProtection(tx, registration, ownerDid)) {
      throw new Error(
        `refusing to adopt an unprotected debug registration for ${ownerDid}`,
      );
    }
    protectedRegistration.asSchema(agentOwnerSchema(ownerDid))
      .applyCfcSchemaToExistingValue();
    tx.prepareCfc();
  } catch (error) {
    tx.abort(error);
    throw error;
  }
  const committed = await tx.commit();
  if (committed.error) {
    throw new Error(
      `could not claim the owner debug registration: ${committed.error.message}`,
      { cause: committed.error },
    );
  }
  return {
    link: registration.getAsNormalizedFullLink(),
    value: asDebugRegistration(readDocumentValue(manager, registration)),
  };
}

async function debugPieceRegistry(
  defaultPattern: Cell<unknown>,
): Promise<Cell<FabricValue[]>> {
  const root = defaultPattern.asSchema(undefined);
  const slot = root.key("pieceRegistry");
  if (slot.getRaw() === undefined) {
    throw new Error("default pattern does not expose pieceRegistry");
  }
  const registry = slot.resolveAsCell().asSchema(
    SHALLOW_PIECE_LINK_LIST_SCHEMA,
  ) as Cell<FabricValue[]>;
  await registry.sync();
  return registry;
}

async function registerDebugPiece(
  manager: PiecesController,
  defaultPattern: Cell<unknown>,
  piece: Cell<unknown>,
  cause: string,
  patternRef: { identity: string; symbol: string },
  deploymentId: string,
  ownerDid: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const [registry, registration] = await Promise.all([
    debugPieceRegistry(defaultPattern),
    debugRegistration(manager, ownerDid),
  ]);
  const precedingPiece = registration.value?.cause !== undefined &&
      registration.value.cause !== cause
    ? manager.runtime.getCell(
      manager.getSpace(),
      registration.value.cause,
      SHALLOW_DEBUG_PIECE_SCHEMA,
    )
    : undefined;
  const retiredPieces = (registration.value?.retiredCauses ?? [])
    .filter((retiredCause) => retiredCause !== cause)
    .map((retiredCause) =>
      manager.runtime.getCell(
        manager.getSpace(),
        retiredCause,
        SHALLOW_DEBUG_PIECE_SCHEMA,
      )
    );
  const piecesToUnregister = [
    ...retiredPieces,
    ...(precedingPiece === undefined ? [] : [precedingPiece]),
  ];
  const precedingWasRunningLocally = precedingPiece !== undefined &&
    isPieceRunningLocally(manager, precedingPiece);
  const nextRegistration: DebugRegistration = {
    cause,
    pieceId: pieceId(piece) ?? "",
    patternIdentity: patternRef.identity,
    patternSymbol: patternRef.symbol,
    deploymentId,
    retiredCauses: [
      ...new Set([
        ...(registration.value?.retiredCauses ?? []).filter((retiredCause) =>
          retiredCause !== cause
        ),
        ...(precedingPiece === undefined ? [] : [registration.value!.cause]),
      ]),
    ],
  };
  if (!nextRegistration.pieceId) {
    throw new Error("debug view piece has no entity ID");
  }
  const candidateLink = piece.getAsNormalizedFullLink();
  const piecesToRemove = [...piecesToUnregister, piece];
  const removePublicDebugLinks = async () => {
    return await manager.runtime.editWithRetry((tx) => {
      const activeDefaultPatternCell = manager.getSpaceCellContents().withTx(tx)
        .key("defaultPattern");
      const activeDefaultPattern = activeDefaultPatternCell.get();
      if (
        !activeDefaultPattern ||
        !areLinksSame(
          activeDefaultPattern,
          defaultPattern,
          activeDefaultPatternCell,
        )
      ) {
        throw new Error(
          "default pattern changed during debug view deployment",
        );
      }
      const activeRegistry = defaultPattern.withTx(tx).key("pieceRegistry");
      if (
        activeRegistry.getRawUntyped() === undefined ||
        !areLinksSame(
          activeRegistry.resolveAsCell(),
          registry,
          activeRegistry,
        )
      ) {
        throw new Error(
          "default pattern registry changed during debug view deployment",
        );
      }
      const registryWithTx = registry.withTx(tx);
      const current = registryWithTx.getRawUntyped({ frozen: false });
      if (!Array.isArray(current)) {
        throw new Error("default pattern pieceRegistry is not an array");
      }
      const retained = current.filter((value) =>
        !piecesToRemove.some((target) =>
          areLinksSame(value, target, registryWithTx)
        )
      );
      if (retained.length === current.length) return false;
      registryWithTx.setRawUntyped(retained);
      return true;
    });
  };
  signal?.throwIfAborted();
  const publicUpdate = await removePublicDebugLinks();
  if (publicUpdate.error) {
    throw new Error(
      `Could not update public debug view registrations: ${publicUpdate.error.message}`,
      { cause: publicUpdate.error },
    );
  }
  try {
    signal?.throwIfAborted();
  } catch (error) {
    const cleanup = await removePublicDebugLinks();
    if (cleanup.error) {
      throw new AggregateError(
        [error, cleanup.error],
        "debug view abort and public-list cleanup failed",
      );
    }
    throw error;
  }
  const privateUpdate = await manager.runtime.editWithRetry((tx) => {
    setCfcImplementationIdentity(tx, {
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    const candidatePattern = asPatternIdentityRef(tx.readOrThrow({
      space: candidateLink.space,
      id: candidateLink.id,
      path: ["patternIdentity"],
      ...(candidateLink.scope !== undefined && {
        scope: candidateLink.scope,
      }),
    }));
    const candidateArgument = tx.readOrThrow({
      space: candidateLink.space,
      id: candidateLink.id,
      path: ["argument"],
      ...(candidateLink.scope !== undefined && {
        scope: candidateLink.scope,
      }),
    });
    if (
      candidatePattern?.identity !== patternRef.identity ||
      candidatePattern.symbol !== patternRef.symbol ||
      candidateArgument === undefined
    ) {
      throw new Error("debug view piece changed during deployment");
    }
    const activeRegistration = asDebugRegistration(
      tx.readValueOrThrow(registration.link),
    );
    if (!debugRegistrationsMatch(activeRegistration, registration.value)) {
      throw new Error(
        "debug view registration changed during deployment",
      );
    }
    manager.runtime.getCellFromLink(registration.link, undefined, tx)
      .asSchema(agentOwnerSchema(ownerDid))
      .setRawUntyped(nextRegistration);
    return true;
  });
  if (privateUpdate.error) {
    const cleanup = await removePublicDebugLinks();
    if (cleanup.error) {
      throw new AggregateError(
        [privateUpdate.error, cleanup.error],
        "debug view registration update and public-list cleanup failed",
      );
    }
    throw new Error(
      `Could not update private debug view registration: ${privateUpdate.error.message}`,
      { cause: privateUpdate.error },
    );
  }
  let supersededPiecesStopped = false;
  const stopPreceding = async (): Promise<void> => {
    if (precedingPiece === undefined) return;
    await stopAndDrainPieces(manager, [precedingPiece]);
  };
  const rollbackForAbort = async (): Promise<void> => {
    const abortSignal = signal;
    if (!abortSignal?.aborted) return;
    let abortError: unknown;
    try {
      abortSignal.throwIfAborted();
    } catch (error) {
      abortError = error;
    }
    let precedingStarted = false;
    if (
      supersededPiecesStopped && precedingPiece !== undefined &&
      precedingWasRunningLocally
    ) {
      try {
        await manager.startPiece(precedingPiece);
        precedingStarted = true;
      } catch (startError) {
        try {
          await stopPreceding();
        } catch (cleanupError) {
          throw new AggregateError(
            [abortError, startError, cleanupError],
            "previous debug view restart and cleanup failed",
          );
        }
        throw new AggregateError(
          [abortError, startError],
          "previous debug view restart failed",
        );
      }
    }
    const registrationRollback = await manager.runtime.editWithRetry((tx) => {
      setCfcImplementationIdentity(tx, {
        kind: "builtin",
        builtinId: AGENT_CONNECTOR_WRITER_ID,
      });
      const activeRegistration = asDebugRegistration(
        tx.readValueOrThrow(registration.link),
      );
      if (!debugRegistrationsMatch(activeRegistration, nextRegistration)) {
        return false;
      }
      manager.runtime.getCellFromLink(registration.link, undefined, tx)
        .asSchema(agentOwnerSchema(ownerDid))
        .setRawUntyped(registration.value ?? EMPTY_DEBUG_REGISTRATION);
      return true;
    });
    if (registrationRollback.error) {
      let registrationWasRestored = true;
      try {
        registrationWasRestored = debugRegistrationsMatch(
          (await debugRegistration(manager, ownerDid)).value,
          registration.value,
        );
      } catch {
        // Registration ownership is unknown. The preceding piece is preserved.
      }
      if (precedingStarted && !registrationWasRestored) {
        try {
          await stopPreceding();
        } catch (cleanupError) {
          throw new AggregateError(
            [abortError, registrationRollback.error, cleanupError],
            "debug view rollback and cleanup failed",
          );
        }
      }
      throw new AggregateError(
        [abortError, registrationRollback.error],
        "debug view rollback failed",
      );
    }
    const listCleanup = await removePublicDebugLinks();
    if (listCleanup.error) {
      throw new AggregateError(
        [abortError, listCleanup.error],
        "debug view public-list cleanup failed",
      );
    }
    if (!registrationRollback.ok && precedingStarted) {
      try {
        await stopPreceding();
      } catch (cleanupError) {
        throw new AggregateError(
          [abortError, cleanupError],
          "debug view abort cleanup failed",
        );
      }
    }
    throw abortError;
  };
  await rollbackForAbort();
  let cleanupError: unknown;
  supersededPiecesStopped = true;
  try {
    await stopAndDrainPieces(manager, piecesToUnregister);
  } catch (error) {
    cleanupError = error;
  }
  try {
    await rollbackForAbort();
  } catch (rollbackError) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [cleanupError, rollbackError],
        "debug view cleanup and rollback failed",
      );
    }
    throw rollbackError;
  }
  if (cleanupError !== undefined) throw cleanupError;
}

export function defaultDebugPatternLocation(): {
  mainPath: string;
  rootPath: string;
} {
  const rootPath = resolve(
    dirname(fromFileUrl(import.meta.url)),
    "../../../../..",
  );
  return {
    rootPath,
    mainPath: join(
      rootPath,
      "packages/connectors/agents/debug-view/main.tsx",
    ),
  };
}

export function deployAgentSessionsDebugView(
  manager: PiecesController,
  target: AgentFabricTarget,
  location = defaultDebugPatternLocation(),
  signal?: AbortSignal,
): Promise<string> {
  return serializeDebugDeployment(
    `${manager.getSpace()}:${target.conn.ownerDid}`,
    () => deployAgentSessionsDebugViewNow(manager, target, location, signal),
  );
}

async function deployAgentSessionsDebugViewNow(
  manager: PiecesController,
  target: AgentFabricTarget,
  location: ReturnType<typeof defaultDebugPatternLocation>,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  let defaultPattern: Cell<unknown> | undefined = await manager
    .getDefaultPattern(false);
  if (!defaultPattern) {
    await manager.ensureDefaultPattern();
    defaultPattern = await manager.getDefaultPattern(false);
    if (!defaultPattern) {
      throw new Error("default pattern was not created");
    }
  }
  signal?.throwIfAborted();
  const program = await resolveLocalProgram(
    (resolver) => manager.runtime.harness.resolve(resolver),
    { main: location.mainPath, root: location.rootPath },
  );
  signal?.throwIfAborted();
  const pattern = await compileAndSavePattern(manager.runtime, program, {
    space: manager.getSpace(),
  });
  const patternRef = manager.runtime.patternManager.getArtifactEntryRef(
    pattern,
  );
  if (!patternRef) throw new Error("debug view pattern has no identity");
  const writerAuthorization = commandWriterAuthorization(pattern);
  if (writerAuthorization === undefined) {
    throw new Error("debug view has no verified command writer authorization");
  }
  await target.bindCommandCell(target.cells.commands, writerAuthorization);
  const cause = debugPieceCause(target.conn.ownerDid, patternRef);
  const setupArguments = {
    ownerDid: target.conn.ownerDid,
    recentIndex: target.cells.index,
    allIndex: target.cells.allIndex,
    health: target.cells.health,
    receipts: target.cells.receipts,
    recentIndexCell: target.cells.index,
    allIndexCell: target.cells.allIndex,
    healthCell: target.cells.health,
    commandsCell: target.cells.commands,
    receiptsCell: target.cells.receipts,
  };
  const currentPiece = await currentDebugPiece(
    manager,
    pattern,
    cause,
    target.conn.ownerDid,
    setupArguments,
  );
  let piece = currentPiece;
  if (piece === undefined) {
    const createdPiece = await manager.setupPersistent(
      pattern,
      setupArguments,
      cause,
    );
    const createdArgument = manager.getArgument(createdPiece);
    await protectOwnerDebugCells(
      manager,
      [createdPiece, createdArgument],
      target.conn.ownerDid,
      new Map([
        [createdPiece, readDocumentRoot(manager, createdPiece)],
        [createdArgument, readDocumentRoot(manager, createdArgument)],
      ]),
    );
    piece = await currentDebugPiece(
      manager,
      pattern,
      cause,
      target.conn.ownerDid,
      setupArguments,
    );
    if (piece === undefined) {
      throw new Error("new debug view disappeared after owner protection");
    }
  }
  const existingRegistration = (await debugRegistration(
    manager,
    target.conn.ownerDid,
  )).value;
  const pieceWasRegistered = debugRegistrationTargets(
    existingRegistration,
    cause,
    pieceId(piece),
    patternRef,
  );
  signal?.throwIfAborted();
  const stopStartingPiece = () => manager.runtime.runner.stop(piece);
  if (!pieceWasRegistered) {
    signal?.addEventListener("abort", stopStartingPiece, { once: true });
  }
  try {
    await manager.startPiece(piece);
    signal?.throwIfAborted();
  } catch (error) {
    if (!pieceWasRegistered) {
      try {
        await stopAndDrainPieces(manager, [piece]);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "debug view startup and cleanup failed",
        );
      }
    }
    throw error;
  } finally {
    if (!pieceWasRegistered) {
      signal?.removeEventListener("abort", stopStartingPiece);
    }
  }
  const deploymentId = crypto.randomUUID();
  try {
    await registerDebugPiece(
      manager,
      defaultPattern,
      piece,
      cause,
      patternRef,
      deploymentId,
      target.conn.ownerDid,
      signal,
    );
  } catch (error) {
    let registrationIsOwned = true;
    try {
      const activeRegistration = (await debugRegistration(
        manager,
        target.conn.ownerDid,
      )).value;
      registrationIsOwned = debugRegistrationTargets(
        activeRegistration,
        cause,
        pieceId(piece),
        patternRef,
      ) && (activeRegistration?.deploymentId === deploymentId ||
        (pieceWasRegistered &&
          activeRegistration?.deploymentId ===
            existingRegistration?.deploymentId));
    } catch {
      // Registration ownership is unknown. The running piece is preserved.
    }
    if (!registrationIsOwned) {
      try {
        await stopAndDrainPieces(manager, [piece]);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "debug view deployment and cleanup failed",
        );
      }
    }
    throw error;
  }
  const id = pieceId(piece);
  if (!id) throw new Error("debug view piece has no entity ID");
  return id;
}

export function describeAgentFabricTarget(
  target: AgentFabricTarget,
  spaceDid: string,
  debugPieceId?: string,
  commandProducers: readonly BoundCommandProducer[] = [],
): AgentsHostTargetDescription {
  return {
    spaceDid,
    ownerDid: target.conn.ownerDid,
    ...(debugPieceId ? { debugPieceId } : {}),
    ...(commandProducers.length > 0
      ? { commandProducers: [...commandProducers] }
      : {}),
    cells: {
      recentIndex: stableCellId(target.cells.index),
      allIndex: stableCellId(target.cells.allIndex),
      health: stableCellId(target.cells.health),
      commands: target.commandCellId(),
      receipts: target.receiptCellId(),
    },
  };
}
