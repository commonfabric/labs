# Implementation progress

Local execution dashboard for the design in PR #7155. The acceptance checklist
is
[the implementation tracker](../../docs/history/plans/pattern-computation-cost-implementation.md).
`status.json` records delivery state, review gates, questions, and demo
milestones. Update it at each milestone and when a question or review finding
changes. “Landed” means merged; implemented work awaiting review stays “In
review.”

Run from the repository root:

```sh
deno run --allow-read=tools/implementation-progress \
  --allow-net=127.0.0.1:7155 tools/implementation-progress/server.ts
```

Open <http://127.0.0.1:7155>. The server exposes only the dashboard files and
pushes file-change notifications. It neither modifies the repository nor starts
tests. Questions are answered in the working conversation and recorded in
`status.json`; the page does not submit answers.

`demo.json` contains recorded output from the controlled lunch-poll run, with
its revision and recorded command, alongside a command for running the fixture
on the current checkout. The page lets the reader inspect each interval and the
reported computation rows. Totals include unlisted rows; the recording is not a
live benchmark. Preserve provenance when replacing it.

The browser section shows recorded screenshots and diagnostic samples at three
vote-list sizes. Its p75 timings include browser/protocol overhead and are
labeled with machine, runtime, execution posture, and sample limitations. The
read counts come from a separate untimed vote. Screenshot routes are explicitly
allowlisted by the server.

Check the server with `deno check tools/implementation-progress/server.ts`.
