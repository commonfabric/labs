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

import { createSession } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { loadIdentity } from "./identity.ts";

const BASE = "/api/ingest-channels";

/**
 * Join the control-plane path onto the configured API base, KEEPING the base's
 * own path.
 *
 * `new URL("/api/…", "https://host/fabric")` resolves the root-absolute path
 * against the origin and silently drops `/fabric`, so a deployment served under
 * a path prefix has every command addressed at the wrong endpoint — and it
 * fails as a 404 from somewhere else, not as a configuration error.
 */
export const controlPlaneUrl = (apiUrl: URL, verb: string): URL => {
  const url = new URL(apiUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${BASE}/${verb}`;
  return url;
};

export interface ChannelConfig {
  apiUrl: URL;
  identityPath: string;
}

export interface ChannelSummary {
  id: string;
  name: string;
  space: string;
  causePrefix: string;
  installId: string;
  sink: "journal";
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
  url: string;
  space: string;
  causePrefix: string;
  installId: string;
  expiresAt?: string;

  /** Shown ONCE. The server keeps only its hash. */
  token: string;
}

/**
 * Accept either a space DID or a space NAME, mirroring `cf acl`. A name is
 * resolved through the same derivation the rest of the CLI uses, so
 * `--space my-space` means the same space everywhere.
 *
 * PREFER A DID. Named spaces derive their key from a shared public passphrase
 * plus the name (`packages/identity/src/session.ts`), so anyone who knows the
 * name can sign AS that space, grant themselves OWNER, and mint channels into
 * it. That is a known temporary platform property, not something this command
 * introduces — but a minted token is durable and outlives any later fix, so it
 * is worth knowing which kind of space you are pointing at.
 */
export async function resolveSpaceDid(
  identityPath: string,
  space: string,
): Promise<string> {
  if (isDID(space)) return space;
  const identity = await loadIdentity(identityPath);
  // `session.space` is the derived space DID and is non-optional, unlike
  // `session.spaceIdentity`, whose optionality is for the `spaceDid` form the
  // branch above already handled.
  const session = await createSession({ identity, spaceName: space });
  return session.space;
}

async function call<T>(
  config: ChannelConfig,
  verb: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const url = controlPlaneUrl(config.apiUrl, verb);
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
    requestId: string;
  },
): Promise<MintedChannel> {
  return call<MintedChannel>(config, "mint", input);
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
    input,
  );
  return channels;
}

export function rotateChannel(
  config: ChannelConfig,
  input: { id: string; ttlDays?: number; requestId: string },
): Promise<MintedChannel> {
  return call<MintedChannel>(config, "rotate", input);
}

export function revokeChannel(
  config: ChannelConfig,
  input: { id: string; requestId: string; expectedRevision: number },
): Promise<{ id: string; revokedAt: string; revision: number }> {
  return call<{ id: string; revokedAt: string; revision: number }>(
    config,
    "revoke",
    input,
  );
}
