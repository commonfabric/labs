/**
 * Authenticated client for generic space invitations, over a memory session
 * or signed HTTP requests.
 */

import type { FabricValue } from "@commonfabric/api";
import {
  type CreateInvite,
  createInviteCredentials,
  inviteCodeVerifier,
  type InviteMetadata,
  type InviteRedemption,
  normalizeInviteHost,
  type RedeemReceipt,
  SpaceInviteError,
} from "@commonfabric/memory/space-invites";
import type { InviteAdministration } from "@commonfabric/memory/v2/client";
import {
  type FirstPartyHttpSigner,
  signFirstPartyHttpRequest,
} from "./toolshed-http-auth.ts";

export {
  buildInviteLink,
  createInviteCredentials,
  INVITE_ACCESS,
  inviteCodeVerifier,
  isInviteAccess,
  normalizeInviteHost,
  parseInviteLink,
  SPACE_INVITE_CAPABILITY,
  SpaceInviteError,
} from "@commonfabric/memory/space-invites";
export type {
  CreateInvite,
  InviteAccess,
  InviteLink,
  InviteMetadata,
  InviteRedemption,
  RedeemReceipt,
} from "@commonfabric/memory/space-invites";

/**
 * Whether a session-path failure leaves the operation to HTTP: true for a
 * `SpaceInviteRefusal` naming `invite-service-unsupported`, which the server
 * sends, or the client raises, when the operation cannot go on a session.
 *
 * @throws SpaceInviteError for another `SpaceInviteRefusal`, with its code.
 */
function usesHttpAfter(error: unknown): boolean {
  const code = error instanceof Error && error.name === "SpaceInviteRefusal"
    ? (error as Error & { code?: unknown }).code
    : undefined;
  if (typeof code !== "string") return false;
  if (code === "invite-service-unsupported") return true;
  throw new SpaceInviteError(code);
}

/** Creation settings with optional credentials for an exact retry. */
export type CreateSpaceInviteOptions =
  & Pick<CreateInvite, "access" | "ttlSeconds" | "maxUses">
  & { inviteId?: string; code?: string };

/** A failed creation attempt retaining caller-only credentials for an exact retry. */
export class SpaceInviteCreateError extends SpaceInviteError {
  #retry: Readonly<
    CreateSpaceInviteOptions & { inviteId: string; code: string }
  >;

  /** Retains credentials privately without adding them to error diagnostics. */
  constructor(
    code: string,
    retry: CreateSpaceInviteOptions & { inviteId: string; code: string },
  ) {
    super(code);
    this.#retry = Object.freeze({ ...retry });
  }

  /** Secret-bearing options to pass to the same client's `create()` method. */
  get retry(): Readonly<
    CreateSpaceInviteOptions & { inviteId: string; code: string }
  > {
    return this.#retry;
  }
}

/**
 * Sends an invitation operation on the space's memory session, as
 * `IStorageManager.administerInvites()` does for one space.
 */
export type SpaceInviteSession = (
  invite: InviteAdministration,
) => Promise<FabricValue>;

/**
 * Redeems an invitation on a memory session whose open carries it, as
 * `IStorageManager.redeemInvite()` does for one space.
 */
export type SpaceInviteRedeemer = (
  invite: { inviteId: string; code: string },
) => Promise<RedeemReceipt>;

/**
 * Client for generic space invitations. Administration goes on the space's
 * memory session where one is given, and redemption on the open of a session
 * where a redeemer is given, each where the server takes it there; anything
 * else is a signed HTTP request. Failed creation retains credentials for
 * uncertain retries.
 */
export class SpaceInviteClient {
  #host: string;
  #space: string;
  #signer: FirstPartyHttpSigner;
  #fetch: typeof fetch;
  #session: SpaceInviteSession | undefined;
  #redeemer: SpaceInviteRedeemer | undefined;

  /**
   * Constructs an instance which binds every operation to one service
   * origin, space, and signing identity, sends administration on `session`
   * when given, and redeems through `redeemer` when given.
   */
  constructor(
    options: {
      host: string;
      space: string;
      signer: FirstPartyHttpSigner;
      fetch?: typeof fetch;
      session?: SpaceInviteSession;
      redeemer?: SpaceInviteRedeemer;
    },
  ) {
    this.#host = normalizeInviteHost(options.host);
    this.#space = options.space;
    this.#signer = options.signer;
    this.#fetch = options.fetch ?? fetch;
    this.#session = options.session;
    this.#redeemer = options.redeemer;
  }

  /** Creates credentials locally; preserve the returned code to deliver the link. */
  async create(
    options: CreateSpaceInviteOptions,
  ): Promise<InviteMetadata & { code: string }> {
    if ((options.inviteId === undefined) !== (options.code === undefined)) {
      throw new SpaceInviteError("invalid-request");
    }
    const credentials = options.inviteId === undefined
      ? createInviteCredentials()
      : { inviteId: options.inviteId, code: options.code! };
    const request = {
      inviteId: credentials.inviteId,
      codeVerifier: inviteCodeVerifier({
        host: this.#host,
        space: this.#space,
        ...credentials,
      }),
      access: options.access,
      ttlSeconds: options.ttlSeconds,
      ...(options.maxUses === undefined ? {} : { maxUses: options.maxUses }),
    };
    try {
      const metadata = await this.issue(request);
      return { ...metadata, code: credentials.code };
    } catch (error) {
      throw new SpaceInviteCreateError(
        error instanceof SpaceInviteError
          ? error.code
          : "create-outcome-unknown",
        {
          access: request.access,
          ttlSeconds: request.ttlSeconds,
          ...(request.maxUses === undefined
            ? {}
            : { maxUses: request.maxUses }),
          ...credentials,
        },
      );
    }
  }

  /** Issues prepared credentials; retry this exact request after uncertain delivery. */
  issue(request: CreateInvite): Promise<InviteMetadata> {
    return this.#administer({
      operation: "create",
      body: {
        inviteId: request.inviteId,
        codeVerifier: request.codeVerifier,
        access: request.access,
        ttlSeconds: request.ttlSeconds,
        ...(request.maxUses === undefined ? {} : { maxUses: request.maxUses }),
      },
    });
  }

  /**
   * Redeems as the signer: on the open of a session on the space, where a
   * redeemer is given and its server redeems there, and over HTTP otherwise.
   * An open that redeems and is then refused its grant, as a repeat
   * redemption of an invitation whose access was since removed is, is also
   * redeemed over HTTP, which returns the receipt with no current access.
   *
   * @throws SpaceInviteError with the service's code when the service refuses
   *   it; a lost session connection is thrown as it came.
   */
  async redeem(
    request: { inviteId: string; code: string },
  ): Promise<RedeemReceipt> {
    if (this.#redeemer !== undefined) {
      try {
        return await this.#redeemer(request);
      } catch (error) {
        const refusedGrant = error instanceof Error &&
          error.name === "AuthorizationError";
        if (!refusedGrant && !usesHttpAfter(error)) throw error;
      }
    }
    return await this.#request("redeem", request);
  }

  /** Lists active metadata visible to the current explicit owner. */
  list(): Promise<InviteMetadata[]> {
    return this.#administer({ operation: "list", body: {} });
  }

  /** Revokes admission while retaining grants and redemption receipts. */
  revoke(inviteId: string): Promise<{ revoked: true }> {
    return this.#administer({ operation: "revoke", body: { inviteId } });
  }

  /** Lists unique receipts visible to the current explicit owner. */
  receipts(inviteId?: string): Promise<InviteRedemption[]> {
    return this.#administer({
      operation: "receipts",
      body: inviteId === undefined ? {} : { inviteId },
    });
  }

  /**
   * Sends an administration operation on the session, or over HTTP where
   * there is none or its server does not take one.
   *
   * @throws SpaceInviteError with the service's code when the service refuses
   *   it; a lost session connection is thrown as it came.
   */
  async #administer<T>(invite: InviteAdministration): Promise<T> {
    if (this.#session !== undefined) {
      try {
        return await this.#session(invite) as T;
      } catch (error) {
        if (!usesHttpAfter(error)) throw error;
      }
    }
    return await this.#request(invite.operation, invite.body);
  }

  async #request<T>(operation: string, body: object): Promise<T> {
    const url = new URL(
      `/api/spaces/${encodeURIComponent(this.#space)}/invites/${operation}`,
      this.#host,
    );
    const payload = JSON.stringify(body);
    const headers = await signFirstPartyHttpRequest({
      url,
      method: "POST",
      body: payload,
      headers: { "Content-Type": "application/json" },
      signer: this.#signer,
    });
    const response = await this.#fetch(url, {
      method: "POST",
      headers,
      body: payload,
      redirect: "error",
    });
    if (response.status === 404 || response.status === 405) {
      throw new SpaceInviteError("invite-service-unsupported");
    }
    if (!response.ok) {
      const error: unknown = await response.json().catch(() => undefined);
      throw new SpaceInviteError(
        error !== null && typeof error === "object" && !Array.isArray(error) &&
          Object.hasOwn(error, "code") && "code" in error &&
          typeof error.code === "string"
          ? error.code
          : "service-error",
      );
    }
    return await response.json() as T;
  }
}
