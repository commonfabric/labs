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
  // The space is one path segment, so a value that is not a DID is refused
  // here rather than reaching the server as a different path.
  if (space !== undefined && !isDID(space)) {
    throw new Error(`Not a space DID: ${space}`);
  }
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
 * What kind of channel a registration is. A `device` channel is written by a
 * device POSTing records with the channel's token, into journal cells under
 * its cause prefix. A `gmail` channel is written by the server on each Gmail
 * push notification for the mailbox bound to it, into the cell its target
 * names. A new mint decides it: a mailbox proof and a target make a gmail
 * channel, and a mint without them makes a device channel. A re-mint keeps
 * the channel's kind, and one carrying neither field keeps a gmail channel's
 * binding and target as well.
 */
export type IngestChannelKind = "device" | "gmail";

/**
 * The cell a gmail channel writes, as the parts of a link: the space, the
 * document id, and the path within it.
 */
export interface CellTarget {
  space: string;
  id: string;
  path: string[];
}

/** A link to a cell, as a mint names the cell a gmail channel writes. */
export type CellTargetLink = { "/": { "link@1": CellTarget } };

export interface ChannelSummary {
  id: string;
  name: string;
  space: string;

  /** A device channel's cause prefix; absent on a gmail channel. */
  causePrefix?: string;

  /** A gmail channel's cell; absent on a device channel. */
  target?: CellTarget;
  installId: string;
  kind: IngestChannelKind;
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

  /** Where a device POSTs; absent for a gmail channel, as `token` is. */
  url?: string;
  space: string;

  /** A device channel's cause prefix; absent on a gmail channel. */
  causePrefix?: string;

  /** A gmail channel's cell; absent on a device channel. */
  target?: CellTarget;
  installId: string;
  expiresAt?: string;

  /**
   * The device's bearer secret, shown ONCE; the server keeps only its hash.
   * Absent for a gmail channel, which no device POSTs to.
   */
  token?: string;

  /** The mailbox the channel was bound to, when the mint carried a proof. */
  emailAddress?: string;
}

/**
 * Proof of a Gmail mailbox, carried on a mint to bind the channel to it: a
 * Google access token that reads the mailbox, used by the server for one
 * profile lookup and kept nowhere, or a Google ID token naming it, which
 * grants nothing. One of the two.
 */
export type GmailProof =
  | { accessToken: string; idToken?: never }
  | { idToken: string; accessToken?: never };

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

    /** With `gmail`, the cell the gmail channel writes. */
    target?: CellTargetLink;
    gmail?: GmailProof;
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
