/**
 * Two final orientation answers shaped like the result schema rather than
 * an instance of it. The first is recorded verbatim from the lunch poll run
 * of 2026-10-13, which named the status field `type`. The second carries the
 * same content nested under the schema's own `type` and `properties` keys,
 * the other shape that playtest recorded.
 */

/** The lunch poll orientation's final answer, its status under `type`. */
export const LUNCH_POLL_ANSWER_STATUS_AS_TYPE =
  '{"type":"incomplete","summary":"I can\u2019t open the lunch poll from the available information: the piece-registry handle is described, but I don\u2019t have a registry-read capability here to resolve \u201clunch poll\u201d to a piece. Attach the piece or give me its exact address (for example, pattern:<space>/<slug>).","inputs":[],"rules":[],"sourceIds":[],"missing":["A resolvable piece reference or attachment, and a capability to open it."],"selectedPatternIds":[],"leads":[],"questions":["Can you attach the lunch poll piece or provide its exact address?"],"refinedTask":"Open the piece identified as \u201clunch poll.\u201d The granted piece-registry handle is described, but this call has no capability to read the registry and resolve that display name; no piece is attached or otherwise selected."}';

/** The same answer wrapped as though it were the schema's `properties`. */
export const LUNCH_POLL_ANSWER_WRAPPED_IN_SCHEMA =
  '{"type":"object","properties":{"status":"incomplete","summary":"I can\u2019t open the lunch poll from the available information: the piece-registry handle is described, but I don\u2019t have a registry-read capability here to resolve \u201clunch poll\u201d to a piece. Attach the piece or give me its exact address (for example, pattern:<space>/<slug>).","inputs":[],"rules":[],"sourceIds":[],"missing":["A resolvable piece reference or attachment, and a capability to open it."],"selectedPatternIds":[],"leads":[],"questions":["Can you attach the lunch poll piece or provide its exact address?"],"refinedTask":"Open the piece identified as \u201clunch poll.\u201d The granted piece-registry handle is described, but this call has no capability to read the registry and resolve that display name; no piece is attached or otherwise selected."}}';
