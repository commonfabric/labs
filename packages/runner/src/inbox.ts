/** Signed client for generic private DID inbox delivery. */

import { hashStringOf } from "@commonfabric/data-model";
import { isDIDKey } from "@commonfabric/identity/did";
import {
  InboxError,
  type InboxMessage,
  type InboxPayload,
  type InboxReceipt,
  snapshotInboxPayload,
  validateInboxPayload,
} from "@commonfabric/memory/inbox";
import { normalizeInviteHost } from "@commonfabric/memory/space-invites";
import {
  type FirstPartyHttpSigner,
  signFirstPartyHttpRequest,
} from "./toolshed-http-auth.ts";
export { INBOX_CAPABILITY, InboxError } from "@commonfabric/memory/inbox";
export type {
  InboxMessage,
  InboxPayload,
  InboxReceipt,
} from "@commonfabric/memory/inbox";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InboxError("invalid-response");
  }
  return value as Record<string, unknown>;
}
function receipt(value: unknown, recipientDid: string): InboxReceipt {
  const data = object(value);
  if (
    data.recipientDid !== recipientDid || typeof data.senderDid !== "string" ||
    !isDIDKey(data.senderDid) || typeof data.operationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(data.operationId) ||
    typeof data.payloadHash !== "string" ||
    typeof data.receivedAt !== "number" ||
    !Number.isSafeInteger(data.receivedAt) || data.receivedAt < 0
  ) throw new InboxError("invalid-response");
  return {
    recipientDid,
    senderDid: data.senderDid,
    operationId: data.operationId,
    payloadHash: data.payloadHash,
    receivedAt: data.receivedAt,
  };
}
function message(value: unknown, recipientDid: string): InboxMessage {
  const data = object(value);
  const parsed = receipt(data.receipt, recipientDid);
  try {
    validateInboxPayload(data.payload);
  } catch {
    throw new InboxError("invalid-response");
  }
  if (hashStringOf(data.payload) !== parsed.payloadHash) {
    throw new InboxError("invalid-response");
  }
  return { receipt: parsed, payload: data.payload };
}

/** Binds signed requests to one origin and identity; it never retries mutations. */
export class InboxClient {
  #host: string;
  #signer: FirstPartyHttpSigner;
  #fetch: typeof fetch;

  /** Creates a client without opening a memory space or enabling an inbox. */
  constructor(
    options: {
      host: string;
      signer: FirstPartyHttpSigner;
      fetch?: typeof fetch;
    },
  ) {
    this.#host = normalizeInviteHost(options.host);
    this.#signer = options.signer;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Explicitly enables delivery to this signing identity. */
  async enable(): Promise<{ recipientDid: string; enabled: true }> {
    const data = await this.#request("enable", {});
    if (data.recipientDid !== this.#signer.did() || data.enabled !== true) {
      throw new InboxError("invalid-response");
    }
    return { recipientDid: this.#signer.did(), enabled: true };
  }

  /** Checks a destination's public readiness without enabling it. */
  async status(
    recipientDid: string,
  ): Promise<{ recipientDid: string; enabled: boolean }> {
    const data = await this.#request("status", { recipientDid });
    if (
      data.recipientDid !== recipientDid || typeof data.enabled !== "boolean"
    ) throw new InboxError("invalid-response");
    return { recipientDid, enabled: data.enabled };
  }

  /** Sends inert JSON; reuse exactly this operation ID and payload after an uncertain result. */
  async send(
    request: {
      recipientDid: string;
      operationId: string;
      payload: InboxPayload;
    },
  ): Promise<InboxReceipt> {
    const sent = {
      ...request,
      payload: snapshotInboxPayload(request.payload).payload,
    };
    const result = receipt(
      await this.#request("send", sent),
      sent.recipientDid,
    );
    if (
      result.senderDid !== this.#signer.did() ||
      result.operationId !== sent.operationId ||
      result.payloadHash !== hashStringOf(sent.payload)
    ) throw new InboxError("invalid-response");
    return result;
  }

  /** Lists this signer's pending deliveries in durable insertion order. */
  async list(
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ messages: InboxMessage[]; nextCursor: string | null }> {
    const data = await this.#request("list", options);
    if (
      !Array.isArray(data.messages) ||
      (data.nextCursor !== null && typeof data.nextCursor !== "string")
    ) throw new InboxError("invalid-response");
    return {
      messages: data.messages.map((item) => message(item, this.#signer.did())),
      nextCursor: data.nextCursor,
    };
  }

  /** Reads a pending delivery in this signer's inbox. */
  async get(
    key: { senderDid: string; operationId: string },
  ): Promise<{ message: InboxMessage | null }> {
    const data = await this.#request("get", key);
    if (data.message === null) return { message: null };
    const result = message(data.message, this.#signer.did());
    if (
      result.receipt.senderDid !== key.senderDid ||
      result.receipt.operationId !== key.operationId
    ) throw new InboxError("invalid-response");
    return { message: result };
  }

  /** Clears a delivery's payload while retaining its deduplication receipt. */
  async acknowledge(
    key: { senderDid: string; operationId: string },
  ): Promise<{ acknowledged: boolean }> {
    const data = await this.#request("acknowledge", key);
    if (typeof data.acknowledged !== "boolean") {
      throw new InboxError("invalid-response");
    }
    return { acknowledged: data.acknowledged };
  }

  async #request(
    operation: string,
    value: unknown,
  ): Promise<Record<string, unknown>> {
    const url = new URL(`/api/inbox/${operation}`, this.#host);
    const body = JSON.stringify(value);
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      body,
      signer: this.#signer,
      headers: { "Content-Type": "application/json" },
    });
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        body,
        headers,
        redirect: "error",
      });
    } catch {
      throw new InboxError("outcome-unknown");
    }
    let data: Record<string, unknown>;
    try {
      data = object(await response.json());
    } catch {
      throw new InboxError(response.ok ? "invalid-response" : "service-error");
    }
    if (!response.ok) {
      const codes = [
        "invalid-proof",
        "invalid-request",
        "invalid-payload",
        "not-enabled",
        "operation-conflict",
        "inbox-full",
        "rate-limited",
        "service-error",
      ];
      throw new InboxError(
        typeof data.code === "string" && codes.includes(data.code)
          ? data.code
          : "service-error",
      );
    }
    return data;
  }
}
