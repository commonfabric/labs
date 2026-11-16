/**
 * Keeps a Topics board's local copy current. A refresh declares every
 * document the copy holds, with the revision it holds it at, and the server
 * sends back only the documents whose revision moved; documents a newly
 * assembled Topic needs and the copy lacks are fetched in further rounds. A
 * refresh that finds nothing changed receives no document bodies.
 *
 * The documents are read over a memory session of their own rather than
 * through a runtime: nothing is computed, so nothing runs, and a read commits
 * nothing to the space.
 */

import { dirname } from "@std/path/dirname";
import { join } from "@std/path/join";
import {
  createSession,
  Identity,
  legacySpaceDid,
} from "@commonfabric/identity";
import { type DID, isDID } from "@commonfabric/identity/did";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import type {
  EntityDocument,
  GraphQuery,
  SessionHolding,
  SessionSyncUpsert,
  WatchSpec,
} from "@commonfabric/memory/v2";
import type { SpaceSession } from "@commonfabric/memory/v2/client";
import { ROUTED_HOLDINGS_LIMIT } from "@commonfabric/memory/v2/routed-limits";
import { settingsForDeployedClient } from "@commonfabric/runner/deployment-meta";
import { namesInstancesByDefault } from "@commonfabric/runner/instance-naming";
import {
  RemoteSessionFactory,
  type SessionFactory,
  storageAddressForHost,
} from "@commonfabric/runner/storage/v2-remote-session";
import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import { describeFailure } from "@commonfabric/js-values/describe-failure";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import {
  assembleTopic,
  DocReader,
  type HeldDoc,
  linkOf,
  type MirrorData,
  type PieceInput,
  type Plain,
  storedAsExpected,
  type Topic,
  topicPieces,
  toPlain,
} from "./mirror.ts";

/** One document as a fetch returned it. */
export interface FetchedDoc {
  id: string;
  seq: number;
  value?: Plain;

  /** The document's `argument` field: a piece document's input link. */
  argument?: Plain;

  /**
   * The CFC label envelope the document stores beside its value, `null`
   * for a document storing none.
   */
  cfc?: Plain | null;

  /** Set for a document that was deleted. */
  deleted?: true;

  /**
   * Set for a document the server sent along with another rather than
   * because it was watched, which the copy takes only as far as it holds it.
   */
  riding?: true;
}

/** A document the fetching side already holds, at the revision it holds. */
export type Holding = Pick<SessionHolding, "id" | "seq">;

/** Where a refresh reads documents from. */
export interface DocSource {
  /** The space's DID. */
  readonly space: string;

  /**
   * Fetches the documents named by `ids`, and may leave out one `held`
   * names at its current revision. A document that was never written is
   * left out, or returned as deleted.
   */
  fetch(
    ids: readonly string[],
    held: readonly Holding[],
  ): Promise<FetchedDoc[]>;

  /**
   * Fetches the documents named by `ids` once, as they stand. A document that
   * was never written is left out, or returned as deleted. A source that
   * keeps watching what it fetches keeps watching only those of these that
   * lead nowhere yet.
   */
  lookup(ids: readonly string[]): Promise<FetchedDoc[]>;
}

/** What a refresh produced. */
export interface Refreshed {
  topics: Topic[];

  /** The board's input document, which holds its entries. */
  boardInput: string;

  /** How many documents the server sent. */
  fetched: number;

  /** The numbers of the board's entries that lead to no Topic piece. */
  unreached: string[];

  /**
   * The numbers of Topics whose input documents do not hold a title,
   * comments, and links where the Topics pattern stores them, and which
   * therefore read as blank.
   */
  unreadable: string[];
}

/**
 * Brings `data` up to date with the board whose piece is `board`, in place,
 * and returns the board's Topics, ordered by number.
 */
export async function refreshMirror(
  data: MirrorData,
  board: string,
  source: DocSource,
): Promise<Refreshed> {
  const { boardInput, fetched } = await locateBoard(data, board, source);
  const absent = new Set<string>();
  const changed = await source.fetch(
    heldContent(data),
    Object.entries(data.docs).map(([id, doc]) => holding(id, doc)),
  );
  applyDocs(data, changed, absent);
  const assembled = await assembleBoard(data, boardInput, source, absent);
  return {
    ...assembled,
    fetched: fetched + changed.length + assembled.fetched,
  };
}

/**
 * The input document of the board whose piece is `board`, which `data`
 * records once `source` has been read for it, and how many documents that
 * reading took.
 */
export async function locateBoard(
  data: MirrorData,
  board: string,
  source: DocSource,
): Promise<{ boardInput: string; fetched: number }> {
  data.space = source.space;
  let fetched = 0;
  if (data.boardInput === undefined) {
    const located = await resolvePieces(source, [board]);
    fetched += located.fetched;
    data.boardInput = located.resolved.get(board)?.input;
  }
  const boardInput = data.boardInput;
  if (boardInput === undefined) {
    throw new Error(`The board \`${board}\` has no input document.`);
  }
  return { boardInput, fetched };
}

/**
 * The documents the copy holds the content of, the board's input document
 * first.
 */
export function heldContent(data: MirrorData): string[] {
  const boardInput = data.boardInput;
  return [
    ...(boardInput === undefined ? [] : [boardInput]),
    ...Object.entries(data.docs).flatMap(([id, doc]) =>
      id !== boardInput && doc.value !== undefined ? [id] : []
    ),
  ];
}

/**
 * Records `docs` in `data`. A deleted document keeps only its revision, and
 * `absent` records it so that it reads as nothing until it is written again.
 */
export function applyDocs(
  data: MirrorData,
  docs: readonly FetchedDoc[],
  absent: Set<string>,
): void {
  for (const doc of docs) {
    if (doc.deleted) {
      // The revision stays, so that nothing older takes the document back,
      // and one the copy watches or holds is known to be gone.
      if (!doc.riding || data.docs[doc.id]?.value !== undefined) {
        absent.add(doc.id);
      }
      data.docs[doc.id] = { seq: doc.seq };
    } else {
      absent.delete(doc.id);
      const held = data.docs[doc.id];
      // A document riding along that the copy holds for its revision alone,
      // a piece, say, or not at all, is kept for its revision alone; one it
      // holds the content of, or a content-addressed one, which never
      // changes and whose content is small, is kept whole.
      const whole = !doc.riding || held?.value !== undefined ||
        doc.id.startsWith("cid:");
      // A content-addressed document sent without its content keeps the
      // content the copy holds.
      const value = whole
        ? doc.value ?? (doc.id.startsWith("cid:") ? held?.value : undefined)
        : undefined;
      data.docs[doc.id] = {
        seq: doc.seq,
        ...(value === undefined ? {} : { value }),
        ...(!whole || doc.cfc === undefined ? {} : { cfc: doc.cfc }),
      };
    }
  }
}

/**
 * Assembles the Topics of the board whose input document is `boardInput`
 * from `data`, fetching from `source` the documents a Topic needs and the
 * copy lacks, and resolving entries the copy has not followed to their
 * pieces. `absent` names documents known not to exist. Prunes what no Topic
 * read, and returns the Topics ordered by number.
 */
export async function assembleBoard(
  data: MirrorData,
  boardInput: string,
  source: DocSource,
  absent: Set<string>,
): Promise<Refreshed> {
  let fetched = 0;
  for (;;) {
    const reader = new DocReader(data, source.space, absent);
    const entries = topicPieces(reader, boardInput);
    const unresolved = [...entries.values()].filter((entry) =>
      data.pieces[entry] === undefined
    );
    const found = await resolvePieces(source, unresolved);
    fetched += found.fetched;
    for (const [entry, piece] of found.resolved) data.pieces[entry] = piece;
    const located = [...entries].flatMap(([number, entry]) => {
      const piece = data.pieces[entry];
      return piece === undefined ? [] : [{ number, entry, piece }];
    });
    const topics = located.map(({ number, entry, piece }) =>
      // The board's entry for the Topic is a slot the Topic is reached
      // through.
      assembleTopic(reader, number, entry, piece, [
        { doc: boardInput, path: ["names", number] },
        ...piece.via.map((doc) => ({ doc, path: [] })),
      ])
    );
    if (reader.missing.size === 0) {
      const unreadable = located.flatMap(({ number, piece }) =>
        storedAsExpected(reader, piece.input) ? [] : [number]
      );
      const unreached = [...entries.keys()].filter((number) =>
        data.pieces[entries.get(number) ?? ""] === undefined
      );
      prune(data, new Set([boardInput, ...reader.touched]), entries, absent);
      return {
        topics: topics.sort((a, b) => Number(a.number) - Number(b.number)),
        boardInput,
        fetched,
        unreadable,
        unreached,
      };
    }
    // Documents the copy has no value for; any that still has none after the
    // fetch reads as nothing.
    const ids = [...reader.missing];
    const docs = await source.fetch(ids, revisionOnly(data, reader.missing));
    fetched += docs.length;
    applyDocs(data, docs, absent);
    for (const id of ids) {
      if (data.docs[id]?.value === undefined) absent.add(id);
    }
  }
}

/**
 * Follows each of `ids` through the documents that only link onward until it
 * reaches a piece document, and returns where each one that reaches one
 * leads, with how many documents that took.
 */
export async function resolvePieces(
  source: DocSource,
  ids: readonly string[],
): Promise<{ resolved: Map<string, PieceInput>; fetched: number }> {
  const resolved = new Map<string, PieceInput>();
  const seen = new Set(ids.map((id) => `${id} ${id}`));
  let fetched = 0;
  let frontier = new Map(ids.map((id) => [id, id]));
  // The documents each id was followed through.
  const via = new Map<string, string[]>();
  while (frontier.size > 0) {
    const docs = await source.lookup([...new Set(frontier.values())]);
    fetched += docs.length;
    const byId = new Map(docs.map((doc) => [doc.id, doc]));
    const next = new Map<string, string>();
    for (const [id, at] of frontier) {
      const doc = byId.get(at);
      const input = linkOf(doc?.argument)?.id;
      const onward = linkOf(doc?.value)?.id;
      const passed = via.get(id) ?? [];
      if (input !== undefined) {
        resolved.set(id, { piece: at, input, via: passed });
      } else if (
        doc !== undefined && onward !== undefined &&
        !seen.has(`${id} ${onward}`)
      ) {
        seen.add(`${id} ${onward}`);
        via.set(id, [...passed, at]);
        next.set(id, onward);
      }
    }
    frontier = next;
  }
  return { resolved, fetched };
}

export function holding(id: string, doc: HeldDoc): Holding {
  return { id, seq: doc.seq };
}

/**
 * The holdings for documents the copy keeps only for their revisions, but
 * for those `wanted` for their content, which the server would otherwise
 * leave out as held.
 */
function revisionOnly(
  data: MirrorData,
  wanted: ReadonlySet<string> = new Set(),
): Holding[] {
  return Object.entries(data.docs).flatMap(([id, doc]) =>
    doc.value === undefined && !wanted.has(id) ? [holding(id, doc)] : []
  );
}

/**
 * Drops every document no Topic read, from the copy and from `absent`, and
 * every entry the board no longer names, keeping for their revisions the
 * documents that ride along with what links them: the content-addressed
 * ones, which never change, and the pieces.
 */
function prune(
  data: MirrorData,
  read: ReadonlySet<string>,
  entries: ReadonlyMap<string, string>,
  absent: Set<string>,
): void {
  for (const id of absent) if (!read.has(id)) absent.delete(id);
  const named = new Set(entries.values());
  for (const entry of Object.keys(data.pieces)) {
    if (!named.has(entry)) delete data.pieces[entry];
  }
  // A piece is kept for its revision alone, so that the server, which sends
  // it along with a document that links to it, need not send it again.
  const pieces = new Set(Object.values(data.pieces).map(({ piece }) => piece));
  for (const [id, doc] of Object.entries(data.docs)) {
    if (read.has(id)) continue;
    // A content-addressed document no Topic read is kept for its revision
    // alone too, which spares watching it.
    if (id.startsWith("cid:") || pieces.has(id)) {
      data.docs[id] = { seq: doc.seq };
    } else delete data.docs[id];
  }
}

/**
 * The identity the keyfile at `path` holds.
 *
 * @throws Error naming the keyfile when it cannot be read.
 */
async function loadIdentity(path: string): Promise<Identity> {
  let pkcs8: Uint8Array;
  try {
    pkcs8 = await Deno.readFile(path);
  } catch (error) {
    throw new Error(
      `The identity keyfile \`${path}\` cannot be read (${
        describeFailure(error)
      }); name another with \`--identity\` or \`CF_IDENTITY\`.`,
      { cause: error },
    );
  }
  return await Identity.fromPkcs8(pkcs8);
}

/** The DID of the identity the keyfile at `path` holds. */
export async function identityDid(path: string): Promise<string> {
  return (await loadIdentity(path)).did();
}

/** A {@link DocSource} over a memory session of its own. */
export interface OpenedDocSource extends DocSource {
  close(): Promise<void>;
}

/** How {@link openDocSource} reaches a deployment, injectable for a test. */
export interface DocSourceDeps {
  settings: typeof settingsForDeployedClient;

  /**
   * Opens sessions signed by `signer`, each on the storage endpoint `address`
   * resolves its space to.
   */
  Sessions: new (
    address: (space: MemorySpace) => URL,
    signer: Signer,
  ) => SessionFactory;
}

const defaultDocSourceDeps: DocSourceDeps = {
  settings: settingsForDeployedClient,
  Sessions: RemoteSessionFactory,
};

/**
 * A source on the space whose DID is `space` that has nothing to give, so
 * that {@link refreshMirror} reads a copy as it stands.
 */
export function copySource(space: string): DocSource {
  const nothing = () => Promise.resolve([]);
  return { space, fetch: nothing, lookup: nothing };
}

/** A memory session of its own on a board's space. */
export interface OpenedSession {
  /** The space's DID. */
  space: string;

  session: SpaceSession;
  close(): Promise<void>;
}

/** The DID of the space `space` names, by its DID or by its name. */
export async function spaceDid(space: string): Promise<DID> {
  return isDID(space) ? space : await legacySpaceDid(space);
}

/**
 * Opens a memory session on `space` at the deployment `apiUrl` names, signed
 * by the identity key at `identity`.
 */
export async function openSession(
  config: { apiUrl: string; space: string; identity: string },
  deps: DocSourceDeps = defaultDocSourceDeps,
): Promise<OpenedSession> {
  const apiUrl = new URL(config.apiUrl);
  const [identity, { experimental, memoryHost }] = await Promise.all([
    loadIdentity(config.identity),
    deps.settings({ apiUrl, env: Deno.env.get }),
  ]);
  // A link's decoded form follows the deployment's cell representation, which
  // a runtime would set from these same settings.
  setModernCellRepConfig(experimental.modernCellRep);
  const space = await spaceDid(config.space);
  const session = await createSession({ identity, spaceDid: space });
  const factory = new deps.Sessions(
    () => storageAddressForHost(memoryHost),
    session.as,
  );
  // The server admits a session by the naming mode it declares (INV-16), and
  // no runtime is here to declare one, so the session declares the mode a
  // runtime given these settings would.
  factory.setInstanceNames?.(namesInstancesByDefault(experimental));
  const opened = await factory.create(space, session.as);
  return {
    space,
    session: opened.session,
    async close() {
      await opened.client.close();
      await factory.close?.();
    },
  };
}

/**
 * Opens a {@link DocSource} over a session of its own, as
 * {@link openSession} opens one.
 */
export async function openDocSource(
  config: { apiUrl: string; space: string; identity: string },
  deps: DocSourceDeps = defaultDocSourceDeps,
): Promise<OpenedDocSource> {
  const { space, session, close } = await openSession(config, deps);
  return { ...sessionDocSource(session, space), close };
}

/** How many documents one watch names when the copy holds none of them. */
export const FRESH_CHUNK = 500;

/**
 * How many held documents one watch declares, beside `riding` ones that
 * ride along with them, to stay inside the memory host's limit on the
 * holdings one request may declare.
 */
export function declarable(riding: number): number {
  return Math.max(FRESH_CHUNK, ROUTED_HOLDINGS_LIMIT - riding);
}

/**
 * Of `held`, the holdings of the documents not among `watched`, which ride
 * along with what links them: the content-addressed ones first, since a
 * request may declare only so many, and they are what most documents link.
 */
export function ridingHoldings(
  held: readonly Holding[],
  watched: ReadonlySet<string>,
): Holding[] {
  const riding = held.filter((h) => !watched.has(h.id));
  return [
    ...riding.filter((h) => h.id.startsWith("cid:")),
    ...riding.filter((h) => !h.id.startsWith("cid:")),
  ];
}

/**
 * A {@link DocSource} reading through `session`, a session on the space
 * whose DID is `space`. Each fetch replaces the session's watch set.
 *
 * Documents the copy holds go in as few watches as the memory host's limit
 * on declared holdings allows, so a refresh that finds nothing changed takes
 * one watch for every few thousand documents held. Documents it does not
 * hold go in smaller watches, since the server sends each one whole.
 */
export function sessionDocSource(
  session: SpaceSession,
  space: string,
): DocSource {
  return {
    space,
    async fetch(ids, held) {
      const holdings = new Map(held.map((h) => [h.id, h]));
      // A document held but not watched rides along with whatever links it,
      // a content-addressed one or a piece, so every watch declares it, as
      // many as one request may beside the documents it watches.
      const watched = new Set(ids);
      const riding = ridingHoldings(held, watched);
      const chunks = [
        ...chunked(
          ids.filter((id) => holdings.has(id)),
          declarable(riding.length),
        ),
        ...chunked(ids.filter((id) => !holdings.has(id)), FRESH_CHUNK),
      ];
      // A document sent more than once, in one chunk and with another, is
      // taken once: its newest revision, as watched rather than riding
      // along where both are as new.
      const docs = new Map<string, FetchedDoc>();
      for (const chunk of chunks) {
        const declared = chunk.flatMap((id) => holdings.get(id) ?? []);
        const { sync } = await session.watchSetSync(
          [watchOf("topics", chunk)],
          [
            ...declared,
            ...riding.slice(0, ROUTED_HOLDINGS_LIMIT - declared.length),
          ],
        );
        for (const doc of fetchedFrom(sync.upserts, watched)) {
          const taken = docs.get(doc.id);
          if (
            taken === undefined || doc.seq > taken.seq ||
            (doc.seq === taken.seq && !doc.riding)
          ) {
            docs.set(doc.id, doc);
          }
        }
      }
      return [...docs.values()];
    },
    lookup: (ids) => queryDocs(session, ids),
  };
}

/**
 * The documents `ids` as `session` reads them now, without watching them;
 * one with no content is left out.
 */
export async function queryDocs(
  session: SpaceSession,
  ids: readonly string[],
): Promise<FetchedDoc[]> {
  const { entities } = await session.queryGraph(graphOf(ids));
  return entities.flatMap((entity): FetchedDoc[] =>
    entity.document === null ? [] : [{
      id: entity.id,
      seq: entity.seq,
      ...plainFields(entity.document),
    }]
  );
}

/** A watch named `id` on the documents `ids`, each read whole and alone. */
export function watchOf(id: string, ids: readonly string[]): WatchSpec {
  return { id, kind: "graph", query: graphOf(ids) };
}

/** A query for the documents `ids`, each read whole and alone. */
export function graphOf(ids: readonly string[]): GraphQuery {
  return {
    roots: ids.map((root) => ({
      id: root,
      selector: { path: [], schema: false },
    })),
  };
}

/**
 * The documents among `upserts`, each one `wanted` does not name marked as
 * riding along. A document with no content, deleted or never written,
 * comes back as deleted: the copy holds no record of an absence.
 */
export function fetchedFrom(
  upserts: readonly SessionSyncUpsert[],
  wanted: ReadonlySet<string>,
): FetchedDoc[] {
  // What applying it keeps of a document riding along turns on what the
  // copy holds of it: see `applyDocs`.
  return upserts.map((upsert): FetchedDoc => ({
    id: upsert.id,
    seq: upsert.seq,
    ...(upsert.deleted || upsert.doc === undefined
      ? { deleted: true }
      : plainFields(upsert.doc)),
    ...(wanted.has(upsert.id) ? {} : { riding: true }),
  }));
}

/** `items` in runs of at most `size`. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** The fields of `document` the copy reads, reduced to plain values. */
export function plainFields(
  document: EntityDocument,
): Pick<FetchedDoc, "value" | "argument" | "cfc"> {
  const value = toPlain(document.value);
  const argument = toPlain(document.argument);
  const cfc = document.cfc === undefined ? null : toPlain(document.cfc);
  return {
    ...(value === undefined ? {} : { value }),
    ...(argument === undefined ? {} : { argument }),
    // An envelope with no plain form is left out, and so reads as not known.
    ...(cfc === undefined ? {} : { cfc }),
  };
}

/**
 * Where a file about `board` at `apiUrl` is kept: the copy of the board,
 * named `.json`, under the user's cache directory, which is safe to clear;
 * the invocation session its writes are chosen within, named
 * `.invocation-session`, and what `browse` remembers for `viewer`, named
 * after the viewer and `.browse.json`, under the user's state directory,
 * which outlives a cleared cache so that a write can still be settled, and
 * a draft finished, after one. What `browse` remembers is kept apart for
 * each identity, so that a write one asked for is never made as another.
 */
export function boardFile(
  kind: "copy" | "session" | { browse: string },
  apiUrl: string,
  space: string,
  board: string,
  env: (name: string) => string | undefined = Deno.env.get,
): string {
  const home = env("HOME") ?? ".";
  const root = kind === "copy"
    ? env("XDG_CACHE_HOME") ?? join(home, ".cache")
    : env("XDG_STATE_HOME") ?? join(home, ".local", "state");
  // Percent-encoded, dots included, so that no two names share a file and no
  // name climbs out of the directory.
  const name = (part: string) =>
    encodeURIComponent(part).replaceAll(".", "%2E");
  return join(
    root,
    "commonfabric",
    "topics",
    name(new URL(apiUrl).host),
    name(space),
    `${name(board)}${
      kind === "copy"
        ? ".json"
        : kind === "session"
        ? ".invocation-session"
        : `.${name(kind.browse)}.browse.json`
    }`,
  );
}

/**
 * Reads the copy at `path`. A copy that is absent or unreadable is an empty
 * one, which the next refresh fills: the copy holds nothing the server does
 * not.
 */
export async function loadMirror(path: string): Promise<MirrorData> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound || error instanceof SyntaxError) {
      return { pieces: {}, docs: {} };
    }
    throw error;
  }
  if (!isMirrorData(parsed)) return { pieces: {}, docs: {} };
  // A document read, or an entry followed, before the copy kept label
  // envelopes is read again, rather than taken for one storing none.
  for (const [entry, piece] of Object.entries(parsed.pieces)) {
    const { via } = piece;
    if (!Array.isArray(via) || !via.every((doc) => typeof doc === "string")) {
      delete parsed.pieces[entry];
    }
  }
  for (const [id, doc] of Object.entries(parsed.docs)) {
    if (!id.startsWith("cid:") && doc.value !== undefined && !("cfc" in doc)) {
      delete parsed.docs[id];
    }
  }
  return parsed;
}

function isMirrorData(value: unknown): value is MirrorData {
  if (!isObjectNotArray(value)) return false;
  const { space, boardInput, pieces, docs } = value;
  return (space === undefined || typeof space === "string") &&
    (boardInput === undefined || typeof boardInput === "string") &&
    isObjectNotArray(pieces) &&
    Object.values(pieces).every((piece) =>
      isObjectNotArray(piece) && typeof piece.piece === "string" &&
      typeof piece.input === "string"
    ) &&
    isObjectNotArray(docs) &&
    Object.values(docs).every((doc) =>
      isObjectNotArray(doc) && typeof doc.seq === "number"
    );
}

/**
 * Writes the copy to `path` by renaming a finished file into place, so a
 * reader running at the same time sees one whole copy or the other.
 */
export async function saveMirror(
  path: string,
  data: MirrorData,
): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await replaceFile(path, JSON.stringify(data));
}

/**
 * Replaces the file at `path` with `text` whole, readable only by its
 * owner: written beside it and on the disk before it takes the file's
 * place, so that a reader, or the next run after a crash, finds either the
 * old file or the new one.
 */
export async function replaceFile(path: string, text: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temporary, text, { mode: 0o600 });
    {
      using file = await Deno.open(temporary, { write: true });
      await file.sync();
    }
    await Deno.rename(temporary, path);
  } catch (error) {
    await Deno.remove(temporary).catch(() => {});
    throw error;
  }
  // The rename is on the disk once the directory holding it is, where a
  // directory can be synced; Windows journals a rename itself.
  if (Deno.build.os !== "windows") {
    using directory = await Deno.open(dirname(path));
    await directory.sync();
  }
}
