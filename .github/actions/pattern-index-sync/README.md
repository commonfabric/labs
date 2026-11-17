# Pattern index sync

This action keeps the patterns a GitHub repository holds current in the Common
Fabric pattern index. Each pattern entry file on the default branch is one
lineage in the index. When a push changes an entry's source, the action
publishes a new version of that lineage. The publish is named, under the brand
of the GitHub account that owns the repository.

## Adopting it

A brand has to exist before its repositories can publish. The index's
administrators create brands, keyed on the GitHub owner's numeric id, and
register which repositories and which workflow file may publish for each. Ask
the Common Fabric team. Then add this workflow to the repository, as
`.github/workflows/pattern-index-sync.yml`:

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

A lineage belongs to a path. Moving or renaming an entry starts a new lineage,
and the summary lists the old path as no longer an entry; the index keeps its
versions.

## What a run does

1. The plan job finds the entries and compiles every one, in a runtime with
   in-memory storage that writes to no fabric. Its experimental flags are the
   Labs build's defaults, which are the flags a shell built from the same commit
   uses. It hashes each entry's program (the file and everything it imports)
   together with those flags, and hands the publish job a plan: each entry's
   hash and publish request, or why it failed.
2. The publish job checks the plan's shape and that it runs for the default
   branch. It makes a signing key that lives only for the run. For each call to
   the index it asks GitHub for an OIDC token whose audience names that key. The
   index checks the token against GitHub's keys, reads the repository and owner
   from it, and accepts only requests signed by the key it names. So a token
   copied out of a log is useless without the key.
3. It asks the index for the newest version of each lineage this repository
   holds, with the hash each was published from. Entries whose hash matches are
   left alone. Each of the rest is published as the lineage's next version and
   put forward for listing.
4. It writes a summary to the job: what it published, what failed, which entries
   lack a description, and which paths the index still holds a lineage for that
   are no longer entries here. It also shows the privacy gardener's findings on
   each newest version. Those findings are reported and never block a publish.

The publish job fails if any entry failed to compile or publish, after
publishing the others. Nothing about past runs is kept outside the index, so the
next run after a failure catches up.
