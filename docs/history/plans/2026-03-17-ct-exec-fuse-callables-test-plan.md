---
status: historical
created: 2026-03-17
archived: 2026-07-09
reason: "Test plan for the executed cf exec and callable-files plan."
---

# Test Plan: `cf exec` + FUSE Callable Files

## Reconciliation

The approved testing strategy still holds against the current implementation plan. The only material clarifications from the plan are:

- mount-state and shebang-shim behavior are first-class acceptance criteria, so helper coverage for absolute identity persistence, longest-prefix mount lookup, stale cleanup, and shim generation is required
- the real end-to-end flow must cover both `pieces/...` and `entities/...` callable paths
- the integration fixture must include a tool input field literally named `help` to prove the raw-argv precedence rule

These adjustments do not change scope or cost from the approved strategy.

## Harness requirements

### `Real FUSE interaction harness`

- **What it does**: Starts from a local toolshed, creates a temp identity and space, deploys a deterministic fixture pattern, mounts a real FUSE filesystem, performs real filesystem reads and writes, runs `cf exec`, and inspects resulting piece state and tool stdout.
- **What it exposes**: Mounted file paths, CLI stdout/stderr, exit codes, observed file contents, and state verification through existing `cf piece get`/`cf piece inspect` style commands.
- **Estimated complexity**: Medium-high.
- **Tests depending on it**: 1, 2, 3, 4.
- **Implementation notes**: Build this as `packages/cli/integration/fuse-exec.sh` plus `packages/cli/integration/pattern/fuse-exec.tsx`. It requires a reachable local `API_URL`, `CF_CLI_INTEGRATION_USE_LOCAL=1`, and a FUSE provider on the test machine.

### `CLI exec focused harness`

- **What it does**: Exercises `cf exec` resolution, argv handling, schema-derived flag parsing, help rendering, and execution dispatch without requiring a live mount.
- **What it exposes**: Temp mount-state directories, synthetic mounted paths and `meta.json` files, stubbed manager/piece/runtime collaborators, captured stdout/stderr, and structured error assertions.
- **Estimated complexity**: Medium.
- **Tests depending on it**: 5, 6, 7.
- **Implementation notes**: Build this in `packages/cli/test/exec.test.ts`. Keep it focused on the CLI contract; use real temp files for mount state and mounted metadata, and use stubs only for the runtime/piece layer where the real FUSE surface is already covered by tests 1 to 4.

### `FUSE callable representation harness`

- **What it does**: Validates the in-memory callable tree, the shared mounted-callable path parser, readable callable bytes, and JSON-sigil synthesis without mounting FUSE.
- **What it exposes**: Pure parser results, in-memory `FsTree` nodes, node kinds, rendered script bytes, and `.json` sibling contents.
- **Estimated complexity**: Low.
- **Tests depending on it**: 8, 9.
- **Implementation notes**: Extend `packages/fuse/tree-builder.test.ts` and add `packages/fuse/callable-path.test.ts`.

### `Mount-state helper harness`

- **What it does**: Validates persisted mount metadata, absolute-path normalization, stale-entry cleanup, and shim generation independently of `cf exec`.
- **What it exposes**: Temp state directories, synthetic mount entries, shim file contents, and liveness decisions.
- **Estimated complexity**: Low.
- **Tests depending on it**: 5, 10.
- **Implementation notes**: Extend `packages/cli/test/fuse.test.ts` rather than building a new helper-only test file.

### `Runner semantic guardrail harness`

- **What it does**: Preserves the existing semantic baselines that `cf exec` relies on for schema lookup and tool-shape formatting.
- **What it exposes**: `asSchemaFromLinks()` behavior, PatternToolResult schema formatting, and real pattern-tool execution examples.
- **Estimated complexity**: Low.
- **Tests depending on it**: 11, 12.
- **Implementation notes**: Reuse `packages/runner/test/cell-callbacks.test.ts`, `packages/runner/test/schema-format.test.ts`, and `packages/runner/test/generate-object-tools.test.ts`.

## Named sources of truth used below

- **User description**: The original feature request in the trycycle transcript.
- **Implementation plan**: [docs/plans/2026-03-17-ct-exec-fuse-callables.md](./2026-03-17-ct-exec-fuse-callables.md), especially `User-visible behavior`, `Important contracts`, and Tasks 1 to 5.
- **FUSE spec**: [2-path-scheme.md](../../specs/fuse-filesystem/2-path-scheme.md), [3-json-mapping.md](../../specs/fuse-filesystem/3-json-mapping.md), and [4-read-write.md](../../specs/fuse-filesystem/4-read-write.md).
- **Handler CLI workflow doc**: [handlers-cli-testing.md](../../common/workflows/handlers-cli-testing.md).
- **Runner guardrails**: Existing tests in [cell-callbacks.test.ts](../../../runtime/runner/test/cell-callbacks.test.ts), [schema-format.test.ts](../../../runtime/runner/test/schema-format.test.ts), and [generate-object-tools.test.ts](../../../runtime/runner/test/generate-object-tools.test.ts).

## Test plan

1. **Name**: Mounted handler files under `pieces/...` are readable, executable through `cf exec`, and still accept legacy write-through.
   **Type**: scenario
   **Disposition**: new
   **Harness**: `Real FUSE interaction harness`
   **Preconditions**: A local toolshed is running; the deterministic fixture pattern is deployed into a temp space; the space is mounted through `cf fuse mount`; the fixture exposes one handler with required scalar input.
   **Actions**: List the mounted piece directory; assert the expected `*.handler` file exists under `input/` or `result/`; read the file and capture the first line; run `cf exec <handler-file> --help`; run `cf exec <handler-file> invoke ...`; run `cf exec <handler-file> ...` again without an explicit verb; inspect piece state after each call; write JSON directly with `echo ... > <handler-file>` and inspect piece state again.
   **Expected outcome**: Per the User description, the Implementation plan `User-visible behavior` items 1, 3, 4, 5, 6, and 10, and the FUSE spec read/write semantics, the handler remains present as `*.handler`, `head -n1` starts with `#!` and contains ` exec`, top-level `--help` succeeds without invoking the handler, explicit and implicit `invoke` both exit `0` and mutate the backing piece state through the mounted handler within a generous 5 second timeout, and the legacy write path still succeeds and mutates the same state.
   **Interactions**: CLI command parsing, mount-state lookup, FUSE daemon reads and writes, mounted-file to cell resolution, piece controller writes, runtime idle/sync waiting, and kernel cache invalidation.

2. **Name**: Mounted tool files under `pieces/...` surface as `.tool`, hide internal tool wiring, and run with schema-derived flags plus bound `extraParams`.
   **Type**: scenario
   **Disposition**: new
   **Harness**: `Real FUSE interaction harness`
   **Preconditions**: The mounted fixture exposes one pattern tool with one bound `extraParam`, plus deterministic JSON output that depends on both user input and the bound parameter.
   **Actions**: List the mounted piece directory and the relevant `.json` sibling; assert a `*.tool` entry exists; assert the old `pattern/extraParams` internals are not exposed as normal mounted children; read the tool file and capture the first line; run `cf exec <tool-file> --help`; run `cf exec <tool-file> run --flag ...`; run `cf exec <tool-file> ...` again without an explicit verb; capture stdout for both runs.
   **Expected outcome**: Per the User description, the Implementation plan `User-visible behavior` items 2, 3, 4, 5, 6, 8, and 9, and the FUSE spec path and JSON mapping, the mounted surface shows `*.tool` instead of expanded tool internals, reading the file returns a shebang-backed script whose first line contains ` exec`, top-level help renders schema-driven usage, explicit and implicit `run` both exit `0` within 5 seconds, and stdout is the expected JSON result that reflects both the provided flags and the bound `extraParams`.
   **Interactions**: FUSE callable discovery, callable JSON-sigil rendering, `cf exec` schema translation, runtime pattern execution, stdout serialization, and mounted tree layout.

3. **Name**: `cf exec <tool-file> run --help` is parsed as the schema field when the tool input schema contains `help`, while `cf exec <tool-file> --help` still prints top-level help.
   **Type**: scenario
   **Disposition**: new
   **Harness**: `Real FUSE interaction harness`
   **Preconditions**: The fixture tool input schema includes a top-level field literally named `help`, and tool output visibly reflects the field value so the execution path is observable.
   **Actions**: Run `cf exec <tool-file> --help`; then run `cf exec <tool-file> run --help <value>`; capture stdout, stderr, and exit code for both invocations.
   **Expected outcome**: Per the User description and the Implementation plan `User-visible behavior` items 6 and 7 plus Task 5, the top-level invocation prints command help and does not execute the tool, while the post-verb invocation treats `--help` as the schema field, executes successfully, and returns output incorporating the provided field value instead of CLI help text.
   **Interactions**: Raw argv preservation in the CLI, schema-derived option parsing, help rendering, and end-to-end tool execution.

4. **Name**: Callable files reached through `entities/<entity-id>/...` resolve the same backing cells as the corresponding `pieces/...` paths.
   **Type**: differential
   **Disposition**: new
   **Harness**: `Real FUSE interaction harness` plus `Reference comparison harness`
   **Preconditions**: The mounted fixture piece is reachable through both `pieces/<display-name>/...` and `entities/<entity-id>/...`.
   **Actions**: Invoke the same handler once via its `pieces/...` path and once via its `entities/...` path with identical input; run the same tool once via each path with identical input; compare resulting piece state and tool stdout across both paths.
   **Expected outcome**: Per the Implementation plan `Important contracts` items 2, 6, and 7 and Task 5, plus the FUSE spec path scheme, the `entities/...` path is accepted, both paths address the same underlying callable cell, handler side effects are identical, and tool stdout is identical for the same inputs.
   **Interactions**: Shared mounted-callable path parser, entity resolution under FUSE, piece metadata lookup, CLI resolution, and runtime execution.

5. **Name**: `cf exec` resolves mounted callable files from persisted mount state and sibling `meta.json`, not from display-name guesses.
   **Type**: integration
   **Disposition**: new
   **Harness**: `CLI exec focused harness` plus `Mount-state helper harness`
   **Preconditions**: Temp mount-state entries exist for multiple mounts, including one nested mount path; the chosen mounted piece directory has a de-duped display name like `notes-2`; a sibling `meta.json` contains the canonical piece ID.
   **Actions**: Resolve an absolute mounted callable path under the nested mount; resolve a callable path under `pieces/notes-2/...`; inspect which mount entry and piece ID the resolver selects.
   **Expected outcome**: Per the Implementation plan `Important contracts` items 2, 3, 4, and 5 and the FUSE spec piece naming rules, the resolver chooses the longest matching mountpoint, requires persisted mount metadata, treats identity and mountpoint as absolute paths, ignores the de-duped display name as a stable identifier, and uses sibling `meta.json` to recover the canonical piece ID.
   **Interactions**: Filesystem temp state, mount-state lookup, mounted-piece metadata parsing, and CLI resolution logic.

6. **Name**: `cf exec` rejects invalid paths and invalid arguments with readable CLI errors instead of stack traces.
   **Type**: boundary
   **Disposition**: new
   **Harness**: `CLI exec focused harness`
   **Preconditions**: Command parsing and resolution helpers are available with stubbed collaborators.
   **Actions**: Run `cf exec` against a non-mounted absolute path, a mounted non-callable file, a stale mount entry, a `.tool` path with an unknown flag, a missing required field, an invalid enum value, and a mixed `--json` plus generated-flags invocation.
   **Expected outcome**: Per the User description, the Implementation plan `User-visible behavior` item 10 and `Keep schema flags simple and predictable`, each case exits non-zero with a clear CLI error describing the problem, and none of the cases surface a raw stack trace.
   **Interactions**: CLI parser, mount resolution, schema-derived flag validation, and error rendering.

7. **Name**: Schema-derived parsing covers the supported flag surface for `cf exec`.
   **Type**: integration
   **Disposition**: new
   **Harness**: `CLI exec focused harness`
   **Preconditions**: A command-spec helper exists for handler and tool schemas with representative object and non-object inputs.
   **Actions**: Parse representative argv for handler and tool callables covering default verb selection, top-level `--help`, boolean flags, `--no-flag`, `--flag=true|false`, arrays and objects passed as JSON strings, non-object schemas via `--value`, and `--json` by itself.
   **Expected outcome**: Per the User description and the Implementation plan `User-visible behavior` items 5 to 8 plus `Keep schema flags simple and predictable`, handlers default to `invoke`, tools default to `run`, top-level `--help` always returns help, booleans accept the supported forms, arrays and objects parse from JSON strings, non-object schemas use `--value`, and `--json` is accepted only when not mixed with generated flags.
   **Interactions**: CLI parsing, schema normalization, and help rendering.

8. **Name**: FUSE tree synthesis renders `.handler` and `.tool` callables as readable synthetic files and replaces callable values with explicit sigils in `.json` siblings.
   **Type**: regression
   **Disposition**: extend
   **Harness**: `FUSE callable representation harness`
   **Preconditions**: In-memory tree-building helpers can classify top-level callable children from representative handler and pattern-tool values.
   **Actions**: Build a tree for representative `input` and `result` objects containing scalar fields, handler callables, and pattern-tool callables; inspect the tree nodes and the `.json` sibling payloads; read the synthetic callable bytes from the tree representation.
   **Expected outcome**: Per the User description, the Implementation plan Task 2, and the FUSE spec path and JSON mapping, ordinary fields remain readable as before, top-level callables become `*.handler` or `*.tool`, callable internals are skipped from normal expansion, `.json` siblings render explicit `{\"/handler\":\"name\"}` or `{\"/tool\":\"name\"}` sigils, and synthetic callable reads return bytes whose first line is a shebang containing ` exec`.
   **Interactions**: Callable classification, tree node creation, JSON rendering, and synthetic read content generation.

9. **Name**: Shared mounted-callable path parsing accepts only supported top-level callable paths and rejects unsupported nested/internal paths.
   **Type**: unit
   **Disposition**: new
   **Harness**: `FUSE callable representation harness`
   **Preconditions**: The shared mounted-callable path parser exists as a pure helper.
   **Actions**: Parse representative paths for `pieces/.../*.handler`, `pieces/.../*.tool`, `entities/.../*.handler`, and `entities/.../*.tool`; then parse non-callable paths and nested internal tool paths such as `pattern/...` or `extraParams/...`.
   **Expected outcome**: Per the Implementation plan `Architecture decisions` item 2 and `Important contracts` items 6 and 7, only the supported top-level callable shapes are accepted, each accepted path returns the correct `rootKind`, `rootName`, `cellProp`, `cellKey`, and `callableKind`, and unsupported nested/internal paths are rejected.
   **Interactions**: Pure path parsing only.

10. **Name**: Mount-state helpers persist absolute identity, generate a stable exec shim, prefer the longest mount prefix, and clean stale entries.
    **Type**: regression
    **Disposition**: extend
    **Harness**: `Mount-state helper harness`
    **Preconditions**: Temp state directories and synthetic process entries are available; shim output can be read back from disk.
    **Actions**: Persist mount-state entries with relative and absolute identities; generate the exec shim; read all state entries; resolve the owning mount for nested paths; mark one entry stale and resolve again.
    **Expected outcome**: Per the Implementation plan Task 1 and `Important contracts` items 4 and 5, persisted entries include `mountpoint`, `apiUrl`, `identity`, `pid`, and `startedAt`, the stored identity is absolute, the shim content points at `packages/cli/mod.ts`, mount resolution chooses the longest matching mountpoint, and stale entries are ignored and cleaned up before selection.
    **Interactions**: State-file I/O, path normalization, process-liveness checks, and shim generation.

11. **Name**: `asSchemaFromLinks()` still resolves callable schemas when the child cell itself does not carry one.
    **Type**: regression
    **Disposition**: extend
    **Harness**: `Runner semantic guardrail harness`
    **Preconditions**: Runner tests can construct cells whose schema must be recovered through linked pattern metadata rather than from the child cell directly.
    **Actions**: Extend the existing `asSchemaFromLinks()` characterization with a callable-shaped child cell representative of the `cf exec` lookup path and assert the resolved schema is the linked schema.
    **Expected outcome**: Per the User description, the Implementation plan `Important contracts` item 1, and the existing runner schema-resolution contract, `asSchemaFromLinks()` resolves the linked schema instead of returning `undefined`, ensuring callable discovery and help generation use the backing schema rather than stale local metadata.
    **Interactions**: Runner cells, source-link traversal, and schema resolution only.

12. **Name**: Pattern-tool schema formatting and execution remain suitable as `cf exec` help and runtime baselines.
    **Type**: regression
    **Disposition**: extend
    **Harness**: `Runner semantic guardrail harness`
    **Preconditions**: Existing PatternToolResult examples and mixed handler plus `patternTool(...)` execution examples remain available in the runner tests.
    **Actions**: Extend the schema-format examples to cover the concrete pattern-tool shapes used by the `cf exec` fixture and run the existing bound-`extraParams` pattern-tool examples.
    **Expected outcome**: Per the User description, the Implementation plan `User-visible behavior` items 8 and 9, and the existing runner guardrails, help formatting shows the user-facing `extraParams` shape rather than leaking internal `pattern` structure, output-schema heuristics stay display-only, and bound-`extraParams` pattern tools still run to completion with the expected structured result.
    **Interactions**: Runner schema formatter, pattern-tool metadata, and runtime execution.

## Coverage summary

### Covered action space

- Real mounted behavior for reading `*.handler` and `*.tool` files, executing them with `cf exec`, and preserving legacy handler writes.
- Both callable path families the plan explicitly supports: `pieces/...` and `entities/...`.
- Help and parsing behavior that the user explicitly called out: top-level help, default verbs, post-verb `--help` precedence, generated flags, and `--json`.
- Mount-state and shebang-shim behavior that `cf exec` depends on outside the daemon.
- FUSE layout and representation rules: readable callable files, `.tool` synthesis, and callable sigils inside `.json` siblings.
- Schema resolution and PatternToolResult formatting guardrails from the runner layer that inform callable discovery and help text.

### Explicit exclusions

- Direct `./file.handler` or `./file.tool` execution as a shell command. The User description and the Implementation plan both exclude this as a release criterion for this change.
- Any refactor of `packages/runner/src/builtins/llm-dialog.ts`. The plan explicitly excludes that work; runner tests are used only as semantic guardrails.
- A deep nested flag DSL beyond top-level fields plus the raw `--json` escape hatch. The User description and the plan both cap scope here.
- CI-only proof of real FUSE behavior on hosts without a FUSE provider. The agreed strategy keeps the real mounted proof as a reproducible local integration artifact instead of replacing it with mocks.

### Risks carried by the exclusions

- Without direct `./file.tool` execution coverage, the feature can still regress on executable-bit or shell-dispatch behavior without failing this plan. That is acceptable for this change because the feature contract is `cf exec`, not direct shell execution.
- Without broader `llm-dialog` refactors, `cf exec` and LLM tool execution may continue to share behavior only by convention rather than through a common helper. The differential and runner guardrail tests reduce this risk but do not remove it entirely.
- If FUSE is unavailable in a given environment, helper and focused tests can still go green while the actual mounted flow remains unproven there. The real integration script is therefore an acceptance gate for feature sign-off on supported local environments.
