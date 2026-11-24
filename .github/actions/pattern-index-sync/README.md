# Pattern index sync

This action keeps the patterns a GitHub repository holds current in the Common
Fabric pattern index. Each pattern entry file on the default branch is one
lineage in the index. When a push changes an entry's source, the action
publishes a new version of that lineage. The publish is named, under the brand
of the GitHub account that owns the repository.

## Adopting it

A brand has to exist before its repositories can publish. The index's
administrators create brands, keyed on the GitHub owner's numeric id, and list
on each brand the repositories that may publish for it: each by its numeric id,
with the workflow file that syncs it
(`<owner>/<repo>/.github/workflows/pattern-index-sync.yml@refs/heads/main`) and
its branch. Ask the Common Fabric team. Then add this workflow to the
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
against the Labs they were written for. Then the code holding the credential is
the repository's own, from its default branch, as trusted as the workflow file
that grants the token. The publish job still runs none of the patterns, and the
plan job still holds no credential, so pattern code never runs beside the token.

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

An entry named `main.tsx` is published as standalone, offered to a person
choosing what to place; every other entry is published as a part. The index
still stores an entry as a part when it has a required input with no default.

A lineage belongs to a path. When the globs stop selecting a path (the file is
deleted, moved, or newly excluded), its lineage is withdrawn: unlisted, and
still readable by id. A path that comes back resumes the same lineage.

## What a run does

1. The plan job finds the entries and compiles every one, in a runtime with
   in-memory storage that writes to no fabric. Its experimental flags are the
   Labs build's defaults, which are the flags a shell built from the same commit
   uses. It hashes each entry's program (the file and everything it imports)
   together with those flags, and hands the publish job a plan: each entry's
   hash and publish request, or why it failed, and every path the globs select.
2. The publish job checks the plan's shape and that it runs for the default
   branch. It makes a signing key that lives only for the run. For each call to
   the index it asks GitHub for an OIDC token whose audience names the index
   host and that key. The index checks the token against GitHub's keys, reads
   the organization, repository, branch, event and commit from it, and accepts
   only requests signed by the key it names. So a token copied out of a log is
   useless without the key.
3. It asks the index for the newest version of each lineage this repository
   holds, with the hash each was published from. Entries whose hash and pattern
   id both match are left alone; the id catches a newer Labs compiling the same
   source differently. Each of the rest is published as the lineage's next
   version, named under the brand and listed at once. Lineages whose paths the
   globs no longer select are withdrawn.
4. It writes a summary to the job: what it published, what failed, which entries
   lack a description or are too large for the index, and what was withdrawn. It
   also shows the privacy gardener's findings on each newest version. The
   gardener judges every brand version and never holds one back, so its findings
   are reported, not enforced.

The publish job fails if any entry failed to compile or publish, or the
withdrawals were refused, after publishing the others. An entry with no
description, one the index refuses as larger than its size limit, and a privacy
finding are reported in the summary and do not fail it: each is fixed in the
pattern. An entry with no description or too large for the index is not
published, so until it is fixed the index keeps listing the path's earlier
version, if it has one. Nothing about past runs is kept outside the index, so
the next run after a failure catches up.
