# Cast-free patterns

Status: proposed. The stages below are not implemented.

## Goal and scope

Remove type assertions from authored patterns. Give authors APIs and types that
let the compiler check their code without assertions. Prevent new assertions
with lint and enforce the same policy when accepting new pattern source.

Include all maintained pattern programs and their authored dependencies:

- The trees registered in
  [`tasks/pattern-files.ts`](../../tasks/pattern-files.ts), including
  connector-owned patterns.
- Pattern tests executed by `cf test`, their shared helpers, and executable
  pattern fixtures under integration directories.
- Executable generated patterns, including those under
  `packages/generated-patterns`. Update generators to produce compliant code;
  their host-side implementation is outside the pattern-source ban.
- Authored local imports, including JavaScript and JSDoc. Moving an assertion
  into a helper or changing a file extension must not evade the policy.

Host-side test drivers, runtime implementations, generated compiler output, and
immutable deployed-source records are separate from authored pattern programs.
Classify them by how they are used. A helper imported into a pattern belongs to
the checked program even if it lives outside a pattern directory. Legacy and
fixture tiers are migration priorities, not permanent exemptions.

This work changes pattern source and the APIs it needs. It does not require
removing every assertion from the runtime implementation. An API repair must
establish its promised behavior; moving an unchecked conversion into a runtime
helper is not a repair.

## The policy

| Construct                                              | Intended treatment                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value as T`, `<T>value`, and chained assertions       | Remove and reject, including assertions to `any`, `unknown`, and `never`.                                                                                                                                                                                                             |
| `as const` and `<const>` assertions                    | Remove in a separate mechanical pass. These preserve literal information rather than inventing a value's type, but the final syntax rule has no assertion exception. Preserve literal and readonly types through checked declarations, inference, and suitable existing generic APIs. |
| Non-null assertions and definite-assignment assertions | Remove and reject. Represent absence and initialization in the type and control flow.                                                                                                                                                                                                 |
| Explicit `any`, including aliases and JSDoc            | Remove and reject in authored pattern code. Track unsafe uses of inferred or imported `any` separately; banning the keyword does not catch them.                                                                                                                                      |
| `unknown`                                              | Retain only where information is intentionally absent: a real validation boundary, an ignored value, or a runtime reference. Model fields that are actually read.                                                                                                                     |
| `satisfies`, typed declarations, and type arguments    | Allow when their contracts are checked. A helper that returns an arbitrary caller-selected `T` without evidence is an assertion under another spelling.                                                                                                                               |
| Explicit type predicates and assertion signatures      | Remove and reject in authored patterns. Use compiler-inferred narrowing or decoders that construct checked results. Runtime validators belong to a tested public API; recognizing a value's outer shape cannot establish an arbitrary caller-selected type.                           |
| Compiler and lint suppression comments                 | Do not allow them to bypass this policy in accepted pattern source. Keep intentional compiler rejection cases in the test harness as source fixtures with expected diagnostics.                                                                                                       |

`unknown` requires special care in Common Fabric. A schema field declared
`unknown` retains a reference instead of fetching its contents. Replacing it
with an object type changes the read. See
[`unknown`](../common/concepts/types-and-schemas/unknown.md) and
[the reference-read diagnostic guide](../development/debugging/gotchas/unknown-typed-field-reads-a-reference.md).
Preserve that behavior while removing casts used to compare, navigate, or
address references. Use narrow consumer projections when fields must be read.

Use `void` for an event whose payload is unused when its call contract permits
that change. Use an empty-input type only for a pattern that takes no input. Do
not replace every `unknown` mechanically: changing either declaration can change
a generated schema and its compatibility with stored pieces.

## Existing foundations and investigation targets

[`cfcheck`](../../tasks/cfcheck.ts) checks a batch of pattern programs in the
actual compiler environment, including their local imports. The compiler already
enables strict checking in
[`options.ts`](../../packages/js-compiler/typescript/options.ts).
[`pattern-files.ts`](../../tasks/pattern-files.ts) excludes test entries and
integration directories. Its current entry list is therefore a starting point
for this migration, not the complete scope.

The root [`deno.jsonc`](../../deno.jsonc) excludes `no-explicit-any` and
registers custom lint plugins. Reuse that plugin mechanism. Existing
[`lint-inline-imports` tests](../../tasks/lint-inline-imports.test.ts)
demonstrate `Deno.lint.runPlugin` for source-based rule tests. Keep the new
policy scoped to authored patterns rather than turning unrelated runtime debt
into this task.

The following source sites identify useful first investigations. They establish
where assertions exist, not whether each assertion is redundant or which API
change is correct.

| Family                 | Source evidence                                                                                                                                                                                                                           | Investigation                                                                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSX composition        | [`send-publish-examples.tsx`](../../packages/patterns/cfc-trusted-component-examples/send-publish-examples.tsx) casts child screens to `never`.                                                                                           | Remove a representative cast and check the actual compiler diagnostic. Correct the producer or JSX contract if needed. Verify nested controls remain bound to their owning piece. |
| Reference operations   | [`reference-address.ts`](../../packages/patterns/notes/reference-address.ts) accesses runtime cell methods through `any`; [`daily-journal.tsx`](../../packages/patterns/notes/daily-journal.tsx) casts around navigation and composition. | Provide the smallest supported public reference operation and preserve identity, paths, scopes, and cross-space addresses.                                                        |
| CFC and cell metadata  | [`trusted.tsx`](../../packages/patterns/cfc-group-chat-demo/trusted.tsx) casts reads, snapshots, writes, and handler inputs.                                                                                                              | Distinguish plain values, defaults, cell capabilities, and policy metadata in the shared types. Establish which conversions the runtime authorizes.                               |
| Provider and open data | The [agent debug view](../../packages/connectors/agents/debug-view/main.tsx) contains open data typed with `any`.                                                                                                                         | Validate external data and retain a recursive data type where the view intentionally accepts arbitrary data.                                                                      |
| Test helpers           | [`vnode-helpers.ts`](../../packages/patterns/test/vnode-helpers.ts) walks rendered values and casts callable properties.                                                                                                                  | Give tests checked traversal and event-dispatch APIs so test migrations do not duplicate conversions.                                                                             |

## Stage 1: inventory and prevent new debt

- [ ] Build a reproducible AST inventory using the repository's pinned
      TypeScript parser. Record file, location, assertion kind, target type,
      enclosing declaration, and source role. Count `as const`, non-null
      assertions, `any`, `unknown`, predicates, and suppressions separately.
      Import aliases, comments, and ordinary strings are not type assertions.
- [ ] Inventory the complete authored module graphs. Extend shared discovery to
      cover pattern test entries and executable generated or integration
      patterns without treating host test drivers as pattern entries. Check
      coverage against the entry sets each runner actually executes.
- [ ] Classify each site as redundant, incorrect domain modeling, a missing
      public API, an inference or transformer defect, unvalidated external
      input, or an intentional negative test. Group sites by the shared cause.
      Identify unsafe uses of inferred or imported `any` with the existing
      TypeScript program now, so they enter the repair queue before final
      enforcement.
- [ ] Add a reporting check with a temporary, per-occurrence debt baseline. CI
      rejects new occurrences immediately. Baseline edits may only remove
      entries; they cannot add allowances. A removed cast cannot pay for a new
      cast elsewhere, including elsewhere in the same file. Reject stale entries
      as well. Keep this separate from deployed-schema baselines.

Exit: every maintained pattern program is accounted for, the report is
reproducible, and a test demonstrates that replacing one old assertion with a
new assertion still fails the check. This reporting stage supplies measurement
and regression prevention before the unconditional lint ban is enabled.

## Stage 2: repair shared causes with representative callers

- [ ] Start with JSX composition and reference operations. Attempt cast removal
      before redesigning an API. Pin a necessary change with a minimal failing
      compiler or runtime test, and verify that it fails for the intended
      reason. Migrate a real caller in the same change.
- [ ] Repair cell and factory typing where evidence requires it: read versus
      write access, nested cells, `Default`, scoped values, handler binding, and
      composed pattern results. Preserve the narrow projections each consumer
      needs. Avoid making writable types interchangeable by widening their
      parameters. A check that recognizes a cell or stream establishes its kind,
      not the type of its contents. Reading a particular shape needs a checked
      projection or validation contract.
- [ ] Repair CFC construction and binding contracts without stripping policy
      metadata. Plain data must not acquire trusted authority because a new type
      alias or generic helper claims it has it. Exercise authorized and
      unauthorized operations in runtime tests.
- [ ] Model event payloads and asynchronous states at their sources. Prefer
      discriminated unions and ordinary control-flow narrowing over repeated
      property checks inside business logic.
- [ ] Audit `JSON.parse`, response parsing, open dictionaries, generic fetch and
      LLM results, and type guards for inferred `any` or unchecked `T`. Reuse
      actual schema validation where it proves the desired type. Where data is
      unvalidated, decode it at ingress and return a checked value or an
      explicit error. Test malformed and nested values. Confirm that a generic
      API really validates; its type parameter alone proves nothing. Decode raw
      ingress before it becomes a schema-driven `unknown` reference, or read
      through a declared data projection. A decoder cannot recover fields that
      its input schema did not retrieve.
- [ ] Preserve arbitrary-data use cases with a supported recursive value model.
      Prove its schema generation and reads before replacing open payload types
      in the debug view or provider patterns.
- [ ] Change the authored API definitions and regenerate
      [`commonfabric.d.ts`](../../packages/static/assets/types/commonfabric.d.ts)
      with the
      [existing generator](../../packages/static/scripts/generate-commonfabric-types.ts).
      Verify the compiler's served types and the runtime implementation agree.

Exit for each family: a representative pattern compiles without its assertions,
invalid uses fail with the expected diagnostic or validation error, and runtime
tests preserve the relevant capabilities and behavior. Each shared repair can
land independently with its first migrated caller.

## Stage 3: migrate the remaining programs

- [ ] Remove redundant assertions and replace unchecked construction with typed
      initializers, return annotations, `satisfies`, or correct type arguments.
      Preserve tuple shapes, literal values, and readonly behavior while
      removing constant assertions. Do not introduce generic conversion helpers
      just to make the assertion count fall.
- [ ] Migrate shared helpers, primitives, exemplars, and system patterns first.
      Continue by cause through CFC patterns, connectors, provider patterns,
      demos, generated programs, and remaining fixtures. Migrate each pattern's
      tests with it. Reduce the temporary baseline in each change.
- [ ] Replace casts that conceal incomplete models with the fields actually read
      or written. Preserve error states and handle missing data explicitly.
      Avoid adding broad index signatures or filling fields with invented
      default values solely to satisfy the checker.
- [ ] Keep runtime rejection tests meaningful. Send malformed data through the
      real validated ingress from a host test when necessary. Compiler rejection
      tests can supply invalid source as test data. Do not remove rejection
      coverage or exempt an entire fixture directory.
- [ ] Update generators, authoring instructions, checked documentation examples,
      and the pattern index so subsequent patterns use the repaired APIs. Remove
      obsolete guidance that recommends assertions or `any`.

Exit for each batch: its authored programs and tests have no forbidden sites,
their applicable checks pass, and the inventory decreases without new
allowances. Fix a newly exposed defect in a separate focused change when it
needs behavior beyond the typing migration.

## Stage 4: enable the unconditional lint policy

- [ ] Add the pattern-scoped Deno plugin through the existing root lint task.
      Cover both assertion syntaxes, constant assertions, non-null and
      definite-assignment assertions, explicit `any`, explicit type predicates
      and assertion signatures, and JSDoc equivalents. Report the authored
      location and the kind of checked replacement needed. Do not automatically
      remove assertions whose semantics are unproven.
- [ ] Prevent suppression directives or local lint configuration from becoming
      an alternative way to accept forbidden source. Test imported helpers,
      connector paths, test patterns, generated patterns, path normalization,
      and JavaScript sources against the same scope contract.
- [ ] Add compiler-backed checks for unsafe uses of inferred or imported `any`
      that the syntax rule cannot see: property access, calls, assignments,
      arguments, and returns. Reuse the existing pattern TypeScript program;
      Deno's syntax plugin cannot establish these facts. Test API-returned and
      aliased `any`, including a file with no explicit `any` keyword.
- [ ] Test that a generic predicate which always returns true cannot claim an
      arbitrary `T` for its argument. Keep validated runtime APIs outside the
      authored-source ban, with tests proving their actual narrowing contracts.
      Do not add unchecked overloads or ambient declarations to conceal a
      conversion from the authored-source checks.
- [ ] Reach zero remaining forbidden occurrences and remove the temporary debt
      baseline and its allowances. Require the lint and compiler checks in CI
      for the complete maintained source set.

Exit: a new forbidden construct fails regardless of directory tier, spelling, or
introduction through an imported authored helper. Invalid assignments still fail
type checking after assertions have been removed. No permanent debt allowlist
remains.

## Stage 5: enforce the policy at authoring entry points

- [ ] Run the policy on authored source before transformation when checking,
      creating, updating, or admitting a newly generated pattern. Keep the
      semantic policy and test cases aligned between the compiler and lint
      adapters. Place shared compiler logic in the appropriate compiler package;
      do not import repository tasks into a runtime package.
- [ ] Enforce validation even when compilation is reused from cache or an
      operation requests `noCheck` or `--no-check`. A compiled artifact does not
      prove that current authoring policy accepted the source. Reuse a
      validation result only when it covers the complete source graph, current
      policy, and current type environment under new-source admission rules.
- [ ] Check the complete authored import graph. Do not inspect assertion nodes
      synthesized by the compiler or bundled runtime declarations as authored
      source. Check JavaScript/JSDoc modules with a policy that prevents untyped
      JavaScript from bypassing the TypeScript checks.
- [ ] Preserve identity-pinned reload of already-deployed source. Use the
      established distinction between authoring diagnostics and stored-source
      reconstruction. A user submitting source through a new create or update
      operation must not acquire that exemption. Test both paths explicitly.
      Warm the compilation cache by loading legacy source containing a cast,
      then reject the same bytes submitted through create and update, including
      with type checking disabled. Confirm the legacy reload still succeeds.
- [ ] Ensure CLI and hosted authoring return actionable diagnostics. Update the
      authoring guide and mark the policy as required once it is active.

Exit: local lint, CI, and new pattern admission agree. Existing stored pieces
can reload while new or updated source must meet the policy. Archive this plan
when the migration and enforcement stages are complete.

## Verification and compatibility

Type annotations drive generated schemas, so a successful TypeScript check is
only one part of verification. For every relevant migration batch:

1. Before changing stateful patterns or the compiler behavior they use, ensure
   pinned vintage fixtures capture their existing durable state. Add missing
   representative coverage against the pre-migration source, following
   [pattern update testing](../specs/pattern-update-testing.md). Capture linked
   and scoped state where the change can affect it.
2. Run `cf check` on affected entries and the full `deno task cfcheck` before
   completion. Use the actual pattern compiler rather than treating the root
   Deno type check as authoritative for JSX.
3. Inspect `cf check --show-transformed` where changed types affect schema
   selection, cell handling, captures, or CFC metadata. Assert both accepted and
   rejected cases for shared type or compiler changes.
4. Run `cf test` for affected pattern test entries and the appropriate package
   tests. Exercise reactivity after an update, reference identity and
   cross-space paths, missing values, invalid input, scoped state, and trusted
   actions where the change touches those behaviors. Use `HEADLESS=1` for
   browser integration checks.
5. Run `deno task pattern-compat --only <pattern>` for affected deployed
   contracts, followed by the full compatibility gate before completion.
   Preserve input acceptance and narrow reads. Do not delete old baselines or
   add accepted breaks merely to make a typing cleanup pass. A required data
   migration needs its own reviewed implementation and a rehearsal against a
   copied space.
6. Run `deno task pattern-vintage` against the migrated source. Schema
   compatibility does not prove state continuity. Verify that affected patterns
   actually occur in the replayed fixtures. Add assertions for exact durable
   values and reference identities where the general replay only detects data
   becoming empty. Exercise writes after the update as well as reads. Do not
   replace old fixtures with captures of the new implementation or add accepted
   state drops to make the migration pass.
7. Run repo-wide `deno fmt --check` and `deno lint` before each commit. Run the
   generated-type consistency and documentation checks when those sources
   change. Review shared API repairs and migrated callers together.

Sequence shared fixes ahead of dependent migrations. The inventory check can
ship first, and already-correct sites can be cleaned up while API repairs are
underway. The work is complete when the entire authored scope passes without
assertions, `any` escape hatches, or suppression-based exceptions, and its
behavior and stored-data compatibility have been verified.
