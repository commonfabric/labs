# FAQ Index

This is a **lightweight index** of frequently asked questions. Each entry contains:
- The question being asked
- A pointer to the documentation that answers it (file path and section reference)
- When the answer was last updated

**Important:** This file is an index only. Detailed explanations, reasoning, and context live in the actual documentation files referenced here. When an entry is added or updated, the reasoning for that change belongs in the git commit message.

When entries are added or modified, provenance can be found in this file's git history.

---

| Question | Answer Location | Last Updated |
|----------|-----------------|--------------|
| What type should handlers use in Output interfaces? | `docs/common/concepts/handler.md` - Section "Exporting Handlers as Streams". Use `Stream<T>` (not `Reactive<T>`) for handlers in Output interfaces. `Stream<T>` represents a write-only channel that other pieces can call via `.send()`. | 2026-06-10 |
| How do I run the cf command? | `skills/cf/SKILL.md` - Section "Running CF". Always use `deno task cf [command]`. There is no binary to build or verify for normal development - `cf` runs TypeScript directly via deno. | 2026-03-25 |
| How do I compare objects for identity? Why does my custom `id` property not work? | `docs/common/concepts/identity.md` and `docs/development/debugging/gotchas/custom-id-property-pitfall.md`. Use `equals()` from `commonfabric`. Properties in `.map()` callbacks are Cells, not plain values. | 2026-03-25 |
| Why do I get "reactive reference outside context" when using input props in `[NAME]` or `new Writable()`? | `docs/development/debugging/gotchas/reactive-reference-outside-context.md`. Input props are reactive values that can only be accessed inside reactive contexts (`computed()`, `lift()`, JSX, event handlers). Wrap `[NAME]` in `computed()`, initialize cells with static values and set from event handlers. | 2026-01-14 |
| When should I use `action()` vs `handler()`? | `docs/common/concepts/action.md`. Use `action()` for most cases - it works inside patterns and closes over state. Use `handler()` only when you need to reuse the same logic with different state bindings or export for other patterns to call. | 2026-01-14 |
| Why can anyone write to the space I just created? How do I make it private? | `docs/tutorial/10-identity-and-security.md` - Section "Reading and changing a space's ACL". Named-space bootstrap grants `"*": "WRITE"` as a rollout default, so a new space is world-writable; `cf acl remove ANYONE` drops the wildcard. | 2026-07-31 |
| Why is my ACL write rejected — "… is the space ACL document: mutate it through ACLManager" or "ACL mutations must replace the space-scoped ACL document"? | `docs/specs/memory-v2/09-invariants.md` - INV-12. Same cause, two reporters: an ACL change must be a single whole-document `set` on `of:<space>`, and a write through the ordinary value surface emits `op: "patch"`. The runner's write chokepoint (`extended-storage-transaction.ts` `noteSystemWrite`) now throws the first message in-process, before any round-trip, so that is what an in-process value-path writer sees; the second is the memory server's own refusal, still reachable for commits that bypass the chokepoint (a raw `session.transact`, or a non-runner client). Fix both by going through `ACLManager` / `cf acl`, which replaces the whole document. See also `04-protocol.md` §4.5.1. | 2026-07-31 |
| Why did my whole-document write get rejected for CFC — "unprivileged write to protected runtime surface …/cfc"? | `docs/plans/runner_cfc_implementation.md` - Section "Document Surface Rules". A write at path `[]` replaces every reserved sibling, so an envelope built as a fresh `{ value }` drops the document's stored `cfc` label map; so does one carrying a `cfc` a reader reports as absent, such as `null`; and one carrying a `cfc` of your own installs a map the derivation pass never derived. The runner's write chokepoint (`extended-storage-transaction.ts` `noteSystemWrite`) records any of those and the enforcing modes reject it, and the same holds for the other reserved sibling, `source`. Read the stored envelope and spread it, the way `ACLManager` does, so the siblings survive the replacement. There is no write option and no exported value that lets a caller past this; a test fixture seeds stored label state through `seedStoredEnvelope` in `packages/runner/test/cfc-seed-envelope.ts`, which runs one write inside the runtime's own privileged persistence scope. | 2026-09-17 |
