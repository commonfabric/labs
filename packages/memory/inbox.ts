/** Versioned wire values for private, authenticated DID inbox delivery. */

export type InboxPayload = null | boolean | number | string | InboxPayload[] | {
  [key: string]: InboxPayload;
};

/** Limits enforced atomically by the inbox store. */
export const INBOX_CAPABILITY = {
  version: 1,
  maxPayloadBytes: 16384,
  maxPending: 1000,
  maxPendingPerSender: 100,
  maxReceipts: 100000,
} as const;

/** Immutable proof of a durable delivery, retained after acknowledgment. */
export interface InboxReceipt {
  recipientDid: string;
  senderDid: string;
  operationId: string;
  payloadHash: string;
  receivedAt: number;
}

/** A pending delivery. Payloads are inert JSON, never runtime cell links. */
export interface InboxMessage {
  receipt: InboxReceipt;
  payload: InboxPayload;
}

/** A stable refusal code that contains no message data. */
export class InboxError extends Error {
  #code: string;

  /** Creates a refusal with a stable machine-readable code. */
  constructor(code: string) {
    super(code);
    this.#code = code;
  }

  /** Stable refusal classification, without message payload data. */
  get code(): string {
    return this.#code;
  }
}

/** Snapshots bounded inert JSON using its wire representation before hashing. */
export function snapshotInboxPayload(
  value: unknown,
): { payload: InboxPayload; json: string } {
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new InboxError("invalid-payload");
    if (
      item === null || typeof item === "string" || typeof item === "boolean"
    ) return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      typeof item !== "object" || item === null ||
      (!Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)
    ) throw new InboxError("invalid-payload");
    if (Object.getOwnPropertySymbols(item).length) {
      throw new InboxError("invalid-payload");
    }
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (
    new TextEncoder().encode(json).length >
      INBOX_CAPABILITY.maxPayloadBytes
  ) throw new InboxError("invalid-payload");
  return { payload: JSON.parse(json), json };
}

/** Refuses values outside the bounded inert JSON contract. */
export function validateInboxPayload(
  value: unknown,
): asserts value is InboxPayload {
  snapshotInboxPayload(value);
}
