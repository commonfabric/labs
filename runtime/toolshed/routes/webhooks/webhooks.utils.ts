import { getLogger } from "@commonfabric/utils/logger";
import { sha256 } from "@/lib/sha2.ts";
import { runtime } from "@/index.ts";
import { identity } from "@/lib/identity.ts";
import {
  type Cell,
  cellRuntime,
  type IExtendedStorageTransaction,
  sendEvent,
  WebhookConfigSchema,
} from "@commonfabric/runner";
import {
  assertWebhookCellLinkRefPayload,
  linkRefFrom,
  linkRefPayload,
  linkRefPayloadFromString,
} from "@commonfabric/runner/shared";
const _logger = getLogger("webhooks.utils");

const WEBHOOK_ID_LENGTH = 20;
const WEBHOOK_SECRET_BYTES = 32;

// Base62 alphabet for generating IDs and secrets
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface WebhookRegistration {
  id: string;
  name: string;
  cellLink: string;
  secretHash: string;
  createdBy: string;
  createdAt: string;
  enabled: boolean;
}

function randomBase62(length: number): string {
  // Use rejection sampling to avoid modulo bias (256 % 62 != 0).
  // Discard bytes >= 248 (largest multiple of 62 <= 256) and redraw.
  const LIMIT = 248; // 62 * 4
  let result = "";
  while (result.length < length) {
    const bytes = crypto.getRandomValues(
      new Uint8Array((length - result.length) * 2),
    );
    for (const byte of bytes) {
      if (byte < LIMIT) {
        result += BASE62[byte % 62];
        if (result.length === length) break;
      }
    }
  }
  return result;
}

export function generateWebhookId(): string {
  return `wh_${randomBase62(WEBHOOK_ID_LENGTH)}`;
}

export function generateWebhookSecret(): {
  secret: string;
  hashPromise: Promise<string>;
} {
  const encoded = randomBase62(WEBHOOK_SECRET_BYTES);
  const secret = `whsec_${encoded}`;
  const hashPromise = sha256(secret);
  return { secret, hashPromise };
}

export async function verifyWebhookSecret(
  provided: string,
  storedHash: string,
): Promise<boolean> {
  const providedHash = await sha256(provided);

  // Timing-safe comparison
  const a = new TextEncoder().encode(providedHash);
  const b = new TextEncoder().encode(storedHash);
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// Compute entity ID for a webhook registration in toolshed's service space
export async function webhookEntityId(webhookId: string): Promise<string> {
  return `of:${await sha256("cf:webhook:" + webhookId)}`;
}

// Compute entity ID for a per-space webhook index in toolshed's service space
async function spaceIndexEntityId(space: string): Promise<string> {
  return `of:${await sha256("cf:webhooks-for:" + space)}`;
}

// Build a cell link targeting toolshed's own service space
function serviceCellLink(entityId: string) {
  return linkRefFrom({
    id: entityId,
    space: identity.did(),
    path: ["webhooks"],
  });
}

// Parse a cell-link wire string (the `fcl1:` addressing-payload form) back into
// a link the runtime can resolve. The wire carries only the plain addressing
// payload; the link envelope is reconstructed locally via `linkRefFrom`.
function parseCellLink(cellLink: string) {
  const payload = linkRefPayloadFromString(cellLink);
  assertWebhookCellLinkRefPayload(payload);
  return linkRefFrom(payload);
}

// Read a cell from toolshed's service space, returning its value.
// Throws on storage errors so callers can distinguish "not found" from "storage failure".
async function readServiceCell<T>(entityId: string): Promise<T | null> {
  const link = serviceCellLink(entityId);
  const cell = runtime.getCellFromLink(link as any);
  await cell.sync();
  await runtime.storageManager.synced();
  const data = cell.get();
  return data as T | null;
}

// Write a value to a cell in toolshed's service space
async function writeServiceCell(
  entityId: string,
  value: unknown,
): Promise<void> {
  const link = serviceCellLink(entityId);
  const cell = runtime.getCellFromLink(link as any);
  await cell.sync();
  await runtime.storageManager.synced();

  const { error } = await cellRuntime(cell).editWithRetry((tx) => {
    cell.withTx(tx).set(value);
  });
  if (error) throw error;
}

// Read a single webhook registration from toolshed's service space
export async function getRegistration(
  webhookId: string,
): Promise<WebhookRegistration | null> {
  const entityId = await webhookEntityId(webhookId);
  return readServiceCell<WebhookRegistration>(entityId);
}

// Write a single webhook registration to toolshed's service space
export async function saveRegistration(
  registration: WebhookRegistration,
): Promise<void> {
  const entityId = await webhookEntityId(registration.id);
  await writeServiceCell(entityId, registration);
}

// Null out a webhook registration
export async function deleteRegistration(webhookId: string): Promise<void> {
  const entityId = await webhookEntityId(webhookId);
  await writeServiceCell(entityId, null);
}

// Write URL+secret to a pattern's confidential config cell
export async function writeConfidentialConfig(
  cellLink: string,
  url: string,
  secret: string,
): Promise<void> {
  const parsedCellLink = parseCellLink(cellLink);
  let cell = runtime.getCellFromLink(parsedCellLink);
  if (!cell.schema) cell = cell.asSchema(WebhookConfigSchema);
  await cell.sync();
  await runtime.storageManager.synced();

  const { error } = await cellRuntime(cell).editWithRetry((tx) => {
    cell.withTx(tx).set({ url, secret });
  });
  if (error) throw error;
}

// Per-space index of webhook IDs in toolshed's service space (for admin list)
export async function getServiceIndex(space: string): Promise<string[]> {
  const entityId = await spaceIndexEntityId(space);
  const data = await readServiceCell<string[]>(entityId);
  return data ?? [];
}

/** The index of webhook IDs for `space`, as a synced cell. */
async function serviceIndexCell(space: string): Promise<Cell<string[]>> {
  const entityId = await spaceIndexEntityId(space);
  const link = serviceCellLink(entityId);
  const cell = runtime.getCellFromLink(link as any) as Cell<string[]>;
  await cell.sync();
  await runtime.storageManager.synced();
  return cell;
}

/** The list held in `cell`, read through `tx`; an unwritten index is empty. */
function indexIds(
  cell: Cell<string[]>,
  tx: IExtendedStorageTransaction,
): string[] {
  const current = cell.withTx(tx).get();
  return Array.isArray(current) ? current : [];
}

/**
 * Stage adding `webhookId` to the index held in `cell` on `tx`, unless the
 * index already holds it. The list is read through `tx` so that the read
 * joins the commit's read set: a commit racing a concurrent change to the
 * index is rejected, and `editWithRetry` re-runs this against the list that
 * change produced rather than overwriting it.
 */
export function addToIndex(
  cell: Cell<string[]>,
  tx: IExtendedStorageTransaction,
  webhookId: string,
): void {
  const ids = indexIds(cell, tx);
  if (!ids.includes(webhookId)) {
    cell.withTx(tx).set([...ids, webhookId]);
  }
}

/**
 * Stage removing `webhookId` from the index held in `cell` on `tx`. The list
 * is read through `tx` for the same reason as in `addToIndex()`.
 */
export function removeFromIndex(
  cell: Cell<string[]>,
  tx: IExtendedStorageTransaction,
  webhookId: string,
): void {
  cell.withTx(tx).set(indexIds(cell, tx).filter((id) => id !== webhookId));
}

export async function addToServiceIndex(
  space: string,
  webhookId: string,
): Promise<void> {
  const cell = await serviceIndexCell(space);
  const { error } = await cellRuntime(cell).editWithRetry((tx) =>
    addToIndex(cell, tx, webhookId)
  );
  if (error) throw error;
}

export async function removeFromServiceIndex(
  space: string,
  webhookId: string,
): Promise<void> {
  const cell = await serviceIndexCell(space);
  const { error } = await cellRuntime(cell).editWithRetry((tx) =>
    removeFromIndex(cell, tx, webhookId)
  );
  if (error) throw error;
}

// Send incoming webhook payload to the target inbox stream.
// The cell must be schema with `asCell: ["stream"]` so .send() dispatches
// through the stream/handler system rather than being treated as a regular
// cell set.
export async function sendToStream(
  cellLink: string,
  payload: unknown,
): Promise<void> {
  const parsedCellLink = parseCellLink(cellLink);
  const cell = runtime.getCellFromLink(parsedCellLink);
  const streamCell = cell.asSchema({ asCell: ["stream"] });
  await streamCell.sync();
  await runtime.storageManager.synced();

  if (runtime.experimental.serverExecution !== true) {
    // OFF arm: byte-for-byte today's behavior — the outer tx's commit
    // is the acknowledgment.
    const { error } = await cellRuntime(streamCell).editWithRetry((tx) => {
      streamCell.withTx(tx).send(payload);
    });
    if (error) throw error;
    return;
  }
  // Events-down: the durable acknowledgment rides the send's settle
  // callback (verdict blocker, 2026-08-12) — the outer tx carries NO
  // writes (the fire's one authored act is the queued event append),
  // so its commit alone would report a webhook delivery as successful
  // while the append was refused, offline, or its server-side handling
  // failed. The callback settles from the append + authoritative
  // consequence outcome; an error status there fails the delivery
  // loudly (the caller's HTTP timeout bounds an offline hold — a held
  // delivery beats a false 200 under at-least-once webhook semantics).
  const settled = new Promise<IExtendedStorageTransaction>(
    (resolve, reject) => {
      cellRuntime(streamCell).editWithRetry((tx) => {
        sendEvent(streamCell.withTx(tx), payload, resolve);
      }).then(({ error }) => {
        if (error) reject(error);
      }, reject);
    },
  );
  const ackTx = await settled;
  const status = ackTx.status();
  if (status.status === "error") {
    throw new Error(
      `webhook delivery failed: ${status.error?.message ?? "send rejected"}`,
    );
  }
}

// Extract space DID from a serialized cell link. `parseCellLink` already
// guarantees a well-formed link (or throws), so this only needs the space.
export function extractSpaceFromCellLink(cellLink: string): string {
  const space = linkRefPayload(parseCellLink(cellLink)).space;
  if (!space) throw new Error("Cell link missing space");

  return space as string;
}
