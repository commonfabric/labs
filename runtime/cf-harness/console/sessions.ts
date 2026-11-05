/**
 * The listing behind `/api/sessions`: what the page shows before a session is
 * open, and what a link to a past session is named by. Everything here is pure
 * so the shape a browser reads — which sessions, in what order, described by
 * what — is testable without a model, a store, or a socket.
 */

import type {
  HarnessChatSessionLifecycle,
  HarnessChatStatusResult,
  HarnessChatTurnRecord,
} from "../src/contracts/interactive-chat.ts";

/**
 * How much of the first task a listing entry carries. The whole text is the
 * session's own transcript to show once it is open; the listing needs only
 * enough of it to tell one session from another.
 */
export const CONSOLE_TASK_PREVIEW_LIMIT = 200;

/** One row of the session list. */
export interface ConsoleSessionSummary {
  sessionId: string;
  status: HarnessChatSessionLifecycle;
  reusable: boolean;
  turnCount: number;
  createdAt: string;
  updatedAt: string;

  /** The first user input of the session, elided past the preview limit. */
  firstTaskText?: string;
}

/** The body `/api/sessions` answers with. */
export interface ConsoleSessionListing {
  sessions: readonly ConsoleSessionSummary[];
}

const preview = (text: string): string =>
  text.length > CONSOLE_TASK_PREVIEW_LIMIT
    ? `${text.slice(0, CONSOLE_TASK_PREVIEW_LIMIT)}…`
    : text;

/**
 * The first task each session was given, by session id. The turns a session
 * holds carry no ordinal, so the earliest `startedAt` is what names the first
 * one; two turns starting in the same millisecond are ordered by turn id, so
 * one of them is the answer rather than whichever the store listed first.
 */
const firstTaskTexts = (
  turns: readonly HarnessChatTurnRecord[],
): Map<string, string> => {
  const first = new Map<string, HarnessChatTurnRecord>();
  for (const turn of turns) {
    const held = first.get(turn.sessionId);
    if (
      held === undefined ||
      turn.turn.startedAt < held.turn.startedAt ||
      (turn.turn.startedAt === held.turn.startedAt &&
        turn.turn.turnId < held.turn.turnId)
    ) {
      first.set(turn.sessionId, turn);
    }
  }
  return new Map(
    [...first].flatMap(([sessionId, turn]) =>
      turn.input.text.trim() === ""
        ? []
        : [[sessionId, preview(turn.input.text)] as const]
    ),
  );
};

/**
 * The session list, most recently touched first, so the session a reload is
 * most likely looking for is the one at the top. Sessions updated in the same
 * millisecond are ordered by session id, so the listing is stable between two
 * requests that read the same state.
 */
export const summarizeConsoleSessions = (
  status: HarnessChatStatusResult,
  turns: readonly HarnessChatTurnRecord[],
): ConsoleSessionListing => {
  const tasks = firstTaskTexts(turns);
  const sessions = status.sessions.map((session): ConsoleSessionSummary => {
    const firstTaskText = tasks.get(session.sessionId);
    return {
      sessionId: session.sessionId,
      status: session.status,
      reusable: session.reusable,
      turnCount: session.turnCount,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(firstTaskText !== undefined ? { firstTaskText } : {}),
    };
  }).sort((left, right) =>
    left.updatedAt === right.updatedAt
      ? left.sessionId.localeCompare(right.sessionId)
      : right.updatedAt.localeCompare(left.updatedAt)
  );
  return { sessions };
};
