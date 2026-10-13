/**
 * Public-stage input checks shared by ticketed Memory hosts and routed clients.
 * The JSON scan precedes the Fabric codec, and gzip expansion is bounded.
 */

import { Gunzip, gzipSync } from "fflate";

import { isCanonicalEd25519DID } from "@commonfabric/identity";
import { isPlainObject } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";

import { ROUTED_HOLDINGS_LIMIT } from "./routed-limits.ts";
import { requireRouted } from "./routed-wire.ts";

export { ROUTED_HOLDINGS_LIMIT };

/** Maximum raw public-stage frame bytes. */
export const ROUTED_RAW_LIMIT = 8 * 1024 * 1024;
/** Maximum expanded public-stage frame bytes. */
export const ROUTED_EXPANDED_LIMIT = 16 * 1024 * 1024;
/** Maximum queued bytes on one ticketed data socket. */
export const ROUTED_QUEUE_LIMIT = 4 * 1024 * 1024;
/** Maximum JSON nesting in any routed input; the router's `DEPTH_LIMIT`. */
export const ROUTED_DEPTH_LIMIT = 64;
/**
 * JSON values in one frame by default: the router's default `max_frame_slots`
 * and the toolshed's default `limits.frameSlots`. Also the cap on the
 * toolshed's own inputs, which are not frames (its policy config, the
 * directory snapshot, the epoch ledger's lines and a link agent's flags), as
 * the router applies its default to its own inputs. A frame's cap is the
 * receiver's: the toolshed's `limits.frameSlots` or the SDK's cap learned
 * from `hello.ok.routerFrameSlots`, with this default when it is absent.
 */
export const ROUTED_DEFAULT_SLOT_LIMIT = 150_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Parses bounded JSON after rejecting duplicate decoded keys, lone surrogates,
 * nesting past {@link ROUTED_DEPTH_LIMIT} and more than `maxSlots` values.
 * A `null` slot cap disables value counting; other checks remain active.
 * Slots count as the router counts them: one per value, whether scalar,
 * object or array, with keys free; the root is the first. Escaped names have
 * the same duplicate-key rule.
 */
export function parseRoutedJson(
  source: string,
  maxSlots: number | null,
): unknown {
  // A caller's error, not a hostile input: it must not read as a denial.
  if (maxSlots !== null && (!Number.isSafeInteger(maxSlots) || maxSlots <= 0)) {
    throw new TypeError(`invalid routed slot cap: ${maxSlots}`);
  }
  requireRouted(source.length <= ROUTED_EXPANDED_LIMIT);
  let at = 0;
  let slots = 0;
  const whitespace = () => {
    while (/[ \t\n\r]/.test(source[at] ?? "x")) at++;
  };
  const string = (): string => {
    const start = at++;
    requireRouted(source[start] === '"');
    while (at < source.length) {
      const char = source[at++];
      if (char === "\\") at++;
      else if (char === '"') {
        const value: unknown = JSON.parse(source.slice(start, at));
        requireRouted(typeof value === "string");
        for (const c of value) {
          const code = c.codePointAt(0)!;
          requireRouted(code < 0xd800 || code > 0xdfff);
        }
        return value;
      }
    }
    throw new Error("Routed memory request denied");
  };
  const value = (depth: number): void => {
    requireRouted(
      depth <= ROUTED_DEPTH_LIMIT && (maxSlots === null || ++slots <= maxSlots),
    );
    whitespace();
    if (source[at] === '"') {
      string();
      return;
    }
    if (source[at] === "{") {
      at++;
      whitespace();
      const keys = new Set<string>();
      if (source[at] === "}") {
        at++;
        return;
      }
      for (;;) {
        whitespace();
        const key = string();
        requireRouted(
          !keys.has(key) &&
            !["__proto__", "constructor", "prototype"].includes(key),
        );
        keys.add(key);
        whitespace();
        requireRouted(source[at++] === ":");
        value(depth + 1);
        whitespace();
        const delimiter = source[at++];
        if (delimiter === "}") return;
        requireRouted(delimiter === ",");
      }
    }
    if (source[at] === "[") {
      at++;
      whitespace();
      if (source[at] === "]") {
        at++;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        const delimiter = source[at++];
        if (delimiter === "]") return;
        requireRouted(delimiter === ",");
      }
    }
    const start = at;
    while (at < source.length && !/[ \t\n\r,\]}]/.test(source[at])) {
      at++;
    }
    requireRouted(at > start);
    const scalar: unknown = JSON.parse(source.slice(start, at));
    requireRouted(
      scalar === null || typeof scalar === "boolean" ||
        (typeof scalar === "number" && Number.isFinite(scalar)),
    );
  };
  value(0);
  whitespace();
  requireRouted(at === source.length);
  return JSON.parse(source);
}

/** Requires an ordinary wire record in a security-relevant position. */
export function routedObject(value: unknown): Record<string, unknown> {
  requireRouted(
    isPlainObject(value) &&
      Object.keys(value).every((key) => !key.startsWith("/")),
  );
  return value;
}

/** Validates a bounded routing/session/request identifier. */
export function routedIdentifier(value: unknown): asserts value is string {
  requireRouted(
    typeof value === "string" && /^[A-Za-z0-9_:\-.@]{1,128}$/.test(value),
  );
}

/** Canonical client flag bytes bound to the toolshed ticket. */
export function routedFlags(value: unknown, requireAuth = true): Uint8Array {
  const record = routedObject(value);
  requireRouted(Object.keys(record).length <= 64);
  for (const [key, field] of Object.entries(record)) {
    requireRouted(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key));
    if (Array.isArray(field)) {
      requireRouted(
        field.length <= 16 && new Set(field).size === field.length &&
          field.every((codec) =>
            typeof codec === "string" && /^[A-Za-z0-9_.@/-]{1,128}$/.test(codec)
          ),
      );
    } else requireRouted(typeof field === "boolean");
  }
  if (requireAuth) {
    requireRouted(
      [
        "connectionAuth",
        "routedAuthV1",
      ].every((key) => record[key] === true),
    );
  }
  const bytes = encoder.encode(
    JSON.stringify(Object.fromEntries(
      Object.entries(record).sort(([a], [b]) => utf8Compare(a, b)),
    )),
  );
  requireRouted(bytes.length <= 2048);
  return bytes;
}

/** A strict frame before the Fabric payload decoder handles its values. */
export interface RoutedFrame {
  payload: string;
  body: Record<string, unknown>;
  space?: string;
}

/**
 * Checks a text frame against `maxSlots` JSON values and compares an optional
 * binary routing hint. `maxHoldings` bounds declared holdings. Either cap
 * accepts `null` to disable its count while retaining the other checks.
 */
export function parseRoutedText(
  payload: string,
  maxSlots: number | null,
  hint?: string,
  maxHoldings: number | null = ROUTED_HOLDINGS_LIMIT,
): RoutedFrame {
  requireRouted(
    payload.startsWith("fvj1:") &&
      encoder.encode(payload).length <= ROUTED_EXPANDED_LIMIT,
  );
  const body = routedObject(parseRoutedJson(payload.slice(5), maxSlots));
  requireRouted(
    typeof body.type === "string" && /^[A-Za-z0-9./_:-]{1,64}$/.test(body.type),
  );
  if (body.space !== undefined) {
    requireRouted(isCanonicalEd25519DID(body.space));
  }
  if (hint !== undefined) requireRouted(hint === (body.space ?? ""));
  for (const field of ["requestId", "sessionId"]) {
    if (body[field] !== undefined) routedIdentifier(body[field]);
  }
  if (body.principal !== undefined) {
    requireRouted(isCanonicalEd25519DID(body.principal));
  }
  if (body.session !== undefined) {
    const session = routedObject(body.session);
    if (session.sessionId !== undefined) routedIdentifier(session.sessionId);
  }
  // A frame's `watches` have no count bound of their own: the slot cap and
  // the byte caps bound the frame, and a toolshed's `limits.watchesPerSession`
  // bounds what a session may hold.
  if (body.watches !== undefined) {
    requireRouted(Array.isArray(body.watches) || isPlainObject(body.watches));
  }
  if (body.holdings !== undefined) {
    const holdings = body.holdings;
    requireRouted(
      (Array.isArray(holdings) || isPlainObject(holdings)) &&
        (maxHoldings === null ||
          (Array.isArray(holdings)
              ? holdings.length
              : Object.keys(holdings).length) <=
            maxHoldings),
    );
  }
  return {
    payload,
    body,
    ...(typeof body.space === "string" ? { space: body.space } : {}),
  };
}

/**
 * Decodes one gzip member, enforcing header, expansion, size and JSON bounds.
 * `maxSlots` is the receiver's frame cap: the toolshed's `limits.frameSlots`
 * or the SDK's cap learned from the public hello; `null` disables counting.
 * `maxHoldings` is the receiver's holdings quota, or `null` to disable it.
 */
export function decodeRoutedFrame(
  frame: string | Uint8Array,
  compression: boolean,
  maxSlots: number | null,
  maxHoldings: number | null = ROUTED_HOLDINGS_LIMIT,
): RoutedFrame {
  if (typeof frame === "string") {
    requireRouted(encoder.encode(frame).length <= ROUTED_RAW_LIMIT);
    return parseRoutedText(frame, maxSlots, undefined, maxHoldings);
  }
  requireRouted(
    compression && frame.length <= ROUTED_RAW_LIMIT && frame.length >= 12 &&
      decoder.decode(frame.subarray(0, 5)) === "mcmp\x02",
  );
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const expanded = view.getUint32(5);
  const hintLength = view.getUint16(9);
  requireRouted(hintLength <= 64 && frame.length > 11 + hintLength);
  const hint = decoder.decode(frame.subarray(11, 11 + hintLength));
  requireRouted(hint === "" || isCanonicalEd25519DID(hint));
  const compressed = frame.subarray(11 + hintLength);
  // A routed envelope uses the minimal gzip header: no optional metadata or
  // extra members. fflate bounds expansion; CRC32 verifies the gzip trailer.
  requireRouted(
    compressed.length >= 18 && compressed[0] === 0x1f &&
      compressed[1] === 0x8b && compressed[2] === 8 && compressed[3] === 0,
  );
  requireRouted(
    expanded <= ROUTED_EXPANDED_LIMIT && expanded <= compressed.length * 32,
  );
  const chunks: Uint8Array[] = [];
  let total = 0;
  let final = false;
  const gzip = new Gunzip((chunk, done) => {
    total += chunk.length;
    requireRouted(total <= expanded);
    chunks.push(chunk);
    final = done;
  });
  gzip.onmember = () => {
    throw new Error("Routed memory request denied");
  };
  for (let offset = 0; offset < compressed.length; offset += 1024) {
    const end = Math.min(offset + 1024, compressed.length);
    gzip.push(compressed.subarray(offset, end), end === compressed.length);
  }
  requireRouted(final && total === expanded);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  const trailer = new DataView(
    compressed.buffer,
    compressed.byteOffset + compressed.length - 8,
    8,
  );
  requireRouted(
    trailer.getUint32(4, true) === bytes.length &&
      trailer.getUint32(0, true) === gzipCrc32(bytes),
  );
  return parseRoutedText(decoder.decode(bytes), maxSlots, hint, maxHoldings);
}

/**
 * Encodes a routed envelope with its cleartext, untrusted space hint, after
 * checking the payload against the sender's frame cap `maxSlots`, so a frame
 * the receiver would refuse is never sent.
 */
export function encodeRoutedFrame(
  payload: string,
  maxSlots: number | null,
): string | Uint8Array<ArrayBuffer> {
  const parsed = parseRoutedText(payload, maxSlots);
  const bytes = encoder.encode(payload);
  const raw = () => {
    requireRouted(bytes.length <= ROUTED_RAW_LIMIT);
    return payload;
  };
  if (bytes.length < 1024) return payload;
  const gzip = gzipSync(bytes);
  if (bytes.length > gzip.length * 32) return raw();
  const hint = encoder.encode(parsed.space ?? "");
  const result = new Uint8Array(11 + hint.length + gzip.length);
  result.set(encoder.encode("mcmp\x02"));
  new DataView(result.buffer).setUint32(5, bytes.length);
  new DataView(result.buffer).setUint16(9, hint.length);
  result.set(hint, 11);
  result.set(gzip, 11 + hint.length);
  return result.length <= ROUTED_RAW_LIMIT && result.length < bytes.length
    ? result
    : raw();
}

/** The gzip trailer checksum (RFC 1952), separate from identity/content hashes. */
function gzipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
