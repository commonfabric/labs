import { chunkEvents } from "./chunking.ts";
import { hashStableArrayValue } from "./array-cell-identity.ts";
import { stableFabricValue } from "./stable-fabric-value.ts";
import { sessionKey } from "./session-contract.ts";
import type {
  AgentDriver,
  NativeSessionSnapshot,
  SessionSummary,
  SourceDescriptor,
} from "./types.ts";

export interface CollectedSource {
  source: SourceDescriptor;
  sessions: NativeSessionSnapshot[];
  /**
   * Inventory summaries whose published copies are current, listed without
   * being read. Absent means every listed session was read.
   */
  retained?: readonly SessionSummary[];
  errors: Array<{ nativeSessionId?: string; message: string }>;
  complete: boolean;
}

export interface CollectSourceOptions {
  signal?: AbortSignal;
  /**
   * Decides from an inventory summary alone whether the session's published
   * copy is current. A session it accepts is retained rather than read.
   */
  retain?: (summary: SessionSummary) => boolean;
}

export interface SourceCollectionOutcome {
  errors: Array<{ nativeSessionId?: string; message: string }>;
  complete: boolean;
  sessionCount: number;
  consumed: boolean;
}

export interface StreamingCollectedSource {
  source: SourceDescriptor;
  sessions: AsyncIterable<NativeSessionSnapshot>;
  /** Inventory summaries retained without reading their published sessions. */
  retained: SessionSummary[];

  outcome: SourceCollectionOutcome;
}

export type SourceCollection = CollectedSource | StreamingCollectedSource;

export interface PreparedSessionChunk {
  part: number;
  events: unknown[];
  byteLength: number;
  eventCount: number;
  contentHash: string;
}

export interface PreparedSession {
  key: string;
  sourceId: string;
  nativeSessionId: string;
  summary: NativeSessionSnapshot["summary"];
  normalizedMessages: NativeSessionSnapshot["normalizedMessages"];
  chunks: PreparedSessionChunk[];
  complete: boolean;
  revision?: string;
  snapshotHash: string;
}

export interface PreparedSessionDescription
  extends Omit<PreparedSession, "chunks"> {
  chunks: Array<Omit<PreparedSessionChunk, "events">>;
}

export type PreparedSessionHeader = Omit<
  PreparedSessionDescription,
  "chunks" | "snapshotHash"
>;

const MAX_SESSION_SUMMARIES = 100_000;

export type SourceCollectionSignal =
  | AbortSignal
  | (() => AbortSignal | undefined);

function currentSignal(
  signal?: SourceCollectionSignal,
): AbortSignal | undefined {
  return typeof signal === "function" ? signal() : signal;
}

function snapshotWithInventoryLifecycle(
  snapshot: NativeSessionSnapshot,
  summary: NativeSessionSnapshot["summary"],
): NativeSessionSnapshot {
  return {
    ...snapshot,
    summary: {
      ...snapshot.summary,
      archived: snapshot.summary.archived ?? summary.archived,
      active: snapshot.summary.active ?? summary.active,
    },
  };
}

/** Reads source pages and yields each snapshot before reading the next. */
export function streamSource(
  driver: AgentDriver,
  signal?: SourceCollectionSignal,
  retain?: CollectSourceOptions["retain"],
): StreamingCollectedSource {
  const outcome: SourceCollectionOutcome = {
    errors: [],
    complete: false,
    sessionCount: 0,
    consumed: false,
  };
  const retained: SessionSummary[] = [];
  const sessions = async function* (): AsyncGenerator<NativeSessionSnapshot> {
    outcome.consumed = true;
    const seenCursors = new Set<string>();
    const seenSessions = new Set<string>();
    const repeatedSessions = new Set<string>();
    let cursor: string | undefined;
    let summaryCount = 0;
    let enumerationComplete = false;
    let sessionsComplete = true;
    try {
      while (true) {
        if (cursor && seenCursors.has(cursor)) {
          throw new Error(`repeated session cursor: ${cursor}`);
        }
        if (cursor) seenCursors.add(cursor);
        currentSignal(signal)?.throwIfAborted();
        const page = await driver.listSessions(cursor);
        currentSignal(signal)?.throwIfAborted();
        if (page.sessions.length > MAX_SESSION_SUMMARIES - summaryCount) {
          throw new Error("session enumeration exceeded safety limit");
        }
        summaryCount += page.sessions.length;
        for (const summary of page.sessions) {
          if (seenSessions.has(summary.nativeSessionId)) {
            if (!repeatedSessions.has(summary.nativeSessionId)) {
              repeatedSessions.add(summary.nativeSessionId);
              outcome.errors.push({
                nativeSessionId: summary.nativeSessionId,
                message:
                  `duplicate session in inventory: ${summary.nativeSessionId}`,
              });
            }
            continue;
          }
          seenSessions.add(summary.nativeSessionId);
          currentSignal(signal)?.throwIfAborted();
          if (retain?.(summary)) {
            retained.push(summary);
            continue;
          }
          try {
            currentSignal(signal)?.throwIfAborted();
            const snapshot = await driver.readSession(summary.nativeSessionId);
            currentSignal(signal)?.throwIfAborted();
            const collected = snapshotWithInventoryLifecycle(snapshot, summary);
            outcome.sessionCount++;
            sessionsComplete &&= collected.complete;
            yield collected;
          } catch (error) {
            currentSignal(signal)?.throwIfAborted();
            outcome.errors.push({
              nativeSessionId: summary.nativeSessionId,
              message: String(error),
            });
          }
        }
        if (!page.nextCursor) {
          enumerationComplete = true;
          break;
        }
        cursor = page.nextCursor;
      }
    } catch (error) {
      currentSignal(signal)?.throwIfAborted();
      outcome.errors.push({ message: String(error) });
    } finally {
      outcome.complete = enumerationComplete && sessionsComplete &&
        outcome.errors.length === 0;
    }
  };
  return { source: driver.source, sessions: sessions(), retained, outcome };
}

export async function collectSource(
  driver: AgentDriver,
  { signal, retain }: CollectSourceOptions = {},
): Promise<CollectedSource> {
  signal?.throwIfAborted();
  const summaries: SessionSummary[] = [];
  const errors: CollectedSource["errors"] = [];
  const seenCursors = new Set<string>();
  const seenSessions = new Set<string>();
  const repeatedSessions = new Set<string>();
  // Listings, repeats included: the safety limit bounds what the provider
  // sends, so an inventory repeating one session under fresh cursors still
  // ends.
  let listed = 0;
  let cursor: string | undefined;
  let enumerationComplete = false;
  try {
    while (true) {
      if (cursor && seenCursors.has(cursor)) {
        throw new Error(`repeated session cursor: ${cursor}`);
      }
      if (cursor) seenCursors.add(cursor);
      signal?.throwIfAborted();
      const page = await driver.listSessions(cursor);
      signal?.throwIfAborted();
      if (page.sessions.length > MAX_SESSION_SUMMARIES - listed) {
        throw new Error("session enumeration exceeded safety limit");
      }
      listed += page.sessions.length;
      // One outcome per session: a page that repeats an ID an earlier page
      // listed is an inventory the provider did not keep consistent across
      // its cursors, recorded as an error once per session; the first
      // listing stands.
      for (const summary of page.sessions) {
        if (seenSessions.has(summary.nativeSessionId)) {
          if (!repeatedSessions.has(summary.nativeSessionId)) {
            repeatedSessions.add(summary.nativeSessionId);
            errors.push({
              nativeSessionId: summary.nativeSessionId,
              message:
                `duplicate session in inventory: ${summary.nativeSessionId}`,
            });
          }
          continue;
        }
        seenSessions.add(summary.nativeSessionId);
        summaries.push(summary);
      }
      if (!page.nextCursor) {
        enumerationComplete = true;
        break;
      }
      cursor = page.nextCursor;
    }
  } catch (error) {
    signal?.throwIfAborted();
    errors.push({ message: String(error) });
  }

  const sessions: NativeSessionSnapshot[] = [];
  const retained: SessionSummary[] = [];
  for (const summary of summaries) {
    if (retain?.(summary)) {
      retained.push(summary);
      continue;
    }
    try {
      signal?.throwIfAborted();
      const snapshot = await driver.readSession(summary.nativeSessionId);
      sessions.push(snapshotWithInventoryLifecycle(snapshot, summary));
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      errors.push({
        nativeSessionId: summary.nativeSessionId,
        message: String(error),
      });
    }
  }
  return {
    source: driver.source,
    sessions,
    retained,
    errors,
    complete: enumerationComplete && errors.length === 0 &&
      sessions.every((session) => session.complete),
  };
}

export function prepareSessionHeader(
  sourceId: string,
  snapshot: NativeSessionSnapshot,
): PreparedSessionHeader {
  const summary = stableFabricValue(
    snapshot.summary,
  ) as unknown as NativeSessionSnapshot["summary"];
  const normalizedMessages = stableFabricValue(
    snapshot.normalizedMessages,
  ) as unknown as NativeSessionSnapshot["normalizedMessages"];
  return {
    key: sessionKey(sourceId, summary.nativeSessionId),
    sourceId,
    nativeSessionId: summary.nativeSessionId,
    summary,
    normalizedMessages,
    complete: snapshot.complete,
    revision: snapshot.revision,
  };
}

export async function completeSessionDescription(
  header: PreparedSessionHeader,
  chunks: PreparedSessionDescription["chunks"],
): Promise<PreparedSessionDescription> {
  const base = { ...header, chunks };
  return {
    ...base,
    snapshotHash: await hashStableArrayValue(base),
  };
}

export async function prepareSession(
  sourceId: string,
  snapshot: NativeSessionSnapshot,
  targetChunkBytes?: number,
): Promise<PreparedSession> {
  const header = prepareSessionHeader(sourceId, snapshot);
  const events = stableFabricValue(snapshot.events) as unknown[];
  const chunks = await Promise.all(
    chunkEvents(events, targetChunkBytes).map(async (chunk) => ({
      ...chunk,
      eventCount: chunk.events.length,
      contentHash: await hashStableArrayValue(chunk.events),
    })),
  );
  const description = await completeSessionDescription(
    header,
    chunks.map(({ events: _events, ...chunk }) => chunk),
  );
  return {
    ...description,
    chunks,
  };
}
