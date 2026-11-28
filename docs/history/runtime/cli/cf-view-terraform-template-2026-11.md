---
status: historical
created: 2026-11-16
archived: 2026-11-22
reason: "Point-in-time measurements of the shipped cf view Terraform template path, and of its coverage of the Infra repository's templates."
---

# `cf view` Terraform templates: shipped measurements

This report records what the `cf view` Terraform template language costs,
measured against the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
and how well it covers the Terraform templates in the organization's
repositories.

A Terraform template is the file OpenTofu's `templatefile` function reads. It
is shown as the file it produces, in the language the rest of its name selects,
which this report calls the host, through the template layer that the
[November 2026 Jinja measurement](cf-view-jinja-2026-11.md) describes. A
focused scanner finds each interpolation, `${…}`, and directive, `%{…}`, and
colors its code, which is HCL's expression syntax, as the HCL language colors
the same code. Three of the four templates in the organization's repositories
are shell scripts, and the fourth has no host language, so the timings below
measure the template over shell. The language adds no dependency and no
grammar.

Scaled against a TOML control run beside it, every work timing of a template
as dense in interpolations as the Infra repository's is at 52 percent of its
maximum or less, and its initialization costs what the shell language's does.
Templates built to be denser, and one with two of each unit's three
interpolations not valid HCL, are inside every maximum too. The closest is the
re-color after an edit of the template with an interpolation on every line, at
an estimated 23.1 ms against 25 by 95th percentiles and 24.1 ms by medians.
Measured beside them in each round, their medians were 0.89 to 1.05 times those
of the shell language alone on its own measurement source, whose re-color is
estimated at 22.0 and 23.5 ms. "Timings" gives the figures.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.8,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. The one-minute load average read
before and after each round was between 4.07 and 5.43.

The probe,
[`cf-view-terraform-template-2026-11-probe.ts`](cf-view-terraform-template-2026-11-probe.ts),
follows the October 2026 HCL probe in its source size, its same-length edit in
the middle of the source, and its sample counts: 40 cold starts, and 50 each of
a complete highlight, a document parse, and a re-color after one edit. It
selects each language by name, as `--language` does. One run measures six
sources, and interleaves their samples: each sample of each operation measures
every source once, in an order that rotates, so that all six are measured under
the same load. The sources, each 100,009 bytes, are:

- the template over shell on the shared fixture's Infra template, repeated,
  which has as many interpolations for its size as the Infra repository's
  templates;
- the template over shell on the shell measurement's source, with an escape,
  two interpolations, and two directives around a line added to each unit, 1,724
  interpolations and directives and 431 escapes in all;
- the template over shell on a source with an interpolation on every line;
- the same, with two of each unit's three interpolations not valid HCL;
- the TOML control, on the Android formats measurement's TOML source; and
- the shell language alone, on the shell measurement's source.

A language's initialization is measured once, under the first source that
selects it. Three rounds ran.
[`cf-view-terraform-template-2026-11-results.json`](cf-view-terraform-template-2026-11-results.json)
holds every sample and the load averages around each round.

## Timings

The TOML control's medians were 0.97 to 1.05 times the medians the Android
formats report recorded for the complete highlight, the document parse, and the
re-color, below the 2.15 times at which the HCL report set rounds aside. An
earlier set of three rounds of the same code was set aside although its control
was inside that limit, at up to 1.37 times: in one of its rounds the load
average rose to 10.1, and every source's 95th percentiles rose with it, shell
alone's included, while its medians agreed with these rounds'.

Each estimate is TOML's recorded 95th percentile multiplied by the largest
ratio, over the three rounds, of the source's figure to the TOML control's in
the same round. The first takes the ratio of 95th percentiles, as the shell and
HCL reports did; the second takes the ratio of medians, which one slow sample
moves less. Each cell gives the first, then the second, in milliseconds.

| Source | Full highlighting | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: |
| Infra template, repeated | 18.7 / 18.8 | 22.7 / 22.5 | 13.1 / 13.0 |
| Shell source with sequences | 30.5 / 31.3 | 37.6 / 37.6 | 20.4 / 21.3 |
| An interpolation on every line | 31.8 / 31.9 | 40.2 / 39.9 | 23.1 / 24.1 |
| Two of three interpolations invalid | 34.2 / 30.9 | 37.9 / 38.2 | 22.1 / 23.5 |
| Shell alone | 33.5 / 34.5 | 41.3 / 41.5 | 22.0 / 23.5 |
| Accepted maximum | 50 | 50 | 25 |

Initialization is not scaled the same way. The probe's cold start loads the
pager's whole set of languages, as `cf view` does, which the TOML control's
recorded figure did not, so the cost every language shares dominates each ratio
to it. Against shell alone, measured beside it, the template's initialization
was 1.00 to 1.01 times shell's by medians, and 0.92 to 1.04 times by 95th
percentiles, so the shell report's estimate of 56.6 ms stands for both, inside
the 75 ms maximum.

The comparison with shell alone needs no scaling, because the sources ran
beside one another. The template's medians were 0.53 to 0.57 times shell
alone's for the Infra template, whose shell is sparser than the shell
measurement's, and 0.89 to 1.05 times for the other three sources. A
template's host reads the same kind of shell as the shell language does, so its
costs follow the shell's own.

An earlier form of the language colored the sequences' code with the HCL
grammar, in one parse of the sequences on each scan. Measured the same way in
three rounds whose TOML controls ran at 1.5 to 38 times their recorded medians,
too loaded for the HCL report's method to accept, its scaled estimates were
inside every maximum on the Infra template: 24.3, 27.6, and 15.9 ms for the
highlight, the document parse, and the re-color by 95th percentiles. On the
denser sources, its document parse was estimated at 84 ms and its re-color at
54 ms by medians, and on the source with invalid interpolations, each of which
it parsed again on its own, at 297 ms and 207 ms. It parsed every sequence's
code with the grammar on each scan, where the focused scanner that replaced it
reads that code once, with no parser. Those rounds' raw samples are not
retained.

## Size, source, and build

| Dimension | Terraform templates | Accepted maximum |
| --- | ---: | ---: |
| Compiled `cf` increase | 0 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | 0 MiB | 10 MiB for a later grammar |
| Owned source | 413 lines | 200 lines for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 |

Built with `deno task build-binaries cf`, the binary was 188,631,650 bytes both
at the commit the language is added to and with the language, the same to the
byte, although the binary with the language holds its module and the one
without does not. The binary with the language colored
`controller_url` in the Infra repository's `startup-script.sh.tftpl` as a
template's identifier, where the one without it read the file as shell, which
its shebang selects, and colored the interpolation as a shell expansion.

Owned source is
`runtime/cli/lib/view/languages/terraform-template/terraform-template.ts`,
which holds no grammar adapter or workaround; selection grew by four lines in
`languages/language.ts`. The 200-line maximum is for a later grammar's owned
source, and the scanner adds no grammar; it is 213 lines over that figure, with
105 of its 413 lines comments and 29 blank. The Jinja scanner, which the same
layer runs, is 251 lines.

## Coverage

On November 22, 2026, at the Infra repository's `64939c46` commit, the local
checkouts of the organization's repositories held four Terraform templates, all
in Infra: three shell scripts named with a `.sh.tftpl` suffix, and a Tailscale
policy file, `policy.hujson.tftpl`, in HuJSON, the JSON dialect with comments
and trailing commas, which no language of `cf view` claims. The six months
before held 16 path-change events on them. The adjacent retained
[coverage check](cf-view-terraform-template-2026-11-coverage.ts) read every one:

```sh
cd runtime/cli
deno run --allow-read --allow-env \
  ../../docs/history/runtime/cli/cf-view-terraform-template-2026-11-coverage.ts DIR
```

The shell scripts select the template over shell, and the policy the template
over plain text, and each reconstructed exactly from its colored spans. They
hold 29 interpolations, four directives, 170 `$${` escapes, and one `%%{`
escape. Every one of the 746 characters other than white space inside those
sequences has a token class. Of the 25,981 characters other than white space in
the four files, 40.62 percent are left plain, all of them outside the
sequences: 8,416 in the policy, whose text no language colors, and in the shell
scripts the command arguments, which the shell leaves uncolored in its own files
too, 12.26 percent of theirs.
