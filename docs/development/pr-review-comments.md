# Reading review comments on a pull request

An automated reviewer posts its findings as inline review comments. Each one is
attached to a file, and a line comment is also attached to a line of the diff.
This document names the commands that list those findings, and at the end the
command that looks as though it would and does not.

## Listing the findings

This returns every inline review comment on a pull request, with the file and
any line it is attached to:

```bash
gh api --paginate repos/commonfabric/labs/pulls/<n>/comments
```

Line comments have `subject_type` set to `line`. When the line has since
changed, `line` comes back as null. File-level comments have `subject_type` set
to `file` and no line. In both cases, `path` identifies the file.

A comment with no `in_reply_to_id` starts a thread and carries that thread's
finding. A comment with `in_reply_to_id` is a reply in an existing thread. The
endpoint returns both kinds.

## Checking whether a thread is still open

This reports, for each thread, whether it is resolved and whether it is
outdated because the code beneath it moved:

```bash
gh api graphql --paginate -f query='
query($owner:String!,$repo:String!,$number:Int!,$endCursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$endCursor){
        nodes{ isResolved isOutdated path line comments(first:1){ nodes{ author{login} body } } }
        pageInfo{ hasNextPage endCursor }
      }
    }
  }
}' -f owner=commonfabric -f repo=labs -F number=<n>
```

An unresolved thread still needs inspection, even when it is outdated: the code
moving is not the same as the finding being answered. It may be waiting on you,
or on the reviewer after a reply; `isResolved` alone does not assign the next
action.

## Waiting for the review

Cubic reviews nearly every pull request in this repository. It is configured by
[`cubic.yaml`](../../cubic.yaml) at the repository root, which points it at the
same guidance the `/cf-review` skill and human reviewers use, and it posts as
`cubic-dev-ai[bot]`. The Codex connector reviews a minority of pull requests
and posts as `chatgpt-codex-connector[bot]`.

Cubic's review arrives a few minutes after a push, so it can be absent simply
because it has not run yet. Wait for it before concluding a pull request has no
findings. A push that adds commits starts a fresh review, so the wait applies
again each time.

Take the feedback into account and leave a comment if you disagree, as
[the contributing section of the root `README.md`](../../README.md#contributing)
requires.

## Who a finding is posted by

Three accounts leave findings on this repository, and a query that names one of
them hides the other two:

- `cubic-dev-ai[bot]` — cubic, on nearly every pull request.
- `chatgpt-codex-connector[bot]` — the Codex connector, on a minority.
- **the invoking user's own account** — a Codex review started by hand, through
  the `review` script in a checkout, posts as whoever ran it. On a pull request
  reviewed that way the findings are indistinguishable by author from the
  author's own replies, and are told apart by `in_reply_to_id`.

The third is the one that catches people, because a query selecting on `cubic`
looks complete and returns a shorter list without saying so.

## Filters that drop findings

Every narrowing below looks reasonable and answers a different question than
the one being asked. Enumerate with no predicate but the endpoint, and triage
by reading; a pull request's whole population is usually small enough to read
in a couple of minutes.

- **By timestamp** — "what is new since I last looked" is not "what is
  outstanding". A finding raised on an earlier push, about code the later
  pushes did not touch, is still open and will not be re-posted.
- **By `commit_id`** — this field is re-anchored as the code moves, so it is
  not the commit the finding was raised against. Selecting on the head hides
  everything anchored elsewhere.
- **By `line`** — a comment whose line has changed comes back with `line`
  null, as does a file-level comment. Any numeric comparison drops them.
- **By author** — see above.

## A review body is a mutable status, not a record

The inline comments are the durable record of what a review found. The body is
a live status display carrying a historical timestamp, and the two do not
correspond.

It says nothing reliable about the review it heads. A body reading "all
reported issues were addressed" has been observed with the *same* `submitted_at`
as inline comments of that review raising a P1 — to the second, twice on one
pull request.

And it is rewritten afterwards. The same review body, read twice about twenty
minutes apart with a push in between, went from "1 issue found across 2 files"
to "all reported issues were addressed", with `submitted_at` unchanged. So
reading bodies in timestamp order does not repair the problem: the ordering is
historical and the content is current. A body from three reviews ago saying
everything is addressed is a statement about now, stamped then — and an
"auto-approval blocked" body may equally have been rewritten since, or not.

**Never read a body as evidence of what a review found, and never as evidence
that nothing was found.** Its only safe use is as a prompt to go and read the
inline comments.

## Where else a pull request carries a verdict

Two surfaces sit outside the inline list, and neither appears in it:

```bash
gh api --paginate repos/commonfabric/labs/pulls/<n>/reviews   # summary bodies
gh api --paginate repos/commonfabric/labs/issues/<n>/comments # issue timeline
```

The issue timeline is where the coverage-debt bot posts, including the line
that settles a coverage argument authoritatively — "Code coverage regression
resolved", with the baseline and the pull request's number beside it.

## Why `gh pr view` shows nothing

Neither of these returns inline review comments:

```bash
gh pr view <n> --json comments,reviews
gh pr view <n> --comments
```

`comments` holds the issue-comment timeline, which is the conversation at the
bottom of the pull request. Inline findings are not in it, so it is frequently
an empty list on a pull request that has several. `reviews` holds one entry per
submitted review, carrying that review's summary body and not the individual
comments it contains. A summary body is a claim about the findings rather than
the findings themselves, and cubic's says every issue was addressed once its
threads are resolved, so reading it in place of the findings can turn an open
one into a clean bill of health.
