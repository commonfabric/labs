/**
 * A session's identity as the agents connector's contract spells it
 * (`packages/connectors/agents/connector/docs/interfaces.md`, "Session key"):
 * both parts trimmed, the source id lowercased, each percent-encoded, and the
 * two joined with one slash, so `("a/b", "c")` and `("a", "b/c")` stay apart.
 *
 * A pattern cannot import the connector's own `sessionKey`, so this is a
 * second spelling of it. `session-key.test.ts` holds the two to each other
 * over a table of identities, so the spelling that moves is the one that
 * fails. This module imports nothing, so that test runs without a runtime.
 */

/** The key a session's record lives under and every join against the
 * connector's index uses. A control character, which the connector refuses,
 * is percent-encoded here rather than thrown on: a view does not refuse a
 * row. */
export const sessionKey = (sourceId: string, nativeSessionId: string): string =>
  `${encodeURIComponent(sourceId.trim().toLowerCase())}/${
    encodeURIComponent(nativeSessionId.trim())
  }`;
