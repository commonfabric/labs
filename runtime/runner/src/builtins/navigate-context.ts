// The navigateTo event-context carrier (server-execution v2 Phase 4;
// docs/specs/server-side-execution/builtins.md §4). The served half of
// `navigateTo` "needs the firing session's identity — it comes from the
// event's `firedAt`" — but the builtin's ACTION is a separate scheduler
// run from the handler that returned it: the handler run (stamped with
// the event's server-stamped actor, events.md §2) instantiates the
// result pattern, and the navigateTo node's action runs later, stamped
// as an ordinary derivation. This module is the hop that carries the
// event context across that gap WITHOUT re-deriving, defaulting, or
// trusting a client-supplied value (builtins.md §4's implementation
// note): the context is COPIED from the instantiating transaction's own
// run stamp — the wave run context on the serving side, the speculation
// stamp on a flag-ON client — at exactly two capture points:
//
// 1. the deferred-start sites (runner.ts's
//    startAfterSuccessfulCommit / runPatternAfterSuccessfulCommit):
//    the handler tx is in scope when the commit callback mints the
//    start tx, so the handler's event context transfers to the start
//    tx before instantiation runs under it;
// 2. the raw-builtin instantiation site (runner.ts's
//    instantiateJavaScriptNode): the instantiating tx's context —
//    carried by (1) for deferred starts, or the handler tx's own stamp
//    when the result pattern runs under it directly — is tagged onto
//    the returned ACTION, where the builtin's later runs read it.
//
// Actor inheritance composes across chains by construction: the
// handler run's stamp already carries the ORIGINATING session
// (events.md §2 — a cascade's `firedAt` inherits hop by hop), so a
// navigateTo several handler hops from the click still addresses the
// session that clicked.
//
// OFF arm: no run stamps exist, both capture points see undefined, and
// nothing here runs beyond one WeakMap miss.

/** The event context a navigateTo instantiation was a consequence of:
 * the firing event's durable id (the nonce discipline keys on it —
 * protocol.md §5) and, on the serving side, the event's server-stamped
 * acting identity (absent on a flag-ON client's speculative capture,
 * where the client's own authenticated session is ambient).
 *
 * `attemptMinted` (independent review M1, 2026-08-11): set when the
 * capture's event is a CASCADE-minted event — its id was minted fresh
 * for THIS attempt (events.md §4's fresh-per-attempt cascades), so the
 * client's speculative twin and the server's authoritative twin carry
 * DIFFERENT ids, and the handler-result frame's cause embeds the id
 * (`$event: tx.dispatchedEventId`, runner.ts), so the twins' navigateTo
 * INSTANCE ids diverge too. Both `effectIntentNonce` components diverge:
 * no keying can converge an attempt-minted capture's optimistic
 * enactment with the authoritative intent, so the optimistic arm
 * REFUSES to enact one (the authoritative intent, delivered on the
 * effects channel, is the cascade hop's one navigation). Derived from
 * `parentEventId` presence on the run stamp — the cascade dispatch
 * carries its emitter's id on both sides (the wave carriage
 * server-side, the client-echo thread in cell.ts's plain queueEvent),
 * while a ROOT event (the client's durable fire, a drained delegated
 * delivery) carries none. */
export type NavigateEventContext = {
  eventId: string;
  acting?: { user: string; session?: string };
  attemptMinted?: true;
};

const navigateEventContexts = new WeakMap<object, NavigateEventContext>();

/** Attach an event context to a carrier (a start transaction, or a
 * builtin's action function). */
export const setNavigateEventContext = (
  carrier: object,
  context: NavigateEventContext,
): void => {
  navigateEventContexts.set(carrier, context);
};

export const navigateEventContextOf = (
  carrier: object,
): NavigateEventContext | undefined => navigateEventContexts.get(carrier);

/** Derive the carried context from a run stamp (the wave run context or
 * the speculation stamp — both carry ServerRunInfo's fields): only an
 * EVENT-HANDLER run with a durable event id is a navigation-bearing
 * consequence; every other run kind carries nothing. */
export const navigateEventContextFromRunInfo = (
  info:
    | {
      kind: string;
      eventId?: string;
      parentEventId?: string;
      acting?: { user: string; session?: string };
    }
    | undefined,
): NavigateEventContext | undefined => {
  if (info === undefined) return undefined;
  if (info.kind !== "event-handler" || info.eventId === undefined) {
    return undefined;
  }
  return {
    eventId: info.eventId,
    ...(info.acting !== undefined ? { acting: info.acting } : {}),
    // A run with a parent is a same-wave cascade hop: its own eventId
    // was minted for this attempt (see NavigateEventContext).
    ...(info.parentEventId !== undefined ? { attemptMinted: true } : {}),
  };
};
