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

- `name`: the report's name, unique on the board, such as `quiet-heron-41`.
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
- `createdAt`: when the board stored the report.

The Topic each report was filed under is kept beside the reports, in `topicOf`,
by report name, rather than inside the report. The board publishes the two
joined as `index`, without the words, and counts the reports with no Topic as
`newCount`.

The board does not store who sent a report. The runtime labels every report
`authored-by` the identity whose key signed the `addReport` call, and that label
is the sender. A field holding a sender would be something any writer could fill
in; the label is something only the runtime writes. Keeping the Topic link out
of the report keeps the report written by its sender alone.

## Verbs

Each verb takes `agentName`, the agent making the call, as Topics verbs do. The
identity behind the call is the key that signs it.

- `addReport { agentName, name, kind, words?, structured }` stores a report and
  returns `{ name }`. It refuses a call with no `agentName`, a missing `name`, a
  missing or unknown `kind`, a `structured` with no `source`, `words` over 4000
  characters, and a `name` already on the board.
- `linkTopic { agentName, name, topic }` records the Topic a report was filed
  under, and returns `{ name, topic }`. A report keeps the first Topic it is
  linked to: linking it to the same Topic again changes nothing, and linking it
  to another is refused, as is linking a report that is not on the board.

A refused call fails with the message `<verb> rejected: <code>: <reason>`, so a
caller can act on the code: `unsigned`, `missing-name`, `missing-kind`,
`bad-kind`, `missing-source`, `bad-words`, `words-too-long`, `duplicate-name`,
`missing-topic`, `unknown-report` or `already-linked`.

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
{"ok":true,"name":"quiet-heron-41"}
```

On failure it prints `{"ok":false,"code":"...","message":"..."}` and exits with
status 1. The code is one of the board's refusal codes above, or one of:

- `bad-request`: stdin did not hold a JSON object.
- `not-configured`: the board's variables are not all set.
- `unsettled`: the write may have landed, but no answer arrived. The answer also
  carries `invocation`; send the same request again with `--invocation <id>` to
  settle it without writing twice.
- `unconfirmed`: the write was made but the report does not read back.
- `failed`: anything else.

### `triage`

```text
deno task -q feedback-reports triage --trusted trusted.txt --agent-name Triage [--dry-run]
```

`triage` runs once and stops. It reads the reports that have no Topic and, for
each one, reads its sender from its `authored-by` label.

**The trust rule.** A report is filed only when every identity its label names
is in the trusted file, one DID per line, and the label names at least one. The
trusted file is the team's to keep; a sender cannot change it. A report from
anyone else, or whose label cannot be read, is not filed: triage prints only how
many there were, never their content, and leaves them for a person.

**Grouping.** A new report belongs to a problem already filed when it has the
same `want.cause` and `want.stop` as a report filed under that Topic, or the
same failing probe. New reports that match each other share a new Topic. A
report that matches nothing gets a Topic of its own. Only reports from trusted
senders define what a filed problem is.

**The Topic.** A new Topic is written from a template over the structured
fields, with no model:

- the title is `[feedback] <surface>: <cause and stop in plain words>`, such as
  `[feedback] Weaver: auth expired, stops at gmail sync`;
- the body starts with `What is asked:` (find and fix the cause, or, when every
  report is a wish, make a product call), then lists the report names, the
  kinds, causes, stops, the most retries seen, failing probes, the releases
  affected, and the count.

The reporters' `words` never go into a Topic: the Topic names each report, and
the words stay on this board. Values from the structured fields are reduced to
letters, digits and a little punctuation, so nothing a sender writes can carry
Markdown, a link or a line break into the Topic.

For a problem already filed, triage rewrites the Topic's body with the new
count, and adds a comment only when the new reports bring a release or a stop
the Topic did not have. Since triage owns the body of a Topic it filed, notes
about the problem belong in the Topic's comments. Each report is linked with
`linkTopic` as soon as its Topic is written, and the run fails if a link does
not read back.

`--dry-run` prints what triage would file and change, and writes nothing.
