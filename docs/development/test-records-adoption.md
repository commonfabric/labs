# Adopting test-run records in another repository

This guide is written for an agent implementing the test-run record
system — designed in [an archived
plan](../history/plans/test-run-telemetry.md) — in another repository of
the organization. The storage, schema, library, and personal keys already
exist; an adopting repository adds its own identities, producers, and relay
and leans on everything shared.

## What already exists to lean on

- **The store**: the `cf-ci-metadata` bucket, publicly readable under each
  repository's `<repo>/test-records/` dataset area. The infra repository's
  `tofu/test-records` root manages the areas, one per reporting
  repository.
- **The record schema and library**:
  `@commonfabric/test-support/records` in this repository — the identity
  with three required parts and an optional variant, the NDJSON line codecs
  with untrusted-input validation, the spool lifecycle with kernel-released
  locks, the JUnit ingester, the create-only store client, and the validating
  reader. Vendor or import it rather than reimplementing; the schema version
  (`v1` in object paths) is shared across repositories.
- **Personal keys**: scoped to people, not repositories. A key minted once
  through this repository's minting workflow writes
  `<repo>/test-records/submissions/local/<username>/` in every adopted
  area, so team members who already hold a key have nothing new to
  collect. The lease janitor widens to count pull-request activity across
  adopting repositories (`LEASE_REPOSITORIES` in
  `tasks/test-records-janitor.ts`).
- **The compactor and reports**: reader-side and repository-agnostic; they
  take a dataset prefix.

## What the adopting repository adds

1. **An infra entry.** Add the repository to `relay_repositories` in the
   infra repository's `tofu/test-records` root: its short area name, its
   immutable numeric GitHub id, and the path of its relay workflow file.
   Applying creates the dataset folders, a relay service account with
   create-only access to `submissions/ci/`, a Workload Identity provider
   pinned to that one workflow file on the default branch, and the
   repository's Actions variables. Also append the repository to the
   minting workflow's folder list (`DATASET_PREFIXES`) and the janitor's
   `LEASE_REPOSITORIES` here.
2. **A canonical `repo` constant.** The context line carries the canonical
   repository name as a constant owned by the adopting repository's
   tooling — never derived from git remotes, which clones and forks get
   wrong. See `tasks/test-records-config.ts` here for the shape.
3. **A relay workflow.** A `workflow_run` follower on the workflows that
   run tests, holding `id-token: write`, authenticating against the
   repository's own provider, downloading every `test-records-*` artifact
   of the triggering run, and shipping one object per artifact with
   deterministic names. Copy `.github/workflows/test-records-relay.yml`
   and `tasks/test-records-relay.ts`; the only repository-specific parts
   are the constants and the watched workflow names.
4. **An identity table.** For each test surface: its kind, its scope, what
   its runner reports as the name, and any non-default configuration that
   needs a separate variant. Keep the default configuration unmarked. Hold
   the line on the rules that keep identities durable — names from the
   runner, shard labels never in identity, file paths only where the file
   genuinely is the test.
5. **Producers.** Three classes cover every surface:
   - Jobs that already write JUnit XML: add the ship step with a
     `--junit kind=...,scope=...,prefix=...,glob=...` specification and
     you are done — leaf cases become records, containers are dropped.
   - Harnesses with per-result callbacks: append through the library's
     `FragmentWriter`, gated on `CF_TEST_RECORDS_DIR`.
   - Command-level checks: wrap with a `run-recorded`-style task that
     spools one record from the exit code.
   Each job points `CF_TEST_RECORDS_DIR` at a workspace spool and ends
   with the credential-free gather-and-upload step, `if: always()`. Set the
   step's `variant` input only for a stable non-default configuration whose
   history must remain separate.
   The relay checks out its parser from the default branch. Land support for
   a new optional record field before a later change starts emitting it from
   test workflows. An older relay drops an unknown field before writing the
   create-only store object.

   This repository does not wire its own surfaces this way: each is a suite of
   its test topology, and the lanes that run the suites gather and mark every
   record before the ship step ([covering a new test
   surface](test-records.md#covering-a-new-test-surface)). An adopting
   repository without such a topology uses the ship step's own inputs.
6. **Local ownership.** The task entry points that people actually run
   stamp a spool when `CF_TEST_RECORDS_KEY_FILE` is present, ship it at
   the end, and sweep the spool root for orphans; see
   `tasks/test-records.ts` here for the exact lifecycle, including why
   the exit call must come after the shipping step.

## The rules that are not optional

- Records carry public material only: no usernames, hostnames, tokens, or
  log text. This is what keeps the store publicly readable.
- A reporting failure never fails a run, and every shipper makes exactly
  one attempt; deterministic object names make retries a collision
  instead of a duplicate.
- Test jobs never hold store credentials. Team members' fork pull
  requests must report, and only the artifact-plus-relay shape does
  that; the relay's member-list gate is what keeps everyone else's fork
  runs out of the store.
- Every test finishes within sixty seconds in CI, not counting setup.
  Name the violators before wiring them in, and split containers rather
  than recording them as one slow test.
