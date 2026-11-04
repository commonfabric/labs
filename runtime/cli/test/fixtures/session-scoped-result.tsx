/**
 * Fixture: a result with a REQUIRED output derived from a perSession cell.
 *
 * `sessionEcho`'s computed inherits the session scope of its `draft` input,
 * so its value lives in a doc only the piece-running session can read. The
 * generated result schema still marks it `required`. A fresh CLI session's
 * path-less `cf cell get` must degrade `sessionEcho` and return the object
 * with `stable` — not void to `undefined` (the lunch-poll deploy-gate bug)
 * and not demand `--step`.
 */

import { computed, pattern, Writable } from "commonfabric";

export default pattern(() => {
  const draft = Writable.perSession.of<string>("session-only");
  const sessionEcho = computed(() => draft.get() ?? "");
  return { stable: "always-visible", sessionEcho };
});
