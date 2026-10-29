/**
 * The defect's own shape in a real process: a run arms the process-end guard
 * and then stops settling. Deno drains such a process and exits, so what the
 * ending says — and the code it says it with — is the guard's alone. Run with
 * `report` to stand the guard down first, which is the ordinary ending this
 * one is compared against.
 *
 * A fixture rather than an in-process case because the thing under test is
 * the production wiring itself: the `unload` event Deno dispatches as the
 * loop drains, and `Deno.exitCode` being writable from inside it. Injected
 * effects cannot observe either.
 */

import { guardRunReport } from "../../lib/unreported-run.ts";

/**
 * The run, called and not awaited — which is how `mod.ts` calls `main`, and
 * why Deno's own "Top-level await promise never resolved" detector never
 * sees this. That detector also skips the `unload` event, so a `cf` that
 * awaited its main at the top level would lose both this guard's summary and
 * the deferred version-skew note.
 */
async function run(): Promise<void> {
  const guard = guardRunReport(() => "the run never reported");
  if (Deno.args[0] === "report") guard.reported();
  await new Promise(() => {});
}

run();
