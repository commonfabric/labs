/**
 * Mint a session id: the caller identity that an invocation id is chosen
 * within.
 *
 * `cf piece call --invocation <id>` lets a caller name a dispatch so that a
 * retry settles on the original outcome: the handler body runs again, loses
 * the race for the create-only receipt, and the caller reads the original
 * back — nothing commits twice, though effects outside the transaction can
 * repeat.
 * The id is the caller's own word — `add-comment-1` — and nothing stops a
 * second caller from picking that same word for its own call on the same verb.
 * The id alone therefore does not say whose invocation it is. A session is
 * what tells the two callers apart.
 *
 * The id is a bare unguessable string. There is no format to parse and no key
 * material to store — a session signs nothing and authenticates nobody, so
 * giving it a keyfile shape would only invite storing and handling it as if it
 * did. Mint one per agent run and let every call of that run share it: one run
 * is exactly the span over which repeating an id should mean repeating a call.
 * `CF_INVOCATION_SESSION` is the way to carry it, and
 * `--invocation-session <id>` the one-call override, because an unguessable
 * string stays unguessable only while it is out of the process listing an
 * argument shows up in.
 *
 * The session is joined to the address a handling's receipt lands at, so it
 * decides what a replay finds: the same id under two sessions reaches two
 * outcomes, and holding an id without the session it was chosen in reaches
 * nothing. That also makes the address unguessable, where a piece, a verb and
 * a word like `add-comment-1` are not.
 */
export function newSessionId(): string {
  return crypto.randomUUID();
}
