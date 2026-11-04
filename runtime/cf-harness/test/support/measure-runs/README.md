# measure-runs fixtures

Hand-authored console run artifacts for `test/measure-runs.test.ts`, so the
extractor is pinned against transcripts whose contents are known rather than
against whatever a machine happens to be holding under
`.cf-harness-console/runs`.

`runs/` is an artifact root of six directories:

- `fixture-run/` — the parent run. Its searches cover every answer the extractor
  distinguishes: two hits, none, a refusal from the index, and one call the run
  never recorded a result for. Its `run_pattern` calls cover a published pattern
  named by id, source carrying no `cf:pattern:` import, and source importing two
  of them under three specifiers. The results for those last two calls appear in
  the **opposite order** from the calls, which is what fails a reader that pairs
  a call to a result by position. It also makes one `bash` call the sandbox
  denied and one `read_file` call that ran and failed, so a surface that was
  withheld is pinned apart from one that answered badly. It also carries a
  `skill-registry.json`, which is the only place the skills tree a run scanned
  is recorded.
- `fixture-run.subagent.1/` — a `delegate_task` child of it.
- `alias-run/` — source that imports a published pattern and re-exports it
  unchanged. It composes nothing, and counting it as composition is what would
  inflate the reuse reading with the behavior being measured.
- `bad-transcript/` — a transcript that parses as JSON and is not a message
  list.
- `no-transcript/` — a run directory with no `transcript.json` at all.
- `unreadable-transcript/` — a run whose `transcript.json` is a directory, so
  the read fails for a reason that is not "the file is missing". The two are
  reported apart because only one of them says a run wrote no transcript.

The last two exist so the report has something to say "not read" about. A run
the extractor could not read must never count as a run that did nothing.
