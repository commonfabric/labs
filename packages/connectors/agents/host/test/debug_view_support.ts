// Shared fixtures for the agent-sessions debug view tests. The suite is split
// across several files so that the workspace test sharder, which distributes
// whole files, can spread its cost; everything those files have in common
// lives here.

import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import type {
  NativeSessionSnapshot,
  SourceDescriptor,
} from "@commonfabric/agents-connector/types";
import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { pieceId } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { compileAndSavePattern, Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  type Options,
} from "@commonfabric/runner/storage/cache.deno";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { fromFileUrl } from "@std/path";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import type { RawDataProvenance } from "../../debug-view/main.tsx";
import { createBuilder } from "../../../../runner/src/builder/factory.ts";
import type { Cell } from "../../../../runner/src/builder/types.ts";
import { commandWriterAuthorization } from "../src/command-authorization.ts";
import {
  defaultDebugPatternLocation,
  protectOwnerDebugResult,
} from "../src/debug-view.ts";

export const identity = await Identity.fromPassphrase(
  "agent sessions debug deployment test",
);
export const EMULATED_AUDIENCE = "did:key:z6Mk-runner-emulated-memory";
export const SHALLOW_PIECE_LIST_SCHEMA = internSchema({
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  default: [],
});
export const SHALLOW_PIECE_SCHEMA = internSchema({
  type: "object",
  properties: {},
});
export interface DebugArgumentSchema {
  $defs?: {
    SessionIndexInput?: {
      properties?: {
        sources?: { items?: CellBoundarySchema };
        sessions?: { items?: CellBoundarySchema };
      };
    };
    PublishedSessionInput?: {
      properties?: {
        active?: { anyOf?: Array<{ type?: string | string[] }> };
        archived?: { anyOf?: Array<{ type?: string | string[] }> };
      };
      required?: string[];
    };
  };
}

export interface CellBoundarySchema {
  asCell?: string[];
  anyOf?: CellBoundarySchema[];
}

export class SharedServerStorageManager extends EmulatedStorageManager {
  static override connectTo(
    server: MemoryV2Server.Server,
    options: Omit<Options, "memoryHost" | "spaceHostMap">,
  ): SharedServerStorageManager {
    const manager = new SharedServerStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      () => server,
    );
    manager.#sharedServer = server;
    return manager;
  }

  #sharedServer!: MemoryV2Server.Server;

  protected override server(): MemoryV2Server.Server {
    return this.#sharedServer;
  }
}

export class ObservedServer extends MemoryV2Server.Server {
  readonly returnedEntityIds: string[] = [];

  override async evaluateGraphQuery(
    ...args: Parameters<MemoryV2Server.Server["evaluateGraphQuery"]>
  ) {
    const result = await super.evaluateGraphQuery(...args);
    this.returnedEntityIds.push(...result.entities.map((entity) => entity.id));
    return result;
  }
}

export function newSharedServer(): ObservedServer {
  return new ObservedServer({
    authorizeSessionOpen: authorizeLoopbackSessionOpen,
    sessionOpenAuth: { audience: EMULATED_AUDIENCE },
  });
}

export function sourceDescriptor(): SourceDescriptor {
  return {
    id: "codex:test",
    driver: "codex-app-server",
    capabilities: {
      inventory: true,
      read: true,
      prompt: true,
      cancel: true,
      rename: true,
      setMode: true,
      setConfigOption: false,
      modes: ["default", "plan"],
    },
  };
}

export function sessionSnapshot(
  sequence = 1,
  titlePrefix = "Sharded session",
): NativeSessionSnapshot {
  const nativeSessionId = `session-${sequence}`;
  return {
    summary: {
      nativeSessionId,
      title: `${titlePrefix} ${sequence}`,
      cwd: "/worktree",
      gitRepo: "example/repo",
      gitBranch: "main",
      gitWorktreeRoot: "/worktree",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: new Date().toISOString(),
      archived: false,
      active: true,
      raw: { id: nativeSessionId, labels: ["debug"] },
    },
    events: [{ type: "message", content: [{ text: "hello" }] }],
    normalizedMessages: [{
      id: "message-1",
      role: "user",
      kind: "message",
      createdAt: "2026-07-20T00:00:00.000Z",
      textPreview: "hello",
      rawIndex: 0,
    }],
    complete: true,
    revision: "1",
  };
}

export function countSessionRawDataLinks(
  value: unknown,
): number {
  const table = publishedSessionTable(value);
  return table === undefined ? 0 : cellLinkCells(table, "Raw data").length;
}

export function materializeCell(value: unknown): unknown {
  if (
    isObjectOrArray(value) && "get" in value &&
    typeof (value as { get?: unknown }).get === "function"
  ) {
    return (value as { get: () => unknown }).get();
  }
  return value;
}

export interface RenderedNode {
  name?: unknown;
  props?: Record<string, unknown>;
  children?: unknown;
}

export function renderedNodes(
  value: unknown,
  result: RenderedNode[] = [],
  visited = new Set<object>(),
): RenderedNode[] {
  const materialized = materializeCell(value);
  if (!isObjectOrArray(materialized)) return result;
  if (visited.has(materialized)) return result;
  visited.add(materialized);
  if (Array.isArray(materialized)) {
    for (const child of materialized) renderedNodes(child, result, visited);
    return result;
  }
  const node = materialized as RenderedNode;
  if (typeof node.name === "string") result.push(node);
  renderedNodes(node.children, result, visited);
  return result;
}

export function renderedText(
  value: unknown,
  visited = new Set<object>(),
): string {
  const materialized = materializeCell(value);
  if (typeof materialized === "string" || typeof materialized === "number") {
    return String(materialized);
  }
  if (!isObjectOrArray(materialized)) return "";
  if (visited.has(materialized)) return "";
  visited.add(materialized);
  if (Array.isArray(materialized)) {
    return materialized.map((child) => renderedText(child, visited)).join("");
  }
  return renderedText((materialized as RenderedNode).children, visited);
}

export function publishedSessionTable(
  value: unknown,
): RenderedNode | undefined {
  return renderedNodes(value).find((node) =>
    node.name === "cf-table" &&
    renderedText(node.children).includes("Status") &&
    renderedText(node.children).includes("Idle for") &&
    renderedText(node.children).includes("Worktree")
  );
}

export function publishedSessionTableRows(value: unknown): RenderedNode[] {
  const table = publishedSessionTable(value);
  return table === undefined
    ? []
    : renderedNodes(table.children).filter((node) => node.name === "tr");
}

export function renderedTableCells(row: RenderedNode): string[] {
  return renderedNodes(row.children)
    .filter((node) => node.name === "td" || node.name === "th")
    .map((node) => renderedText(node.children));
}

export function tableWithHeaders(
  value: unknown,
  expectedHeaders: string[],
): RenderedNode | undefined {
  return renderedNodes(value).find((node) => {
    if (node.name !== "cf-table") return false;
    const firstRow = renderedNodes(node.children).find((child) =>
      child.name === "tr"
    );
    if (firstRow === undefined) return false;
    const headers = renderedTableCells(firstRow);
    return headers.length === expectedHeaders.length &&
      headers.every((header, index) => header === expectedHeaders[index]);
  });
}

export function tableRowWithFirstCell(
  table: RenderedNode,
  expected: string,
): RenderedNode | undefined {
  return renderedNodes(table.children)
    .filter((node) => node.name === "tr")
    .slice(1)
    .find((row) => renderedTableCells(row)[0] === expected);
}

export function renderedAriaSortValues(row: RenderedNode): string[] {
  return renderedNodes(row.children)
    .filter((node) => node.name === "th")
    .map((node) => materializeCell(node.props?.["aria-sort"]))
    .filter((value): value is string => typeof value === "string");
}

export function cellLinkIds(value: unknown, label: string): string[] {
  return cellLinkCells(value, label).flatMap((cell) => {
    const link = cell.resolveAsCell().getAsNormalizedFullLink();
    return [`${link.space}/${link.id}/${JSON.stringify(link.path)}`];
  });
}

export function cellLinkCells(value: unknown, label: string): Cell<unknown>[] {
  return renderedNodes(value).flatMap((node) => {
    if (
      node.name !== "cf-cell-link" ||
      materializeCell(node.props?.label) !== label
    ) {
      return [];
    }
    const cell = node.props?.["$cell"] as Cell<unknown> | undefined;
    return typeof cell?.getAsNormalizedFullLink === "function" ? [cell] : [];
  });
}

export async function loadRawDataView(
  runtime: Runtime,
  link: Cell<unknown>,
): Promise<unknown> {
  const view = link.resolveAsCell();
  await runtime.start(view);
  return await readRawDataView(runtime, view);
}

export async function readRawDataView(
  runtime: Runtime,
  view: Cell<unknown>,
): Promise<unknown> {
  const ui = view.key("$UI");
  await ui.pull();
  await runtime.settled();
  await ui.pull();
  const pre = renderedNodes(ui.get()).find((node) => node.name === "pre");
  return JSON.parse(renderedText(pre?.children));
}

export async function readRawDataProvenance(
  runtime: Runtime,
  link: Cell<unknown>,
): Promise<{ provenance: RawDataProvenance; rendered: string }> {
  const view = link.resolveAsCell();
  await view.pull();
  const ui = view.key("$UI");
  const provenance = view.key("provenance");
  await ui.pull();
  await provenance.pull();
  await runtime.settled();
  await ui.pull();
  await provenance.pull();
  return {
    provenance: provenance.get() as RawDataProvenance,
    rendered: renderedText(ui.get()),
  };
}

export async function installDefaultPattern(
  manager: PiecesController,
): Promise<Cell<unknown>> {
  const { handler, pattern } = createBuilder().commonfabric;
  const addPiece = handler<
    { piece: Cell<unknown> },
    { pieceRegistry: Cell<Cell<unknown>[]> }
  >(
    {
      type: "object",
      properties: {
        piece: { type: "unknown", asCell: ["cell"] },
      },
      required: ["piece"],
    },
    {
      type: "object",
      properties: {
        pieceRegistry: {
          ...SHALLOW_PIECE_LIST_SCHEMA,
          asCell: ["cell"],
        },
      },
      required: ["pieceRegistry"],
    },
    ({ piece }, { pieceRegistry }) => {
      pieceRegistry.push(piece);
    },
  );
  const defaultPattern = pattern<{
    pieceRegistry: Cell<unknown>[];
  }>(
    ({ pieceRegistry }) => ({
      pieceRegistry,
      addPiece: addPiece({ pieceRegistry }),
    }),
  );
  const piece = await manager.runPersistent(
    defaultPattern,
    { pieceRegistry: [] },
    "agents-host-debug-test-default-pattern",
  );
  await manager.linkDefaultPattern(piece);
  await manager.runtime.idle();
  await manager.synced();
  return piece;
}

export async function registeredPieceIds(
  defaultPattern: Cell<unknown>,
): Promise<string[]> {
  const slot = defaultPattern.asSchema(undefined).key("pieceRegistry");
  if (slot.getRaw() === undefined) return [];
  const list = slot.resolveAsCell().asSchema(
    SHALLOW_PIECE_LIST_SCHEMA,
  ) as Cell<Cell<unknown>[]>;
  await list.sync();
  return (list.get() ?? []).flatMap((piece) => {
    const id = pieceId(piece);
    return id ? [id] : [];
  });
}

export async function deployDebugPiece(
  manager: PiecesController,
  target: AgentFabricTarget,
  cause?: string,
) {
  const location = defaultDebugPatternLocation();
  const program = await resolveLocalProgram(
    (resolver) => manager.runtime.harness.resolve(resolver),
    { main: location.mainPath, root: location.rootPath },
  );
  const pattern = await compileAndSavePattern(manager.runtime, program, {
    space: manager.getSpace(),
  });
  const writerAuthorization = commandWriterAuthorization(pattern);
  if (writerAuthorization === undefined) {
    throw new Error("debug command writer authorization is missing");
  }
  await target.bindCommandCell(target.cells.commands, writerAuthorization);
  const piece = await manager.create(
    program,
    {
      input: {
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
      },
    },
    cause,
  );
  const resultCell = await piece.result.getCell();
  await protectOwnerDebugResult(manager, resultCell, target.conn.ownerDid);
  return piece;
}

export async function deployRawDataPiece(
  manager: PiecesController,
  manifest: AgentFabricTarget["cells"]["index"],
) {
  const location = defaultDebugPatternLocation();
  const program = await resolveLocalProgram(
    (resolver) => manager.runtime.harness.resolve(resolver),
    {
      main: fromFileUrl(
        new URL("./fixtures/raw-session-view.tsx", import.meta.url),
      ),
      root: location.rootPath,
    },
  );
  return await manager.create(program, {
    input: {
      manifest,
      sourceId: "codex:test",
      nativeSessionId: "session-1",
    },
  });
}
