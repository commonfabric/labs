import {
  type AsBytes,
  type DIDKey,
  VerifierIdentity,
} from "@commonfabric/identity";
import { isDIDKey } from "@commonfabric/identity/did";
import { sha256 } from "@commonfabric/content-hash";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";

const textEncoder = new TextEncoder();

export type FirstPartyHttpSigner = {
  did(): string;
  sign<T>(
    payload: AsBytes<T>,
  ):
    | PromiseLike<
      { ok: Uint8Array; error?: undefined } | { error: Error; ok?: undefined }
    >
    | { ok: Uint8Array; error?: undefined }
    | { error: Error; ok?: undefined };
};

export const FIRST_PARTY_HTTP_AUTH_VERSION = "CF1";
export const FIRST_PARTY_HTTP_PROOF_DOMAIN =
  "common-toolshed-first-party-request-v1";
export const FIRST_PARTY_USER_DID_HEADER = "CF-User-DID";
export const FIRST_PARTY_HTTP_AUTH_HEADERS = {
  auth: "CF-Request-Auth",
  proof: "CF-Request-Proof",
  bodySha256: "CF-Request-Body-SHA256",
  userDid: FIRST_PARTY_USER_DID_HEADER,
} as const;

export const PROTECTED_TOOLSHED_FIRST_PARTY_ROUTES = [
  "/api/agent-tools/web-read",
  "/api/agent-tools/web-search",
  "/api/sandbox/exec",
] as const;

const protectedRouteSet = new Set<string>(
  PROTECTED_TOOLSHED_FIRST_PARTY_ROUTES,
);

const DEFAULT_VALID_FOR_SECONDS = 60;
const DEFAULT_MAX_PROOF_AGE_SECONDS = 300;
const DEFAULT_FUTURE_SKEW_SECONDS = 60;
const PROOF_ALGORITHM = "ed25519";
const AUTH_FIELD_ISSUED_AT = "issued-at";
const AUTH_FIELD_VALID_UNTIL = "valid-until";
const AUTH_FIELD_PROOF_DID = "proof-did";
const AUTH_FIELD_PROOF_KIND = "proof-kind";

export class FirstPartyHttpAuthError extends Error {
  override name = "AuthorizationError";
}

function authError(message: string): FirstPartyHttpAuthError {
  return new FirstPartyHttpAuthError(message);
}

export function isProtectedToolshedFirstPartyRoute(
  url: URL,
  method: string,
): boolean {
  return method.toUpperCase() === "POST" &&
    protectedRouteSet.has(normalizeProtectedPath(url.pathname));
}

export function isToolshedApiOrigin(url: URL, apiBase: URL): boolean {
  return url.origin === apiBase.origin;
}

function normalizeProtectedPath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

function requestPath(url: URL): string {
  return `${url.pathname}${url.search}`;
}

function authority(url: URL): string {
  return url.host.toLowerCase();
}

function isUnpaddedBase64url(encoded: string): boolean {
  return /^[A-Za-z0-9_-]*$/.test(encoded);
}

function sha256Base64url(bytes: Uint8Array): string {
  return toUnpaddedBase64url(sha256(bytes));
}

async function bodyBytesFromInit(
  body: BodyInit | null | undefined,
): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return textEncoder.encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof URLSearchParams) {
    return textEncoder.encode(body.toString());
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }

  throw authError("unsupported authenticated request body type");
}

async function bodyBytesFromRequest(request: Request): Promise<Uint8Array> {
  try {
    return new Uint8Array(await request.clone().arrayBuffer());
  } catch {
    throw authError("could not read request body for authentication");
  }
}

function removeAuthHeaders(headers: Headers): void {
  headers.delete(FIRST_PARTY_HTTP_AUTH_HEADERS.auth);
  headers.delete(FIRST_PARTY_HTTP_AUTH_HEADERS.proof);
  headers.delete(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256);
  headers.delete(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid);
  headers.delete("Signature");
  headers.delete("Signature-Input");
  headers.delete("Content-Digest");
}

function encodeHeaderParam(value: string): string {
  return encodeURIComponent(value);
}

function decodeHeaderParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw authError("request auth metadata has invalid encoding");
  }
}

function authHeaderValue(params: {
  issuedAt: number;
  validUntil: number;
  did: string;
}): string {
  return `${FIRST_PARTY_HTTP_AUTH_VERSION} ${AUTH_FIELD_ISSUED_AT}=${params.issuedAt}; ${AUTH_FIELD_VALID_UNTIL}=${params.validUntil}; ${AUTH_FIELD_PROOF_DID}=${
    encodeHeaderParam(params.did)
  }; ${AUTH_FIELD_PROOF_KIND}=${PROOF_ALGORITHM}`;
}

function parseAuthHeader(headerValue: string): {
  issuedAt: number;
  validUntil: number;
  did: string;
  proofKind: string;
} {
  const prefix = `${FIRST_PARTY_HTTP_AUTH_VERSION} `;
  if (!headerValue.startsWith(prefix)) {
    throw authError("request auth metadata has an unknown version");
  }

  const rawParams = headerValue.slice(prefix.length);
  const params = new Map<string, string>();
  for (const rawPart of rawParams.split(";")) {
    const part = rawPart.trim();
    const separator = part.indexOf("=");
    if (separator <= 0 || separator === part.length - 1) {
      throw authError("request auth metadata is malformed");
    }

    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (
      ![
        AUTH_FIELD_ISSUED_AT,
        AUTH_FIELD_VALID_UNTIL,
        AUTH_FIELD_PROOF_DID,
        AUTH_FIELD_PROOF_KIND,
      ].includes(key)
    ) {
      throw authError("request auth metadata has an unknown field");
    }
    if (params.has(key)) {
      throw authError("request auth metadata has a duplicate field");
    }
    params.set(key, value);
  }

  const issuedAt = Number(params.get(AUTH_FIELD_ISSUED_AT));
  const validUntil = Number(params.get(AUTH_FIELD_VALID_UNTIL));
  const didValue = params.get(AUTH_FIELD_PROOF_DID);
  const proofKind = params.get(AUTH_FIELD_PROOF_KIND);

  if (!Number.isInteger(issuedAt) || !Number.isInteger(validUntil)) {
    throw authError("request auth freshness fields must be integers");
  }
  if (!didValue || !proofKind) {
    throw authError("request auth metadata is missing required fields");
  }

  return {
    issuedAt,
    validUntil,
    did: decodeHeaderParam(didValue),
    proofKind,
  };
}

function requestProofBase(params: {
  method: string;
  url: URL;
  headers: Headers;
  userDid: string;
  issuedAt: number;
  validUntil: number;
  proofKind: string;
}): string {
  const lines = [
    FIRST_PARTY_HTTP_PROOF_DOMAIN,
    `method: ${params.method.toUpperCase()}`,
    `authority: ${authority(params.url)}`,
    `path: ${requestPath(params.url)}`,
    `user-did: ${params.userDid}`,
    `issued-at: ${params.issuedAt}`,
    `valid-until: ${params.validUntil}`,
    `proof-kind: ${params.proofKind}`,
  ];

  const bodySha256 = params.headers.get(
    FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256,
  );
  if (bodySha256 !== null) {
    lines.push(`body-sha256: ${bodySha256}`);
  }

  return lines.join("\n");
}

function parseProofHeader(headerValue: string): Uint8Array {
  if (!isUnpaddedBase64url(headerValue)) {
    throw authError("request proof is not valid unpadded base64url");
  }

  try {
    return fromBase64url(headerValue);
  } catch {
    throw authError("request proof is not valid unpadded base64url");
  }
}

function assertFresh(params: {
  issuedAt: number;
  validUntil: number;
  nowSeconds: number;
  maxProofAgeSeconds: number;
  futureSkewSeconds: number;
}) {
  if (params.validUntil <= params.issuedAt) {
    throw authError("request auth validUntil must be after issuedAt");
  }
  if (params.validUntil - params.issuedAt > params.maxProofAgeSeconds) {
    throw authError("request auth lifetime is too long");
  }
  if (params.issuedAt > params.nowSeconds + params.futureSkewSeconds) {
    throw authError("request auth issuedAt is too far in the future");
  }
  if (params.validUntil < params.nowSeconds) {
    throw authError("request auth has expired");
  }
}

function assertBodySha256(
  headers: Headers,
  bodyBytes: Uint8Array,
) {
  const bodySha256 = headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256);
  if (!bodySha256 && bodyBytes.length > 0) {
    throw authError("request body must have a body SHA-256 header");
  }
  if (!bodySha256) return;

  const expected = sha256Base64url(bodyBytes);
  if (bodySha256 !== expected) {
    throw authError("body SHA-256 does not match request body");
  }
}

export async function signFirstPartyHttpRequest(params: {
  url: URL;
  method: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  signer: FirstPartyHttpSigner;
  nowSeconds?: number;
  validForSeconds?: number;
}): Promise<Headers> {
  const headers = new Headers(params.headers);
  removeAuthHeaders(headers);

  const userDid = params.signer.did();
  if (!isDIDKey(userDid)) {
    throw authError("first-party HTTP authentication requires did:key signers");
  }

  headers.set(FIRST_PARTY_HTTP_AUTH_HEADERS.userDid, userDid);

  const bodyBytes = await bodyBytesFromInit(params.body);
  if (bodyBytes !== undefined) {
    headers.set(
      FIRST_PARTY_HTTP_AUTH_HEADERS.bodySha256,
      sha256Base64url(bodyBytes),
    );
  }

  const issuedAt = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  const validUntil = issuedAt +
    (params.validForSeconds ?? DEFAULT_VALID_FOR_SECONDS);
  headers.set(
    FIRST_PARTY_HTTP_AUTH_HEADERS.auth,
    authHeaderValue({ issuedAt, validUntil, did: userDid }),
  );

  const base = requestProofBase({
    method: params.method,
    url: params.url,
    headers,
    userDid,
    issuedAt,
    validUntil,
    proofKind: PROOF_ALGORITHM,
  });
  const payload = textEncoder.encode(base) as unknown as AsBytes<string>;
  const signed = await params.signer.sign(payload);
  if (signed.error) throw signed.error;

  headers.set(
    FIRST_PARTY_HTTP_AUTH_HEADERS.proof,
    toUnpaddedBase64url(signed.ok),
  );
  return headers;
}

export async function verifyFirstPartyHttpRequest(params: {
  request: Request;
  nowSeconds?: number;
  maxProofAgeSeconds?: number;
  futureSkewSeconds?: number;
}): Promise<{ userDid: DIDKey }> {
  const { request } = params;
  const authHeader = request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.auth);
  const proofHeader = request.headers.get(FIRST_PARTY_HTTP_AUTH_HEADERS.proof);
  if (!authHeader || !proofHeader) {
    throw authError("request is missing first-party auth headers");
  }

  const parsedAuth = parseAuthHeader(authHeader);
  if (parsedAuth.proofKind !== PROOF_ALGORITHM) {
    throw authError("unsupported first-party proof algorithm");
  }
  if (!isDIDKey(parsedAuth.did)) {
    throw authError("first-party auth DID must be a did:key");
  }

  const userDid = request.headers.get(FIRST_PARTY_USER_DID_HEADER);
  if (!userDid || userDid !== parsedAuth.did) {
    throw authError("proof user DID does not match request auth DID");
  }

  const nowSeconds = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  assertFresh({
    issuedAt: parsedAuth.issuedAt,
    validUntil: parsedAuth.validUntil,
    nowSeconds,
    maxProofAgeSeconds: params.maxProofAgeSeconds ??
      DEFAULT_MAX_PROOF_AGE_SECONDS,
    futureSkewSeconds: params.futureSkewSeconds ??
      DEFAULT_FUTURE_SKEW_SECONDS,
  });

  const bodyBytes = await bodyBytesFromRequest(request);
  assertBodySha256(request.headers, bodyBytes);

  const base = requestProofBase({
    method: request.method,
    url: new URL(request.url),
    headers: request.headers,
    userDid,
    issuedAt: parsedAuth.issuedAt,
    validUntil: parsedAuth.validUntil,
    proofKind: parsedAuth.proofKind,
  });

  const verifier = await VerifierIdentity.fromDid(parsedAuth.did as DIDKey);
  const proof = parseProofHeader(proofHeader);
  const verified = await verifier.verify({
    payload: textEncoder.encode(base),
    signature: proof,
  });
  if (verified.error) throw verified.error;

  return { userDid: userDid as DIDKey };
}
