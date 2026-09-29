---
status: historical
created: 2026-09-09
archived: 2026-09-09
superseded-by: docs/history/packages/cli/issue-6964-authority-follow-up-2026-09-09.md
reason: "Investigation of source-preflight store writes and the remaining operator documentation gap in #6964."
---

# Issue #6964: source preflight preserves the piece but can write artifacts

Investigated [#6964](https://github.com/commontoolsinc/labs/issues/6964) at
`879f2d7a423f7b21c588f1cb5905f24484a6ccdb`, after #7100, #7086, and #7103
merged. Production code and live spaces were unchanged.

## Conclusion

The current implementation matches
[Mike's correction](https://github.com/commontoolsinc/labs/issues/6964#issuecomment-5556079380):
preflight persists candidate compilation artifacts, including when compatibility
is refused. It does not need to start the target piece. A repeated check can
reuse the stored artifacts and make no additional content writes.

The remaining issue is operator documentation. The CLI README now describes the
behavior correctly, but the command's help and the clone-rehearsal procedure do
not. The help also includes an explicitly incorrect example description claiming
the check runs “without writing.”

## Measured behavior

The [probe](issue-6964-check-writes-probe.ts) creates a populated piece in a
disposable Memory v2 server. It calls the production CLI library
`checkPiecePattern`, including local-file resolution and import pinning. Only
the connection loader is injected. Each measurement opens a fresh Runtime and
storage client against the same server, then closes it.

The probe reads the engine's commit, revision, and entity-head tables. It
compares all pre-existing head rows across scopes, the piece's pattern identity,
and its raw argument. It also observes calls to the client Runner's `start`
method.

| Operation                                    | Compatible | New commits | New revisions | Added entity heads | Changed / removed existing heads | Runner starts |
| -------------------------------------------- | ---------- | ----------: | ------------: | -----------------: | -------------------------------- | ------------: |
| Open, read, close control                    | —          |           0 |             0 |                  0 | 0 / 0                            |             0 |
| New incompatible candidate                   | No         |           1 |             5 |                  5 | 0 / 0                            |             0 |
| Repeat incompatible candidate, fresh Runtime | No         |           0 |             0 |                  0 | 0 / 0                            |             0 |
| New compatible candidate                     | Yes        |           1 |             4 |                  4 | 0 / 0                            |             0 |
| Repeat compatible candidate, fresh Runtime   | Yes        |           0 |             0 |                  0 | 0 / 0                            |             0 |

The incompatible candidate introduces a required input with no default. Its
report contains both the schema incompatibility and the missing required
argument. The compatible candidate changes the result expression while keeping
the input/output contract. Neither check replaces the piece's source or changes
its arguments.

These counts characterize the small fixture. They do not reproduce the original
Topics clone's 18 additions. The probe measures logical store records, not
physical SQLite-file bytes, and does not exercise a deployed toolshed or a live
Topics board.

## Mechanism

1. `packages/cli/lib/piece.ts:checkPiecePattern` resolves the target with
   `pieces.get(..., false, ...)`, then resolves and pins the candidate package.
2. `packages/piece/src/ops/piece-controller.ts:checkPattern` loads the current
   pattern, compiles the candidate, and only then runs compatibility review. Its
   JSDoc explicitly distinguishes preserving the piece from preserving the
   entire store.
3. `packages/piece/src/ops/utils.ts:compileProgram` calls
   `packages/runner/src/piece-helpers.ts:compileAndSavePattern` with the target
   space and predecessor identity.
4. The normal enforcing compilation path uses PatternManager's content-addressed
   cache. Its awaited write-back calls `writeSourceAndCompiledDocs` before the
   compatibility verdict. A refused verdict therefore does not roll back those
   already-persisted artifacts. Stored artifacts can be reused by another
   Runtime, explaining the zero-write repeat measurements.

No runtime change is needed to explain or address Mike's narrowed documentation
request. Making compilation persistence optional would be a separate design
change, with cache, policy, and validation consequences beyond this issue.

## Remaining corrections

- **CLI help, `packages/cli/commands/piece.ts`:** the `--check` description
  correctly promises not to update the piece but omits the possible artifact
  writes. State that it compiles and stores candidate artifacts as needed,
  including on refusal. Change the example's “without writing” to “without
  replacing its source.” Both gaps appear in the rendered help.
- **`docs/development/space-clone-rehearsal.md`:** explain that a preflight may
  change the clone before any migration applies. If a clean baseline is needed
  for the next pass, stop the server, reset, and restart. Artifact additions are
  not evidence that a source update happened, and a cached check can leave
  content unchanged. Amend the verdict guidance accordingly.
- **Topics reference, `docs/history/skills/topics/references/namespace-backfill.md`:** its
  warning already identifies #6964, but its unconditional wording can be made
  precise: preflight _can_ write; cached checks need not add anything. Preserve
  the stop-before-reset requirement when pointing operators to the procedure.
- **CLI README:** no correction is needed. Its “Updating piece source” section
  already explains unattached source/module documents, preserved arguments and
  source pointer, and the absence of a new source revision.

## Reproduction and validation

From the repository root:

```bash
deno run -A docs/history/packages/cli/issue-6964-check-writes-probe.ts
deno task cf piece setsrc --help
deno test -A packages/piece/test/pattern-compatibility-check.test.ts
```

All five probe measurements completed with their preservation assertions
passing. The existing compatibility-preflight suite passed all 13 steps. The
rendered help confirmed both documentation gaps. The probe passed lint and was
type-checked through an importing module because direct checks exclude
`docs/history/` in the repository configuration.

Prepared by Codex (Astra), on Gideon's behalf.
