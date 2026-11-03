import type { ExperimentalOptions } from "./runtime.ts";

/**
 * Gives each experimental flag that a `Runtime` consumes from its own
 * instance its local default, wherever `experimental` leaves the flag unset.
 * Modifies `experimental` in place.
 *
 * A flag's default can change what the compiler builds from a pattern's
 * source, and so how it numbers the pattern's anonymous cells, so
 * `deno task check-cause-assignments` compiles on any change to this module
 * (`COMPILER_PATHS` in `tasks/check-cause-assignments.ts`). That is what holds
 * a change to a default to the numbering an unchanged pattern already has.
 */
export function applyLocalExperimentalDefaults(
  experimental: ExperimentalOptions,
): void {
  experimental.computedCellIds ??= true;
  experimental.plainResultReceipts ??= true;
  experimental.lazyMaterialization ??= true;
  experimental.agentBuiltin ??= true;
  experimental.localFold ??= false;
  experimental.pieceCreatorRecord ??= false;
  // TODO(danfuzz): Turn this on once every deployment's posture names
  // instances. Until then a runtime with it on is refused each unmarked space
  // of a deployment whose posture names none (INV-16).
  experimental.instanceNames ??= false;
  experimental.localSessionDocuments ??= false;
}
