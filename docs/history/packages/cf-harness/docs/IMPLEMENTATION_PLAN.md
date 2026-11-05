---
status: historical
created: 2026-04-17
archived: 2026-07-22
reason: "Executed package bootstrap plan; the implementation and product integrations have advanced beyond its staged checkpoint."
superseded-by: packages/cf-harness/docs/CURRENT_STATE.md
---

# cf-harness Implementation Plan

This document is the checked-in package-local implementation plan for
`@commonfabric/cf-harness`. It is meant for engineers and agents who do not have
access to local session notes.

## Purpose

Build a Common Fabric-native agent harness that can support Loom and future
Common Fabric products without forcing CFC to be retrofitted onto an unrelated
runtime.

The key architectural principle is:

- `runner` owns authoritative CFC meaning
- `cf-harness` should not invent a second semantic layer
- the harness implements mechanisms that respect and transport those semantics
- sandbox layers enforce conservative low-level mediation where needed

## Product Direction

The current intended v1 shape is:

- general Common Fabric agent runtime, not just an internal coding harness
- shell-centric and mostly headless
- static trusted built-in tools
- long-running unattended tasks supported
- Loom as the first practical rollout target

Current Loom migration judgment:

- background/non-interactive Loom work is the cleaner first migration target
- interactive Loom chat should be treated as a separate transport problem

See also:

- [LOOM_MIGRATION_NOTES.md](LOOM_MIGRATION_NOTES.md)
- [SKILLS_SUPPORT_SPEC.md](../../../../../runtime/cf-harness/docs/SKILLS_SUPPORT_SPEC.md)

## Design Principles

### 1. CFC-shaped from day one

The harness should not be built as a separate “normal” agent runtime first and
then later retrofitted for CFC. Instead:

- the interfaces should be CFC-shaped from the beginning
- enforcement can move from permissive/advisory toward blocking over time

### 2. Mechanistic harness

The harness itself should be deterministic:

- explicit mode handling
- explicit preflight heuristics
- explicit deny/recovery behavior
- explicit routing and boundary handling

The model consumes these signals; it does not create them.

### 3. Narrow tools first

The initial built-in tool floor is intentionally small:

- `bash`
- `read_file`
- `write_file`

That keeps the execution surface understandable while the core runtime shape is
still settling.

### 4. Sandbox-first execution path

The current execution path targets the practical `runsc-cfc` sandbox route. FUSE
and `fabricd`/space projection are intentionally out of scope for the first
core.

## Current Implementation Status

The package already includes:

### Stage A: Package skeleton and contracts

- package scaffold under [packages/cf-harness](../../../../../runtime/cf-harness)
- package exports and tasks in [deno.jsonc](../../../../../runtime/cf-harness/deno.jsonc)
- initial contract surfaces:
  - [prompt-slot.ts](../../../../../runtime/cf-harness/src/contracts/prompt-slot.ts)
  - [run-manifest.ts](../../../../../runtime/cf-harness/src/contracts/run-manifest.ts)
  - [observation.ts](../../../../../runtime/cf-harness/src/contracts/observation.ts)
  - [policy.ts](../../../../../runtime/cf-harness/src/contracts/policy.ts)
  - [transcript.ts](../../../../../runtime/cf-harness/src/contracts/transcript.ts)
  - [tool-result.ts](../../../../../runtime/cf-harness/src/contracts/tool-result.ts)

Why this was done first:

- to stabilize the internal runtime vocabulary before broader orchestration work

### Stage B: Execution core

- sandbox adapter in [src/sandbox](../../../../../runtime/cf-harness/src/sandbox)
- engine in [engine.ts](../../../../../runtime/cf-harness/src/engine.ts)
- built-in tool implementations in [src/tools](../../../../../runtime/cf-harness/src/tools)

Why:

- to get real shell/file execution working against `runsc-cfc` early
- to validate the VM/sandbox boundary before adding richer agent behavior

### Stage C: Prompt/tool loop

- bounded prompt loop in [prompt-loop.ts](../../../../../runtime/cf-harness/src/prompt-loop.ts)
- OpenAI-compatible client in
  [openai-client.ts](../../../../../runtime/cf-harness/src/gateway/openai-client.ts)

Why:

- to move from “tool runtime” into “actual harness”
- to expose message/tool-call/transcript requirements early

### Stage D: Persistence and resumability

- artifact store in [artifacts.ts](../../../../../runtime/cf-harness/src/artifacts.ts)
- run-state tracking in [run-state.ts](../../../../../runtime/cf-harness/src/run-state.ts)
- retained Loom run manifest artifacts
- transcript-based resume support in the prompt loop and CLI

Why:

- to make runs inspectable
- to make debugging and iterative development feasible

### Stage E: Operator CLI

- package-local CLI in [cli.ts](../../../../../runtime/cf-harness/src/cli.ts)
- entrypoint in [main.ts](../../../../../runtime/cf-harness/src/main.ts)

Why:

- to make the harness manually operable before product integration

### Stage F: First CFC-aware shaping

- persisted `policyEvents`
- prompt-loop policy evaluation for:
  - `disabled`
  - `observe`
  - `enforce-explicit`
  - `enforce-strict`
- default CFC mode aligned with runner-style `enforce-explicit`
- deny/recovery via JSON `ObservationDenied` tool messages
- spec-aligned `PromptSlotBound` prompt-slot evidence
- capability snapshots that record current CFC mode, manifest presence,
  substrate absence behavior, sandbox CFC request hints, and expected protected
  xattr visibility
- CLI summaries of accumulated policy events

Why:

- to make the runtime meaningfully CFC-shaped before broader orchestration work

### Stage G: Gateway auth controls

- improved API-key diagnostics
- `gatewayAuthMode: bearer|none`
- caller-no-auth path for the stage gateway
- auth-mode-aware `401` messaging

Why:

- to support current Common Tools gateway expectations
- to make local operator debugging less ambiguous

### Stage G2: Codex subscription auth and provider transport

- provider-neutral `HarnessModelClient` seam keeps the existing bounded
  prompt/tool loop and CFC mediation shared by every provider
- separate `openai-codex` provider using the pinned OpenCode/pi-compatible
  browser PKCE and device-code OAuth contract
- dedicated owner-keyed local credential storage with atomic private writes and
  serialized refresh-token rotation; no Codex CLI credential import
- fixed-origin ChatGPT Codex Responses SSE transport with encrypted reasoning
  continuation, tool-call-id preservation, and provider-neutral diagnostics
- explicit CLI login/status/logout, provider selection, live model listing, and
  provider-stable resume
- Loom run-manifest owner reference plus trusted host injection for batch and
  interactive use; personal subscriptions are never selected from ambient
  process state

Why:

- to let local and Loom users explicitly fund harness runs from their supported
  ChatGPT/Codex subscription without changing who owns the model/tool loop
- to prevent a service-wide credential, local operator credential, or API-key
  fallback from crossing user and workload boundaries

### Stage H: Minimal subagent delegation

- built-in `delegate_task` tool descriptor
- prompt-loop orchestration for one focused child run at a time
- fresh child prompt context with the delegated goal and optional context
- explicit default child profile limited to:
  - `bash`
  - `read_file`
  - `write_file`
- parent delegation authority separated from direct parent tool allowlists:
  - unconstrained runs allow the default profile
  - runs with an explicit `--allow-tool` list require
    `--allow-subagent-profile default` to spawn the default profile
- named return policy that sends the parent a summary, manifest, and sanitized
  run-state summary, while retaining raw child transcript/failure detail in
  child artifacts
- persisted parent references to child run ids, manifests, summaries, and run
  state snapshots
- summary-only parent tool output, without exposing the child transcript back to
  the parent model

Why:

- to introduce the core containment and provenance shape before browser access
- to give Loom and Pattern Factory a native delegation primitive without adding
  additional profiles, parallelism, or browser mediation in the first slice
- to make delegation a visible policy transition before adding higher-taint
  child capabilities such as `agent-browser`

### Stage I: Browser subagent profile, provisional host shell

- built-in `bash-no-sandbox` tool descriptor and implementation
- parent/default prompt loops keep `bash-no-sandbox` unavailable unless a loop
  is explicitly constructed with that tool
- package CLI intentionally does not expose `bash-no-sandbox` as a parent
  `--allow-tool`
- named `browser` subagent profile limited to:
  - `bash-no-sandbox`
  - `read_file`
- subagent manifests record `hostToolIds` so host execution capability is
  visible in retained provenance
- child prompt explicitly labels host execution as outside the sandbox and
  orients browser-profile children toward `agent-browser`

### Stage J: Browser host command policy

- `bash-no-sandbox` is no longer an arbitrary host shell even inside the browser
  profile
- allowed host command shapes:
  - `agent-browser ...` except host-mutating setup such as
    `agent-browser install`
  - `which agent-browser` and `command -v agent-browser`
  - `pwd`
  - `ls` with a small read-only flag set and workspace-relative paths
  - `find` with workspace-relative paths, required bounded `-maxdepth`, and a
    small read-only predicate set
- denied host commands return a normal nonzero tool result without invoking the
  host process runner, and diagnostics classify the denial as `tool_not_allowed`

Why:

- to keep the intended eventual `agent-browser` usage shape: agents invoke it
  through shell commands, not through a special-purpose harness tool
- to put the high-taint browser capability behind an explicit delegation
  transition before broader browser policy exists
- to avoid silently making host execution part of the parent/default tool
  surface

### Stage K: Browser write posture and artifact placement

- browser-profile children do not receive `write_file`; browser observations
  should return through schema-validated structured returns rather than normal
  workspace files
- raw browser host-tool outputs and raw structured returns are still retained in
  child artifacts for audit/debugging
- local/browser examples should place `--artifact-root` outside `--workspace` so
  raw child artifacts do not become ordinary parent-readable workspace files
- when artifacts are physically placed under a workspace, the artifact root is
  reserved from `read_file`, `write_file`, and browser-profile host `ls`/`find`
  discovery paths

Still planned:

- stop treating raw host artifact paths as model-facing references; prefer
  opaque output IDs/handles for parent-visible results and keep paths in
  operator-facing run state/report data
- introduce an explicit declassification/readback mechanism for raw child
  artifacts before exposing them to a parent model

Why:

- removing `write_file` prevents the browser child from directly turning tainted
  page observations into normal workspace files, but it does not by itself make
  raw retained artifacts confidential if the artifact directory is mounted
  inside the workspace
- the long-term sandbox/infrastructure design should make raw browser artifacts
  operator-inspectable while keeping them out of the parent prompt unless a
  deliberate declassification step occurs

### Stage L: Explicit Agent Skills preload

- explicit `skillsRoot` configuration and CLI flags
- explicit skill preload for batch/product runs
- persisted skill registry and activation artifacts
- runtime-generated supporting-resource indexes in skill registry artifacts
- text-first `read_skill_resource` support for indexed resources
- `skill-resource-reads.json` provenance artifacts
- exact-allowlisted `run_skill_script` support for activated skill scripts
- `skill-script-executions.json` provenance artifacts
- CFC classification of skill content as context, not direct-command authority
- context message insertion before the final task prompt

Still planned:

- eventual dedicated `load_skill` tool for model-driven activation
- explicit subagent skill activation policy

Why:

- Pattern Factory depends on repo-local skills for acceptable implementation
  quality
- `cf-harness` should not need broad parent `bash` just to discover or load task
  guidance
- skill loading must be inspectable, resumable, and aligned with CFC policy

See the package-local spec:

- [SKILLS_SUPPORT_SPEC.md](../../../../../runtime/cf-harness/docs/SKILLS_SUPPORT_SPEC.md)

## Current Verified State

At the current checkpoint, the package has:

- package-local verification green
- real `runsc-cfc` integration tests green
- a local commit checkpoint on `codex/cf-harness-skeleton`:
  - `9208ac17a` `Add cf-harness policy and gateway controls`

The earlier stage gateway caveat has been resolved, but one auth-defaulting
question remains important:

- standalone `cf-harness` still defaults to `bearer`
- Loom's `cf-harness` adapter defaults to `none`
- that split is intentional for now, but it means operator behavior differs
  between the package CLI and the Loom batch adapter

## What Comes Next

The next implementation step is not fully fixed yet. The main candidates are:

### Option 1: First Loom background integration contract

Define the first narrow product-facing replacement for Loom's current background
`codex exec` usage.

Why:

- it is the clearest real migration target
- it fits the current `cf-harness` shape much better than interactive chat
- it will force the right input/output/artifact contract decisions

Tradeoff:

- it may require some Loom-specific adapter work before more abstract harness
  cleanup

### Option 2: Debug/operator path without direct-command binding

Add a deliberate way to run the prompt loop without the default CLI
direct-command binding.

Why:

- easier manual testing of deny/recovery behavior
- helps exercise the current policy layer more directly

Tradeoff:

- useful for operator experiments, but not the most product-facing work

### Option 3: Runner-aware CFC feedback integration

Start consuming real `runner`-side CFC signals instead of relying only on local
harness heuristics.

Why:

- moves `cf-harness` closer to the intended architectural split
- reduces the risk of harness-local semantic drift

Tradeoff:

- more design-sensitive
- likely needs shared contract refinement across harness, `runner`, and the
  sandbox side

My current recommendation is:

1. Loom background integration contract
2. runner-aware CFC feedback expansion beyond the initial `write_file` seam

The operator/debug surface remains useful, but it is no longer the primary
near-term product milestone.

## Open Questions

These are the main unresolved questions that still matter:

### 1. How quickly should runner-aware CFC feedback be wired in?

Current deny/recovery behavior is harness-local and intentionally conservative.
That is useful, but it is not the final architecture.

### 2. Should `llm.stage.commontools.dev` become a special-case default?

Right now `gatewayAuthMode` defaults to `bearer`, with `none` as an explicit
opt-in. If the stage gateway remains caller-unauthenticated, we may want a more
ergonomic defaulting strategy.

### 3. Do we want a first-class `--api-key` flag?

At the moment the harness uses environment variables only:

- `CF_HARNESS_API_KEY`
- `OPENAI_API_KEY`

That is acceptable, but not the only plausible UX.

### 4. How much resumability do we want before product integration?

Current resumability is transcript-based and useful, but still limited:

- no rich partial tool-call recovery
- no richer orchestration state-machine resume

### 5. When do subagents start mattering?

The package now has a first minimal subagent path: a parent can delegate one
focused child run through `delegate_task`, and the child receives a fresh prompt
context plus the selected profile's tool set. The default profile remains
sandbox shell/file only; the provisional browser profile adds host shell access
for `agent-browser`-style commands. `delegate_task` can also take an optional
`returnSchema`; when supplied, the harness validates the child JSON return,
keeps the raw return in child artifacts, and exposes only a sanitized structured
value with free-form strings and objects with unmodeled keys linkified through
opaque `@link` handles.

The remaining subagent work is still substantial:

- first-class browser-mediated subagent policy on top of the provisional host
  shell path
- parallel child orchestration
- richer orchestration resume for partially completed child runs

## Suggested Reading Order

For a new engineer or agent:

1. [README.md](../../../../../runtime/cf-harness/README.md)
2. [config.ts](../../../../../runtime/cf-harness/src/config.ts)
3. [engine.ts](../../../../../runtime/cf-harness/src/engine.ts)
4. [prompt-loop.ts](../../../../../runtime/cf-harness/src/prompt-loop.ts)
5. [cli.ts](../../../../../runtime/cf-harness/src/cli.ts)
6. [integration/engine.integration.test.ts](../../../../../packages/cf-harness/integration/engine.integration.test.ts)

For the broader architectural context:

- [runner README](../../../../../runtime/runner/README.md)
- `specs/cfc/18-runtime-implementation-profiles.md` in the sibling `specs` repo
