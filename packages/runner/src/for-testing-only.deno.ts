/**
 * What this package offers to tests alone: `FakeInbox`, an inbox service a
 * test runs in-process. It answers the DID-inbox `send` operation over an
 * in-memory `InboxStore`, as the `fetch` of a runtime whose `apiUrl` is the
 * inbox's origin. It verifies each request's signature the way the toolshed
 * routes do, so a message's sender is the identity that signed it, and it
 * refuses what the store refuses, so a duplicate operation and a conflicting
 * one behave as they would against the real service. What a run sent is then
 * readable without a network or a server.
 *
 * This package offers it because it is built from this package's request
 * verifier and the inbox store this package's client sends to, so the fake
 * answers exactly what the client asks. It has its own entry in the package's
 * export map, `./for-testing-only`, and no place in any barrel, so that a
 * consumer of the package's general surface loads none of it. It is
 * Deno-only, which the file name says: the store is SQLite, which
 * `@db/sqlite` opens through FFI as it loads, so loading this module takes
 * `--allow-ffi` and a Deno runtime.
 */

import type { DIDKey } from "@commonfabric/identity";
import {
  InboxError,
  type InboxMessage,
  validateInboxPayload,
} from "@commonfabric/memory/inbox";
import { InboxStore } from "@commonfabric/memory/inbox-store";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { verifyFirstPartyHttpRequest } from "./toolshed-http-auth.ts";

/** The `send` envelope, as the store takes it. */
type SendRequest = Parameters<InboxStore["send"]>[1];

/**
 * Helper for {@link FakeInbox.fetch}, which reads `request`'s body as a `send`
 * envelope: JSON holding a string `recipientDid`, a string `operationId`, and
 * a `payload` within the inbox's payload contract.
 *
 * @throws InboxError `invalid-request` for a body that is not JSON or not
 *   such an envelope, and `invalid-payload` as `validateInboxPayload()` does.
 */
async function sendRequestOf(request: Request): Promise<SendRequest> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new InboxError("invalid-request");
  }
  if (
    !isObjectNotArray(body) || typeof body.recipientDid !== "string" ||
    typeof body.operationId !== "string" || !("payload" in body)
  ) {
    throw new InboxError("invalid-request");
  }
  validateInboxPayload(body.payload);
  return {
    recipientDid: body.recipientDid,
    operationId: body.operationId,
    payload: body.payload,
  };
}

/** The shape of `fetch` a {@link FakeInbox} answers and falls back to. */
export type FakeInboxFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The origin a {@link FakeInbox} answers at unless given another: a loopback
 * `http:` origin, which is what an inbox client accepts, at port 0, which no
 * connection can be made to, so a request that reached the network instead of
 * the fake could not find a service by accident.
 */
export const FAKE_INBOX_API_URL = new URL("http://127.0.0.1:0/");

/** Options for {@link FakeInbox}. */
export interface FakeInboxOptions {
  /** The origin the inbox answers at; {@link FAKE_INBOX_API_URL} by default. */
  readonly apiUrl?: URL | string;

  /**
   * Whether every recipient counts as having enabled their inbox. Off, a
   * recipient is enabled by {@link FakeInbox.enable} and a send to anyone else
   * is refused `not-enabled`, as the real service refuses it.
   */
  readonly everyRecipientEnabled?: boolean;

  /**
   * Where a request to any other origin goes. Without one, such a request is
   * answered `404` with the inbox's `invalid-request` code.
   */
  readonly fallback?: FakeInboxFetch;
}

/**
 * An inbox service over an in-memory store, answering the inbox `send`
 * operation as a runtime's `fetch`, at one origin. A request to any other
 * origin goes to the fallback the instance was given, or is answered `404`.
 */
export class FakeInbox {
  #store = new InboxStore(":memory:");
  #apiUrl: URL;
  #everyRecipientEnabled: boolean;
  #fallback: FakeInboxFetch | undefined;
  #sends = 0;
  #refusals: string[] = [];
  #accepted: InboxMessage[] = [];
  #acceptedKeys = new Set<string>();

  /** Constructs an instance answering at `options.apiUrl`. */
  constructor(options: FakeInboxOptions = {}) {
    this.#apiUrl = new URL(options.apiUrl ?? FAKE_INBOX_API_URL);
    this.#everyRecipientEnabled = options.everyRecipientEnabled ?? false;
    this.#fallback = options.fallback;
  }

  /** The origin this inbox answers at, as a runtime's `apiUrl`. */
  get apiUrl(): URL {
    return new URL(this.#apiUrl);
  }

  /** How many `send` requests have arrived, accepted or not. */
  get sends(): number {
    return this.#sends;
  }

  /**
   * The codes of the `send` requests refused, in order, by the envelope check
   * or by the store. A request whose signature did not verify is not among
   * them: nothing of it was read.
   */
  get refusals(): readonly string[] {
    return this.#refusals;
  }

  /**
   * Every message the store accepted, in the order it accepted them. A `send`
   * repeating an accepted operation returns its receipt and adds nothing
   * here.
   */
  get messages(): readonly InboxMessage[] {
    return this.#accepted;
  }

  /** Enables delivery to `recipient`, a DID. */
  enable(recipient: string): void {
    this.#store.enable(recipient);
  }

  /** Returns the messages pending in the inbox of `recipient`, a DID. */
  messagesFor(recipient: string): InboxMessage[] {
    return this.#store.list(recipient).messages;
  }

  /**
   * Answers one request, as a runtime's `fetch`. A send is refused the way the
   * inbox router refuses one: `401 invalid-proof` for a request whose
   * signature does not verify, `400` for a body that is not JSON, an envelope
   * that is not a send, or a refusal code opening with `invalid`, `429` for
   * `inbox-full`, and `409` for any other refusal.
   */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // Read before any `Request` is built from `input`: building one from a
    // `Request` uses up its body, which a fallback is owed intact.
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== this.#apiUrl.origin) {
      if (this.#fallback !== undefined) return this.#fallback(input, init);
      return Response.json({ code: "invalid-request" }, { status: 404 });
    }
    if (url.pathname !== "/api/inbox/send") {
      return Response.json({ code: "invalid-request" }, { status: 404 });
    }
    this.#sends++;
    const request = new Request(input, init);
    let sender: DIDKey;
    try {
      ({ userDid: sender } = await verifyFirstPartyHttpRequest({
        request: request.clone(),
      }));
    } catch {
      return Response.json({ code: "invalid-proof" }, { status: 401 });
    }
    try {
      return Response.json(this.#send(sender, await sendRequestOf(request)));
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      this.#refusals.push(error.code);
      return Response.json({ code: error.code }, {
        status: error.code.startsWith("invalid")
          ? 400
          : error.code === "inbox-full"
          ? 429
          : 409,
      });
    }
  }

  /** Closes the store. */
  close(): void {
    this.#store.close();
  }

  /**
   * Helper for {@link fetch}, which hands a `send` request to the store as
   * `sender` and records the message where the store accepted a new one.
   *
   * @throws InboxError as the store does.
   */
  #send(sender: DIDKey, request: SendRequest): unknown {
    if (this.#everyRecipientEnabled) this.#store.enable(request.recipientDid);
    const receipt = this.#store.send(sender, request);
    const key = JSON.stringify([
      receipt.recipientDid,
      receipt.senderDid,
      receipt.operationId,
    ]);
    if (!this.#acceptedKeys.has(key)) {
      this.#acceptedKeys.add(key);
      const { message } = this.#store.get(receipt.recipientDid, {
        senderDid: receipt.senderDid,
        operationId: receipt.operationId,
      });
      if (message !== null) this.#accepted.push(message);
    }
    return receipt;
  }
}
