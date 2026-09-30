import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import {
  type Cancel,
  type Cell,
  cfcAtom,
  type JSONSchema,
  type MemorySpace,
  type Runtime,
} from "@commonfabric/runner";
import { readStoredCfcMetadata } from "@commonfabric/runner/cfc";
import { addressKey } from "@commonfabric/runner/shared";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { stableFabricValue } from "./stable-fabric-value.ts";
import { setCfcImplementationIdentity } from "@commonfabric/runner/cfc/trust-authority";

export interface AgentFabricConnection {
  runtime: Runtime;
  spaceDid: MemorySpace;
  ownerDid: string;
}

export const AGENT_CONNECTOR_WRITER_ID = "commonfabric.agents-connector";

export function cellHasOwnerConfidentiality(
  tx: Parameters<typeof readStoredCfcMetadata>[0],
  cell: Cell<unknown>,
  ownerDid: string,
): boolean {
  const ownerAtom = cfcAtom.user(ownerDid);
  return readStoredCfcMetadata(
    tx,
    cell.getAsNormalizedFullLink(),
  )?.labelMap.entries.some((entry) =>
    entry.label.confidentiality?.some((clause) =>
      isObjectNotArray(clause) && "type" in clause &&
      clause.type === ownerAtom.type && "subject" in clause &&
      clause.subject === ownerDid
    )
  ) ?? false;
}

export function cellHasOwnerProtection(
  tx: Parameters<typeof readStoredCfcMetadata>[0],
  cell: Cell<unknown>,
  ownerDid: string,
): boolean {
  const metadata = readStoredCfcMetadata(
    tx,
    cell.getAsNormalizedFullLink(),
  );
  const ownerAtom = cfcAtom.user(ownerDid);
  return metadata?.labelMap.entries.some((entry) =>
    entry.path.length === 0 &&
    entry.label.confidentiality?.some((clause) =>
        isObjectNotArray(clause) && "type" in clause &&
        clause.type === ownerAtom.type && "subject" in clause &&
        clause.subject === ownerDid
      ) === true &&
    entry.label.integrity?.some((atom) =>
        isObjectOrArray(atom) &&
        "kind" in atom && atom.kind === "represents-principal" &&
        "subject" in atom && atom.subject === ownerDid
      ) === true
  ) ?? false;
}

export function agentPrincipalSchema(
  ownerDid: string,
  writerAuthorization: unknown,
): JSONSchema {
  return {
    ifc: {
      confidentiality: [cfcAtom.user(ownerDid)],
      ownerPrincipal: ownerDid,
      addIntegrity: [{
        kind: "represents-principal",
        subject: ownerDid,
      }],
      writeAuthorizedBy: writerAuthorization,
    },
  } as JSONSchema;
}

export function agentOwnerSchema(
  ownerDid: string,
  connectorWritable = true,
): JSONSchema {
  return {
    ifc: {
      confidentiality: [cfcAtom.user(ownerDid)],
      ...(connectorWritable
        ? {
          ownerPrincipal: ownerDid,
          addIntegrity: [{
            kind: "represents-principal",
            subject: ownerDid,
          }],
          writeAuthorizedBy: [AGENT_CONNECTOR_WRITER_ID],
        }
        : {}),
    },
  };
}

export type StableCellMaterializer = (
  cause: unknown,
  value: unknown,
) => Cell<unknown>;

export interface StableCellGraphEntry {
  cell: Cell<unknown>;
  value: (
    materializeCell: StableCellMaterializer,
  ) => Record<string, unknown>;
}

const HYDRATION_BATCH_SIZE = 50;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isObjectNotArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function commitErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Fabric transaction commit failed";
}

export function stableCellId(cell: Cell<unknown>): string {
  const id = cell.getAsNormalizedFullLink().id!;
  return id.startsWith("of:") ? id.slice(3) : id;
}

export async function pushStableCellGraph(
  connection: AgentFabricConnection,
  entries: ReadonlyArray<StableCellGraphEntry>,
): Promise<void> {
  if (entries.length === 0) return;
  const writes: Array<{ cell: Cell<unknown>; value: unknown }> = [];
  const materializeCell: StableCellMaterializer = (cause, value) => {
    const cell = connection.runtime.getCell(
      connection.spaceDid,
      cause,
      agentOwnerSchema(connection.ownerDid),
    );
    writes.push({ cell, value });
    return cell;
  };
  for (const entry of entries) {
    writes.push({ cell: entry.cell, value: entry.value(materializeCell) });
  }
  const ownerSchema = agentOwnerSchema(connection.ownerDid);
  const protectedCells = new Map<string, Cell<unknown>>();
  const protectedWrites = writes.map(({ cell, value }) => {
    const link = cell.getAsNormalizedFullLink();
    const key = addressKey(link);
    let protectedCell = protectedCells.get(key);
    if (protectedCell === undefined) {
      protectedCell = cell.asSchema(ownerSchema);
      protectedCells.set(key, protectedCell);
    }
    return { cell: protectedCell, value };
  });
  const uniqueCells = [...protectedCells.values()];
  for (
    let offset = 0;
    offset < uniqueCells.length;
    offset += HYDRATION_BATCH_SIZE
  ) {
    await Promise.all(
      uniqueCells.slice(offset, offset + HYDRATION_BATCH_SIZE).map((cell) =>
        cell.sync()
      ),
    );
  }

  const tx = connection.runtime.edit();
  setCfcImplementationIdentity(tx, {
    kind: "builtin",
    builtinId: AGENT_CONNECTOR_WRITER_ID,
  });
  const writtenCells = new Set<string>();
  try {
    const writeCellValue = (cell: Cell<unknown>, value: unknown) => {
      const link = cell.getAsNormalizedFullLink();
      const priorValue = tx.readValueOrThrow(link);
      const cellKey = addressKey(link);
      if (
        priorValue !== undefined &&
        !writtenCells.has(cellKey) &&
        !cellHasOwnerProtection(tx, cell, connection.ownerDid)
      ) {
        throw new Error(
          `refusing to adopt an unprotected stable graph cell for ${connection.ownerDid}`,
        );
      }
      writtenCells.add(cellKey);
      const protectedCell = cell.withTx(tx);
      if (!isPlainRecord(value)) {
        protectedCell.setRawUntyped(stableFabricValue(value));
        return protectedCell;
      }
      if (!isPlainRecord(priorValue)) {
        protectedCell.setRawUntyped(stableFabricValue(value));
        return protectedCell;
      }
      for (const key of Object.keys(priorValue)) {
        if (!Object.hasOwn(value, key)) {
          tx.writeOrThrow(
            {
              space: link.space!,
              scope: link.scope,
              id: link.id!,
              path: ["value", ...link.path, key],
            },
            undefined,
            { delete: true },
          );
        }
      }
      for (const [key, fieldValue] of Object.entries(value)) {
        tx.writeOrThrow(
          {
            space: link.space!,
            scope: link.scope,
            id: link.id!,
            path: ["value", ...link.path, key],
          },
          stableFabricValue(fieldValue),
        );
      }
      protectedCell.applyCfcSchemaToExistingValue();
      return protectedCell;
    };
    for (const write of protectedWrites) {
      writeCellValue(write.cell, write.value);
    }
  } catch (error) {
    tx.abort(error);
    throw error;
  }
  tx.prepareCfc();
  const result = await tx.commit();
  if (result.error) {
    throw new Error(commitErrorMessage(result.error), { cause: result.error });
  }
}

async function resolveStableGraphLinks(
  connection: AgentFabricConnection,
  value: unknown,
  cache: Map<string, Promise<unknown>>,
  preserveLinkFields: ReadonlySet<string>,
  field?: string,
): Promise<unknown> {
  if (isLinkRef(value)) {
    if (field && preserveLinkFields.has(field)) return value;
    const link = linkRefPayload(value);
    if (typeof link.id !== "string" || typeof link.space !== "string") {
      throw new Error(
        `Stable graph contains an incomplete link: ${JSON.stringify(link)}`,
      );
    }
    const key = JSON.stringify({
      id: link.id,
      space: link.space,
      scope: link.scope,
      path: link.path ?? [],
      preserveLinkFields: [...preserveLinkFields].sort(),
    });
    const cached = cache.get(key);
    if (cached) return await cached;
    const pending = (async () => {
      const child = connection.runtime.getCellFromLink(
        link as Parameters<Runtime["getCellFromLink"]>[0],
      );
      await child.sync();
      await connection.runtime.storageManager.synced();
      return await resolveStableGraphLinks(
        connection,
        child.getRaw(),
        cache,
        preserveLinkFields,
      );
    })();
    cache.set(key, pending);
    return await pending;
  }
  if (Array.isArray(value)) {
    const resolved: unknown[] = [];
    for (
      let offset = 0;
      offset < value.length;
      offset += HYDRATION_BATCH_SIZE
    ) {
      resolved.push(
        ...await Promise.all(
          value.slice(offset, offset + HYDRATION_BATCH_SIZE).map((child) =>
            resolveStableGraphLinks(
              connection,
              child,
              cache,
              preserveLinkFields,
            )
          ),
        ),
      );
    }
    return resolved;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value as Record<string, unknown>).map(
          async ([key, child]) => [
            key,
            await resolveStableGraphLinks(
              connection,
              child,
              cache,
              preserveLinkFields,
              key,
            ),
          ],
        ),
      ),
    );
  }
  return value;
}

export async function readStableCellGraphValue(
  connection: AgentFabricConnection,
  cell: Cell<unknown>,
  cache: Map<string, Promise<unknown>> = new Map(),
  options: { preserveLinkFields?: ReadonlySet<string> } = {},
): Promise<unknown> {
  await cell.sync();
  await connection.runtime.storageManager.synced();
  return await resolveStableGraphLinks(
    connection,
    cell.getRaw(),
    cache,
    options.preserveLinkFields ?? new Set(),
  );
}

export async function subscribeStableActions(
  connection: AgentFabricConnection,
  cell: Cell<unknown>,
  callback: (actions: unknown[]) => void,
): Promise<Cancel> {
  await cell.sync();
  await connection.runtime.storageManager.synced();
  return cell.sink((value) => {
    callback(Array.isArray(value) ? [...value] : []);
  });
}

export async function readStableActions(
  connection: AgentFabricConnection,
  cell: Cell<unknown>,
): Promise<unknown[]> {
  const value = await readStableCellGraphValue(connection, cell);
  return Array.isArray(value) ? [...value] : [];
}
