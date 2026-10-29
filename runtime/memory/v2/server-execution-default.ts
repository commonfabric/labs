/**
 * The ONE first-party default of the server-execution v2 flag
 * (`EXPERIMENTAL_SERVER_EXECUTION`; docs/specs/server-side-execution/,
 * docs/plans/server-execution-v2.md Phase 7 — the flip). Every
 * deployed-topology entry point resolves an UNSET flag to this value: the
 * `productionServer` / `remoteClient` construction presets
 * (`runtime/runner/src/runtime-presets.ts`), toolshed's serving-host gate
 * and memory ACL principal lists (`runtime/toolshed/lib/
 * server-execution.ts`; the DELEGATING class since OW31's build — never
 * an implicit-OWNER service grant),
 * and the browser shell's build-define fallback
 * (`runtime/shell/src/lib/env.ts`), so flipping the default is this one
 * value. `true` is the v2 posture; `false` is the pre-v2 behavior
 * byte-for-byte. This value is the truth about the current default; the
 * registry entry in `docs/development/EXPERIMENTAL_OPTIONS.md` carries the
 * dated history (flipped ON 2026-08-28 by #6535 after the plan's Phase 7
 * ordered gates; rolled back 2026-09-03 by #6840) and its summary cell is
 * pinned to this value by a test. An explicit `EXPERIMENTAL_SERVER_EXECUTION=true|false`
 * (or `experimental.serverExecution`) selects an arm regardless of this
 * value. CI's stable `default` / `opposite` roles derive both postures
 * from this resolver, so both arms stay guarded without role renames or
 * source edits. Whichever arm is not the default is selected explicitly
 * per deployment — the rollback lever whenever the default is ON.
 * To change the first-party default, update this value and the registry's
 * summary cell in the same PR (plus a dated status entry there, by the
 * registry's own rule); the pin fails an isolated one-token change. Every
 * other document describes the mechanism and points at the registry, so
 * nothing else needs re-tensing.
 * Do not rewrite role names, build jobs, or tests for a flip: they all
 * follow the default through `tasks/server-execution-ci.ts`.
 * After the soak, the post-soak removal PR (Phase 7's split-out task)
 * retires the flag, the OFF path, and the OFF guard lanes.
 *
 * Deliberately a leaf module: the shell's main thread imports it without
 * pulling the wire-shape module (`../v2.ts`, which re-exports it).
 *
 * Single-process harnesses — a bare `new Runtime`, the `unitTest` /
 * `patternTest` / `localDev` presets — do NOT read this value: they have no
 * serving host, so they resolve the ambient baseline (OFF) by construction
 * (see the ambient flag in `../v2.ts`).
 */
export const SERVER_EXECUTION_DEFAULT_ENABLED = false;
