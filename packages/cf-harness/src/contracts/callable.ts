/**
 * The shape a model reads one callable thing in, whoever owns it: a command a
 * host admits (`list_commands`), and in time a verb a held piece declares. A
 * Loom manifest row and a `cf piece describe` verb both reduce to it — a name,
 * a title or description, an input schema — so the model reads one format
 * whatever the source, and a source's own facts (a command's targeting, a
 * verb's cell) wrap this core rather than widen it.
 *
 * `effect` and `outputSchema` are optional because neither source states them
 * for every callable: the Loom manifest declares no effect at all, and a
 * builtin command's `outputs` names fields rather than giving a schema. An
 * absent `effect` means the source did not say, never that the callable only
 * reads.
 */

import type { JSONObject } from "@commonfabric/api";

/** What a callable does to the person's world, where its source says. */
export type HarnessCallableEffect = "read" | "change";

/** One callable thing, as a model reads it. */
export interface HarnessCallableDescriptor {
  /** The name a call passes to invoke it. */
  name: string;

  /** One line saying what it does. */
  title?: string;

  /** The full description, in its author's own words. */
  description?: string;

  /** JSON schema of its arguments; `true` where the source leaves them open. */
  inputSchema: JSONObject | true;

  /** JSON schema of what it hands back, where the source declares one. */
  outputSchema?: JSONObject;

  /** Whether it only reads, where the source declares it. */
  effect?: HarnessCallableEffect;
}
