/** Authenticated client for generic space invitations, independent of a session. */
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
import {
  type FirstPartyHttpSigner,
  signFirstPartyHttpRequest,
} from "./toolshed-http-auth.ts";

export {
  buildInviteLink,
  createInviteCredentials,
  inviteCodeVerifier,
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

/** Signed HTTP client. Failed creation retains credentials for uncertain retries. */
export class SpaceInviteClient {
  #host: string;
  #space: string;
  #signer: FirstPartyHttpSigner;
  #fetch: typeof fetch;

  /** Binds all operations to one service origin, space, and signing identity. */
  constructor(
    options: {
      host: string;
      space: string;
      signer: FirstPartyHttpSigner;
      fetch?: typeof fetch;
    },
  ) {
    this.#host = normalizeInviteHost(options.host);
    this.#space = options.space;
    this.#signer = options.signer;
    this.#fetch = options.fetch ?? fetch;
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
    return this.#request("create", {
      inviteId: request.inviteId,
      codeVerifier: request.codeVerifier,
      access: request.access,
      ttlSeconds: request.ttlSeconds,
      ...(request.maxUses === undefined ? {} : { maxUses: request.maxUses }),
    });
  }

  /** Redeems as the signer, without first opening a target-space session. */
  redeem(request: { inviteId: string; code: string }): Promise<RedeemReceipt> {
    return this.#request("redeem", request);
  }

  /** Lists active metadata visible to the current explicit owner. */
  list(): Promise<InviteMetadata[]> {
    return this.#request("list", {});
  }

  /** Revokes admission while retaining grants and redemption receipts. */
  revoke(inviteId: string): Promise<{ revoked: true }> {
    return this.#request("revoke", { inviteId });
  }

  /** Lists unique receipts visible to the current explicit owner. */
  receipts(inviteId?: string): Promise<InviteRedemption[]> {
    return this.#request(
      "receipts",
      inviteId === undefined ? {} : { inviteId },
    );
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
