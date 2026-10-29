/**
 * Keeps a Topics board's local copy current for as long as a memory session
 * stays open. The session watches every document the copy holds, and the
 * server pushes each change to it as it commits; each change is applied to
 * the copy and the board's Topics are assembled again, fetching and watching
 * whatever new comment, link, or Topic a changed document now links.
 */

import type { SpaceSession } from "@commonfabric/memory/v2/client";

import { linkOf, type MirrorData } from "./mirror.ts";
import {
  applyDocs,
  assembleBoard,
  chunked,
  declarable,
  type DocSource,
  type FetchedDoc,
  fetchedFrom,
  FRESH_CHUNK,
  heldContent,
  holding,
  locateBoard,
  queryDocs,
  type Refreshed,
  watchOf,
} from "./sync.ts";

/**
 * How many watches following adds, each for documents a change newly needs,
 * before it sets them all again as one: few enough to stay well inside the
 * memory host's limit on watches per session.
 */
const MOST_ADDED = 256;

/**
 * Brings `data` up to date with the board whose piece is `board` through
 * `session`, a session on the space whose DID is `space`, and calls `changed`
 * with the board's Topics, then again after every change the server pushes,
 * until `stop` is aborted, and never after. A watch set by anything else on
 * `session` is replaced. Aborting `stop` and then closing the session ends
 * the following quietly, at whatever point it had reached; the session ending
 * any other way is an error.
 */
export async function followBoard(
  session: SpaceSession,
  space: string,
  data: MirrorData,
  board: string,
  changed: (refreshed: Refreshed) => void | Promise<void>,
  stop: AbortSignal,
): Promise<void> {
  const report = (refreshed: Refreshed) =>
    stop.aborted ? undefined : changed(refreshed);
  try {
    await follow(session, space, data, board, report, stop);
  } catch (error) {
    if (!stop.aborted) throw error;
  }
}

/** Helper for {@link followBoard}, which follows until the session ends. */
async function follow(
  session: SpaceSession,
  space: string,
  data: MirrorData,
  board: string,
  changed: (refreshed: Refreshed) => void | Promise<void>,
  stop: AbortSignal,
): Promise<void> {
  const absent = new Set<string>();
  // Where the entries the board names stopped leading anywhere, as of the
  // last time the board was assembled.
  const waiting = new Set<string>();
  // The documents watched: every one the copy holds or knows to be missing,
  // and every one a change needs from then on, so that the server pushes
  // whatever happens to each.
  let watched = new Set<string>();
  let added = 0;
  // Watches `ids` in watches of their own, returning what the server sent of
  // them: each one this session was not sent before, whole.
  const add = async (ids: readonly string[]) => {
    const sent: FetchedDoc[] = [];
    for (const chunk of chunked(ids, FRESH_CHUNK)) {
      const { sync } = await session.watchAddSync([
        watchOf(`topics-live-${++added}`, chunk),
      ]);
      for (const doc of fetchedFrom(sync.upserts, watched)) sent.push(doc);
    }
    return sent;
  };
  // Watches afresh what the copy holds or knows to be missing, where entries
  // stop leading anywhere, and `also`.
  // The first watch declares the revisions the copy holds, with the
  // content-addressed documents that ride along, as many as one request may,
  // so that the server sends only what moved; the rest go in watches of
  // their own.
  const rewatch = async (also: readonly string[] = []) => {
    watched = new Set([...heldContent(data), ...absent, ...waiting, ...also]);
    const all = [...watched];
    const addressed = Object.keys(data.docs).filter((id) =>
      id.startsWith("cid:")
    );
    const declared = all.slice(0, declarable(addressed.length));
    const { sync, view } = await session.watchSetSync(
      [watchOf("topics-live", declared)],
      [...declared, ...addressed].flatMap((id) =>
        id in data.docs ? [holding(id, data.docs[id])] : []
      ),
    );
    added = 0;
    return {
      view,
      docs: [
        ...fetchedFrom(sync.upserts, watched),
        ...await add(all.slice(declared.length)),
      ],
    };
  };
  // Watches those of `ids` not yet watched. Past `MOST_ADDED` watches added,
  // everything is watched afresh, so that the watches stay few however long
  // the view runs.
  const watch = async (ids: readonly string[]) => {
    const fresh = ids.filter((id) => !watched.has(id));
    if (fresh.length === 0) return [];
    if (added + Math.ceil(fresh.length / FRESH_CHUNK) > MOST_ADDED) {
      return (await rewatch(fresh)).docs;
    }
    for (const id of fresh) watched.add(id);
    return await add(fresh);
  };
  // The server sends a document it never sent this session; one it did,
  // which the copy has since let go, is read as it stands. Where an entry
  // stops leading anywhere is watched, so that the entry is followed again
  // once it leads on.
  const source: DocSource = {
    space,
    async fetch(ids) {
      const sent = await watch(ids);
      const got = new Set(sent.map((doc) => doc.id));
      const rest = ids.filter((id) => !got.has(id));
      return rest.length === 0
        ? sent
        : [...sent, ...await queryDocs(session, rest)];
    },
    async lookup(ids) {
      const found = await queryDocs(session, ids);
      const onward = new Set(
        found.flatMap((doc) =>
          linkOf(doc.argument) ?? linkOf(doc.value) ? [doc.id] : []
        ),
      );
      const ends = ids.filter((id) => !onward.has(id));
      for (const id of ends) waiting.add(id);
      return [...found, ...await watch(ends)];
    },
  };
  const { boardInput } = await locateBoard(data, board, source);
  const first = await rewatch();
  const pushed = first.view.subscribeSync();
  let docs = first.docs;
  let assemble = true;
  for (;;) {
    // A push can come after a newer revision of its document was read, and
    // is then not taken.
    const newer = docs.filter((doc) =>
      (data.docs[doc.id]?.seq ?? -1) < doc.seq
    );
    applyDocs(data, newer, absent);
    if (assemble || newer.length > 0) {
      assemble = false;
      waiting.clear();
      await changed(await assembleBoard(data, boardInput, source, absent));
    }
    if (stop.aborted) return;
    const next = await pushed.next();
    if (next.done) {
      throw session.closeError ?? new Error("The memory session ended.");
    }
    // A document the copy has let go, which no Topic reads, waits until a
    // change needs it again.
    docs = fetchedFrom(next.value.upserts, watched).filter((doc) =>
      doc.id in data.docs || absent.has(doc.id) || waiting.has(doc.id)
    );
  }
}
