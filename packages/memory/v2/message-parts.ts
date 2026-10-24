/**
 * Messages split into parts by their lists, in both directions.
 *
 * A server splits a sync too large for one message (`syncPartsV1`,
 * 04-protocol.md section 4.2.3), and the client handles the parts as the one
 * sync they divide. The first part takes the whole sync's place, as
 * `response.ok.sync` or `session/effect.effect`; each later part is a
 * `session/effect` for the same session. A server sends a sync's parts one
 * after another, with no other message for that session between them.
 *
 * A client splits a `session.watch.set` too large for one message
 * (`watchSetPartsV1`, section 4.3.5): the server holds each part and applies
 * their concatenation as one set when the last arrives.
 *
 * Either way, every part but the last carries `more: true`, every part
 * repeats the message's other fields, and a split divides lists, never an
 * entry: a part holds at least one entry, and an entry larger than the budget
 * goes alone.
 */

import { membersWritten } from "@commonfabric/data-model/codec-json";
import { isPlainObject } from "@commonfabric/utils/types";

import type {
  ResponseMessage,
  ServerMessage,
  SessionEffectMessage,
  SessionSync,
  WatchSetRequest,
} from "../v2.ts";
import { encodeMemoryBoundary } from "../v2.ts";

/** The bounds a message is split to fit, and its parts cut to. */
export type PartLimits = {
  /** Most UTF-8 bytes of a part's encoded message. */
  readonly bytes: number;
  /** Most JSON values in a message, whole or a part; `null` counts none. */
  readonly values: number | null;
  /**
   * Most UTF-8 bytes of a message sent whole, when more than a part's: one
   * that fits these and the value bound is not split. Splitting costs the
   * sender more than sending whole, so a transport splits only what its
   * receiver could not take whole.
   */
  readonly whole?: number;
};

/** The bounds a message is sent whole within. */
export function wholeLimits(limits: PartLimits): PartLimits {
  return limits.whole === undefined
    ? limits
    : { bytes: limits.whole, values: limits.values };
}

/** The space and session a split sync's later parts are pushed to. */
export type SyncPartSession = {
  readonly space: string;
  readonly sessionId: string;
};

/**
 * The list fields a split divides, each a list whose concatenation over the
 * parts is the list the whole message carried, and those of them every part
 * carries. Every other field is repeated on every part, and a receiver
 * requires the parts to repeat it alike, so a list field added to the message
 * can be divided only behind a new capability: a peer that knows only these
 * lists would refuse parts whose new list differs.
 */
type ListShape = {
  readonly fields: readonly string[];
  readonly required: readonly string[];
};

const SYNC_LISTS: ListShape = {
  fields: ["upserts", "removes", "crossings", "operationFields", "viewPlans"],
  required: ["upserts", "removes"],
};

const WATCH_SET_LISTS: ListShape = {
  fields: ["watches", "holdings", "views"],
  required: ["watches"],
};

type Entry = { readonly field: string; readonly entry: unknown };

type Size = { readonly bytes: number; readonly values: number };

/** The wire tag every encoded message starts with. */
const WIRE_TAG = "fvj1:";

const TEXT_ENCODER = new TextEncoder();

/** The sync a server message carries, if it carries one. */
export function serverMessageSync(
  message: unknown,
): SessionSync | undefined {
  if (!isPlainObject(message)) return undefined;
  const sync = message.type === "session/effect"
    ? message.effect
    : message.type === "response" && isPlainObject(message.ok)
    ? message.ok.sync
    : undefined;
  return isPlainObject(sync) && sync.type === "sync"
    ? sync as SessionSync
    : undefined;
}

/**
 * Whether `payload`, an encoded message, fits `limits`. A character takes at
 * most three UTF-8 bytes, so text of at most a third of the byte bound fits
 * it unmeasured. JSON text of `n` characters holds at most `(n + 1) / 2`
 * values, as every value takes a character and every value but the first a
 * separator besides, so a payload of at most `2 * values + 1` characters, the
 * wire tag's five among them, holds fewer values than the bound, and only
 * longer text is scanned.
 */
export function payloadFits(payload: string, limits: PartLimits): boolean {
  if (payload.length > limits.bytes) return false;
  if (
    payload.length * 3 > limits.bytes && utf8Length(payload) > limits.bytes
  ) {
    return false;
  }
  if (limits.values === null || payload.length <= 2 * limits.values + 1) {
    return true;
  }
  return membersWritten(payload.slice(WIRE_TAG.length), limits.values - 1) <
    limits.values;
}

/**
 * Divides the sync `message` carries into parts whose messages fit `limits`:
 * the first in `message`'s envelope, the rest as effects for `session`.
 * `prepared` is `message` as the connection's table encodings leave it, whose
 * entries are measured when they correspond one for one to `message`'s, so
 * that a part is cut by what it takes on the wire. Every part is charged
 * room for tables: those of the whole prepared message, which hold every
 * table a part can carry, up to half the bounds. A part whose own tables
 * still take it past the bounds is the caller's to check. Returns
 * `[message]` when the sync has fewer than two entries or the entries fit
 * one part.
 */
export function splitSyncMessage(
  message: ServerMessage,
  session: SyncPartSession,
  limits: PartLimits,
  prepared: ServerMessage = message,
): ServerMessage[] {
  const sync = serverMessageSync(message);
  if (sync === undefined) return [message];
  const entries = entriesOf(sync, SYNC_LISTS);
  if (entries.length < 2) return [message];
  const compacted = serverMessageSync(prepared);
  const measured = compacted === undefined
    ? entries
    : entriesOf(compacted, SYNC_LISTS);
  const sizes = (measured.length === entries.length &&
      measured.every((item, index) => item.field === entries[index].field)
    ? measured
    : entries).map((item) => measure(item.entry));
  // Every part is charged the larger of the two envelopes a part can take,
  // and room for tables.
  const empty = partOf(sync, SYNC_LISTS, [], true, true) as SessionSync;
  const first = measure(inEnvelope(message, empty, session, true));
  const later = measure(inEnvelope(message, empty, session, false));
  const tables = tablesOf(sync, compacted, limits);
  const groups = pack(entries, sizes, {
    bytes: Math.max(first.bytes, later.bytes) + tables.bytes,
    values: Math.max(first.values, later.values) + tables.values,
  }, limits);
  if (groups.length === 1) return [message];
  return groups.map((group, index) =>
    inEnvelope(
      message,
      partOf(
        sync,
        SYNC_LISTS,
        group,
        index < groups.length - 1,
        index === 0,
      ) as SessionSync,
      session,
      index === 0,
    )
  );
}

/**
 * Divides one part's message in two by its entries, for a part whose
 * compacted encoding still exceeds its bounds. Returns `undefined` for a part
 * with a single entry. Both halves keep the part's place in the sequence: the
 * first keeps its envelope and always carries `more`, and the second, an
 * effect, carries the part's `more`.
 */
export function halveSyncPart(
  message: ServerMessage,
  session: SyncPartSession,
): [ServerMessage, ServerMessage] | undefined {
  const sync = serverMessageSync(message);
  if (sync === undefined) return undefined;
  const entries = entriesOf(sync, SYNC_LISTS);
  if (entries.length < 2) return undefined;
  const middle = Math.ceil(entries.length / 2);
  return [
    inEnvelope(
      message,
      partOf(
        sync,
        SYNC_LISTS,
        entries.slice(0, middle),
        true,
        true,
      ) as SessionSync,
      session,
      true,
    ),
    inEnvelope(
      message,
      partOf(
        sync,
        SYNC_LISTS,
        entries.slice(middle),
        sync.more === true,
        false,
      ) as SessionSync,
      session,
      false,
    ),
  ];
}

/**
 * Collects the parts of the syncs split across a connection's messages, by
 * session, and hands back each sync whole once its last part arrives. A
 * message for a session whose sync is incomplete that carries no sync is
 * handed back as it is: a router answers some of a session's requests
 * itself, and its answer can come between the parts. The next message for
 * the session that carries a sync must be the sync's next part. A sync for a
 * session whose sync is incomplete that is not an effect, a part whose fields
 * differ from the first part's, a `more` other than `true`, and a first part
 * whose session is not known are protocol violations, which throw.
 */
export class SyncPartAssembler {
  #open = new Map<string, {
    first: ServerMessage;
    parts: SessionSync[];
  }>();

  /** Whether some session's sync is incomplete. */
  get pending(): boolean {
    return this.#open.size > 0;
  }

  /**
   * Accepts a decoded message naming `session` (a response's is the session
   * its request named or opened), and returns the message to handle now:
   * `message` itself, a split sync's first envelope carrying the whole sync
   * once its last part arrives, or `undefined` while the sync is incomplete.
   */
  accept(
    message: ServerMessage,
    session: SyncPartSession | undefined,
  ): ServerMessage | undefined {
    const sync = serverMessageSync(message);
    if (sync === undefined) return message;
    // A part names its session, a response's through its request.
    if (session === undefined) {
      requireParts(sync.more === undefined);
      return message;
    }
    const key = `${session.space} ${session.sessionId}`;
    const open = this.#open.get(key);
    if (open === undefined) {
      if (sync.more === undefined) return message;
      requireParts(sync.more === true);
      this.#open.set(key, { first: message, parts: [sync] });
      return undefined;
    }
    requireParts(message.type === "session/effect");
    requireParts(sameFields(open.parts[0], sync, SYNC_LISTS));
    open.parts.push(sync);
    if (sync.more === true) return undefined;
    requireParts(sync.more === undefined);
    this.#open.delete(key);
    return inEnvelope(
      open.first,
      joinLists(open.parts, SYNC_LISTS) as SessionSync,
      session,
      true,
    );
  }

  /** Drops every incomplete sync, as a closed connection's are. */
  clear(): void {
    this.#open.clear();
  }
}

/**
 * Divides a watch set into staged parts whose messages fit `limits`, each
 * naming the set by `message`'s request ID (`stage`) and numbered by the
 * parts before it (`part`), with a request ID of its own made from
 * `message`'s; the last keeps `message`'s. Returns `[message]` when the set
 * has fewer than two entries or its entries fit one part.
 */
export function splitWatchSetRequest(
  message: WatchSetRequest,
  limits: PartLimits,
): WatchSetRequest[] {
  const entries = entriesOf(message, WATCH_SET_LISTS);
  if (entries.length < 2) return [message];
  const partId = (index: number) => `${message.requestId}:part:${index}`;
  const empty = partOf(message, WATCH_SET_LISTS, [], true, true);
  const groups = pack(
    entries,
    entries.map((item) => measure(item.entry)),
    measure({
      ...empty,
      requestId: partId(entries.length),
      stage: message.requestId,
      part: entries.length,
    }),
    limits,
  );
  if (groups.length === 1) return [message];
  return groups.map((group, index) => {
    const last = index === groups.length - 1;
    return {
      ...partOf(message, WATCH_SET_LISTS, group, !last, index === 0),
      requestId: last ? message.requestId : partId(index),
      stage: message.requestId,
      part: index,
    } as WatchSetRequest;
  });
}

/**
 * Appends a staged part's lists to the set `staged` holds, in place; `staged`
 * is the server's own copy, which the first part makes with
 * `stagedWatchSet()`.
 */
export function appendWatchSetPart(
  staged: WatchSetRequest,
  part: WatchSetRequest,
): void {
  for (const { field, entry } of entriesOf(part, WATCH_SET_LISTS)) {
    const held = staged as unknown as Record<string, unknown[]>;
    (held[field] ??= []).push(entry);
  }
  // A list a part names empty is still named.
  for (const field of WATCH_SET_LISTS.fields) {
    const held = staged as unknown as Record<string, unknown[]>;
    if (Array.isArray((part as Record<string, unknown>)[field])) {
      held[field] ??= [];
    }
  }
}

/**
 * The server's own copy of a staged set's first part, with lists of its own
 * for later parts to append to, and without `stage`, `part` or `more`.
 */
export function stagedWatchSet(part: WatchSetRequest): WatchSetRequest {
  const staged: Record<string, unknown> = { ...part };
  delete staged.stage;
  delete staged.part;
  delete staged.more;
  for (const field of WATCH_SET_LISTS.fields) {
    const list = staged[field];
    if (Array.isArray(list)) staged[field] = [...list];
  }
  return staged as WatchSetRequest;
}

/**
 * Helper for the sync split: the size of the fields table encodings add to
 * `sync` in `compacted`, at most half of each bound.
 */
function tablesOf(
  sync: SessionSync,
  compacted: SessionSync | undefined,
  limits: PartLimits,
): Size {
  let bytes = 0;
  let values = 0;
  if (compacted !== undefined) {
    for (const [key, value] of Object.entries(compacted)) {
      if (Object.hasOwn(sync, key)) continue;
      const size = measure(value);
      // The key, its quotes and colon, and the comma before it.
      bytes += size.bytes + key.length + 4;
      values += size.values;
    }
  }
  return {
    bytes: Math.min(bytes, Math.floor(limits.bytes / 2)),
    values: limits.values === null
      ? values
      : Math.min(values, Math.floor(limits.values / 2)),
  };
}

/** Helper for the splits, which lists a message's entries in order. */
function entriesOf(record: object, shape: ListShape): Entry[] {
  const entries: Entry[] = [];
  for (const field of shape.fields) {
    const list = (record as Record<string, unknown>)[field];
    if (Array.isArray(list)) {
      for (const entry of list) entries.push({ field, entry });
    }
  }
  return entries;
}

/**
 * Helper for the splits, which packs entries in order into groups whose
 * messages fit `limits`, given each entry's size and `base`, an empty part's
 * size; each entry is charged the comma before it.
 */
function pack(
  entries: readonly Entry[],
  sizes: readonly Size[],
  base: Size,
  limits: PartLimits,
): Entry[][] {
  const groups: Entry[][] = [];
  let current: Entry[] = [];
  let bytes = base.bytes;
  let values = base.values;
  entries.forEach((item, index) => {
    const size = sizes[index];
    const fits = bytes + size.bytes + 1 <= limits.bytes &&
      (limits.values === null || values + size.values <= limits.values);
    if (!fits && current.length > 0) {
      groups.push(current);
      current = [];
      bytes = base.bytes;
      values = base.values;
    }
    current.push(item);
    bytes += size.bytes + 1;
    values += size.values;
  });
  groups.push(current);
  return groups;
}

/**
 * Helper for the splits, which builds one part of `record` holding
 * `entries`. Required lists are on every part. An optional list is on the
 * parts that carry its entries, and the first part carries every optional
 * list `record` did, empty if its entries are elsewhere, so that a list sent
 * empty is still sent.
 */
function partOf(
  record: object,
  shape: ListShape,
  entries: readonly Entry[],
  more: boolean,
  first: boolean,
): Record<string, unknown> {
  const part: Record<string, unknown> = { ...record };
  for (const field of shape.fields) {
    const carried = Array.isArray(part[field]);
    delete part[field];
    if (shape.required.includes(field) || (first && carried)) part[field] = [];
  }
  for (const { field, entry } of entries) {
    ((part[field] ??= []) as unknown[]).push(entry);
  }
  delete part.more;
  if (more) part.more = true;
  return part;
}

/** Helper for the assembler, which concatenates the parts' lists. */
function joinLists(
  parts: readonly object[],
  shape: ListShape,
): Record<string, unknown> {
  const whole: Record<string, unknown> = { ...parts[0] };
  delete whole.more;
  for (const field of shape.fields) {
    const lists = parts.flatMap((part) => {
      const list = (part as Record<string, unknown>)[field];
      return Array.isArray(list) ? [list as unknown[]] : [];
    });
    if (lists.length > 0) whole[field] = lists.flat();
  }
  return whole;
}

/**
 * Helper for the sync split and assembler, which puts `sync` in `message`'s
 * envelope for a first part and in an effect for `session` otherwise.
 */
function inEnvelope(
  message: ServerMessage,
  sync: SessionSync,
  session: SyncPartSession,
  first: boolean,
): ServerMessage {
  if (!first) {
    return {
      type: "session/effect",
      space: session.space,
      sessionId: session.sessionId,
      effect: sync,
    } satisfies SessionEffectMessage;
  }
  if (message.type === "session/effect") return { ...message, effect: sync };
  const response = message as ResponseMessage<Record<string, unknown>>;
  return { ...response, ok: { ...response.ok, sync } } as ServerMessage;
}

/** Helper for the assembler: whether two parts repeat the same fields. */
function sameFields(first: object, part: object, shape: ListShape): boolean {
  const keys = (record: object) =>
    Object.keys(record).filter((key) =>
      key !== "more" && !shape.fields.includes(key)
    ).sort();
  const firstKeys = keys(first);
  const partKeys = keys(part);
  return firstKeys.length === partKeys.length &&
    firstKeys.every((key, index) =>
      key === partKeys[index] &&
      encodeMemoryBoundary((first as Record<string, never>)[key]) ===
        encodeMemoryBoundary((part as Record<string, never>)[key])
    );
}

function requireParts(condition: boolean): asserts condition {
  if (!condition) {
    const error = new Error("Invalid session sync part");
    error.name = "ProtocolError";
    throw error;
  }
}

/** Helper for the splits: the encoded size of one value, as a message holds it. */
function measure(value: unknown): Size {
  const json = encodeMemoryBoundary(value as never).slice(WIRE_TAG.length);
  return { bytes: utf8Length(json), values: membersWritten(json) + 1 };
}

function utf8Length(text: string): number {
  // Text that is ASCII throughout encodes to one byte a character.
  // deno-lint-ignore no-control-regex
  return /^[\x00-\x7f]*$/.test(text)
    ? text.length
    : TEXT_ENCODER.encode(text).length;
}
