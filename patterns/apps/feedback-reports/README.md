# Feedback reports

A team's board of problem reports. When someone using an app reports that
something broke, or that they wish it worked differently, the service acting for
them sends the report here. A team member then runs triage, which files each new
report from a trusted sender as a Topic on the team's
[Topics board](../topics/README.md), and records on this board which Topic each
report went to.

The board is deliberately small: it stores reports and the Topic each was filed
under, and nothing else. It does not notify anyone, hold a thread, or track
status. The Topic is where people discuss the problem.

## What a report holds

Each report is stored as:

- `id`: the report's id, unique on the board: exactly 32 lowercase hex
  characters. The sender derives it from a secret of its own and the report's
  name, so sending the same report again carries the same id, and two senders'
  ids do not collide.
- `name`: a label for people, of the form `quiet-heron-41`, at most 64
  characters. Names come from a small set and restart on every install, so two
  reports may share one; nothing on the board is keyed by name.
- `kind`: `broke` or `wish`.
- `words`: the person's own words, if they gave any, at most 4000 characters.
  The sending service removes names and other personal details first.
- `structured`: what the sending service knew, as fields. Only `source` is
  required. The fields senders write today are:
  - `source`: where the report started, such as `failure-card` or `report`.
  - `cfs`: `{ release, setupVersion? }`, the sending service's release.
  - `want`: `{ id, cause, job?, stop?, retries?, since }`, the task that failed:
    why it failed (`cause`), where it stopped (`stop`), and how many times it
    was retried. Never the task's own words.
  - `commands`: `[{ id, ok, code?, at, ms }]`, the commands run in the last 15
    minutes, without their arguments.
  - `failingProbes`: `[{ connector, probe }]`, connector checks that are
    failing.

  The board keeps every field it is sent, including ones it does not know, so a
  sender can add a field without the board changing. A reader ignores a field it
  does not know.

  The known fields are identifiers, never prose, and the board refuses a report
  whose fields break their shape: `source`, `want.cause`, `want.stop`,
  `connector` and `probe` match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, and
  `cfs.release` is a commit hash or a version such as `2026.11.18`. No value or
  key anywhere in `structured` may hold a link (a URL scheme, `www.`, or a
  script scheme such as `javascript:`). `structured` may be at most 64K
  characters as JSON, `commands` may hold 200 entries and `failingProbes` 50.
  `fields.ts` holds these shapes, which triage checks again.
- `createdAt`: when the board stored the report.

The Topic each report was filed under is kept beside the reports, in `topicOf`,
by report id, rather than inside the report. Only `linkTopic` may write a link,
and the runtime labels each link `authored-by` whoever wrote it. The board
publishes the two joined as `index`, without the words, and counts the reports
with no Topic as `newCount`.

The board does not store who sent a report. The runtime labels every report
`authored-by` the identity whose key signed the `addReport` call, and that label
is the sender. A field holding a sender would be something any writer could fill
in; the label is something only the runtime writes. Keeping the Topic link out
of the report keeps the report written by its sender alone.

## Verbs

Each verb takes `agentName`, the agent making the call, as Topics verbs do. The
identity behind the call is the key that signs it.

- `addReport { agentName, id, name, kind, words?, structured }` stores a report
  and returns `{ id, name }`. It refuses a call with no `agentName`, a missing
  or malformed `id`, a missing or malformed `name`, a missing or unknown `kind`,
  a `structured` that breaks the rules above, `words` over 4000 characters, and
  an `id` already on the board.
- `linkTopic { agentName, id, topic }` records the Topic the report with that id
  was filed under, and returns `{ id, topic }`. `topic` must be a Topic address,
  `top/<n>` or a piece id such as `of:fid1:…`. A later link replaces an earlier
  one. Anyone who may write the board may call `linkTopic`, so a link is no fact
  by itself: a reader decides whom to believe from the link's label, as triage
  does. (A first-link-wins rule would let any writer claim a report before
  triage reached it.)

A refused call fails with the message `<verb> rejected: <code>: <reason>`, so a
caller can act on the code. `addReport`: `unsigned`, `bad-id`, `missing-name`,
`name-too-long`, `bad-name`, `missing-kind`, `bad-kind`, `missing-source`,
`bad-source`, `structured-too-large`, `link-in-structured`, `bad-want`,
`bad-release`, `bad-commands`, `too-many-commands`, `bad-probe`,
`too-many-probes`, `bad-words`, `words-too-long` or `duplicate-id`. `linkTopic`:
`unsigned`, `bad-id`, `bad-topic` or `unknown-report`.

## From the command line

`deno task feedback-reports` runs the client in [`tools/`](tools/). It reads the
board the way the Topics client reads the Topics board, from a local copy of the
board's documents and their labels, and writes through `cf piece call`. The
board is named by `FEEDBACK_REPORTS_API_URL`, `FEEDBACK_REPORTS_SPACE` and
`FEEDBACK_REPORTS_BOARD`, which must all be set: there is no default board. The
identity is `--identity`, else `CF_IDENTITY`.

### `send`

`send` is how a sending service writes a report. It reads one `addReport`
request as JSON on stdin and prints one JSON answer on stdout:

```text
$ deno task -q feedback-reports send < request.json
{"ok":true,"id":"0f3c…","name":"quiet-heron-41"}
```

On failure it prints `{"ok":false,"code":"...","message":"..."}` and exits with
status 1. The code is one of the board's refusal codes above, or one of:

- `bad-request`: stdin did not hold a JSON object.
- `not-configured`: the board's variables are not all set.
- `unsettled`: the write may have landed, but no answer arrived. The answer also
  carries `invocation`; send the same request again with `--invocation <id>` to
  settle it without writing twice. Sending it again without `--invocation` is
  safe too: if the first write landed, the board answers `duplicate-id`, which
  for a resend means the report is already there.
- `unconfirmed`: the write was made but the report does not read back.
- `failed`: anything else.

### `triage`

```text
deno task -q feedback-reports triage --trusted trusted.txt --triagers triagers.txt \
  --agent-name Triage [--dry-run]
```

`triage` runs once and stops. It reads the reports that have no Topic and, for
each one, reads its sender from its `authored-by` label.

**The trust rule.** A report is filed only when every identity its label names
is in the trusted file, one DID per line, and the label names at least one. The
trusted file is the team's to keep; a sender cannot change it. A report from
anyone else, or whose label cannot be read, is not filed: triage prints only how
many there were, never their content, and leaves them for a person.

**Links.** A report counts as filed only when its link names a Topic address and
every identity the link's `authored-by` label names is in the triagers file, one
DID per line; the identities triage runs as belong there. Any other link is
ignored and counted, and its report is triaged as new, so a writer who links
someone else's report to a Topic can neither hide the report nor steer which
Topic triage rewrites.

**Grouping.** A new report belongs to a problem already filed when it has the
same `want.cause` and `want.stop` as a report filed under that Topic, or the
same failing probe. New reports that match each other share a new Topic. A
report that matches nothing gets a Topic of its own. Only reports from trusted
senders define what a filed problem is.

**The Topic.** A new Topic is written from a template over the structured
fields, with no model:

- the title is `[feedback] <surface>: <cause> at <stop>`, such as
  `[feedback] Weaver: auth-expired at gmail-sync`;
- the body is a section between two marker comments. It starts with
  `What is asked:` (find and fix the cause, or, when every report is a wish,
  make a product call), then lists the report names, the kinds, causes, stops,
  the most retries seen, failing probes, the releases affected, and the count. A
  list shows at most 20 entries, then how many more.

The reporters' `words` never go into a Topic: the Topic names each report, and
the words stay on this board. Every value triage puts in a Topic or prints must
match its field's shape from `fields.ts`; one that does not shows as `invalid`,
is counted, and groups nothing. So nothing a sender writes can carry Markdown, a
link or a line break into a Topic or a terminal.

For a problem already filed, triage replaces only its marked section of the
Topic's body, leaving whatever people wrote around it, and adds a comment only
when the new reports bring a release or a stop the Topic did not have. A body
whose markers are gone gets a new section after what it holds. Each report is
linked with `linkTopic` as soon as its Topic is written, and the run fails if a
link does not read back.

A new Topic is filed as an invocation named by a hash of the ids of the reports
it files, and a comment by the Topic and those ids. A run that stops after
filing a Topic but before linking its reports files the same reports again when
run again, under the same invocation, which settles on the Topic already filed
rather than filing a second. Invocations are remembered per machine, so this
holds for a rerun on the same machine.

`--dry-run` prints what triage would file and change, and writes nothing.
