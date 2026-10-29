# cf-harness Skills Support Design and Contract

Date: 2026-04-30

Status: live implementation-specific contract; future sections are non-normative

## Purpose

Define first-class Agent Skills support in `cf-harness` so Common Fabric product
workflows can supply durable, task-specific operating knowledge without stuffing
large documentation bundles into every prompt.

The near-term motivating case is Pattern Factory. Its Claude and Codex paths
depend heavily on repo-local skills such as `pattern-dev`, `pattern-implement`,
`pattern-ui`, `pattern-test`, `pattern-critic`, `agent-browser`, and `cf`. The
`cf-harness` now supplies those skills to Pattern Factory through explicit,
phase-owned preload and profile-scoped child policy.

This spec defines a supported path for skill discovery, activation, provenance,
and CFC-aware handling in `cf-harness`.

## Current Local State

`labs` already has a canonical skill tree:

- `skills/<name>/SKILL.md`
- optional `references/`, `templates/`, scripts, and other assets
- `.agents/skills/<name>` symlinks for Codex and other Agent Skills clients
- `.claude/skills/<name>` symlinks for Claude compatibility

Representative Pattern Factory skills use YAML frontmatter with at least `name`
and `description`, then point to canonical repo docs. Examples:

- `skills/pattern-dev/SKILL.md` points to
  `docs/common/ai/pattern-development-guide.md`.
- `skills/pattern-ui/SKILL.md` points to style, cookbook, component, and binding
  docs.
- `skills/pattern-test/SKILL.md` points to
  `docs/common/ai/pattern-testing-guide.md`.
- `skills/cf/SKILL.md` provides current CLI command guidance.

`cf-harness` uses `skillsRoot?: string` in `src/config.ts` for explicit skill
preload. The CLI, prompt loop, and artifact store persist the discovered
registry and activation artifacts. The registry snapshots `SKILL.md` and
supporting resources present in the configured skill directories at run start.

## External Models Reviewed

The Agent Skills open specification defines a skill as a directory containing
`SKILL.md` plus optional `scripts/`, `references/`, and `assets/`; it requires
`name` and `description` frontmatter and recommends progressive disclosure:
catalog metadata first, full instructions only when activated, resources only
when needed. See [Agent Skills specification][agent-skills-spec].

The Agent Skills client implementation guide recommends scanning project and
user scopes, including the cross-client `.agents/skills/` convention, then
disclosing only `name` and `description` to the model. It explicitly calls out
two viable activation models: ordinary file reads of `SKILL.md` or a dedicated
activation tool. See [Adding skills support][agent-skills-client].

Claude Code skills use YAML frontmatter and markdown body content. Claude Code
supports fields such as `description`, `when_to_use`,
`disable-model-invocation`, `context`, and `allowed-tools`, and project skills
can be committed under `.claude/skills/`. See
[Claude Code skills docs][claude-code-skills].

Hermes Agent uses a dedicated `skills_list` and `skill_view` tool pair. Its
open-source implementation lists compact metadata, loads full `SKILL.md` content
on demand, lists linked files, blocks path traversal for supporting files, warns
on prompt-injection-like patterns, handles platform compatibility, and tracks
skill use. See [Hermes skills guide][hermes-skills-guide],
[Hermes skills_tool.py][hermes-skills-tool], and
[Hermes skill_commands.py][hermes-skill-commands].

OpenCode uses a native `skill` tool. It scans `.opencode/skills`,
`.claude/skills`, and `.agents/skills` at project and global scopes; lists
available skills in the tool description; loads a skill with `skill({ name })`;
and applies allow, deny, and ask permissions. See
[OpenCode Agent Skills][opencode-skills].

OpenAI's public Codex/agent material describes skills as repeatable playbooks
with `SKILL.md` and supporting resources. The Responses API agent-skills
discussion describes a deterministic loading sequence: fetch metadata, fetch and
unpack the bundle into the execution environment, then update model context with
metadata and container path. See
[OpenAI Codex plugins and skills][openai-codex-skills],
[OpenAI Skills overview][openai-skills-overview], and
[OpenAI Responses agent skills][openai-responses-skills].

## Design Goals

1. Use the standard `SKILL.md` directory shape already present in `labs`.
2. Preserve progressive disclosure. Do not eagerly paste entire skill trees into
   every run.
3. Make skill loading deterministic, inspectable, and resumable.
4. Keep CFC semantics authoritative. Skill text can guide work, but it must not
   grant authority or bypass tool policy.
5. Avoid giving the parent model broad `bash` merely to discover skills.
6. Support Pattern Factory's phase-specific skill needs quickly, then grow into
   model-driven skill activation.
7. Keep subagent skill inheritance explicit, because `cf-harness` subagents use
   fresh context and summary-only returns.

## Non-Goals

- Installing skills from remote registries into the skills root. Discovery on
  the external skills.sh registry and pinned acquisition — a `SKILL.md` into a
  capability-typed handle a child consumes, and the skill's `scripts/` held
  host-side beside it — are a separate surface (`search_skills`,
  `acquire_skill`, `delegate_task.skillHandle`), specified in
  `docs/plans/external-skill-acquisition.md` and described in the package
  README; nothing acquired that way enters the registry this document defines,
  and an acquired script answers to the same operator allowlist a registry
  skill's script does.
- Managing user-global skill directories outside an explicitly configured root.
- Running skill scripts automatically, or without the operator allowing them.
- Treating `allowed-tools` as a permission grant.
- Defining Pattern Factory's general orchestration or fulfillment contract.
- Implementing a broad filesystem discovery tool as a prerequisite.

## Skill Compatibility Contract

`cf-harness` should accept skills that follow the Agent Skills directory shape:

```text
skill-name/
  SKILL.md
  references/
  templates/
  scripts/
  assets/
```

For the first supported implementation:

- `SKILL.md` is required.
- YAML frontmatter is expected.
- `name` and `description` are required for catalog discovery.
- `name` should be lowercase alphanumeric with single hyphen separators and
  should match the directory name.
- `description` should describe both what the skill does and when to use it.
- Unknown frontmatter fields are preserved in metadata but ignored for policy.
- `allowed-tools` is advisory or restrictive only. It never expands the
  harness's allowed tool set.
- `disable-model-invocation` or `user-invocable: false` should be honored as
  catalog filters once model-driven activation exists.

Validation should be lenient where that improves compatibility:

- Missing or unparseable `description`: skip and record a diagnostic.
- Name mismatch: warn and load under the frontmatter name if unique.
- Duplicate names: deterministic precedence plus a diagnostic.
- Symlinked skill directories are allowed only when the resolved `SKILL.md`
  stays under the configured skill root or another explicitly allowed root.

## Skill Resource Index

`SKILL.md` and supporting resources are discovered automatically from the
filesystem at runtime. Normal skills do not need a hand-authored resource
manifest.

At run start, `cf-harness` should snapshot every accepted skill directory and
record a resource index inside `skill-registry.json`. This index is bounded by
the configured `skillsRoot` and the resolved skill directory, not by global host
filesystem discovery.

Resource classification is path-convention based:

- `references/**` -> `reference`
- `assets/**` -> `asset`
- `templates/**` -> `template`
- `scripts/**` -> `script`
- any other accepted file under the skill directory -> `other`

Each resource record should include:

- path relative to the skill directory
- kind
- host path
- sandbox path
- byte size
- digest
- text/binary content guess
- diagnostics
- for `scripts/**`: executable bit, shebang when present, and inferred runtime

Resource discovery:

- include the root `SKILL.md` as kind `other` before scanning supporting files,
  counting it toward the resource file limit
- sort paths deterministically
- reject or skip resources whose resolved paths escape the skill directory or
  configured skills root
- avoid following cyclic directory structures
- preserve diagnostics for unreadable, unresolvable, out-of-bound, or
  scan-limited resources

The registry is a snapshot. The implemented `read_skill_resource` tool stat/read
checks the actual file at call time. If the file differs from the run-start
snapshot, the tool reports the mismatch in its output and artifacts rather than
silently treating the snapshot as exact.

## Skill Resource Reads

Status: implemented for indexed skill resources.

`read_skill_resource` is a built-in read tool available to parent runs by
default. A run can read a registered skill's instructions with
`path: "SKILL.md"` without preloading the skill. Supporting resources use their
relative paths:

```json
{
  "skill": "pattern-dev",
  "path": "references/guide.md",
  "maxBytes": 64000
}
```

Behavior:

- requires a run-start skill registry
- requires the named skill to exist in that registry
- rejects absolute paths and `..` traversal
- requires the requested relative path to exist in that skill's registry
  `resources` array
- revalidates the call-time resolved path against the resolved skill directory
  and configured skills root
- reads the call-time file content without shelling out
- returns bounded text content for text resources
- returns metadata only for binary resources
- reports digest/size mismatch diagnostics when the call-time file differs from
  the run-start snapshot
- records read provenance in both the normal per-tool output artifact and
  `skill-resource-reads.json`

Resource read output is context. It cannot authorize tools, protected
observations, writes, or CFC downgrades.

## Skill Script Execution

Status: implemented for scripts of already activated skills the operator allows
— the run-wide switch, or an exact entry.

`run_skill_script` is a built-in side-effect tool. It is not available in the
default parent tool set; callers must explicitly include
`--allow-tool run_skill_script`.

Tool input:

```json
{
  "skill": "deno-memory-profiler",
  "path": "scripts/memory.ts",
  "args": ["usage", "--gc"],
  "cwd": ".",
  "timeoutMs": 60000
}
```

Execution is allowed only when all of these are true:

- a run-start skill registry exists
- the named skill exists in the registry
- the named skill was explicitly activated for this run
- the requested path is relative, normalized, and under `scripts/`
- the exact `skill:scripts/path` pair was allowlisted by operator config
- the resource exists in the run-start registry with `kind: "script"`
- the call-time resolved file still stays inside the resolved skill directory
  and configured skills root
- the call-time digest and size still match the run-start registry snapshot
- the runtime is supported

v1 supports standalone Deno TypeScript/JavaScript scripts and standalone Bash
scripts. The validated script bytes are passed to the interpreter over stdin so
execution uses the same content snapshot that was checked against the run-start
registry instead of a mutable script path.

Deno permissions are inferred from a checked-in `deno run` shebang when present,
otherwise the script runs via `deno run` without extra permission flags. Deno
scripts run as `deno run -`, so v1 rejects literal relative module
imports/exports such as `import "./helper.ts"` until cf-harness has an immutable
staged script-tree design that preserves file-based module resolution.

Bash scripts must use a Bash shebang such as `#!/bin/bash` or
`#!/usr/bin/env bash` and run as `bash -s -- ...args`. Bash shebang interpreter
flags and literal relative `source ./helper.sh` includes are rejected in v1 for
the same reason: stdin execution deliberately avoids resolving supporting code
from the mutable workspace cwd. Other executable shebang scripts are indexed for
metadata, but are not executable by `run_skill_script` in v1.

Bundled scripts that wrap host-adjacent tools should still be parameterized and
policy-shaped. For example, the `agent-browser` scripts attach only to the local
CDP origin their environment supplies, avoid saved browser state and filesystem
capture commands, and emit snapshots/text to stdout so the harness can capture
the run artifact.

The default execution target is the sandbox direct argv API, not a
model-authored shell string. The default cwd is the workspace root, even if the
harness current directory is elsewhere. Optional `cwd` is resolved through
normal sandbox path rules. The sandbox runtime receives:

```text
CF_HARNESS_RUN_ID=<run id>
SKILL_NAME=<skill name>
SKILL_DIR=<sandbox skill directory>
SKILL_SCRIPT=<sandbox script path>
CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET=sandbox
```

Subagent profiles may opt exact allowlisted scripts into host execution when the
script is specifically a host-adjacent integration helper. The browser profile
uses this for the bundled `agent-browser` scripts so they can call the host
`agent-browser` CLI attached to the Browser Access CDP endpoint leased to the
child task. The endpoint is harness-side state: the harness injects it as
`AGENT_BROWSER_CDP` in the script environment, rejects a `--cdp` argument, and
scrubs endpoint echoes — verbatim, URL-encoded, or bare host:port — from the
script output the model reads. The scripts themselves are trusted with the
endpoint the way any digest-pinned bundled code is; the scrub is a backstop
against accidental echoes, not the confinement mechanism. Host-target scripts
receive host paths in `SKILL_DIR` and `SKILL_SCRIPT` and
`CF_HARNESS_SKILL_SCRIPT_EXECUTION_TARGET=host`; they run with a cleared
subprocess environment plus a controlled `PATH` and explicit `CF_HARNESS_*` /
`SKILL_*` variables. They must execute from a workspace cwd outside cf-harness
artifacts. Host-target script output is treated like other browser-profile host
observations: raw stdout/stderr are visible to the child model and retained in
child artifacts, and the parent sees only the sanitized subagent return channel.

Script execution records provenance in the normal tool output artifact and in
`skill-script-executions.json`. In CFC enforce modes, `run_skill_script` is
treated like other side-effect tools: direct-command authorization is required.
Sandbox-target script stdout/stderr/exit-code observations must be mediated
before model exposure.

## CLI and Config Surface

The current config field is:

```ts
skillsRoot?: string;
```

The current CLI flags are:

```text
--skills-root <path>      Skill root containing <name>/SKILL.md
--skill <name>            Preload a skill for this run (repeatable)
--allow-skill-scripts     Run skill scripts in the sandbox, for every skill
                          this run holds, registry and acquired alike
--allow-skill-script <s>  Allow one exact script (skill:scripts/path,
                          where skill is a registry name or an acquired pin;
                          a registry name requires --skills-root, a pin does
                          not)
--no-skill-catalog        Disable automatic skill catalog disclosure
```

Current v1 behavior:

- If `--skills-root` is absent, the run uses the checkout's own `skills/` tree
  when the harness runs out of a checkout, and records that source in run state;
  with no checkout either, skills are disabled.
- `--skills-root` must resolve within `--workspace` unless a future trusted
  external mount policy explicitly allows otherwise.
- `--skill` requires `--skills-root`.
- Multiple `--skill` values are allowed and loaded in the provided order after
  deduplication.
- `--allow-skill-script` is repeatable and deduplicates exact normalized
  entries. An entry keyed on a registry name requires `--skills-root`, since
  that is what gives the script a sandbox path; an entry keyed on an acquired
  pin does not, its bytes reaching the sandbox through the acquisition's own
  mount.
- The entry and the tool are decided separately for the run's own surface and
  together for a child's, and the difference is not a preference. The run's
  surface is `--allow-tool`, a list of tools rather than a list of scripts, so
  an operator narrowing it must include `run_skill_script` — an entry alone does
  not add a tool to a list the operator wrote. A delegated child's surface is
  its profile's, which the operator never writes, so a child handed an acquired
  skill receives `run_skill_script` when two things hold together: the run
  allows skill scripts — the run-wide switch, or at least one entry at that
  skill's pin — and the child's own sandbox mounts that skill. The second is the
  backing gate, which a child sharing a handed-in runtime fails, no mount having
  been added for it — so the allowlist decides what may run and the mount is
  whether there is anything to run. There is no configuration anyone wants in
  which a script is allowlisted and the tool withheld; where that happens on the
  run's own surface it is a mistake, and a run narrowed that way offers no tool
  rather than refusing a call, so nothing names the cause.
- `--no-skill-catalog` is available for tightly scripted batch runs that only
  want explicit preloaded skills.

Do not auto-discover user-global skill roots in the first slice. That keeps the
trust boundary simple and avoids host-specific behavior in batch/product runs.

## Explicit Preload

Status: implemented. The harness scans an explicitly configured `--skills-root`,
accepts repeatable `--skill` preload names, injects the selected `SKILL.md`
files as configured context before the task prompt, and persists
`skill-registry.json` and `skill-activations.json`.

This is enough for Pattern Factory to invoke `cf-harness` with phase-relevant
skills:

```bash
deno task run -- \
  --workspace /path/to/common-fabric-2 \
  --cwd pattern-factory \
  --skills-root /path/to/common-fabric-2/labs/skills \
  --skill pattern-dev \
  --skill pattern-implement \
  --prompt "Build this pattern..."
```

Behavior:

1. Resolve and validate `skillsRoot`.
2. Build a registry of `skillsRoot/**/SKILL.md` with bounded traversal.
3. Validate frontmatter and produce diagnostics.
4. For each accepted skill, index `SKILL.md` and supporting resources from the
   runtime filesystem and record them in `skill-registry.json`.
5. For each explicit `--skill`, read the full `SKILL.md`.
6. Inject a structured skill context block before the user task.
7. Record skill registry and skill activation artifacts.
8. Preserve the activated skill context in transcript/resume state.

The injected block should be labeled as configured context, not as a direct user
command:

```text
Configured skills context:

<skill_context name="pattern-dev" source="/workspace/labs/skills/pattern-dev/SKILL.md">
...full SKILL.md...
Skill directory: /workspace/labs/skills/pattern-dev
Relative paths in this skill resolve against that directory unless stated otherwise.
</skill_context>
```

The harness system prompt should state:

- Skill content is task guidance from the configured workspace.
- Harness policy, CFC policy, and explicit user instructions take precedence.
- A skill cannot authorize tools or protected observations by itself.
- Supporting files are not loaded unless explicitly read through an allowed
  harness tool.
- Supporting resource reads are recorded as context provenance.

## Eventual Dynamic Activation

After explicit preload is working, add a dedicated `skill` or `load_skill`
built-in tool rather than relying on `bash` for discovery.

Tool shape:

```json
{
  "name": "load_skill",
  "description": "Load full instructions for one configured skill.",
  "parameters": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "enum": ["pattern-dev", "pattern-ui"]
      },
      "file_path": {
        "type": "string",
        "description": "Optional path inside the skill directory."
      }
    },
    "required": ["name"]
  }
}
```

The tool description can contain the available skill catalog, following the
OpenCode pattern. If no skills are available, do not register the tool.

Activation output should include:

- skill name
- `SKILL.md` content, either full file or body plus metadata
- skill directory in sandbox path form
- optional supporting file listing
- digest/provenance fields in artifacts, not necessarily in model-visible text

When `file_path` is provided:

- reject absolute paths
- reject `..`
- resolve relative to the skill directory
- ensure the resolved path remains inside the skill directory
- support text files first
- return a binary-file placeholder for non-text files

## Catalog Disclosure

For v1, the catalog is optional because explicit preloading is the immediate
Pattern Factory need.

For dynamic activation, disclose a compact catalog containing:

- `name`
- `description`
- optional compatibility/user-invocable indicators
- no full markdown body
- no unbounded file listings

Catalog placement can be either:

- a system prompt section, or
- the `load_skill` tool description.

Prefer the tool description once a dedicated tool exists, because it couples
discovery and activation and keeps the main system prompt smaller.

Catalog filtering:

- Hide invalid skills.
- Hide denied skills.
- Hide model-invocation-disabled skills from model-driven catalog entries.
- Still allow explicit `--skill` preload for non-user-invocable phase skills
  when the caller has configured them intentionally.

## CFC and Policy Semantics

Skills are retrieved context. They are not direct operator commands.

`cf-harness` should classify skill injection and skill tool outputs as
context/provenance in run artifacts. They must not be treated as
`direct-command` prompt-slot evidence.

Policy rules:

- A skill cannot grant a tool that the run did not already allow.
- A skill cannot downgrade CFC enforcement.
- A skill cannot authorize reading protected substrate observations.
- A skill script can run only through `run_skill_script`, and only where the
  operator allows skill scripts: `--allow-skill-scripts` for every skill the run
  holds, or an exact `skill:scripts/path` entry for one. The switch covers a
  registry skill and an acquired one alike, since what a script is trusted with
  is the sandbox it runs in rather than where the skill came from.
- A registry skill's script must additionally belong to a skill activated by
  name in this run, and match that script's entry in the run-start registry
  snapshot by digest and size.
- An acquired skill's script goes through the same decision. An entry naming one
  keys on the pin its bytes were read at — `owner/repo/slug@<commit sha>` —
  since an acquired skill has no registry name; a run with the switch on needs
  no entry at all. It has no registry and no run-start snapshot either, so the
  two conditions above are met differently: the run must hold an activation
  whose acquisition names that pin, and the file must match the digest taken at
  acquisition. The run-wide switch satisfies the allowlist gate for an acquired
  script as for a registry one, and replaces neither of those two conditions. It
  runs in the sandbox; a run whose skill-script execution target is the host
  refuses it.
- What backs `run_skill_script` for an acquired script is the mount that puts it
  at a path, so a run given no `--skills-root` still offers the tool to a child
  whose sandbox carries that mount, and `--allow-skill-script` takes an acquired
  pin without a skills root. A run holding an acquired skill it does not mount —
  the acquiring parent, or a child sharing a handed-in sandbox runtime — is not
  backed by the mount. That is not the same as having no tool: a skills root
  backs `run_skill_script` on its own, so such a run is offered the tool
  whenever it has one, and what stops it is a refusal rather than an absence.
  The acquiring parent never loaded what it acquired, so no activation names the
  pin and the call refuses `skill_not_activated`; a run that is activated for
  the pin and still lacks the mount refuses `script_not_mounted`.
  `read_skill_resource` stays registry-backed, an acquired skill having no
  resource index.
- `allowed-tools` can narrow or advise, but v1 should not let it expand the
  allowed tool surface.
- Prompt-injection-like content in a skill should produce a diagnostic event. It
  should not automatically block trusted repo-local skills, but third-party
  roots can be stricter later.

The CFC policy snapshot should eventually include:

- configured `skillsRoot`
- loaded skill names and digests
- activation source (`cli-preload`, `model-tool`, `user-explicit`,
  `subagent-inherit`, `skill-handle`)
- whether skill content was injected as context
- any skill diagnostics relevant to trust or provenance
- exact skill script allowlist entries

## Artifacts and Resume

Persist these artifacts under the run root:

```text
skill-registry.json
skill-activations.json
acquired-skills.json
```

`skill-registry.json`:

```json
{
  "type": "cf-harness.skill-registry",
  "version": 1,
  "skillsRoot": "/workspace/labs/skills",
  "generatedAt": "...",
  "skills": [
    {
      "name": "pattern-dev",
      "description": "...",
      "skillPath": "/workspace/labs/skills/pattern-dev/SKILL.md",
      "skillDir": "/workspace/labs/skills/pattern-dev",
      "digest": "sha256:...",
      "resources": [
        {
          "path": "scripts/check.ts",
          "kind": "script",
          "resourcePath": "/workspace/labs/skills/pattern-dev/scripts/check.ts",
          "sandboxResourcePath": "/workspace/skills/pattern-dev/scripts/check.ts",
          "sizeBytes": 2048,
          "digest": "sha256:...",
          "contentKind": "text",
          "script": { "executable": true, "runtime": "deno" },
          "diagnostics": []
        }
      ],
      "frontmatter": {},
      "diagnostics": []
    }
  ],
  "diagnostics": []
}
```

Each script resource carries the `digest` and `sizeBytes` a registry script's
execution is held to. `run_skill_script` re-reads the file and refuses when
either has moved.

`skill-activations.json`:

```json
{
  "type": "cf-harness.skill-activations",
  "version": 1,
  "activations": [
    {
      "name": "pattern-dev",
      "source": "cli-preload",
      "runId": "...",
      "skillPath": "/workspace/labs/skills/pattern-dev/SKILL.md",
      "digest": "sha256:...",
      "activatedAt": "...",
      "cfcPromptRole": "context"
    },
    {
      "name": "handle:cfh:a:3kk78",
      "source": "skill-handle",
      "runId": "...",
      "digest": "sha256:...",
      "activatedAt": "...",
      "cfcPromptRole": "context",
      "handleToken": "cfh:a:3kk78"
    },
    {
      "name": "handle:cfh:a:f4ecd",
      "source": "skill-handle",
      "runId": "...",
      "digest": "sha256:...",
      "activatedAt": "...",
      "cfcPromptRole": "context",
      "handleToken": "cfh:a:f4ecd",
      "acquisition": {
        "registryId": "owner/repo/slug",
        "commitSha": "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c",
        "sourceUrl": "https://raw.githubusercontent.com/owner/repo/dd93980.../skills/slug/SKILL.md",
        "verification": "git-commit-sha",
        "valueDigest": "sha256:...",
        "receivedAt": "..."
      }
    }
  ]
}
```

The registry path fields (`skillPath`, `skillDir`, `sandboxSkillPath`,
`sandboxSkillDir`) are absent for a `skill-handle` activation: its text came
from a cell the delegation's `skillHandle` named, not from a registry directory,
and `handleToken` plus `digest` carry its provenance instead.

A handle an acquisition minted carries `acquisition` as well, and that is what
an acquired skill's script is authorized by: the run holds the skill when an
activation's `acquisition` names the pin, since there is no registry name to
match.

The child's `skill_context` header includes that acquisition's pin as
`pin="owner/repo/slug@<commit sha>"`. It is the `skill` argument accepted by
`run_skill_script`. A run holding acquired skills receives a pin hint when a
non-pin identifier fails registry lookup. The header is context metadata; the
activation digest and return scrub cover the skill text itself.

`acquired-skills.json`, written only by a run that acquired a skill carrying
scripts:

```json
{
  "type": "cf-harness.acquired-skills",
  "version": 1,
  "generatedAt": "...",
  "skills": [
    {
      "registryId": "owner/repo/slug",
      "commitSha": "dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c",
      "pin": "owner/repo/slug@dd93980e2f9a1d4c4d50a6e1a3cbb6e2b7a91f3c",
      "hostRoot": "<artifactRoot>/.acquired-skills/<runId>/<commitSha>/slug",
      "sandboxRoot": "/acquired-skill",
      "scripts": [
        {
          "path": "scripts/report.sh",
          "hostPath": "<hostRoot>/scripts/report.sh",
          "sandboxPath": "/acquired-skill/scripts/report.sh",
          "valueDigest": "sha256:...",
          "sizeBytes": 512
        }
      ]
    }
  ]
}
```

`valueDigest` is the digest taken at acquisition, in the encoding the
acquisition records, and it stands where a registry script's snapshot digest
stands: the execution re-reads the file and refuses when it has moved. The
`hostRoot` sits outside every run root, so no run's own artifacts contain it.

On resume:

- Re-read the persisted registry and activation records.
- Verify current file digests match when the same `skillsRoot` is available.
- If a digest changed, record a resume diagnostic and either reload the changed
  skill explicitly or fail closed for batch mode. Batch mode should prefer
  fail-closed behavior unless the caller opts into drift.

## Subagents

`cf-harness` subagents start with fresh context and return only a summary plus
sanitized state to the parent. Skills therefore need explicit child handling.

Current rule:

- Parent active skills do not implicitly transfer to child runs.
- Subagent profiles may define exact child skills, exact child skill-script
  allowlists, and a skill-script execution target.
- The browser profile activates `agent-browser` when the parent run has a skill
  registry. It exposes `read_skill_resource` and `run_skill_script` in the child
  and allowlists the non-credentialed bundled `agent-browser` browser workflow
  scripts.
- The `pattern-author` profile activates `pattern-dev`, `pattern-schema` and
  `pattern-ui` and exposes `read_skill_resource` in the child.
- Profile-scoped skill preload is best-effort against the run's registry. A
  profile names the skills its child works best with, while the skills root is
  configured per run; the child preloads whichever of them the registry carries
  and runs without the rest. A skills root missing a profile's skills yields a
  weaker child, not a failed delegation. Caller-requested `--skill` preload is
  unchanged: an unknown name there is still an error.
- Browser-profile skill scripts run through the host process runner because they
  need the host `agent-browser` CLI. This is profile-scoped host execution, not
  a general parent-run script mode.
- Credential-bearing scripts such as
  `agent-browser:scripts/authenticated-session.sh` are not in the default
  browser-profile allowlist. Re-enabling them should use an explicit credential
  grant and origin-binding design.
- Child skill activations and script executions are recorded in the child run
  artifacts.
- The parent receives only the child summary and sanitized state, not raw child
  skill content.

This preserves the current CFC posture: delegation is a visible policy
transition, child artifacts retain detail, and the parent does not silently
receive additional raw context through the return channel.

## Pattern Factory Wiring

Pattern Factory does not depend on model-driven skill selection. Its launcher
knows the phase and passes exact skills.

The default mapping is:

| Phase         | Explicit skills                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `spec`        | none                                                                                                                        |
| `ux_design`   | none                                                                                                                        |
| `ui_design`   | `pattern-ui`, `lit-component`                                                                                               |
| `build`       | `pattern-dev`, `pattern-schema`, `pattern-implement`, `pattern-test`, `pattern-debug`, `pattern-ui`, `cf`, `pattern-deploy` |
| `critic`      | `pattern-critic`, `pattern-dev`, `pattern-test`, `pattern-debug`, `pattern-ui`                                              |
| `manual_test` | `agent-browser`, `cf`, `pattern-deploy`, `pattern-debug`, `pattern-test`                                                    |
| `grade`       | none                                                                                                                        |
| `summarize`   | none                                                                                                                        |

The launcher keeps phase tools separate from skill content. Loading a skill does
not grant `bash`, file writes, browser access, or script execution.

For Pattern Factory's symlinked layout, prefer passing the canonical labs root:

```text
--skills-root /path/to/common-fabric-2/labs/skills
```

The harness should expose sandbox paths in injected text, for example:

```text
/workspace/labs/skills/pattern-dev/SKILL.md
```

This avoids ambiguity between host paths and sandbox paths.

## Delivery Status

| Capability                                                                          | Status                                                     |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Explicit skill root, discovery, preload, registry, activation, and resume artifacts | implemented                                                |
| Indexed supporting-resource reads                                                   | implemented                                                |
| Exact allowlisted sandbox Deno/Bash skill scripts                                   | implemented                                                |
| Acquired skills' scripts, run under that same allowlist and keyed by pin            | implemented                                                |
| Profile-scoped host skill scripts for the leased browser child                      | implemented                                                |
| Pattern Factory phase-specific skills                                               | implemented                                                |
| Explicit child-profile skill policy and summary-only parent return                  | implemented                                                |
| Model-driven dynamic `load_skill` activation                                        | not implemented; future design above                       |
| User/global/remote skill installation into the skills root                          | not planned without a product requirement and trust design |
| External registry discovery and pinned acquisition by handle (skills.sh)            | implemented outside this contract; see the package README  |

## Open Questions

- Should `--skills-root` accept multiple roots now, or stay singular until a
  concrete product need appears?
- In batch resume, should skill digest drift fail closed by default? This spec
  recommends yes, but operator mode might prefer a warning.
- What stable policy vocabulary should govern model-driven catalog visibility
  before a `load_skill` tool is added?
- If multiple roots are ever supported, how should precedence, duplicate names,
  and trust tiers be represented in artifacts?

## Current Direction

Keep explicit caller preload as the stable product path. Add dynamic
model-driven activation only in response to a concrete workflow that cannot
select skills at the adapter boundary, and only after catalog visibility,
provenance, resume, and child-policy semantics are specified and tested.

[agent-skills-spec]: https://agentskills.io/specification
[agent-skills-client]: https://agentskills.io/client-implementation/adding-skills-support
[claude-code-skills]: https://code.claude.com/docs/en/skills
[hermes-skills-guide]: https://hermes-agent.nousresearch.com/docs/guides/work-with-skills
[hermes-skills-tool]: https://github.com/NousResearch/hermes-agent/blob/main/tools/skills_tool.py
[hermes-skill-commands]: https://github.com/NousResearch/hermes-agent/blob/main/agent/skill_commands.py
[opencode-skills]: https://opencode.ai/docs/skills
[openai-codex-skills]: https://openai.com/academy/codex-plugins-and-skills/
[openai-skills-overview]: https://academy.openai.com/public/resources/skills
[openai-responses-skills]: https://openai.com/index/equip-responses-api-computer-environment/
