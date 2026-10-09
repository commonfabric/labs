// HTTP client for the toolshed ingest-channel control plane.
//
// Every call carries a CF1 first-party request proof signed with the user's own
// identity key — the same mechanism `cf inspect --remote` uses. That proof is
// what makes this self-serve: the server verifies the caller DID
// cryptographically and then requires an explicit OWNER grant on the target
// space's ACL, so no operator and no vault password is involved.
//
// All verbs are POST. The in-runtime signer only ever signs POSTs to an
// allowlisted path, so keeping the whole surface POST-only is what leaves room
// for a future in-shell or in-pattern client.

import { legacySpaceDid } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { loadIdentity } from "./identity.ts";

/**
 * Join the control-plane path onto the configured API base, KEEPING the base's
 * own path.
 *
 * `new URL("/api/…", "https://host/fabric")` resolves the root-absolute path
 * against the origin and silently drops `/fabric`, so a deployment served under
 * a path prefix has every command addressed at the wrong endpoint — and it
 * fails as a 404 from somewhere else, not as a configuration error.
 *
 * A verb that acts on one space names it in the path, which is what lets a
 * server dispatch the request by space without reading the body. Without
 * `space` the URL is the one for the caller's own list, the only verb that
 * names none.
 */
export const controlPlaneUrl = (
  apiUrl: URL,
  verb: string,
  space?: string,
): URL => {
  const base = space === undefined
    ? "/api/ingest-channels"
    : `/api/spaces/${space}/ingest-channels`;
  const url = new URL(apiUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${base}/${verb}`;
  return url;
};

export interface ChannelConfig {
  apiUrl: URL;
  identityPath: string;
}

/**
 * What a channel's writes land in: a `journal` of records in per-day
 * partition cells, which a device POSTs to, or one `latest` cell holding the
 * newest Gmail push notification.
 */
export type IngestSink = "journal" | "latest";

/** The sinks a channel can be minted with, as `--sink` accepts them. */
export const INGEST_SINKS: readonly IngestSink[] = ["journal", "latest"];

export interface ChannelSummary {
  id: string;
  name: string;
  space: string;
  causePrefix: string;
  installId: string;
  sink: IngestSink;
  createdAt: string;
  enabled: boolean;
  owner?: string;
  expiresAt?: string;
  revoked?: { at: string; by: string };
  revocations?: { at: string; by: string }[];
  lastSeenAt: string | null;

  /** The generation this summary describes; `revoke` must name it. */
  revision: number;
}

export interface MintedChannel {
  id: string;

  /** Where a device POSTs, and its bearer secret; absent for a `latest` channel. */
  url?: string;
  space: string;
  causePrefix: string;
  installId: string;
  expiresAt?: string;

  /** Shown ONCE. The server keeps only its hash. */
  token: string;
}

/**
 * Accept either a space DID or a space NAME, mirroring `cf acl`. A name is
 * resolved through the same legacy derivation the rest of the CLI uses, so
 * `--space my-space` means the same space everywhere. Resolving opens and
 * creates nothing, and needs no network.
 */
export async function resolveSpaceDid(
  _identityPath: string,
  space: string,
): Promise<string> {
  if (isDID(space)) return space;
  return await legacySpaceDid(space);
}

async function call<T>(
  config: ChannelConfig,
  verb: string,
  payload: Record<string, unknown>,
  space?: string,
): Promise<T> {
  const url = controlPlaneUrl(config.apiUrl, verb, space);
  const identity = await loadIdentity(config.identityPath);
  // The proof commits to the body hash, so the bytes signed and the bytes sent
  // must be identical — serialize once.
  const body = JSON.stringify(payload);
  const headers = await signFirstPartyHttpRequest({
    url,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signer: identity,
  });

  const response = await fetch(url, { method: "POST", headers, body });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${verb} failed (${response.status}): ${text.slice(0, 200)}`,
    );
  }
  if (!response.ok) {
    const error = (parsed as { error?: string }).error ??
      `HTTP ${response.status}`;
    throw new Error(error);
  }
  return parsed as T;
}

/**
 * A fresh idempotency key per invocation. Reuse the SAME id when retrying a
 * failed call and the server answers 409 rather than minting a second live
 * token — within a replay window of about half an hour, which is what the
 * defense is sized for. A retry days later mints a new token and supersedes
 * the old one.
 */
export const newRequestId = (): string => crypto.randomUUID();

export function mintChannel(
  config: ChannelConfig,
  input: {
    space: string;
    installId: string;
    causePrefix?: string;
    name?: string;
    ttlDays?: number;
    sink?: IngestSink;
    requestId: string;
  },
): Promise<MintedChannel> {
  const { space, ...payload } = input;
  return call<MintedChannel>(config, "mint", payload, space);
}

/**
 * Without `space`, the channels this identity minted. With `space`, EVERY
 * channel targeting it — which requires currently owning the space, and is the
 * only way to discover a channel minted by someone whose grant has since been
 * removed.
 */
export async function listChannels(
  config: ChannelConfig,
  input: { space?: string } = {},
): Promise<ChannelSummary[]> {
  const { channels } = await call<{ channels: ChannelSummary[] }>(
    config,
    "list",
    {},
    input.space,
  );
  return channels;
}

/** Mints a new token for channel `input.id`, which writes into `input.space`. */
export function rotateChannel(
  config: ChannelConfig,
  input: { space: string; id: string; ttlDays?: number; requestId: string },
): Promise<MintedChannel> {
  const { space, ...payload } = input;
  return call<MintedChannel>(config, "rotate", payload, space);
}

/** Disables channel `input.id`, which writes into `input.space`. */
export function revokeChannel(
  config: ChannelConfig,
  input: {
    space: string;
    id: string;
    requestId: string;
    expectedRevision: number;
  },
): Promise<{ id: string; revokedAt: string; revision: number }> {
  const { space, ...payload } = input;
  return call<{ id: string; revokedAt: string; revision: number }>(
    config,
    "revoke",
    payload,
    space,
  );
}

/**
 * Binds channel `input.id`, which writes into `input.space`, to the Gmail
 * mailbox `input.accessToken` reads, so that each Gmail push notification for
 * the mailbox replaces the record in the channel's one cell. The channel has
 * to be a `latest` channel. The server uses the token for one profile lookup
 * and does not keep it.
 */
export function bindGmail(
  config: ChannelConfig,
  input: { space: string; id: string; accessToken: string; requestId: string },
): Promise<{ id: string; emailAddress: string }> {
  const { space, ...payload } = input;
  return call<{ id: string; emailAddress: string }>(
    config,
    "gmail-bind",
    payload,
    space,
  );
}

/**
 * Unbinds channel `input.id`, which writes into `input.space`, from its Gmail
 * mailbox, if it is bound to one.
 */
export function unbindGmail(
  config: ChannelConfig,
  input: { space: string; id: string; requestId: string },
): Promise<{ id: string; unbound: boolean }> {
  const { space, ...payload } = input;
  return call<{ id: string; unbound: boolean }>(
    config,
    "gmail-unbind",
    payload,
    space,
  );
}
