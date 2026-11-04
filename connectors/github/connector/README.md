# Common Fabric GitHub connector

`@commonfabric/github-connector` collects every open pull request authored by
the authenticated GitHub user. It publishes the current state to stable cells in
one Common Fabric space.

The collector reads GitHub directly through GraphQL. It follows every page and
checks that the reported total remains stable. A missing page, changed total,
duplicate pull request, malformed response, or cancelled request rejects the
whole collection.

The Fabric target writes an immutable detail cell for each observed pull-request
snapshot. It writes the index after every detail write succeeds. A failed
collection or publication therefore leaves the last complete index and all of
its detail links unchanged. Each pull-request row carries the GitHub observation
time. The index's `lastCompleteCollectionAt` field records when the complete
scan began. Its `generatedAt` field records when that generation was committed.

## Published cells

The target owns these deterministic root cells:

| Cell               | Schema                                                |
| ------------------ | ----------------------------------------------------- |
| Pull-request index | `commonfabric.github-connector.pull-request-index.v1` |
| Health             | `commonfabric.github-connector.health.v1`             |

Each observed pull-request snapshot also has a deterministic detail cell with
schema `commonfabric.github-connector.pull-request.v1`. The source and complete
snapshot form its identity. An older index therefore continues to resolve to the
older detail after a later publication fails.

The source GitHub host and authenticated account form part of each root cell's
identity. Several account connectors can publish into one Fabric space without
replacing one another.

The index repeats the fields needed for a table. These include repository,
number, URL, source repository, source branch, source commit, draft state,
mergeability, merge state, review decision, combined check state, derived
status, and observation time.

## Status classification

The derived status uses this precedence for pull requests visible in the latest
complete GitHub scan:

1. Draft pull requests are `draft`.
2. Conflicting pull requests are `merge-conflicts`.
3. Failed or errored check rollups are `tests-failed`.
4. Pending or expected check rollups are `tests-running`.
5. Mergeable, clean pull requests with no required review are
   `green-and-can-land`.
6. Every other open pull request is `merge-blocked`.

When a previously visible pull request disappears from the authored list, the
connector queries that pull request by node ID. A confirmed closed or merged
pull request is removed. An inaccessible pull request is retained as
`visibility-unknown`, so reduced token access cannot silently masquerade as a
complete deletion.

The source GitHub fields remain available. A consumer can apply a different
policy without recollecting data.

## Tests

Run the package tests from this directory:

```sh
deno task test
```
