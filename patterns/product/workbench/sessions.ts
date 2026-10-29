/**
 * What a workbench reads and records about a person's agent sessions: the
 * agents connector's session index through narrow views, the sessions the
 * piece has attached to its subject, the starts it has sent, and the rows
 * its rail renders. Shared by the topic workbench and the person workbench,
 * which stay separate pieces because each one's queue, attachments, and
 * starts belong to the viewer; what they read of the index is the same.
 *
 * Attachments and starts are keyed records written with the mergeable
 * methods (`docs/features/keyed-collection-writes.md`), so the same person
 * writing from two tabs, or a session attaching itself from a skill, do not
 * overwrite each other. A start is confirmed by the index carrying the
 * session it named. That confirmation is derived on read, and a pattern
 * writes only in a handler, so the start's own record is what keeps a
 * started session attached: the record holds every start sent, and dropping
 * one detaches its session.
 */

import { Default, lift, Writable } from "commonfabric";

import { sessionKey } from "./session-key.ts";

//
// Views of the connector's index
//

/** One session row of the agents connector's index, as a workbench reads
 * it: the shallow fields and nothing under the manifest. */
export interface SessionEntry {
  sourceId: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  updatedAt: string | null;
  active: boolean | null;
  archived: boolean | null;
  syncStatus: string;
}

/** One checkout the connector discovered below its configured roots. */
export interface CheckoutEntry {
  root: string;
  branch?: string | null;
  commit?: string | null;
}

/** One source the connector collects, as the index's status rows name it. */
export interface SourceEntry {
  id: string;
  driver: string;
}

/** The index's source rows to the depth the harness picker reads: the row
 * and the one capability a workbench acts on, whether the driver can start
 * a session (the connector publishes each driver's capabilities). Declared
 * apart from `SessionIndexView`, which is a piece's argument contract: a
 * typed field added inside that contract's `SourceEntry | undefined`
 * alternatives is a narrowing the update-compatibility check refuses, while
 * a lift's own parameter type is what bounds its read. */
export interface StartableSourcesView {
  sources?: Array<
    | {
      id: string;
      driver: string;
      capabilities?: { startSession?: boolean; surfaces?: string[] };
    }
    | undefined
  >;
}

/** Which of the connector's two indexes is linked. The connector publishes
 * a `recent` bucket, which drops deleted rows and rows older than a week,
 * and an `all` bucket, which keeps every row it has published; a start is
 * confirmed by its row, so only the `all` bucket keeps a started session
 * attached. Read through a lift, apart from the argument contract, for the
 * reason `StartableSourcesView` gives. */
export interface IndexBucketView {
  ownerDid?: string;
  bucket?: string;
}

/** A session entry with the desktop start that made it, as the lifts that
 * confirm starts read the index. The argument contract's `SessionEntry` sits
 * in `SessionEntry | undefined` alternatives, where the update-compatibility
 * check allows no evolution, so the field is declared on this lift-local
 * view instead, which a lift's own parameter type reads through. */
export interface PairedSessionEntry {
  sourceId: string;
  nativeSessionId: string;
  title: string | null;
  cwd: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitWorktreeRoot: string | null;
  updatedAt: string | null;
  active: boolean | null;
  archived: boolean | null;
  syncStatus: string;
  /** The id a `start` command named, when the app made this session for a
   * desktop start under an id of its own. */
  startedAs?: string;
}

/** The index as the lifts that confirm starts read it: `SessionIndexView`
 * with each session's pairing. */
export interface PairedSessionIndexView {
  schema: string;
  ownerDid?: string;
  generatedAt?: string;
  sources?: Array<SourceEntry | undefined>;
  sessions: Array<PairedSessionEntry | undefined>;
  checkouts?: Array<CheckoutEntry | undefined>;
}

/** A harness shown in the picker that no configured source backs. */
export interface ShownHarness {
  id: string;
  driver: string;
}

/** A JSON-encoded connector command, as the connector's queues hold them. */
export type CommandValue = string;

/** The connector's session index, declared to the depth a workbench reads.
 * Every array element the connector publishes is a linked child cell; the
 * `undefined` branch is a child that has not loaded yet, and the reads below
 * skip it. Declared inline, the way a board declares its linked topics: a
 * workbench reads the shallow fields and never forwards a row as a cell.
 * `recentMessages` is deliberately not declared: reading it walks every
 * session's event documents. */
export interface SessionIndexView {
  schema: string;
  /** The connector owner's DID; every command a workbench sends names it. */
  ownerDid?: string;
  generatedAt?: string;
  sources?: Array<SourceEntry | undefined>;
  sessions: Array<SessionEntry | undefined>;
  checkouts?: Array<CheckoutEntry | undefined>;
}

//
// The workbench's own records
//

/** A session a workbench has attached to its subject by hand. The key is
 * provider identity, so the row stays attached across renames and
 * reconnections. */
export interface Attachment {
  sourceId: string;
  nativeSessionId: string;
  title: string;
  attachedAt: number;
  /** The workstream the session was attached under, where one applies. */
  workstreamId?: string;
}

/** A start a workbench has sent, keyed by the session it named. The record
 * holds every start sent: until the index carries the session, the start
 * shows as starting and can be withdrawn; once it does, the record is what
 * attaches the started session, and dropping it detaches the session. */
export interface SessionStart {
  commandId: string;
  sourceId: string;
  nativeSessionId: string;
  title: string;
  startedAt: number;
  /** The workstream the start was made for, where one applies. */
  workstreamId?: string;
}

/** A session as a workbench shows it: the index row joined with whether it
 * is attached. Plain values, derived on read. */
export interface SessionRow {
  key: string;
  sourceId: string;
  nativeSessionId: string;
  title: string;
  cwd: string;
  gitBranch: string;
  gitRepo: string;
  updatedAt: string;
  active: boolean;
  attached: boolean;
  /** The id the start that made this session named, or "" when the session
   * is its own start's or none. */
  startedAs: string;
}

/** One entry of a picker: a harness or a checkout. */
export interface CheckoutOption {
  label: string;
  value: string;
}

/** What the attach verb returns. */
export interface AttachResult {
  attachedAt: number;
  /** False when the session was already attached; the call is idempotent. */
  added: boolean;
}

export interface DetachEvent {
  sourceId: string;
  nativeSessionId: string;
}

//
// Derivations
//
// Module-scope lifts, because the declared parameter is what bounds the read.

export { sessionKey };

/** The index row carrying a session: the row under that id, or the row of
 * a session the app made for a desktop start under an id of its own, which
 * names the start's id as `startedAs`. A plain copy of the fields read, made
 * where the row is live. */
const indexRowFor = (
  index: PairedSessionIndexView | undefined,
  sourceId: string,
  nativeSessionId: string,
):
  | { sourceId: string; nativeSessionId: string; startedAs: string }
  | undefined => {
  const key = sessionKey(sourceId, nativeSessionId);
  for (const s of index?.sessions ?? []) {
    if (s === undefined) continue;
    const own = sessionKey(s.sourceId, s.nativeSessionId) === key;
    const made = !!s.startedAs && sessionKey(s.sourceId, s.startedAs) === key;
    if (own || made) {
      return {
        sourceId: s.sourceId,
        nativeSessionId: s.nativeSessionId,
        startedAs: s.startedAs ?? "",
      };
    }
  }
  return undefined;
};

/** Whether the index carries a session in any state. A row the connector
 * has since marked deleted still confirms that the session existed, so a
 * confirmed start stays attached, showing from its own record the way a
 * manually attached session does once the index drops it. */
const indexCarries = (
  index: PairedSessionIndexView | undefined,
  sourceId: string,
  nativeSessionId: string,
): boolean => indexRowFor(index, sourceId, nativeSessionId) !== undefined;

/** One session the app made for a desktop start: its own id and the id the
 * start named. Plain values, for a verb that runs where the index is read
 * through the argument contract and so cannot see the pairing itself. */
export interface SessionPairing {
  sourceId: string;
  nativeSessionId: string;
  startedAs: string;
}

/** The pairings the index carries, read where the rows are live. */
export const pairingsOf = lift((
  { index }: { index?: PairedSessionIndexView },
): SessionPairing[] =>
  (index?.sessions ?? []).flatMap((s) =>
    s?.startedAs
      ? [{
        sourceId: s.sourceId,
        nativeSessionId: s.nativeSessionId,
        startedAs: s.startedAs,
      }]
      : []
  )
);

/** The id the start that made a session named, from the pairings under the
 * session's own id; "" when none names it. */
export const startedAsOf = (
  pairings: readonly SessionPairing[],
  sourceId: string,
  nativeSessionId: string,
): string => {
  const key = sessionKey(sourceId, nativeSessionId);
  for (const p of pairings) {
    if (sessionKey(p.sourceId, p.nativeSessionId) === key) return p.startedAs;
  }
  return "";
};

/** The starts the index has confirmed, as attachments: the connector
 * published the session the start named, so it is the person's. */
export const confirmedStartsOf = lift((
  { starts, index }: {
    starts: SessionStart[] | Default<[]>;
    index?: PairedSessionIndexView;
  },
): Attachment[] =>
  // The attachment names the session's own id: a desktop start's session
  // carries an id the app minted, and the rows join on it.
  starts.flatMap((s) => {
    const row = indexRowFor(index, s.sourceId, s.nativeSessionId);
    return row === undefined ? [] : [{
      sourceId: s.sourceId,
      nativeSessionId: row.nativeSessionId,
      title: s.title,
      attachedAt: s.startedAt,
      ...(s.workstreamId ? { workstreamId: s.workstreamId } : {}),
    }];
  })
);

/** The starts the index has not confirmed: still starting, or refused by
 * the connector, which the person can withdraw. */
export const startingOf = lift((
  { starts, index }: {
    starts: SessionStart[] | Default<[]>;
    index?: PairedSessionIndexView;
  },
): SessionStart[] =>
  starts.filter((s) => !indexCarries(index, s.sourceId, s.nativeSessionId))
);

/** The attachments and the confirmed starts as one list, one per session,
 * in the order they were attached or started. A session both attached by
 * hand and started keeps the hand-made record, taking the start's title when
 * that record names none, as a skill attaching its own session does. */
export const attachmentsOf = lift((
  { attached, confirmed }: {
    attached: Attachment[] | Default<[]>;
    confirmed: Attachment[];
  },
): Attachment[] => {
  const started = new Map(
    confirmed.map((c) => [sessionKey(c.sourceId, c.nativeSessionId), c]),
  );
  // Plain copies, read here where the records are live, so what this list
  // hands on carries every field.
  const byHand = attached.map((a) => {
    const start = started.get(sessionKey(a.sourceId, a.nativeSessionId));
    return {
      ...a,
      title: a.title || start?.title || "",
    };
  });
  const keys = new Set(
    byHand.map((a) => sessionKey(a.sourceId, a.nativeSessionId)),
  );
  return [
    ...byHand,
    ...confirmed.filter((c) =>
      !keys.has(sessionKey(c.sourceId, c.nativeSessionId))
    ),
  ].toSorted((a, b) => a.attachedAt - b.attachedAt);
});

/** Every session the index holds, newest first, with the fields the rows
 * render. Reads the shallow row and nothing under the manifest. */
export const sessionRowsOf = lift((
  { index, attached }: {
    index?: PairedSessionIndexView;
    attached: Attachment[] | Default<[]>;
  },
): SessionRow[] => {
  const attachedKeys = new Set(
    attached.map((a) => sessionKey(a.sourceId, a.nativeSessionId)),
  );
  const rows: SessionRow[] = [];
  for (const s of index?.sessions ?? []) {
    if (!s || s.syncStatus === "deleted") continue;
    const key = sessionKey(s.sourceId, s.nativeSessionId);
    rows.push({
      key,
      sourceId: s.sourceId,
      nativeSessionId: s.nativeSessionId,
      title: s.title ?? "",
      cwd: s.cwd ?? "",
      gitBranch: s.gitBranch ?? "",
      gitRepo: s.gitRepo ?? "",
      updatedAt: s.updatedAt ?? "",
      active: s.active === true,
      attached: attachedKeys.has(key),
      startedAs: s.startedAs ?? "",
    });
  }
  return rows.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
});

/** The row an attachment shows as when the index does not carry its
 * session: the record's own facts, and nothing of the live row. */
export const rowFromAttachment = (a: Attachment): SessionRow => ({
  key: sessionKey(a.sourceId, a.nativeSessionId),
  sourceId: a.sourceId,
  nativeSessionId: a.nativeSessionId,
  title: a.title,
  cwd: "",
  gitBranch: "",
  gitRepo: "",
  updatedAt: "",
  active: false,
  attached: true,
  startedAs: "",
});

/** The attached sessions, in attach order, each joined with its live row when
 * the index still carries it. A session the index no longer holds still shows,
 * from the attachment's own record, so an attachment never silently vanishes. */
export const attachedRowsOf = lift((
  { attached, rows }: {
    attached: Attachment[] | Default<[]>;
    rows: SessionRow[];
  },
): SessionRow[] =>
  attached.map((a) => {
    const key = sessionKey(a.sourceId, a.nativeSessionId);
    return rows.find((r) => r.key === key) ?? rowFromAttachment(a);
  })
);

/** The newest unattached sessions, bounded. */
export const recentRowsOf = lift((
  { rows, limit }: { rows: SessionRow[]; limit: number },
): SessionRow[] => rows.filter((r) => !r.attached).slice(0, limit));

/** A caution about the linked index, or "" when there is none to give: a
 * linked index that is not the connector's `all` bucket stops carrying rows
 * as they age, and with them the starts they confirm. */
export const indexNoteOf = lift((
  { index }: { index?: IndexBucketView },
): string => {
  if (!index?.ownerDid || index.bucket === "all") return "";
  const named = index.bucket ? `the connector's ${index.bucket} bucket` : "";
  return `The linked session index is ${
    named || "not the connector's complete index"
  }, which stops listing sessions as they age; a started session stays attached only while it is listed. Link the complete index instead.`;
});

/** Whether a text is empty once trimmed. A lift, because `.length` on a
 * reactive string reads a path into it, which is not an object. */
export const isEmptyText = lift((
  { text }: { text: string },
): boolean => text.trim().length === 0);

const whenIso = (iso: string): string =>
  iso ? iso.replace("T", " ").slice(0, 16) : "";

const tail = (path: string, parts = 2): string =>
  path.split("/").filter(Boolean).slice(-parts).join("/");

/** The one-line caption under a session's title. Module scope, because a
 * callable used inside a reactive `.map()` must be self-contained. */
export const captionOf = (row: SessionRow): string =>
  [
    row.sourceId,
    row.gitBranch,
    row.cwd ? tail(row.cwd) : "",
    row.updatedAt ? whenIso(row.updatedAt) : "",
  ].filter((part) => part.length > 0).join(" · ");

/** The color of the dot beside a session: live, or at rest. */
export const sessionDotColor = (active: boolean): string =>
  active ? "#2A7A55" : "#C2CAD0";

//
// Keyed writes
//
// Handler-side helpers: a record per session under its `sessionKey`,
// membership added if absent and removed by value, the record cleared on
// removal so a later write of the same session starts fresh.

/** Records the attachment when none is there and adds it to the list: a
 * keyed record and an add-if-absent membership, so the same person writing
 * from two tabs or a session's own skill do not overwrite each other. True
 * when the record was new. */
export const recordAttachment = (
  attached: Writable<Attachment[] | Default<[]>>,
  attachment: Attachment,
): boolean => {
  const record = attached.elementById(
    sessionKey(attachment.sourceId, attachment.nativeSessionId),
  );
  const added = record.get() === undefined;
  if (added) record.set(attachment);
  attached.addUnique(record);
  return added;
};

/** Drops a session's attachment and clears its record, so a later attach of
 * the same session starts fresh rather than reviving this one. */
export const dropAttachment = (
  attached: Writable<Attachment[] | Default<[]>>,
  sourceId: string,
  nativeSessionId: string,
): void => {
  const key = sessionKey(sourceId, nativeSessionId);
  attached.removeByValue(attached.elementById(key));
  const record: Writable<Attachment | undefined> = attached.elementById(key);
  record.set(undefined);
};

/** Records a start, keyed by the session it named. */
export const recordStart = (
  starts: Writable<SessionStart[] | Default<[]>>,
  start: SessionStart,
): void => {
  const record = starts.elementById(
    sessionKey(start.sourceId, start.nativeSessionId),
  );
  record.set(start);
  starts.addUnique(record);
};

/** Drops a start and clears its record: the person withdrew it, or detached
 * the session it became. */
export const dropStart = (
  starts: Writable<SessionStart[] | Default<[]>>,
  sourceId: string,
  nativeSessionId: string,
  startedAs = "",
): void => {
  // A desktop start's record lives under the id the start named, while its
  // session carries that id as `startedAs`: a detach by the session's own
  // id drops the record under either.
  const ids = startedAs && startedAs !== nativeSessionId
    ? [nativeSessionId, startedAs]
    : [nativeSessionId];
  for (const id of ids) {
    const key = sessionKey(sourceId, id);
    starts.removeByValue(starts.elementById(key));
    const record: Writable<SessionStart | undefined> = starts.elementById(key);
    record.set(undefined);
  }
};
