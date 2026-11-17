# Pattern index sync

This action keeps the patterns a GitHub repository holds current in the Common
Fabric pattern index. Each pattern entry file on the default branch is one
lineage in the index. When a push changes an entry's source, the action
publishes a new version of that lineage. The publish is named, under the brand
of the GitHub account that owns the repository.

## Adopting it

A brand has to exist before its repositories can publish. The index's
administrators create brands, keyed on the GitHub owner's numeric id; a brand's
public repositories can publish once it exists, and a private one only once the
brand lists it. Ask the Common Fabric team. Then add this workflow to the
repository, as `.github/workflows/pattern-index-sync.yml`:

```yaml
name: Pattern Index Sync
on:
  push:
    branches: [main]
    paths: ["patterns/**"]
  workflow_dispatch:
permissions:
  contents: read
concurrency:
  group: pattern-index-sync
  cancel-in-progress: false
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: commonfabric/labs/.github/actions/pattern-index-sync@<commit>
        with:
          step: plan
          program-root: patterns
          include: |
            patterns/**
  publish:
    needs: plan
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: commonfabric/labs/.github/actions/pattern-index-sync@<commit>
        with:
          step: publish
```

Keep the two jobs apart, and grant `id-token: write` to the publish job alone.
The plan job compiles the patterns, which runs their code, so it must hold no
credential. The plan step refuses to run in a job that could mint a token. The
publish job holds the credential, and runs none of the repository's code.

Pin the action to a Labs commit rather than to a branch, so the code holding the
credential is code you chose. Run both jobs on GitHub-hosted runners: a
self-hosted runner shared between jobs can carry one job's leftovers into the
next.

A repository that vendors Labs can run the vendored copy instead
(`uses: ./vendor/labs/.github/actions/pattern-index-sync` and
`labs-path: vendor/labs`, after a step that fetches it), so its patterns compile
against the Labs they were written for.

## What counts as an entry

An entry is a tracked `.ts` or `.tsx` file that matches `include`, does not
match `exclude`, is not a test (`*.test.ts(x)`, `*_test.ts(x)`), and has a
top-level default export (`export default`, or `as default` in an export list).
Modules without one are helpers. They are never published on their own, but they
are part of every entry that imports them, so a change to a helper republishes
those entries.

An entry's description, hashtags and keywords come from its opening doc comment,
as for `cf pattern publish`. An entry with no description is compiled but not
published, and the job summary lists it.

A lineage belongs to a path. Deleting an entry file withdraws its lineage: it is
unlisted, and its versions stay readable by id. A path that comes back resumes
the same lineage. Moving or renaming an entry is a deletion and a new lineage.

## What a run does

1. The plan job finds the entries and compiles every one, in a runtime with
   in-memory storage that writes to no fabric. Its experimental flags are the
   Labs build's defaults, which are the flags a shell built from the same commit
   uses. It hands the publish job a plan: each entry's compiled pattern or why
   it failed, and the entry paths the push deleted.
2. The publish job checks the plan's shape and that it runs for the default
   branch. It sends every compiled pattern to the index, up to 25 to a call,
   with the deleted paths. For each call it asks GitHub for an OIDC token whose
   audience is the index; the index checks the token against GitHub's keys and
   reads the organization, repository, branch, event and commit from it.
3. The index makes a new version of each lineage whose newest version has a
   different source, under the brand's name, and withdraws the deleted paths'
   lineages. A brand's versions are listed as they sync; the privacy gardener
   judges each one and records its verdict for the index's administrators, and
   never holds one back.
4. The publish job writes a summary: what it published, what was unchanged, what
   failed, which entries lack a description, and what was withdrawn.

The publish job fails if any entry failed to compile or publish, after
publishing the others. Nothing about past runs is kept outside the index, so the
next run after a failure catches up.
