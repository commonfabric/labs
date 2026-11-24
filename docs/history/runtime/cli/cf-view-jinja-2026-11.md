---
status: historical
created: 2026-11-13
archived: 2026-11-13
reason: "Point-in-time measurements of the shipped cf view Jinja path, and of its coverage of the Infra repository's Jinja templates."
---

# `cf view` Jinja: shipped measurements

This report records what the `cf view` Jinja language costs, measured against
the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
and how well it covers the Jinja templates in the organization's repositories.

A Jinja template is shown as the file it produces, in the language the rest of
its name selects, which this report calls the host. The host colors the source
with each Jinja region hidden from it, and a focused scanner colors the Jinja
regions. Jinja adds no dependency and no grammar. Over a host that runs on the
shared Tree-sitter adapter, such as shell, it pays that host's parser costs, so
the timings below measure Jinja over shell, and over YAML for comparison.

The machine was far too loaded for timings that compare directly with the
recorded maximums. Scaled against a TOML control run beside each round, every
timing is inside its maximum when the scaling uses the rounds' medians. When it
uses their 95th percentiles, as the earlier reports did, the re-color after one
edit is over its maximum, because of one round. Measured beside it in each
round, the shell language alone took more CPU time than Jinja over shell on the
same source, by medians, in every dimension but initialization, where the two
were within 6 percent of each other. "Timings" gives the figures.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.8,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. The load average stayed between 120
and 280 while they ran, so there were many more runnable threads than cores.

The probe, [`cf-view-jinja-2026-11-probe.ts`](cf-view-jinja-2026-11-probe.ts),
follows the October 2026 HCL probe. It selects each language by name, as
`--language` does, builds a source of 100,009 bytes by repeating a unit shaped
like the Infra templates, and times 40 cold starts, 50 complete highlights, 50
document parses, and 50 re-colors after one same-length edit in the middle of
the source. It records the process's CPU time beside the time that passed,
because on this machine the time that passed was mostly time spent waiting for
a core. The shell unit is a deploy function inside `{% if %}`, with
expressions inside double-quoted strings and in a command's arguments. The YAML
unit is a collector pipeline with a `{% for %}` loop.

Each of four rounds ran the probe for TOML, Jinja over shell, shell alone on the
same source as Jinja over shell, Jinja over YAML, and TOML again.
[`cf-view-jinja-2026-11-results.json`](cf-view-jinja-2026-11-results.json) holds
every sample.

## Timings

The TOML controls' 95th percentiles were 2.9 to 12.0 times TOML's recorded
figures in CPU time, and 37 to 186 times in the time that passed. The HCL
report set aside the two rounds whose controls ran over twice TOML's recorded
medians, and its other rounds' controls stayed within 1.22 times them; no round
here came close to that. The estimates below therefore carry more
uncertainty than the earlier reports' estimates, and the CPU figures are the
ones scaled.

Each estimate is TOML's recorded 95th percentile multiplied by the largest
ratio, over the four rounds, of Jinja's figure to the mean of that round's two
TOML figures. The first estimate takes the ratio of 95th percentiles, as the
shell and HCL reports did. The second takes the ratio of medians, which one
slow sample in a round moves less.

| Dimension | Jinja over shell, by 95th percentiles | Jinja over shell, by medians | Jinja over YAML, by 95th percentiles | Accepted maximum |
| --- | ---: | ---: | ---: | ---: |
| 95th-percentile lazy initialization | 32.6 ms | 32.8 ms | 23.3 ms | 75 ms |
| 95th-percentile full highlighting | 35.8 ms | 23.0 ms | 10.3 ms | 50 ms |
| 95th-percentile document parse, with structure | 28.8 ms | 23.9 ms | 8.9 ms | 50 ms |
| 95th-percentile re-color after one edit | 34.2 ms | 15.7 ms | 13.0 ms | 25 ms |

The re-color estimate by 95th percentiles comes from the second round, whose
95th percentile was 351 ms of CPU time against 47 to 113 ms in the other three.
Without that round, the largest ratio gives 11.2 ms. By medians, the ratio of
Jinja over shell to TOML stayed between 0.95 and 1.31 in every round.

The comparison with shell alone needs no scaling, because the two ran one after
the other in each round. In CPU time, Jinja over shell's median was 0.37 to 0.42
of shell's for a complete highlight, 0.40 to 0.45 for a document parse, 0.21 to
0.33 for a re-color, and 0.98 to 1.06 for initialization. By 95th percentiles
the ratios were wider, 0.97 to 1.14 for initialization, and the second round's
re-color was 1.13. A guess at the cause, which was not measured: the shell
grammar recovers from errors throughout the raw Jinja, and that costs more than
hiding the Jinja from it first.

The rounds ran before three later changes to the layer, which were not timed.
The host then read each character of an expression as `_`; it now reads the
expression as a mark of the same length. The host then read the line breaks
inside a region as line breaks; it now reads them as part of the region. And
the layer then spelled only structure names as the source spells them; it now
also replaces each mark in an entry's label with its region's source.

A live edit of a template is colored through the host's own highlighter, which
updates the parse it already has, with the edited text's Jinja regions hidden.
The Jinja scan and the overlay run over the whole source on each edit.

## Coverage

On November 13, 2026, the local checkouts of the organization's repositories
held 26 Jinja templates, all of them Ansible templates in Infra named with a
`.j2` suffix. Each reconstructed exactly. Every character other than white space
inside their 113 Jinja regions has a token class.
[`cf-view-jinja-2026-11-coverage.ts`](cf-view-jinja-2026-11-coverage.ts) counts
these figures from a list of the templates' paths.

| Language selected | Templates | Characters other than white space outside regions | Of those, without a token class |
| --- | ---: | ---: | ---: |
| Jinja over shell | 6 | 2,252 | 325 (14.4%) |
| Jinja over XML | 5 | 3,771 | 1,076 (28.5%) |
| Jinja over YAML | 3 | 5,370 | 0 |
| Jinja over authorized keys | 3 | 105 | 0 |
| Jinja over plain text | 9 | 13,814 | 13,814 (100%) |

Outside the regions, each host leaves uncolored what it leaves uncolored in its
own files: shell command arguments, and the text inside XML elements. The nine
templates over plain text are four systemd units, two dotenv files, and one
each of nginx, logrotate, and sudoers configuration, whose own languages had
not landed when this was measured.

## Owned source

The layer that puts a template syntax over a host is
`runtime/cli/lib/view/languages/template.ts`, 535 lines, which the other
template syntaxes in the plan use as well. The Jinja scanner is
`runtime/cli/lib/view/languages/jinja/jinja.ts`, 251 lines. `languages/language.ts`,
which selects languages and declares which hosts have only literal values, grew
by 74 lines. The authorized keys language is 172
lines. None of these lines is adapter or workaround source for a Tree-sitter
grammar.
