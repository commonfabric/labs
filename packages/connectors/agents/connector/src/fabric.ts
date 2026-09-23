import type { Cancel, Cell } from "@commonfabric/runner";
import {
  AGENT_CONNECTOR_WRITER_ID,
  type AgentFabricConnection,
  agentOwnerSchema,
  agentPrincipalSchema,
  cellHasOwnerProtection,
  pushStableCellGraph,
  readStableActions,
  readStableCellGraphValue,
  stableCellId,
  subscribeStableActions,
} from "./fabric-graph.ts";
import { stableFabricValue } from "./stable-fabric-value.ts";
import {
  commandReceiptCause,
  normalizeNativeSessionId,
  normalizeSourceId,
  sessionCause,
  sessionChunkCause,
  sessionKey,
  sessionManifestCause,
} from "./session-contract.ts";
import {
  completeSessionDescription,
  type PreparedSessionDescription,
  prepareSessionHeader,
  type SourceCollection,
} from "./reconcile.ts";
import { iterateEventChunks } from "./chunking.ts";
import {
  type AgentSessionCommandReceipt,
  commandIdentity,
  type CommandTarget,
  parseCommandReceipt,
} from "./commands.ts";
import type {
  AgentDriver,
  DriverCapabilities,
  NormalizedMessage,
} from "./types.ts";
import { AGENT_CONNECTOR_SCHEMAS } from "./protocol.ts";
import { type GitContext, GitContextResolver } from "./git-context.ts";
import {
  hashStableArrayValue,
  materializeStableArrayCells,
  planStableArrayCells,
  type StableArrayCellPlan,
} from "./array-cell-identity.ts";
import { AsyncSerialQueue } from "./serial-queue.ts";
import { isAbsolute as isPosixAbsolute } from "@std/path/posix";
import { isAbsolute as isWindowsAbsolute } from "@std/path/windows";

export interface AgentFabricCells {
  index: Cell<unknown>;
  allIndex: Cell<unknown>;
  health: Cell<unknown>;
  commands: Cell<unknown>;
  receipts: Cell<unknown>;
}

/**
 * What a host reads of a published session to decide retention: the fields
 * an inventory summary can change, the row's status, and any durable pairing
 * with the desktop start that made it. The map it comes in supplies the
 * identity.
 */
export type PublishedSessionState = Readonly<
  Pick<
    IndexEntry,
    "driver" | "updatedAt" | "archived" | "active" | "syncStatus" | "startedAs"
  >
>;

export interface AgentFabricPublishOptions {
  preserveUntouchedStatus?: boolean;
  observationSequence?: number;
  checkoutDirectories?: string[];
  signal?: AbortSignal;
  onCommit?: () => void;
}

export interface AgentFabricGraphSession {
  connection: AgentFabricConnection;
  release(): Promise<void>;
}

export type AgentFabricGraphSessionFactory = () => Promise<
  AgentFabricGraphSession
>;

interface CellLink {
  id: string;
  space: string;
  path: readonly (string | number)[];
}

interface IndexEntry {
  ownerDid: string;
  key: string;
  sourceId: string;
  driver: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  gitHeadSha: string | null;
  gitRemotes: Array<{ name: string; urls: string[] }>;
  gitObservedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  archived: boolean | null;
  active: boolean | null;
  /** The id a `start` command named, when this session is the one that
   * start produced under another id (a desktop start). Once published, a
   * later publication of the row keeps it. */
  startedAs?: string;
  capabilities: Record<string, unknown>;
  recentMessages?: NormalizedMessage[];
  manifest: Cell<unknown>;
  manifestVersioned?: boolean;
  manifestHash?: string;
  contentHash: string;
  syncStatus: "complete" | "partial" | "stale" | "deleted";
  deletedAt?: string;
}

export function recentSessionMessages(
  messages: NormalizedMessage[],
  limit = 12,
): NormalizedMessage[] {
  const count = Math.max(0, Math.trunc(limit));
  return count === 0 ? [] : messages.slice(-count);
}

interface AgentSessionIndex {
  schema: typeof AGENT_CONNECTOR_SCHEMAS.sessionIndex;
  ownerDid: string;
  bucket: "recent" | "all";
  generatedAt: string;
  generation: number;
  totalSessionCount?: number;
  olderSessionCount?: number;
  sources: Array<Record<string, unknown>>;
  checkouts?: CheckoutEntry[];
  // TODO(@ianh): Publish a shallow session directory with the row links and
  // sortable title, update-time, and worktree keys. Consumers cannot sort the
  // linked session rows globally without loading every row cell.
  sessions: IndexEntry[];
}

export interface CheckoutEntry {
  root: string;
  gitRepo: string | null;
  gitBranch: string | null;
  gitHeadSha: string | null;
  gitRemotes: Array<{ name: string; urls: string[] }>;
  observedAt: string;
}

export interface CheckoutObservation {
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  gitHeadSha: string | null;
  gitRemotes: Array<{ name: string; urls: string[] }>;
  gitObservedAt: string | null;
  syncStatus?: "complete" | "stale" | "partial" | "deleted";
}

const RECENT_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionIndexBuckets<
  T extends { updatedAt: string | null },
>(entries: T[], generatedAt: string): {
  recent: T[];
  all: T[];
  olderCount: number;
} {
  const cutoff = new Date(generatedAt).getTime() - RECENT_SESSION_WINDOW_MS;
  const recent = entries.filter((entry) => {
    if (!entry.updatedAt) return false;
    const updatedAt = new Date(entry.updatedAt).getTime();
    return Number.isFinite(updatedAt) && updatedAt >= cutoff;
  });
  return {
    recent,
    all: [...entries],
    olderCount: entries.length - recent.length,
  };
}

export function checkoutEntries(
  sessions: CheckoutObservation[],
  discovered: CheckoutObservation[] = [],
): CheckoutEntry[] {
  const checkouts = new Map<string, CheckoutEntry>();
  const observe = (observation: CheckoutObservation) => {
    const root = observation.gitWorktreeRoot;
    const observedAt = observation.gitObservedAt;
    if (!root || !observedAt || observation.syncStatus === "deleted") return;
    const prior = checkouts.get(root);
    if (prior && prior.observedAt > observedAt) return;
    checkouts.set(root, {
      root,
      gitRepo: observation.gitRepo,
      gitBranch: observation.gitBranch,
      gitHeadSha: observation.gitHeadSha,
      gitRemotes: observation.gitRemotes,
      observedAt,
    });
  };
  for (const session of sessions) observe(session);
  for (const checkout of discovered) observe(checkout);
  return [...checkouts.values()].sort((left, right) =>
    left.root.localeCompare(right.root)
  );
}

function storedCheckoutObservations(
  ...indexes: Array<AgentSessionIndex | null>
): CheckoutObservation[] {
  return indexes.flatMap((index) =>
    (index?.checkouts ?? []).map((checkout) => ({
      gitRepo: checkout.gitRepo,
      gitBranch: checkout.gitBranch,
      gitWorktreeRoot: checkout.root,
      gitHeadSha: checkout.gitHeadSha,
      gitRemotes: checkout.gitRemotes,
      gitObservedAt: checkout.observedAt,
    }))
  );
}

export function agentFabricCauses(spaceDid: string, ownerDid: string) {
  return {
    index: {
      spaceDid,
      ownerDid,
      agentConnector: "recent-session-index",
    },
    allIndex: {
      spaceDid,
      ownerDid,
      agentConnector: "all-session-index",
    },
    health: { spaceDid, ownerDid, agentConnector: "health" },
    commands: { spaceDid, ownerDid, agentConnector: "commands" },
    receipts: { spaceDid, ownerDid, agentConnector: "receipts" },
  } as const;
}

/**
 * The cause of the command queue bound to the producer pattern `producerId`,
 * distinct from the owner's queue that the debug view writes.
 */
export function producerCommandsCause(
  spaceDid: string,
  ownerDid: string,
  producerId: string,
) {
  return {
    spaceDid,
    ownerDid,
    agentConnector: "commands",
    producer: producerId,
  } as const;
}

function fullLink(cell: Cell<unknown>): CellLink {
  const link = cell.getAsNormalizedFullLink();
  return {
    id: link.id!,
    space: link.space!,
    path: [...link.path],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDriverCapabilities(value: unknown): value is DriverCapabilities {
  if (!isRecord(value)) return false;
  if (
    ![
      "inventory",
      "read",
      "prompt",
      "cancel",
      "rename",
      "setMode",
      "setConfigOption",
    ].every((key) => typeof value[key] === "boolean")
  ) {
    return false;
  }
  if (
    value.startSession !== undefined && typeof value.startSession !== "boolean"
  ) {
    return false;
  }
  if (
    value.modes !== undefined &&
    (!Array.isArray(value.modes) ||
      !value.modes.every((mode) => typeof mode === "string"))
  ) {
    return false;
  }
  if (
    value.surfaces !== undefined &&
    (!Array.isArray(value.surfaces) ||
      !value.surfaces.every((surface) => typeof surface === "string"))
  ) {
    return false;
  }
  return value.configOptions === undefined || isRecord(value.configOptions);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === "boolean";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function equalCellLink(value: unknown, expected: CellLink): boolean {
  if (!isRecord(value)) return false;
  if (
    value.id !== expected.id || value.space !== expected.space ||
    !Array.isArray(value.path) || value.path.length !== expected.path.length
  ) {
    return false;
  }
  return value.path.every((part, index) =>
    (typeof part === "string" || typeof part === "number") &&
    part === expected.path[index]
  );
}

function graphEntry(cell: Cell<unknown>, plan: StableArrayCellPlan) {
  return {
    cell,
    value: (
      materializeCell: Parameters<typeof materializeStableArrayCells>[1],
    ) =>
      materializeStableArrayCells(
        plan,
        materializeCell,
      ) as Record<string, unknown>,
  };
}

function sessionChunkHashes(value: unknown, key: string): string[] {
  if (!isRecord(value) || value.key !== key || !Array.isArray(value.chunks)) {
    return [];
  }
  const hashes: string[] = [];
  for (let index = 0; index < value.chunks.length; index++) {
    const descriptor = value.chunks[index];
    if (
      !isRecord(descriptor) || descriptor.part !== index ||
      typeof descriptor.contentHash !== "string"
    ) {
      return [];
    }
    hashes.push(descriptor.contentHash);
  }
  return hashes;
}

function childScope(
  spaceDid: string,
  ownerDid: string,
  owner: string,
  identity?: Record<string, unknown>,
) {
  return {
    spaceDid,
    ownerDid,
    agentConnector: `${owner}-array-elements`,
    ...identity,
  };
}

function validatedReceiptIndexRows(
  conn: AgentFabricConnection,
  value: unknown,
): Array<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    value.schema !== AGENT_CONNECTOR_SCHEMAS.commandReceipts ||
    value.ownerDid !== conn.ownerDid ||
    !isIsoTimestamp(value.updatedAt) ||
    !Array.isArray(value.receipts)
  ) {
    throw new Error("command receipt index has an invalid shape");
  }
  if (value.receipts.length > 200) {
    throw new Error("command receipt index exceeds 200 rows");
  }

  const identities = new Set<string>();
  return value.receipts.map((item, index) => {
    if (!isRecord(item) || typeof item.commandId !== "string") {
      throw new Error(
        `command receipt index row has an invalid shape: ${index}`,
      );
    }
    const commandId = item.commandId;
    const receipt = parseCommandReceipt(
      commandId,
      {
        schema: AGENT_CONNECTOR_SCHEMAS.commandReceipt,
        ownerDid: item.ownerDid,
        commandId,
        sourceId: item.sourceId,
        nativeSessionId: item.nativeSessionId,
        ...(item.producer === undefined ? {} : { producer: item.producer }),
        status: item.status,
        ...(item.error === undefined ? {} : { error: item.error }),
      },
      `command receipt index row ${index}`,
    );
    if (receipt.ownerDid !== conn.ownerDid) {
      throw new Error(
        `command receipt index row belongs to another owner: ${index}`,
      );
    }
    if (!isIsoTimestamp(item.updatedAt)) {
      throw new Error(
        `command receipt index row updatedAt is invalid: ${index}`,
      );
    }
    const expectedLink = fullLink(
      conn.runtime.getCell(
        conn.spaceDid,
        commandReceiptCause(
          conn.spaceDid,
          conn.ownerDid,
          commandId,
          receipt.producer,
        ),
        agentOwnerSchema(conn.ownerDid),
      ),
    );
    if (!equalCellLink(item.receipt, expectedLink)) {
      throw new Error(
        `command receipt index row receipt link is invalid: ${index}`,
      );
    }
    const identity = commandIdentity(commandId, receipt.producer);
    if (identities.has(identity)) {
      throw new Error(
        `command receipt index contains a duplicate command: ${commandId}`,
      );
    }
    identities.add(identity);
    return {
      commandId,
      ownerDid: receipt.ownerDid,
      sourceId: receipt.sourceId,
      nativeSessionId: receipt.nativeSessionId,
      ...(receipt.producer === undefined ? {} : { producer: receipt.producer }),
      status: receipt.status,
      updatedAt: item.updatedAt,
      ...(receipt.error ? { error: receipt.error } : {}),
      receipt: expectedLink,
    };
  });
}

export function createAgentFabricCells(
  conn: AgentFabricConnection,
): AgentFabricCells {
  const causes = agentFabricCauses(conn.spaceDid, conn.ownerDid);
  const connectorSchema = agentOwnerSchema(conn.ownerDid);
  const commandSchema = agentOwnerSchema(conn.ownerDid, false);
  return {
    index: conn.runtime.getCell(conn.spaceDid, causes.index, connectorSchema),
    allIndex: conn.runtime.getCell(
      conn.spaceDid,
      causes.allIndex,
      connectorSchema,
    ),
    health: conn.runtime.getCell(conn.spaceDid, causes.health, connectorSchema),
    commands: conn.runtime.getCell(
      conn.spaceDid,
      causes.commands,
      commandSchema,
    ),
    receipts: conn.runtime.getCell(
      conn.spaceDid,
      causes.receipts,
      connectorSchema,
    ),
  };
}

export async function ensureAgentFabricCells(
  conn: AgentFabricConnection,
): Promise<AgentFabricCells> {
  const cells = await syncAgentFabricCells(conn);
  await claimAgentFabricRoots(conn, cells);
  return cells;
}

async function syncAgentFabricCells(
  conn: AgentFabricConnection,
): Promise<AgentFabricCells> {
  const cells = createAgentFabricCells(conn);
  await Promise.all([
    cells.index.sync(),
    cells.allIndex.sync(),
    cells.health.sync(),
    cells.commands.sync(),
    cells.receipts.sync(),
  ]);
  await conn.runtime.storageManager.synced();
  return cells;
}

async function claimAgentFabricRoots(
  conn: AgentFabricConnection,
  cells: AgentFabricCells,
): Promise<void> {
  const generatedAt = new Date().toISOString();
  const roots: Array<{
    name: string;
    cell: Cell<unknown>;
    initialValue: Record<string, unknown>;
  }> = [{
    name: "recent session index",
    cell: cells.index,
    initialValue: {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: conn.ownerDid,
      bucket: "recent",
      generatedAt,
      generation: 0,
      totalSessionCount: 0,
      olderSessionCount: 0,
      sources: [],
      sessions: [],
    },
  }, {
    name: "complete session index",
    cell: cells.allIndex,
    initialValue: {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: conn.ownerDid,
      bucket: "all",
      generatedAt,
      generation: 0,
      totalSessionCount: 0,
      olderSessionCount: 0,
      sources: [],
      sessions: [],
    },
  }, {
    name: "health",
    cell: cells.health,
    initialValue: {
      schema: AGENT_CONNECTOR_SCHEMAS.health,
      ownerDid: conn.ownerDid,
    },
  }, {
    name: "receipt index",
    cell: cells.receipts,
    initialValue: {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      ownerDid: conn.ownerDid,
      receipts: [],
      updatedAt: generatedAt,
    },
  }];
  const tx = conn.runtime.edit();
  tx.setCfcImplementationIdentity({
    kind: "builtin",
    builtinId: AGENT_CONNECTOR_WRITER_ID,
  });
  try {
    for (const root of roots) {
      const link = root.cell.getAsNormalizedFullLink();
      const value = tx.readValueOrThrow(link);
      if (value !== undefined) {
        if (!cellHasOwnerProtection(tx, root.cell, conn.ownerDid)) {
          throw new Error(
            `refusing to adopt an unprotected ${root.name} for ${conn.ownerDid}`,
          );
        }
        root.cell.withTx(tx).applyCfcSchemaToExistingValue();
        continue;
      }
      tx.writeValueOrThrow(link, stableFabricValue(root.initialValue));
      root.cell.withTx(tx).applyCfcSchemaToExistingValue();
    }
    tx.prepareCfc();
  } catch (error) {
    tx.abort(error);
    throw error;
  }
  const committed = await tx.commit();
  if (committed.error) {
    throw new Error(
      `could not claim agent connector storage: ${committed.error.message}`,
      { cause: committed.error },
    );
  }
}

function asIndex(
  value: unknown,
  ownerDid: string,
  expectedBucket: "recent" | "all",
): AgentSessionIndex | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent session index is not an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema !== AGENT_CONNECTOR_SCHEMAS.sessionIndex ||
    record.ownerDid !== ownerDid ||
    record.bucket !== expectedBucket ||
    !isIsoTimestamp(record.generatedAt) ||
    !isNonNegativeSafeInteger(record.generation) ||
    (record.totalSessionCount !== undefined &&
      !isNonNegativeSafeInteger(record.totalSessionCount)) ||
    (record.olderSessionCount !== undefined &&
      !isNonNegativeSafeInteger(record.olderSessionCount)) ||
    !Array.isArray(record.sources) ||
    (record.checkouts !== undefined && !Array.isArray(record.checkouts)) ||
    !Array.isArray(record.sessions)
  ) {
    throw new Error("agent session index has an invalid shape");
  }
  const sourceIds = new Set<string>();
  for (const [index, source] of record.sources.entries()) {
    if (
      !isRecord(source) || typeof source.id !== "string" ||
      normalizeSourceId(source.id) !== source.id || sourceIds.has(source.id) ||
      typeof source.driver !== "string" || source.driver.length === 0 ||
      !isDriverCapabilities(source.capabilities)
    ) {
      throw new Error(
        `agent session index source ${index} has an invalid shape`,
      );
    }
    sourceIds.add(source.id);
  }
  const checkoutRoots = new Set<string>();
  for (const [index, checkout] of (record.checkouts ?? []).entries()) {
    if (
      !isRecord(checkout) || typeof checkout.root !== "string" ||
      !(isPosixAbsolute(checkout.root) || isWindowsAbsolute(checkout.root)) ||
      checkoutRoots.has(checkout.root) ||
      !isNullableString(checkout.gitRepo) ||
      !isNullableString(checkout.gitBranch) ||
      !isNullableString(checkout.gitHeadSha) ||
      !Array.isArray(checkout.gitRemotes) ||
      !checkout.gitRemotes.every((remote) =>
        isRecord(remote) && typeof remote.name === "string" &&
        remote.name.length > 0 && Array.isArray(remote.urls) &&
        remote.urls.every((url) => typeof url === "string" && url.length > 0)
      ) ||
      !isIsoTimestamp(checkout.observedAt)
    ) {
      throw new Error(
        `agent session index checkout ${index} has an invalid shape`,
      );
    }
    checkoutRoots.add(checkout.root);
  }
  const sessionKeys = new Set<string>();
  const statuses = new Set(["complete", "partial", "stale", "deleted"]);
  for (const [index, session] of record.sessions.entries()) {
    if (!isRecord(session)) {
      throw new Error(`agent session index row ${index} has an invalid shape`);
    }
    if (typeof session.driver !== "string" || session.driver.length === 0) {
      throw new Error(`agent session index row ${index} has no driver`);
    }
    if (
      session.ownerDid !== ownerDid || typeof session.key !== "string" ||
      typeof session.sourceId !== "string" ||
      typeof session.nativeSessionId !== "string" ||
      normalizeSourceId(session.sourceId) !== session.sourceId ||
      normalizeNativeSessionId(session.nativeSessionId) !==
        session.nativeSessionId ||
      session.key !== sessionKey(session.sourceId, session.nativeSessionId) ||
      sessionKeys.has(session.key) ||
      typeof session.contentHash !== "string" ||
      session.contentHash.length === 0 ||
      typeof session.syncStatus !== "string" ||
      !statuses.has(session.syncStatus) ||
      !isNullableString(session.title) || !isNullableString(session.cwd) ||
      !isNullableString(session.gitRepo) ||
      !isNullableString(session.gitBranch) ||
      !isNullableString(session.gitWorktreeRoot) ||
      !isNullableString(session.createdAt) ||
      !isNullableString(session.updatedAt) ||
      !isNullableBoolean(session.archived) ||
      !isNullableBoolean(session.active) ||
      (session.startedAs !== undefined &&
        (typeof session.startedAs !== "string" ||
          session.startedAs.length === 0)) ||
      !isRecord(session.capabilities) ||
      (session.recentMessages !== undefined &&
        !Array.isArray(session.recentMessages)) ||
      (session.manifestVersioned !== undefined &&
        typeof session.manifestVersioned !== "boolean") ||
      (session.manifestHash !== undefined &&
        (typeof session.manifestHash !== "string" ||
          session.manifestHash.length === 0)) ||
      (session.manifestVersioned === true &&
        typeof session.manifestHash !== "string") ||
      (session.deletedAt !== undefined &&
        !isIsoTimestamp(session.deletedAt))
    ) {
      throw new Error(`agent session index row ${index} has an invalid shape`);
    }
    sessionKeys.add(session.key);
  }
  return record as unknown as AgentSessionIndex;
}

function sessionManifestCell(
  conn: AgentFabricConnection,
  entry: IndexEntry,
): Cell<unknown> {
  const cause = entry.manifestVersioned === true
    ? sessionManifestCause(
      conn.spaceDid,
      conn.ownerDid,
      entry.sourceId,
      entry.nativeSessionId,
      entry.driver,
      entry.manifestHash!,
    )
    : sessionCause(
      conn.spaceDid,
      conn.ownerDid,
      entry.sourceId,
      entry.nativeSessionId,
    );
  return conn.runtime.getCell(
    conn.spaceDid,
    cause,
    agentOwnerSchema(conn.ownerDid),
  );
}

async function publishSessionGraph(
  conn: AgentFabricConnection,
  header: ReturnType<typeof prepareSessionHeader>,
  events: readonly unknown[],
  driver: string,
  gitContext: GitContext,
  previousEntry: IndexEntry | undefined,
  startGraphCommit: () => void,
): Promise<{
  prepared: PreparedSessionDescription;
  indexEntry?: IndexEntry;
}> {
  const previousManifest = previousEntry === undefined
    ? undefined
    : await readStableCellGraphValue(
      conn,
      sessionManifestCell(conn, previousEntry),
      new Map(),
      { preserveLinkFields: new Set(["link"]) },
    );
  const previousChunkHashes = previousManifest === undefined
    ? []
    : sessionChunkHashes(previousManifest, header.key);
  const previousManifestMatches = previousEntry?.manifestVersioned === true &&
    typeof previousEntry.manifestHash === "string" &&
    previousManifest !== undefined &&
    await hashStableArrayValue(previousManifest) === previousEntry.manifestHash;
  const chunkDescriptors = [];
  const preparedChunks = [];
  for (const chunk of iterateEventChunks(events)) {
    const contentHash = await hashStableArrayValue(chunk.events);
    const cell = conn.runtime.getCell(
      conn.spaceDid,
      sessionChunkCause(
        conn.spaceDid,
        conn.ownerDid,
        header.sourceId,
        header.nativeSessionId,
        chunk.part,
        contentHash,
      ),
      agentOwnerSchema(conn.ownerDid),
    );
    if (previousChunkHashes[chunk.part] !== contentHash) {
      const value = {
        schema: AGENT_CONNECTOR_SCHEMAS.sessionChunk,
        ownerDid: conn.ownerDid,
        key: header.key,
        part: chunk.part,
        contentHash,
        events: chunk.events,
      };
      const plan = await planStableArrayCells(
        value,
        childScope(conn.spaceDid, conn.ownerDid, "session-events", {
          sourceId: header.sourceId,
          nativeSessionId: header.nativeSessionId,
          part: chunk.part,
          contentHash,
        }),
      );
      startGraphCommit();
      await pushStableCellGraph(conn, [graphEntry(cell, plan)]);
    }
    chunkDescriptors.push({
      part: chunk.part,
      link: cell,
      contentHash,
      byteLength: chunk.byteLength,
      eventCount: chunk.events.length,
    });
    preparedChunks.push({
      part: chunk.part,
      contentHash,
      byteLength: chunk.byteLength,
      eventCount: chunk.events.length,
    });
  }
  const prepared = await completeSessionDescription(header, preparedChunks);
  if (
    previousManifestMatches &&
    previousEntry?.contentHash === prepared.snapshotHash &&
    previousEntry.driver === driver
  ) {
    return { prepared };
  }
  const manifestValue = {
    schema: AGENT_CONNECTOR_SCHEMAS.session,
    ownerDid: conn.ownerDid,
    key: prepared.key,
    sourceId: prepared.sourceId,
    driver,
    nativeSessionId: prepared.nativeSessionId,
    metadata: prepared.summary.raw,
    summary: prepared.summary,
    normalized: { messages: prepared.normalizedMessages },
    chunks: chunkDescriptors,
    snapshotHash: prepared.snapshotHash,
    revision: prepared.revision ?? null,
    observedAt: new Date().toISOString(),
    complete: prepared.complete,
  };
  const manifestHash = await hashStableArrayValue(manifestValue);
  const manifest = conn.runtime.getCell(
    conn.spaceDid,
    sessionManifestCause(
      conn.spaceDid,
      conn.ownerDid,
      prepared.sourceId,
      prepared.nativeSessionId,
      driver,
      manifestHash,
    ),
    agentOwnerSchema(conn.ownerDid),
  );
  const manifestScope = childScope(conn.spaceDid, conn.ownerDid, "session", {
    sourceId: prepared.sourceId,
    nativeSessionId: prepared.nativeSessionId,
    manifestHash,
  });
  const manifestPlan = await planStableArrayCells(
    manifestValue,
    manifestScope,
  );
  startGraphCommit();
  await pushStableCellGraph(conn, [graphEntry(manifest, manifestPlan)]);
  return {
    prepared,
    indexEntry: {
      ownerDid: conn.ownerDid,
      key: prepared.key,
      sourceId: prepared.sourceId,
      driver,
      nativeSessionId: prepared.nativeSessionId,
      title: prepared.summary.title,
      cwd: prepared.summary.cwd,
      gitRepo: prepared.summary.gitRepo ?? null,
      gitBranch: prepared.summary.gitBranch ?? null,
      gitWorktreeRoot: prepared.summary.gitWorktreeRoot ?? null,
      gitHeadSha: gitContext.gitHeadSha,
      gitRemotes: gitContext.gitRemotes,
      gitObservedAt: gitContext.gitObservedAt,
      createdAt: prepared.summary.createdAt,
      updatedAt: prepared.summary.updatedAt,
      archived: prepared.summary.archived,
      active: prepared.summary.active,
      ...(prepared.summary.startedAs
        ? { startedAs: prepared.summary.startedAs }
        : {}),
      capabilities: {},
      recentMessages: recentSessionMessages(prepared.normalizedMessages),
      manifest,
      manifestVersioned: true,
      manifestHash,
      contentHash: prepared.snapshotHash,
      syncStatus: prepared.complete ? "complete" : "partial",
    },
  };
}

/**
 * The Git context a row carries after an observation: the observed one, or
 * the prior row's when the observation failed, or when the worktree is the
 * prior row's and its details have not resolved yet.
 */
function rowGitContext(
  previousEntry: IndexEntry | undefined,
  observed: GitContext,
): GitContext {
  if (
    previousEntry !== undefined &&
    (observed.gitObservationFailed === true ||
      (observed.gitWorktreeRoot !== null &&
        observed.gitObservedAt === null &&
        previousEntry.gitWorktreeRoot === observed.gitWorktreeRoot))
  ) {
    return {
      gitRepo: previousEntry.gitRepo,
      gitBranch: previousEntry.gitBranch,
      gitWorktreeRoot: previousEntry.gitWorktreeRoot,
      gitHeadSha: previousEntry.gitHeadSha,
      gitRemotes: previousEntry.gitRemotes,
      gitObservedAt: previousEntry.gitObservedAt,
    };
  }
  return observed;
}

/**
 * A prior row carried into this publication: its `deletedAt` dropped, its
 * Git context and source capabilities refreshed. What a session's previews
 * and completeness become is the caller's difference.
 */
function refreshedRow(
  prior: IndexEntry,
  context: GitContext,
  capabilities: DriverCapabilities,
): IndexEntry {
  const { deletedAt: _deletedAt, ...rest } = prior;
  return {
    ...rest,
    gitRepo: context.gitRepo,
    gitBranch: context.gitBranch,
    gitWorktreeRoot: context.gitWorktreeRoot,
    gitHeadSha: context.gitHeadSha,
    gitRemotes: context.gitRemotes,
    gitObservedAt: context.gitObservedAt,
    capabilities: { ...capabilities },
  };
}

export class AgentFabricTarget implements CommandTarget {
  readonly conn: AgentFabricConnection;
  readonly cells: AgentFabricCells;
  readonly #gitContext: GitContextResolver;
  readonly #graphSessionFactory?: AgentFabricGraphSessionFactory;
  readonly #mutations = new AsyncSerialQueue();
  readonly #latestObservationBySession = new Map<string, number>();
  readonly #latestCompleteObservationBySource = new Map<string, number>();
  readonly #latestDescriptorObservationBySource = new Map<string, number>();
  #nextObservationSequence = 1;
  #commandCellBound = false;
  readonly #producerQueues = new Map<string, Cell<unknown>>();
  // A subscription covers the queues bound when it began, so binding is
  // refused while one is live.
  #commandsSubscribed = false;
  #storageClaimed: boolean;

  private constructor(
    conn: AgentFabricConnection,
    cells: AgentFabricCells,
    gitContext: GitContextResolver,
    storageClaimed: boolean,
    graphSessionFactory?: AgentFabricGraphSessionFactory,
  ) {
    this.conn = conn;
    this.cells = cells;
    this.#gitContext = gitContext;
    this.#storageClaimed = storageClaimed;
    this.#graphSessionFactory = graphSessionFactory;
  }

  static async open(
    conn: AgentFabricConnection,
    gitContext = new GitContextResolver(),
    graphSessionFactory?: AgentFabricGraphSessionFactory,
  ): Promise<AgentFabricTarget> {
    const cells = await ensureAgentFabricCells(conn);
    return new AgentFabricTarget(
      conn,
      cells,
      gitContext,
      true,
      graphSessionFactory,
    );
  }

  static async connect(
    conn: AgentFabricConnection,
    gitContext = new GitContextResolver(),
    graphSessionFactory?: AgentFabricGraphSessionFactory,
  ): Promise<AgentFabricTarget> {
    const cells = await syncAgentFabricCells(conn);
    return new AgentFabricTarget(
      conn,
      cells,
      gitContext,
      false,
      graphSessionFactory,
    );
  }

  claimStorage(): Promise<void> {
    return this.#mutations.run(async () => {
      if (this.#storageClaimed) return;
      await claimAgentFabricRoots(this.conn, this.cells);
      this.#storageClaimed = true;
    });
  }

  #assertStorageClaimed(): void {
    if (!this.#storageClaimed) {
      throw new Error("agent connector storage has not been claimed");
    }
  }

  async publish(
    collected: SourceCollection[],
    options: AgentFabricPublishOptions = {},
  ): Promise<number> {
    this.#assertStorageClaimed();
    const observationSequence = options.observationSequence ??
      this.beginSessionObservation();
    if (
      !Number.isSafeInteger(observationSequence) || observationSequence < 1
    ) {
      throw new Error("observationSequence must be a positive safe integer");
    }
    return await this.#mutations.run(() =>
      this.#publish(collected, { ...options, observationSequence })
    );
  }

  /**
   * The published state of every session the complete index holds. A host
   * consults it before a collection to retain sessions whose inventory
   * summaries show nothing changed.
   */
  async publishedSessions(): Promise<
    ReadonlyMap<string, PublishedSessionState>
  > {
    this.#assertStorageClaimed();
    const index = asIndex(
      await readStableCellGraphValue(
        this.conn,
        this.cells.allIndex,
        new Map(),
        { preserveLinkFields: new Set(["manifest"]) },
      ),
      this.conn.ownerDid,
      "all",
    );
    const states = new Map<string, PublishedSessionState>();
    for (const entry of index?.sessions ?? []) {
      states.set(entry.key, {
        driver: entry.driver,
        updatedAt: entry.updatedAt ?? null,
        archived: typeof entry.archived === "boolean" ? entry.archived : null,
        active: typeof entry.active === "boolean" ? entry.active : null,
        syncStatus: entry.syncStatus,
        ...(entry.startedAs ? { startedAs: entry.startedAs } : {}),
      });
    }
    return states;
  }

  beginSessionObservation(): number {
    this.#assertStorageClaimed();
    const sequence = this.#nextObservationSequence;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("session observation sequence is exhausted");
    }
    this.#nextObservationSequence++;
    return sequence;
  }

  async validateCheckout(
    directory: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    this.#assertStorageClaimed();
    return await this.#gitContext.validateCheckout(directory, signal);
  }

  async #publish(
    collected: SourceCollection[],
    options: AgentFabricPublishOptions & { observationSequence: number },
  ): Promise<number> {
    let graphCommitStarted = false;
    const startGraphCommit = () => {
      if (graphCommitStarted) return;
      options.signal?.throwIfAborted();
      options.onCommit?.();
      graphCommitStarted = true;
    };
    const throwIfPublicationCanStop = () => {
      if (!graphCommitStarted) options.signal?.throwIfAborted();
    };
    const cancellableSignal = () =>
      graphCommitStarted ? undefined : options.signal;
    throwIfPublicationCanStop();
    const isSuperseded = (key: string) =>
      (this.#latestObservationBySession.get(key) ?? 0) >
        options.observationSequence;
    const isSourceSuperseded = (sourceId: string) =>
      (this.#latestCompleteObservationBySource.get(sourceId) ?? 0) >
        options.observationSequence;
    const isDescriptorSuperseded = (sourceId: string) =>
      (this.#latestDescriptorObservationBySource.get(sourceId) ?? 0) >
        options.observationSequence;
    const gitContext = this.#gitContext.beginObservation();
    const graphReadCache = new Map<string, Promise<unknown>>();
    const previousRecent = asIndex(
      await readStableCellGraphValue(
        this.conn,
        this.cells.index,
        graphReadCache,
        { preserveLinkFields: new Set(["manifest"]) },
      ),
      this.conn.ownerDid,
      "recent",
    );
    const previousAll = asIndex(
      await readStableCellGraphValue(
        this.conn,
        this.cells.allIndex,
        graphReadCache,
        { preserveLinkFields: new Set(["manifest"]) },
      ),
      this.conn.ownerDid,
      "all",
    );
    const discoveredCheckouts: GitContext[] = [];
    if (options.checkoutDirectories !== undefined) {
      for (const directory of options.checkoutDirectories) {
        throwIfPublicationCanStop();
        const checkout = await gitContext.resolveCheckout(
          directory,
          cancellableSignal(),
        );
        if (checkout) discoveredCheckouts.push(checkout);
      }
    }
    throwIfPublicationCanStop();
    const previousEntries = [
      ...(previousRecent?.sessions ?? []),
      ...(previousAll?.sessions ?? []),
    ];
    // The rows as the previous indexes hold them, kept apart from the working
    // rows below, which a full publication marks stale until a session is
    // seen: retention reads a session's prior row and status from here.
    const priorEntriesByKey: ReadonlyMap<string, IndexEntry> = new Map(
      previousEntries
        .map((entry): [string, IndexEntry] => [entry.key, {
          ...entry,
          gitHeadSha: typeof entry.gitHeadSha === "string"
            ? entry.gitHeadSha
            : null,
          gitRemotes: Array.isArray(entry.gitRemotes) ? entry.gitRemotes : [],
          gitObservedAt: typeof entry.gitObservedAt === "string"
            ? entry.gitObservedAt
            : null,
          archived: typeof entry.archived === "boolean" ? entry.archived : null,
          active: typeof entry.active === "boolean" ? entry.active : null,
          manifest: sessionManifestCell(this.conn, entry),
        }]),
    );
    const entriesByKey = new Map<string, IndexEntry>(
      [...priorEntriesByKey.values()].map((restored): [string, IndexEntry] => [
        restored.key,
        options.preserveUntouchedStatus || isSuperseded(restored.key) ||
          isSourceSuperseded(restored.sourceId)
          ? restored
          : { ...restored, syncStatus: "stale" },
      ]),
    );
    const sourceRows = new Map<string, Record<string, unknown>>(
      [
        ...(previousRecent?.sources ?? []),
        ...(previousAll?.sources ?? []),
      ].map((
        source,
      ) => [String(source.id), { ...source }]),
    );
    const observedSessionKeys = new Set<string>();
    const observedCompleteSourceIds = new Set<string>();
    const observedDescriptorSourceIds = new Set<string>();
    for (const source of collected) {
      if (isSourceSuperseded(source.source.id)) continue;
      const priorSourceRow = sourceRows.get(source.source.id);
      const descriptorSuperseded = isDescriptorSuperseded(source.source.id);
      const driver = descriptorSuperseded &&
          typeof priorSourceRow?.driver === "string"
        ? priorSourceRow.driver
        : source.source.driver;
      const capabilities = descriptorSuperseded &&
          isDriverCapabilities(priorSourceRow?.capabilities)
        ? priorSourceRow.capabilities
        : source.source.capabilities;
      if (!descriptorSuperseded) {
        observedDescriptorSourceIds.add(source.source.id);
      }
      const priorForSource = [...entriesByKey.values()].filter((entry) =>
        entry.sourceId === source.source.id
      );
      const currentKeys = new Set<string>();
      for await (const nativeSnapshot of source.sessions) {
        throwIfPublicationCanStop();
        const snapshot = stableFabricValue(
          nativeSnapshot,
        ) as unknown as typeof nativeSnapshot;
        const key = sessionKey(
          source.source.id,
          snapshot.summary.nativeSessionId,
        );
        currentKeys.add(key);
        if (isSuperseded(key)) continue;
        const previousEntry = entriesByKey.get(key);
        const context = rowGitContext(
          previousEntry,
          await gitContext.resolve(snapshot.summary.cwd, cancellableSignal()),
        );
        throwIfPublicationCanStop();
        const {
          gitHeadSha: _gitHeadSha,
          gitRemotes: _gitRemotes,
          gitObservedAt: _gitObservedAt,
          gitObservationFailed: _gitObservationFailed,
          ...summaryContext
        } = context;
        const publicationSnapshot = {
          ...snapshot,
          summary: {
            ...snapshot.summary,
            ...summaryContext,
          },
        };
        const graphSession = await this.#graphSessionFactory?.();
        const graphConnection = graphSession?.connection ?? this.conn;
        const publicationOutcome = await (async () => {
          if (
            graphConnection.spaceDid !== this.conn.spaceDid ||
            graphConnection.ownerDid !== this.conn.ownerDid
          ) {
            throw new Error(
              "agent graph session must use the target space and owner",
            );
          }
          return await publishSessionGraph(
            graphConnection,
            prepareSessionHeader(source.source.id, publicationSnapshot),
            publicationSnapshot.events,
            driver,
            context,
            previousEntry,
            startGraphCommit,
          );
        })().then(
          (value) => ({ ok: true as const, value }),
          (error) => ({ ok: false as const, error }),
        );
        try {
          await graphSession?.release();
        } catch (releaseError) {
          if (!publicationOutcome.ok) {
            throw new AggregateError(
              [publicationOutcome.error, releaseError],
              "agent session publication and graph storage release failed",
            );
          }
          throw releaseError;
        }
        if (!publicationOutcome.ok) {
          throw publicationOutcome.error;
        }
        const publication = publicationOutcome.value;
        const prepared = publication.prepared;
        observedSessionKeys.add(prepared.key);
        if (publication.indexEntry === undefined) {
          if (previousEntry === undefined) {
            throw new Error("unchanged session has no prior index entry");
          }
          entriesByKey.set(prepared.key, {
            ...refreshedRow(previousEntry, context, capabilities),
            recentMessages: recentSessionMessages(
              prepared.normalizedMessages,
            ),
            syncStatus: prepared.complete ? "complete" : "partial",
          });
          continue;
        }
        const entry = publication.indexEntry;
        // The driver pairs a session with the desktop start that made it in
        // its own memory, which a host restart empties; the pairing the row
        // was published with is kept across that, so a session the
        // workbench attached through its start stays attached.
        if (entry.startedAs === undefined && previousEntry?.startedAs) {
          entry.startedAs = previousEntry.startedAs;
        }
        entry.manifest = sessionManifestCell(this.conn, entry);
        entry.capabilities = { ...capabilities };
        entriesByKey.set(entry.key, entry);
      }
      const outcome = "outcome" in source ? source.outcome : {
        errors: source.errors,
        complete: source.complete,
        sessionCount: source.sessions.length,
        consumed: true,
      };
      // A retained session keeps the row and graph its last read produced,
      // taking the refreshed source capabilities and the checkout's current
      // Git context, observed the way a read session's is: a branch switch
      // or a new commit reaches the row (and the checkout index built from
      // it) without the transcript being read again. The manifest inside the
      // graph keeps the context of its last read. Retention rests on a
      // complete copy being there; where one is not, the retention is an
      // error like a failed read: the inventory cannot vouch for the session
      // and stops being complete, so nothing absent from it is deleted on its
      // word, and the session's row, where there is one, is marked partial
      // below with the other errors. A session this publication read has
      // its outcome already; a retention naming it too is not applied.
      let sourceComplete = outcome.complete;
      const sourceErrors = [...outcome.errors];
      let retainedListed = 0;
      for (const summary of source.retained ?? []) {
        throwIfPublicationCanStop();
        const key = sessionKey(source.source.id, summary.nativeSessionId);
        if (currentKeys.has(key)) continue;
        currentKeys.add(key);
        retainedListed++;
        if (isSuperseded(key)) continue;
        const prior = priorEntriesByKey.get(key);
        if (prior === undefined || prior.syncStatus !== "complete") {
          sourceComplete = false;
          sourceErrors.push({
            nativeSessionId: summary.nativeSessionId,
            message: "retained session has no complete published copy",
          });
          continue;
        }
        const context = rowGitContext(
          prior,
          await gitContext.resolve(summary.cwd, cancellableSignal()),
        );
        throwIfPublicationCanStop();
        entriesByKey.set(key, {
          ...refreshedRow(prior, context, capabilities),
          syncStatus: "complete",
        });
        observedSessionKeys.add(key);
      }
      // Reading sessions and finishing inventory can change driver controls.
      // Every row takes the final capabilities, including rows read early.
      for (const entry of entriesByKey.values()) {
        if (
          entry.sourceId !== source.source.id || isSuperseded(entry.key)
        ) continue;
        entriesByKey.set(entry.key, {
          ...entry,
          capabilities: { ...capabilities },
        });
      }
      if (sourceComplete) {
        observedCompleteSourceIds.add(source.source.id);
        for (const prior of priorForSource) {
          if (!currentKeys.has(prior.key) && !isSuperseded(prior.key)) {
            const current = entriesByKey.get(prior.key) ?? prior;
            entriesByKey.set(prior.key, {
              ...current,
              syncStatus: "deleted",
              deletedAt: current.deletedAt ?? new Date().toISOString(),
            });
            observedSessionKeys.add(prior.key);
          }
        }
      } else {
        for (const error of sourceErrors) {
          if (!error.nativeSessionId) continue;
          const key = sessionKey(source.source.id, error.nativeSessionId);
          if (isSuperseded(key)) continue;
          const prior = entriesByKey.get(key);
          if (prior) {
            entriesByKey.set(key, { ...prior, syncStatus: "partial" });
            observedSessionKeys.add(key);
          }
        }
      }
      if (options.preserveUntouchedStatus && priorSourceRow) {
        sourceRows.set(source.source.id, {
          ...priorSourceRow,
          id: source.source.id,
          driver,
          capabilities,
        });
      } else {
        sourceRows.set(source.source.id, {
          id: source.source.id,
          driver,
          capabilities,
          complete: sourceComplete,
          sessionCount: outcome.sessionCount + retainedListed,
          errors: sourceErrors,
        });
      }
    }
    throwIfPublicationCanStop();
    const generatedAt = new Date().toISOString();
    const generation = Math.max(
      previousRecent?.generation ?? 0,
      previousAll?.generation ?? 0,
    ) + 1;
    const sources = [...sourceRows.values()].sort((left, right) =>
      String(left.id).localeCompare(String(right.id))
    );
    const sessions = [...entriesByKey.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    );
    const activeSessions = sessions.filter((session) =>
      session.syncStatus !== "deleted"
    );
    const deletedSessions = sessions.filter((session) =>
      session.syncStatus === "deleted"
    );
    const buckets = sessionIndexBuckets(activeSessions, generatedAt);
    const allSessions = [...buckets.all, ...deletedSessions].sort((
      left,
      right,
    ) => left.key.localeCompare(right.key));
    const checkouts = options.checkoutDirectories === undefined
      ? checkoutEntries(
        activeSessions,
        storedCheckoutObservations(previousRecent, previousAll),
      )
      : checkoutEntries(activeSessions, discoveredCheckouts);
    const recentIndex: AgentSessionIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: this.conn.ownerDid,
      bucket: "recent",
      generatedAt,
      generation,
      totalSessionCount: activeSessions.length,
      olderSessionCount: buckets.olderCount,
      sources,
      checkouts,
      sessions: buckets.recent,
    };
    const allIndex: AgentSessionIndex = {
      schema: AGENT_CONNECTOR_SCHEMAS.sessionIndex,
      ownerDid: this.conn.ownerDid,
      bucket: "all",
      generatedAt,
      generation,
      totalSessionCount: activeSessions.length,
      olderSessionCount: buckets.olderCount,
      sources,
      checkouts,
      sessions: allSessions,
    };
    const indexChildScope = childScope(
      this.conn.spaceDid,
      this.conn.ownerDid,
      "session-index",
    );
    const recentIndexPlan = await planStableArrayCells(
      recentIndex,
      indexChildScope,
    );
    const allIndexPlan = await planStableArrayCells(
      allIndex,
      indexChildScope,
    );
    throwIfPublicationCanStop();
    startGraphCommit();
    await pushStableCellGraph(this.conn, [
      graphEntry(this.cells.index, recentIndexPlan),
      graphEntry(this.cells.allIndex, allIndexPlan),
    ]);
    for (const key of observedSessionKeys) {
      this.#latestObservationBySession.set(
        key,
        options.observationSequence,
      );
    }
    for (const sourceId of observedCompleteSourceIds) {
      this.#latestCompleteObservationBySource.set(
        sourceId,
        options.observationSequence,
      );
    }
    for (const sourceId of observedDescriptorSourceIds) {
      this.#latestDescriptorObservationBySource.set(
        sourceId,
        options.observationSequence,
      );
    }
    return activeSessions.length;
  }

  async publishHealth(value: Record<string, unknown>): Promise<void> {
    this.#assertStorageClaimed();
    return await this.#mutations.run(() => this.#publishHealth(value));
  }

  async #publishHealth(value: Record<string, unknown>): Promise<void> {
    const healthValue = {
      ...value,
      schema: AGENT_CONNECTOR_SCHEMAS.health,
      ownerDid: this.conn.ownerDid,
    };
    const plan = await planStableArrayCells(
      healthValue,
      childScope(this.conn.spaceDid, this.conn.ownerDid, "health"),
    );
    await pushStableCellGraph(
      this.conn,
      [graphEntry(this.cells.health, plan)],
    );
  }

  commandCellId(): string {
    this.#assertStorageClaimed();
    return stableCellId(this.cells.commands.resolveAsCell());
  }

  receiptCellId(): string {
    this.#assertStorageClaimed();
    return stableCellId(this.cells.receipts);
  }

  async bindCommandCell(
    cell: Cell<unknown>,
    writerAuthorization: unknown,
  ): Promise<void> {
    this.#assertStorageClaimed();
    const suppliedLink = cell.getAsNormalizedFullLink();
    const expectedLink = this.cells.commands.getAsNormalizedFullLink();
    if (
      suppliedLink.space !== expectedLink.space ||
      suppliedLink.id !== expectedLink.id ||
      suppliedLink.scope !== expectedLink.scope ||
      suppliedLink.path.length !== expectedLink.path.length ||
      suppliedLink.path.some((part, index) => part !== expectedLink.path[index])
    ) {
      throw new Error("command cell is not the connector's owner-scoped queue");
    }
    await this.#bindQueue(cell, writerAuthorization, "owner");
    this.cells.commands = cell;
    this.#commandCellBound = true;
  }

  /**
   * Creates the queue for the producer pattern `producerId`, protects it for
   * the owner with the producer's verified command-sending handler as its only
   * writer, and adds it to the queues commands are read from. Returns the
   * bound cell, which the producer piece receives as its `commands` input.
   */
  async bindProducerCommandCell(
    producerId: string,
    writerAuthorization: unknown,
  ): Promise<Cell<unknown>> {
    this.#assertStorageClaimed();
    const cell = this.conn.runtime.getCell(
      this.conn.spaceDid,
      producerCommandsCause(
        this.conn.spaceDid,
        this.conn.ownerDid,
        producerId,
      ),
      agentOwnerSchema(this.conn.ownerDid, false),
    );
    if (this.#producerQueues.has(producerId)) {
      throw new Error(`command producer is already bound: ${producerId}`);
    }
    await cell.sync();
    await this.conn.runtime.storageManager.synced();
    await this.#bindQueue(cell, writerAuthorization, `producer ${producerId}`);
    this.#producerQueues.set(producerId, cell);
    return cell;
  }

  commandsAreBound(): boolean {
    this.#assertStorageClaimed();
    return this.#commandCellBound || this.#producerQueues.size > 0;
  }

  /** Every bound queue with the producer it belongs to; the owner's has none. */
  #boundQueues(): Array<{ producer?: string; cell: Cell<unknown> }> {
    return [
      ...(this.#commandCellBound ? [{ cell: this.cells.commands }] : []),
      ...[...this.#producerQueues].map(([producer, cell]) => ({
        producer,
        cell,
      })),
    ];
  }

  #assertCommandCellBound(): void {
    if (!this.#commandCellBound && this.#producerQueues.size === 0) {
      throw new Error("no command queue has been bound");
    }
  }

  async #bindQueue(
    cell: Cell<unknown>,
    writerAuthorization: unknown,
    label: string,
  ): Promise<void> {
    if (this.#commandsSubscribed) {
      throw new Error(
        `${label} queue cannot be bound while commands are subscribed`,
      );
    }
    const authorization = isRecord(writerAuthorization) &&
        isRecord(writerAuthorization.__ctWriterIdentityOf)
      ? writerAuthorization.__ctWriterIdentityOf
      : undefined;
    if (
      !authorization || typeof authorization.file !== "string" ||
      typeof authorization.moduleIdentity !== "string" ||
      !Array.isArray(authorization.path) ||
      !authorization.path.every((part) => typeof part === "string")
    ) {
      throw new Error("command writer authorization is invalid");
    }
    const tx = this.conn.runtime.edit();
    tx.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: authorization.moduleIdentity,
      sourceFile: authorization.file,
      bindingPath: authorization.path as string[],
    });
    try {
      const hasOwnerProtection = cellHasOwnerProtection(
        tx,
        cell,
        this.conn.ownerDid,
      );
      const protectedCell = cell.withTx(tx);
      const existing = protectedCell.getRawUntyped({ frozen: false });
      if (
        !hasOwnerProtection && existing !== undefined &&
        (!Array.isArray(existing) || existing.length > 0)
      ) {
        throw new Error(
          "refusing to adopt a populated command queue without its owner label",
        );
      }
      if (existing === undefined) protectedCell.setRawUntyped([]);
      protectedCell.asSchema(
        agentPrincipalSchema(this.conn.ownerDid, writerAuthorization),
      )
        .applyCfcSchemaToExistingValue();
      tx.prepareCfc();
    } catch (error) {
      tx.abort(error);
      throw error;
    }
    const result = await tx.commit();
    if (result.error) {
      throw new Error(
        `could not protect the ${label} command cell: ${result.error.message}`,
        { cause: result.error },
      );
    }
  }

  async readReceipt(
    commandId: string,
    producer?: string,
  ): Promise<AgentSessionCommandReceipt | undefined> {
    this.#assertStorageClaimed();
    const cell = this.conn.runtime.getCell(
      this.conn.spaceDid,
      commandReceiptCause(
        this.conn.spaceDid,
        this.conn.ownerDid,
        commandId,
        producer,
      ),
      agentOwnerSchema(this.conn.ownerDid),
    );
    await cell.sync();
    await this.conn.runtime.storageManager.synced();
    const claim = this.conn.runtime.edit();
    claim.setCfcImplementationIdentity({
      kind: "builtin",
      builtinId: AGENT_CONNECTOR_WRITER_ID,
    });
    try {
      if (
        claim.readValueOrThrow(cell.getAsNormalizedFullLink()) === undefined
      ) {
        claim.abort();
        return undefined;
      }
      if (!cellHasOwnerProtection(claim, cell, this.conn.ownerDid)) {
        throw new Error(
          `refusing to trust an unprotected command receipt: ${commandId}`,
        );
      }
      cell.withTx(claim).applyCfcSchemaToExistingValue();
      claim.prepareCfc();
    } catch (error) {
      claim.abort(error);
      throw error;
    }
    const claimed = await claim.commit();
    if (claimed.error) {
      throw new Error(
        `could not verify command receipt ownership: ${claimed.error.message}`,
        { cause: claimed.error },
      );
    }
    const value = await readStableCellGraphValue(this.conn, cell);
    if (value === undefined || value === null) {
      throw new Error(
        `command receipt disappeared while reading: ${commandId}`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`command receipt is not an object: ${commandId}`);
    }
    const receipt = parseCommandReceipt(commandId, value);
    if (receipt.ownerDid !== this.conn.ownerDid) {
      throw new Error(`command receipt belongs to another owner: ${commandId}`);
    }
    return receipt;
  }

  /**
   * Subscribes to every bound queue. The callback receives one queue's
   * commands at a time with that queue's producer, `undefined` for the
   * owner's queue, which is what qualifies each command's identity.
   */
  async subscribeCommands(
    callback: (commands: unknown[], producer?: string) => void,
  ): Promise<Cancel> {
    this.#assertStorageClaimed();
    this.#assertCommandCellBound();
    const cancels: Cancel[] = [];
    try {
      for (const { producer, cell } of this.#boundQueues()) {
        cancels.push(
          await subscribeStableActions(
            this.conn,
            cell,
            (commands) => callback(commands, producer),
          ),
        );
      }
    } catch (error) {
      for (const cancel of cancels) cancel();
      throw error;
    }
    this.#commandsSubscribed = true;
    return () => {
      this.#commandsSubscribed = false;
      for (const cancel of cancels) cancel();
    };
  }

  /**
   * Every bound queue's pending commands, in binding order and without their
   * queues: a diagnostic read. The worker learns each command's queue from the
   * subscription.
   */
  async pollCommands(): Promise<unknown[]> {
    this.#assertStorageClaimed();
    this.#assertCommandCellBound();
    const values: unknown[] = [];
    for (const { cell } of this.#boundQueues()) {
      values.push(...await readStableActions(this.conn, cell));
    }
    return values;
  }

  async publishReceipt(
    receipt: AgentSessionCommandReceipt,
  ): Promise<void> {
    this.#assertStorageClaimed();
    return await this.#mutations.run(() => {
      const parsed = parseCommandReceipt(receipt.commandId, receipt);
      if (parsed.ownerDid !== this.conn.ownerDid) {
        throw new Error(
          `command receipt belongs to another owner: ${receipt.commandId}`,
        );
      }
      return this.#publishReceipt(parsed);
    });
  }

  async #publishReceipt(
    receipt: AgentSessionCommandReceipt,
  ): Promise<void> {
    this.#assertStorageClaimed();
    const cell = this.conn.runtime.getCell(
      this.conn.spaceDid,
      commandReceiptCause(
        this.conn.spaceDid,
        this.conn.ownerDid,
        receipt.commandId,
        receipt.producer,
      ),
      agentOwnerSchema(this.conn.ownerDid),
    );
    const receiptPlan = await planStableArrayCells(
      receipt,
      childScope(this.conn.spaceDid, this.conn.ownerDid, "command-receipt", {
        commandId: receipt.commandId,
        ...(receipt.producer === undefined
          ? {}
          : { producer: receipt.producer }),
      }),
    );
    await pushStableCellGraph(
      this.conn,
      [graphEntry(cell, receiptPlan)],
    );
    const prior = await readStableCellGraphValue(
      this.conn,
      this.cells.receipts,
    );
    let priorReceipts: Array<Record<string, unknown>> = [];
    if (prior !== undefined && prior !== null) {
      priorReceipts = validatedReceiptIndexRows(this.conn, prior);
    }
    const identity = commandIdentity(receipt.commandId, receipt.producer);
    const receipts = priorReceipts
      .filter((item) =>
        item && typeof item === "object" &&
        commandIdentity(
            String((item as Record<string, unknown>).commandId),
            (item as Record<string, unknown>).producer as string | undefined,
          ) !== identity
      );
    receipts.push({
      commandId: receipt.commandId,
      ownerDid: receipt.ownerDid,
      sourceId: receipt.sourceId,
      nativeSessionId: receipt.nativeSessionId,
      ...(receipt.producer === undefined ? {} : { producer: receipt.producer }),
      status: receipt.status,
      updatedAt: receipt.completedAt ?? receipt.claimedAt ??
        new Date().toISOString(),
      ...(receipt.error ? { error: receipt.error } : {}),
      receipt: fullLink(cell),
    });
    const receiptIndexValue = {
      schema: AGENT_CONNECTOR_SCHEMAS.commandReceipts,
      ownerDid: this.conn.ownerDid,
      receipts: receipts.slice(-200),
      updatedAt: new Date().toISOString(),
    };
    const receiptIndexPlan = await planStableArrayCells(
      receiptIndexValue,
      childScope(
        this.conn.spaceDid,
        this.conn.ownerDid,
        "command-receipt-index",
      ),
    );
    await pushStableCellGraph(
      this.conn,
      [graphEntry(this.cells.receipts, receiptIndexPlan)],
    );
  }

  async refreshSession(
    driver: AgentDriver,
    nativeSessionId: string,
  ): Promise<void> {
    const observationSequence = this.beginSessionObservation();
    const snapshot = await driver.readSession(nativeSessionId);
    await this.publish(
      [{
        source: driver.source,
        sessions: [snapshot],
        errors: [],
        complete: false,
      }],
      { preserveUntouchedStatus: true, observationSequence },
    );
  }
}
