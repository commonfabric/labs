// The toolshed process's ONE resolution of the server-execution v2 flag
// (docs/specs/server-side-execution/; docs/plans/server-execution-v2.md
// Phase 7): the environment's explicit `EXPERIMENTAL_SERVER_EXECUTION`
// value when set, else the first-party default. Both consumers in this
// process — the serving-host bootstrap (`server-execution.ts`) and the
// memory server's service-principal grant (`routes/storage/memory.ts`) —
// read THIS, so they can never disagree about the posture. Kept a leaf
// module (no runner executor imports) so the memory route can import it
// without pulling the serving loop.

import {
  type EnvReader,
  experimentalOptionsFromEnv,
} from "@commonfabric/runner";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

/** Whether THIS toolshed process runs the server-execution v2 posture:
 * the explicit env value if present (`"true"` / `"false"`), else
 * `SERVER_EXECUTION_DEFAULT_ENABLED`. */
export function serverExecutionEnabledFromEnv(envGet: EnvReader): boolean {
  return experimentalOptionsFromEnv(envGet).serverExecution ??
    SERVER_EXECUTION_DEFAULT_ENABLED;
}

/**
 * The memory-server ACL principal lists for this process (OW31, RULED
 * 2026-08-18/19; protocol.md §2b's "read a foreign doc" row):
 *
 * - `serviceDids` — the operator-configured `MEMORY_SERVICE_DIDS` list,
 *   VERBATIM on both arms. The OWNER-class semantics of that list are
 *   untouched and stay operator-only: the process identity is NOT added
 *   to it under the flag. (The Phase-7 posture — the process identity as
 *   an implicit-OWNER memory service principal wherever the operator
 *   had not listed it — is RETIRED by the OW31 ruling: the serving
 *   identity is not an implicit owner of users' spaces. If a future
 *   stage needs the process identity to WRITE over the session plane,
 *   the answer is a wave-stamped path or an explicit grant — never
 *   re-adding it to this list.)
 * - `delegatingDids` — under the flag, this process's own identity; OFF
 *   the flag, empty. A delegating principal's loopback sessions may
 *   carry the session-level READ binding (`actingAs: "space-owner"`):
 *   the memory server resolves the space's ACL OWNER — the user whose
 *   space it is — and the session's READ-class capability decisions run
 *   as that user (session.open on an owner-only home space included),
 *   mirroring the write posture's delegated carriage. The service
 *   identity itself reads a space's ACL ONLY (the server dereferences
 *   it during that resolution); WRITE/OWNER requirements keep resolving
 *   against the envelope, so the binding grants no write path. The
 *   trust footing is LT5's: the co-hosted process is already trusted
 *   for carried actor claims on the write plane (the engine-direct
 *   sink), so binding its READS to the attributed user grants nothing
 *   the process does not structurally hold — it ATTRIBUTES what was
 *   ambient.
 *
 * If the operator ALSO listed the process identity in
 * `MEMORY_SERVICE_DIDS`, verbatim wins — it is then an OWNER-class
 * service principal by explicit configuration (scope report flag F1)
 * and the delegating listing is moot; the memory route logs that
 * combination rather than refusing it.
 */
export function memoryAclPrincipalsFor(options: {
  configured: readonly string[];
  processIdentityDid: string;
  serverExecution: boolean;
}): {
  serviceDids: readonly string[];
  delegatingDids: readonly string[];
} {
  return {
    serviceDids: [...options.configured],
    delegatingDids: options.serverExecution ? [options.processIdentityDid] : [],
  };
}
