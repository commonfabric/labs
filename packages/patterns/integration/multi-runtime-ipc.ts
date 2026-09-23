/**
 * The protocol between the multi-runtime harness and one of its worker
 * realms: the two message shapes and the values they name.
 *
 * This module holds no state and runs nothing on load, which is what lets the
 * harness realm import from it. Its counterpart `./multi-runtime-worker.ts` is
 * a worker entry point — loading it installs a `self.onmessage` handler — so
 * nothing outside a worker may import a value from there.
 */

import type { FabricValue } from "@commonfabric/data-model";
import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import type { SchedulerGraphSnapshot } from "@commonfabric/runner";

/**
 * A request to a worker realm.
 *
 * `args` crosses as one `codec-realm` encoding, that being the format written
 * for a realm boundary, so a command's arguments carry the whole `FabricValue`
 * domain rather than whatever structured cloning preserves of them. `id` and
 * `cmd` are addressing and travel as themselves.
 */
export type WorkerRequest = {
  id: number;
  cmd: string;
  args: RealmEncodedValue;
};

/**
 * A response from a worker realm. `ok` is the command's answer as one
 * `codec-realm` encoding, for the reason {@link WorkerRequest} gives; a
 * command that fails answers with text instead. `ready` announces that the
 * request listener is installed.
 */
export type WorkerResponse =
  | { ready: true }
  | { id: number; ok: RealmEncodedValue }
  | { id: number; error: string };

export type TrustedUiDescriptor = {
  /** `data-ui-pattern` / `data-ui-event-integrity` of the trusted surface. */
  surface: string;

  /** `data-ui-action` of the control inside the surface. */
  action: string;
};

export type RuntimeDiagnosticsSnapshot = {
  graph: SchedulerGraphSnapshot;
  settleStatsHistory: FabricValue[];
  actionRunTrace: FabricValue[];
};

/**
 * One commit a runtime had refused, carrying the `storage.push.error`
 * telemetry marker's fields.
 *
 * `error` is the rejection's name, `ConflictError` for a stale read.
 * `message` is the rejection's text, which separates a root conflict — a
 * "stale … read" of a named document — from a commit refused because a commit
 * it stacked on was refused, which reads "pending dependency" and says how
 * that dependency ended. One root conflict can cost several of the second
 * kind, and a count of rolled-back writes adds them together. `reads` is the
 * commit's conflict set and `writes` the entities it wrote, both as the marker
 * gives them.
 */
export type CommitRejection = {
  error: string;
  message: string;
  reads: string[];
  writes: string[];
};
