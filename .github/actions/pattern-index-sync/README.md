# Pattern index sync

This action keeps the patterns a GitHub repository holds current in the Common
Fabric pattern index. Each pattern entry file on the default branch is one
lineage in the index. When a push changes an entry's source, the action
publishes a new version of that lineage. The publish is named, under the brand
of the GitHub account that owns the repository.

## Adopting it

A brand has to exist before its repositories can publish. Brands are created by
the index's administrators and are keyed on the GitHub owner's numeric id, so
ask them first. Then add this workflow to the repository:

```yaml
name: Pattern Index Sync
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
concurrency:
  group: pattern-index-sync
  cancel-in-progress: false
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: commonfabric/labs/.github/actions/pattern-index-sync@<commit>
        with:
          program-root: patterns
          include: |
            patterns/**
```

Pin the action to a Labs commit rather than to a branch, so the code holding the
run's credential is code you chose. A repository that vendors Labs can instead
run the vendored copy (`uses: ./vendor/labs/.github/actions/…` and
`labs-path: vendor/labs`). Its patterns then compile against the Labs they were
written for.

## What counts as an entry

An entry is a tracked `.ts` or `.tsx` file that matches `include`, does not
match `exclude`, is not a test (`*.test.ts(x)`, `*_test.ts(x)`), and has a
top-level `export default`. Modules without a default export are helpers. They
are never published on their own, but they are part of every entry that imports
them, so a change to a helper republishes those entries.

An entry's description, hashtags and keywords come from its opening doc comment,
as for `cf pattern publish`. An entry with no description is not published, and
the job summary lists it.

## What a run does

1. It makes a signing key that lives only for the run, and asks GitHub for an
   OIDC token whose audience names that key. That token is the run's only
   credential. The index checks it against GitHub's keys, reads the repository
   and owner from it, and accepts only requests signed by the key it names. So a
   token copied out of a log is useless without the key.
2. It asks the index for the newest version of each lineage this repository
   holds, along with the hash of the source each was published from.
3. It reads every entry's program (the file and everything it imports) and
   hashes it. Entries whose hash matches their lineage's newest version are
   skipped without compiling. Each of the rest is compiled, published as the
   lineage's next version, and put forward for listing.
4. It writes a summary to the job: what it published, what failed, which entries
   lack a description, and which files the index still holds a lineage for that
   are no longer entries here. It also shows the privacy gardener's findings on
   each newest version. Those findings are reported and never block a publish.

The run fails if any entry fails to resolve, compile or publish. The other
entries are still published first. Nothing about past runs is kept outside the
index, so the next run after a failure catches up.

Compiling uses a runtime with in-memory storage. It writes to no fabric. Its
experimental flags are the Labs build's defaults, which are the flags a shell
built from the same commit uses.
