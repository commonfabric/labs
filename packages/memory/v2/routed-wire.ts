/**
 * Canonical signed Mode A records. Binary lengths and domain tags give router
 * challenges, receipt evidence and client statements one interpretation.
 */

import { sha256 } from "@commonfabric/content-hash";
import { decodeHex, encodeHex } from "@std/encoding/hex";
import {
  isCanonicalEd25519DID,
  VerifierIdentity,
} from "@commonfabric/identity";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";

import type { Signer } from "../interface.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Refuses a malformed routed record without exposing its content. */
export function requireRouted(condition: unknown): asserts condition {
  if (!condition) throw new Error("Routed memory request denied");
}

/** Writer for bounded, big-endian router records. */
export class RoutedWriter {
  #parts: Uint8Array[];

  /** Starts a record with its four-byte domain tag. */
  constructor(tag: string) {
    requireRouted(tag.length === 4);
    this.#parts = [encoder.encode(tag)];
  }

  /** The concatenated canonical record. */
  get bytes(): Uint8Array {
    const result = new Uint8Array(
      this.#parts.reduce((size, part) => size + part.length, 0),
    );
    let offset = 0;
    for (const part of this.#parts) {
      result.set(part, offset);
      offset += part.length;
    }
    requireRouted(result.length <= 4096);
    return result;
  }

  /** Appends a fixed-size field. */
  fixed(bytes: Uint8Array): this {
    this.#parts.push(bytes.slice());
    return this;
  }

  /** Appends a two-byte-length-prefixed field. */
  blob(bytes: Uint8Array): this {
    requireRouted(bytes.length <= 4096);
    return this.fixed(new Uint8Array([bytes.length >> 8, bytes.length & 255]))
      .fixed(bytes);
  }

  /** Appends a bounded ASCII string. */
  text(value: string): this {
    requireRouted(
      value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value),
    );
    return this.blob(encoder.encode(value));
  }

  /** Appends an integral Unix second or control sequence. */
  time(value: number): this {
    requireRouted(Number.isSafeInteger(value) && value >= 0);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
    return this.fixed(bytes);
  }

  /** Signs the exact record bytes with their domain tag. */
  async sign(identity: Signer): Promise<Uint8Array> {
    const signature = await identity.sign(this.bytes);
    if (signature.error) throw signature.error;
    return this.fixed(signature.ok).bytes;
  }
}

/** Reader that refuses truncated fields and trailing record bytes. */
export class RoutedReader {
  #bytes: Uint8Array;
  #offset = 4;

  /** Checks a record's size and domain tag. */
  constructor(bytes: Uint8Array, tag: string) {
    requireRouted(bytes.length >= 4 && bytes.length <= 4096);
    requireRouted(decoder.decode(bytes.subarray(0, 4)) === tag);
    this.#bytes = bytes;
  }

  /** Reads exactly `length` bytes. */
  fixed(length: number): Uint8Array {
    requireRouted(length >= 0 && this.#offset + length <= this.#bytes.length);
    const result = this.#bytes.slice(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }

  /** Reads a length-prefixed field. */
  blob(): Uint8Array {
    const length = this.fixed(2);
    return this.fixed(length[0] * 256 + length[1]);
  }

  /** Reads a bounded ASCII string. */
  text(): string {
    const value = decoder.decode(this.blob());
    requireRouted(
      value.length > 0 && value.length <= 256 && /^[\x21-\x7e]+$/.test(value),
    );
    return value;
  }

  /** Reads a nonnegative safe integer. */
  time(): number {
    const bytes = this.fixed(8);
    const value = Number(new DataView(bytes.buffer).getBigUint64(0));
    requireRouted(Number.isSafeInteger(value));
    return value;
  }

  /** Refuses unconsumed bytes. */
  end(): void {
    requireRouted(this.#offset === this.#bytes.length);
  }
}

/** Verifies a signature over an exact domain-separated record. */
export async function verifyRoutedRecord(
  bytes: Uint8Array,
  did: string,
): Promise<Uint8Array> {
  requireRouted(
    bytes.length >= 68 && bytes.length <= 4096 && isCanonicalEd25519DID(did),
  );
  const identity = await VerifierIdentity.fromDid(did);
  const payload = bytes.slice(0, -64);
  const verified = await identity.verify({
    payload,
    signature: bytes.slice(-64),
  });
  if (verified.error) throw verified.error;
  return payload;
}

/** A routed connection-auth invocation decoded after client verification. */
export interface RoutedStatement {
  principal: string;
  router: string;
  deployment: string;
  challenge: Uint8Array;
  iat: number;
  exp: number;
}

/** Builds the client-signed routed invocation payload. */
export function routedStatementPayload(
  statement: RoutedStatement,
): RoutedWriter {
  requireRouted(
    isCanonicalEd25519DID(statement.principal) &&
      isCanonicalEd25519DID(statement.router) &&
      statement.challenge.length === 32,
  );
  return new RoutedWriter("mra1").text(statement.principal)
    .text("connection.auth").text(statement.router).text("memory")
    .text(statement.deployment).fixed(statement.challenge)
    .time(statement.iat).time(statement.exp);
}

/** Decodes and verifies the client's signature before returning any fields. */
export async function readRoutedStatement(
  bytes: Uint8Array,
): Promise<RoutedStatement> {
  requireRouted(bytes.length <= 1024 && bytes.length >= 68);
  const reader = new RoutedReader(bytes.slice(0, -64), "mra1");
  const principal = reader.text();
  requireRouted(reader.text() === "connection.auth");
  const router = reader.text();
  requireRouted(reader.text() === "memory");
  const statement = {
    principal,
    router,
    deployment: reader.text(),
    challenge: reader.fixed(32),
    iat: reader.time(),
    exp: reader.time(),
  };
  reader.end();
  requireRouted(isCanonicalEd25519DID(router));
  await verifyRoutedRecord(bytes, principal);
  return statement;
}

/** Exact signed statement with the link agent's two signed evidence records. */
export interface RoutedProof {
  statement: Uint8Array;
  challenge: Uint8Array;
  receipt: Uint8Array;
}

/** Decodes the bounded forwarded-proof control payload. */
export function readRoutedProof(bytes: Uint8Array): RoutedProof {
  const r = new RoutedReader(bytes, "mrp1");
  const proof = { statement: r.blob(), challenge: r.blob(), receipt: r.blob() };
  r.end();
  return proof;
}

/** Holds forwarded evidence to the authenticated link and ticketed context. */
export async function verifyRoutedProof(proof: RoutedProof, options: {
  router: string;
  deployment: string;
  epoch: Uint8Array;
  context: Uint8Array;
  now: number;
}): Promise<RoutedStatement> {
  // Hash before decoding: receipt admission is about these exact statement bytes.
  const statementHash = sha256(proof.statement);
  const c = new RoutedReader(
    await verifyRoutedRecord(proof.challenge, options.router),
    "mrc1",
  );
  requireRouted(c.text() === options.deployment && c.text() === options.router);
  requireRouted(
    equalRoutedBytes(c.fixed(16), options.epoch) &&
      equalRoutedBytes(c.fixed(16), options.context),
  );
  const challenge = c.fixed(32);
  const issued = c.time();
  const expires = c.time();
  c.end();
  const r = new RoutedReader(
    await verifyRoutedRecord(proof.receipt, options.router),
    "mrr1",
  );
  requireRouted(equalRoutedBytes(r.fixed(32), sha256(proof.challenge)));
  const principal = r.text();
  requireRouted(equalRoutedBytes(r.fixed(32), statementHash));
  const received = r.time();
  r.end();
  requireRouted(
    expires > issued && expires - issued <= 60 && issued <= received &&
      received < expires && received <= options.now,
  );
  const s = await readRoutedStatement(proof.statement);
  requireRouted(
    s.principal === principal && s.router === options.router &&
      s.deployment === options.deployment &&
      equalRoutedBytes(s.challenge, challenge),
  );
  requireRouted(
    s.iat <= received + 120 && s.exp > s.iat && s.exp > options.now &&
      s.exp <= s.iat + 3600 && s.exp <= received + 3600,
  );
  return s;
}

/** Compares bounded public control fields. */
export function equalRoutedBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((byte, i) => byte === right[i]);
}

/** Canonical, unpadded base64url for statement transport. */
export function routedBase64(bytes: Uint8Array): string {
  return toUnpaddedBase64url(bytes);
}

/** Decodes a canonical, bounded statement transport string. */
export function readRoutedBase64(value: unknown): Uint8Array {
  requireRouted(
    typeof value === "string" && value.length <= 1366 &&
      /^[A-Za-z0-9_-]+$/.test(value),
  );
  const bytes = fromBase64url(value);
  requireRouted(routedBase64(bytes) === value && bytes.length <= 1024);
  return bytes;
}

/** Canonical lowercase hex for context, epoch, ticket and challenge identifiers. */
export function routedHex(bytes: Uint8Array): string {
  return encodeHex(bytes);
}

/** Reads one fixed-size lowercase hex identifier. */
export function readRoutedHex(value: unknown, size: number): Uint8Array {
  requireRouted(
    typeof value === "string" && value.length === size * 2 &&
      /^[0-9a-f]+$/.test(value),
  );
  return decodeHex(value);
}
