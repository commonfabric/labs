import {
  fabricFromConvertibleJsValue,
  type FabricValue,
} from "@commonfabric/data-model";
import type { Cell, MemorySpace, Runtime } from "@commonfabric/runner";

export interface GithubFabricConnection {
  runtime: Runtime;
  spaceDid: MemorySpace;
}

export interface GithubFabricWriteEntry {
  cell: Cell<unknown>;
  value: Record<string, unknown>;
}

export type GithubFabricWriter = (
  connection: GithubFabricConnection,
  entries: ReadonlyArray<GithubFabricWriteEntry>,
) => Promise<void>;

function commitErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "Fabric transaction commit failed";
}

/** Atomically replace a group of GitHub connector cells. */
export async function writeGithubFabricCells(
  connection: GithubFabricConnection,
  entries: ReadonlyArray<GithubFabricWriteEntry>,
): Promise<void> {
  if (entries.length === 0) return;
  const tx = connection.runtime.edit();
  try {
    for (const entry of entries) {
      tx.writeValueOrThrow(
        entry.cell.getAsNormalizedFullLink(),
        fabricFromConvertibleJsValue(entry.value) as FabricValue,
      );
    }
  } catch (error) {
    tx.abort(error);
    throw error;
  }
  const result = await tx.commit();
  if (result.error) {
    throw new Error(commitErrorMessage(result.error), { cause: result.error });
  }
}

/** Read one synchronized GitHub connector cell without following its links. */
export async function readGithubFabricCell(
  connection: GithubFabricConnection,
  cell: Cell<unknown>,
): Promise<unknown> {
  await cell.sync();
  await connection.runtime.storageManager.synced();
  return cell.getRaw();
}

/** Return the entity identifier for a GitHub connector cell. */
export function githubFabricCellId(cell: Cell<unknown>): string {
  const id = cell.getAsNormalizedFullLink().id!;
  return id.startsWith("of:") ? id.slice(3) : id;
}
