---
status: historical
created: 2026-09-16
archived: 2026-09-16
reason: "Design checkpoint and reproduction evidence before implementation."
---

# Generated internal-cell identity: design checkpoint

This records a design-and-reproduction milestone, not an implemented change.
The objective is to isolate anonymously identified state across authored
artifact updates while preserving intentional continuity and unchanged legacy
pieces. No production files were changed, and no PR disposition was taken.

## Refreshed baseline

- Main: `b71d635a6e7405401ff8f68888bdd275ecefb8f1`, fetched September 16.
- [PR #4916](https://github.com/commontoolsinc/labs/pull/4916): open,
  conflicting, head `9e29077b0e7c1b427c757d3658486b5f9a95e4bb`; four
  PR-only commits and 1,909 main-only commits. The combined discussion and
  review timeline contains eight entries; no entry is newer than July 24.
  The review-thread query returns no inline threads.
- Worktree: `labs-wt-generated-cell-design-20260916`, branch
  `gideon/generated-cell-design-20260916`. The existing checkout and all older
  worktrees were left untouched.
- Deno: repository-pinned `2.9.4`.

The September 10 identity collision remains. Relevant intervening changes
include shared node planning and staged resume waves (#7287), descriptor scope
preservation (#7273), inherited writer authority on start/swap (#7359),
source-update authority across the compiled root (#7538), serving setup commits
outside a wave (#7375), and setup receipts (#7341). These make an old updater
or wholesale asynchronous resume transplant inappropriate.

Production artifact identities still hash authored source and its reachable
dependency closure. The executable runtime fingerprint provider remains a
pending design, explicitly identified as such in
[`module-loading.md`](../../specs/module-loading.md). The main agent verified
the empty fingerprint at the current engine and replication call sites. Lazy
materialization defaults on; server execution defaults off.

## Executed evidence

[`generated-cell-update-diagnostic.test.ts`](../../../packages/runner/test/generated-cell-update-diagnostic.test.ts)
compiles authored versions at the same `/main.tsx` path and uses an in-process
memory server. The assertions characterize the baseline defect; they are not
the desired post-fix regression expectations.

| Fixture | Observation | What it establishes |
| --- | --- | --- |
| Named computed plus callback-created computed | Real, distinct artifact refs; named and generated addresses both reused; visible output settles from v1 to v2 | Structural collision, with benign recomputation in this fixture |
| Callback-created writable plus explicitly named sentinel | Shipping slot receives user state; billing replacement retains that state instead of its own default; named sentinel remains | Observable unintended state transfer through the replacement public projection |
| Independent runtime reopening the writable piece | Fresh runtime starts the persisted replacement and reads the same billing purpose and shipping state | The transfer survives storage reload; it is not merely an old handle reading its old cell |
| Callback-created static child with named `note` state | Parent slot, child result backlink, and named leaf all retain IDs; replacement child reports billing purpose with shipping state | Anonymous child anchoring can transfer named descendant state; slot and child identities were measured separately |

Replacing the writable assertion with the desired `billing-default` expectation
failed with actual `shipping-user-state`. The characterization assertion was
then restored. No concurrency storm, production severity, throughput benefit,
or performance parity was measured. Replacements in these fixtures call
`runtime.setup` directly; the writable case does not start the first graph.
The nested and computed cases exercise live replacement. The independent
runtime is a separate runtime/replica in one process, not a separate worker.

Validation before the checkpoint:

- Diagnostic plus `source-reconciler.test.ts`,
  `pattern-update-argument-validation.test.ts`, and
  `nested-piece-setup-repair.test.ts`: **5 top-level tests / 124 steps passed**.
- Diagnostic file: `deno check --frozen`, targeted lint, and formatting passed.
- The wrong-expectation control failed at the state-transfer assertion.
- Existing lifecycle tests emit expected refusal diagnostics and some teardown
  storage messages; their test result is green. This is focused evidence, not
  full package, integration, or posture-matrix certification.

The test command, from the worktree root, was:

```sh
ENV=test deno test --frozen --no-check \
  --preload=packages/runner/test/clock-preload.ts -A \
  packages/runner/test/generated-cell-update-diagnostic.test.ts \
  packages/runner/test/source-reconciler.test.ts \
  packages/runner/test/pattern-update-argument-validation.test.ts \
  packages/runner/test/nested-piece-setup-repair.test.ts
```

## Mechanism comparison

The main agent deep-read the mint, registration, promotion, setup, resume, and
child-binding paths. Three bounded read-only subagent reviews independently
checked construction context, lifecycle/rollout, and prior art; a subagent also
reviewed the diagnostic assertions. References below name the baseline code,
whose line numbers may move.

| Mechanism | Strength | Required correction or additional work |
| --- | --- | --- |
| Old deferred descriptor-to-ref snapshot | Uses existing post-evaluation artifact registration; local runner change | First-write-wins can retain keyless refs; metadata-based compatibility depends on loading; descriptor-blind child identity binding loses the namespace |
| Earlier trusted context in `factoryFromPattern` / anonymous causes | Authored module identity is available before graph evaluation; namespaced causes naturally reach aliases | Requires a trusted per-artifact symbol before eager construction, canonical export/alias/hoist handling, and compiler/verifier/cache-path changes; module identity alone is insufficient |
| Recommended deferred owner resolution plus explicit instance context | Reuses trusted registration and derived-copy links; avoids a new compiler contract | Resolve a real owner ref lazily, prepare legacy/versioned mode explicitly, and apply the effective generated coordinate to both value and child identity binding |

Relevant current seams:

- `builder/pattern.ts:180-189`: eager pattern callback and factory creation;
  `:378-408`: anonymous and duplicate-name-generated causes.
- `harness/engine.ts:563-579`: authored identity before compilation/evaluation.
- `pattern-manager.ts:2705-2796`: exports and `__cfReg` registrations indexed
  after evaluation, restricted to trusted builder artifacts.
- `builder/pattern-metadata.ts:144-224`: trusted copy ancestry, refusal to pin
  keyless refs on copies, and real-ref promotion.
- `link-utils.ts:878-903`: internal mint; `runner.ts:3030-3100`: manifest
  matching and initialization; `runner.ts:970-979`: owned-store enumeration.
- `runner.ts:11668-11776`: static child value binding uses descriptors, while
  identity binding omits them; child identity uses a cause-only output position.

Merely applying the old descriptor namespace would leave the static child
anchor unversioned. This is a code-path conclusion, not a run of the old PR on
new main. The recommended effective cause is the original cause for a unique
named/manual position or a legacy instance, and a cause namespaced by the
containing artifact's accepted real `{identity,symbol}` for a generated
position in a versioned instance. Value minting applies the existing URI kind;
child-coordinate minting uses the same effective cause with the kind omitted.
The explicit existing-child-link shortcut stays intact. Neither schema nor
incidental link metadata enters this coordinate.

Thus a generated static child anchor resets on its containing authored artifact
update, including its named descendants under that changed parent. A unique
named child anchor retains its existing continuity. Raw/list children require
their own path tests; this finding does not generalize by assertion to every
nested cell. Namespaces belong to the containing artifact, since the child
artifact alone cannot distinguish unrelated anonymous uses of the same child.

## Compatibility and rollout recommendation

Make identity format an explicit per-instance decision, backed by durable
metadata and prepared with the piece's metadata available. Represent unloaded
metadata separately from established legacy state. Keep the mint pure with
respect to loading; it must not guess a format from an absent local read.

- Existing legacy piece, unchanged authored artifact: retain legacy addresses.
- Fresh real-artifact piece: use the versioned format.
- Accepted authored transition of a legacy piece: atomically select the new
  format and artifact namespace with setup, manifest, source state, defaults,
  backlinks, and projection. A refusal commits none of them.
- Reload or same-version repair: reuse the persisted decision. Persist the
  accepted namespace so export aliases cannot silently change it on reload.
- Keyless execution: retain session semantics; never persist a keyless ref as a
  namespace. Promotion resolves the real ref without a stale descriptor cache.
- Historical anonymous documents remain in storage. No copying or garbage
  collection is part of this increment. Artifact-based identities can revisit
  the same namespace when an exact artifact is restored; this is not a fresh
  identity for every edit event.

Use the existing atomic transition in `source-reconciler.ts:1100-1123` and its
matching setup-marker watcher path. Preserve the marker's current tri-state
argument semantics and the missing-stream repair's refusal to restage stored
arguments; neither is a substitute for an explicit identity-format decision.

Metadata preparation must fit current resume waves. Synchronous absence probes
call `#collectResumeOwnedCells` (`runner.ts:6037,6179`), while asynchronous
resume currently collects before syncing owned cells (`:7760,7792`), and list
resume derives child-owned cells before awaiting child-result sync (`:8335-8389`).
Prepare the context outside those pure synchronous derivation paths and cover
delayed nested metadata explicitly.

Older runtimes cannot safely execute transitioned pieces. There is a concrete
admission mechanism to reuse: `stableExpressionResultIds` rejects incompatible
clients at `session.open` (`memory/v2/server.ts:3208-3219`), and clients reject
servers that do not enforce it (`memory/v2/client.ts:541-550`). A **new** contract
marker is required; current marker-bearing clients still use ordinal-only IDs.
The recommendation is a deployment-wide minimum-runtime baseline before any
versioned transition. Backend replacement must disconnect old sockets, and old
tabs/CLI clients must update. This follows the existing protocol-admission
precedent; a selective per-piece mixed-version gate would be additional work.
It does not fence superseded producers among compatible runtimes.

The rollout decision for the user is whether to accept that minimum-runtime
baseline. Publishing new shell assets alone cannot guarantee safe coexistence
with older active runtimes.

## Implementation acceptance after agreement

1. Turn the baseline writable and nested leak cases into reset assertions;
   retain named/manual and sentinel controls, duplicate-name disambiguation,
   generated streams, and kind/scope checks.
2. Cover unchanged legacy open, missing markers and repair, first transition,
   exact versioned reload, restoration of an artifact, and rejected-update
   atomicity with a still-functional previous graph.
3. Measure parent value slot, child result, and named leaf independently for
   anonymous/named static children, list children, and explicit linked children.
   Preserve kind-independent child anchors and no reads of cause-only positions.
4. Cover copied descriptors before/after registration, hoists, multiple exports,
   aliases/re-exports, cold artifact loading, and keyless-to-real promotion.
5. Assert full address agreement (space, ID, path, scope) across setup, value
   binding, manifest, CFC ownership, and cold/delayed-metadata resume.
6. Run an event-driven two-runtime authored upgrade while writes continue;
   assert convergence and anonymous isolation without a throughput claim.
   Test old-client initial admission and reconnect with pending work.
7. Exercise default lazy/server-OFF, eager materialization, and server-ON paths.
   Then run relevant runner/piece/memory package suites, integration, type,
   repository lint/fmt, and changed-document gates in proportion to the patch.

First-class serializable factories, runtime-fingerprint integration, transformer
naming coverage, general producer fencing, and orphan reclamation remain
separate work. Confidence is high in the reproduced baseline and traced seams;
the proposed mechanism and rollout are not implemented or certified here.
