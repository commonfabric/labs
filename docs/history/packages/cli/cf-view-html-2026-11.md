---
status: historical
created: 2026-11-13
archived: 2026-11-13
reason: "Point-in-time measurements of the shipped cf view HTML path with its embedded CSS and JavaScript, its coverage of the organization's HTML files, and the evaluation of the HTML parsers the UI package already pins."
---

# `cf view` HTML: shipped measurements

This report records what the `cf view` HTML language costs, measured against
the operating maximums in the
[`cf view` language coverage plan](../../../plans/cf-view-language-coverage.md),
and how well it covers the HTML files in the organization's repositories. It is
also the nested-HTML measurement that the plan requires before Stage 5, and the
evaluation of the HTML parsers that the UI package already pins.

HTML runs on the shared Tree-sitter adapter with the official HTML grammar,
`tree-sitter-html` 0.23.2. Another language colors four kinds of stretch inside
a page. A `script` element's text is colored as JavaScript by the pager's
TypeScript and JavaScript highlighter, or as JSON by its JSON scanner, as the
type string the HTML standard derives from the element's `type` and `language`
attributes says. An event handler attribute's value is colored as JavaScript. A
`style` element's text and a `style` attribute's value are colored through the
CSS grammar, `tree-sitter-css` 0.25.0, which the
[November 2026 CSS report](cf-view-css-2026-11.md) measures on its own. An
attribute's value is colored with its character references read as the
characters they stand for.

HTML is inside the maximums for compiled bytes, unpacked bytes, and build
steps. Its owned source is 306 lines, over the 200 a later grammar may add, and
the cumulative owned-source maximum for the runtime and its four host grammars
was already exceeded before HTML; "Size, source, and build" gives the counts.
The machine was too loaded for elapsed time to mean anything. Scaled against a
TOML control run beside each round, in processor time, every timing is
estimated to be inside its maximum, the document parse closest at about 45 ms
against 50. "Timings" gives the figures and the inference behind the estimate.

## Environment and method

The measurements ran on a MacBook Pro identified as `Mac17,6`, with an Apple M5
Max, 18 cores and 128 GB of memory, running arm64 macOS 26.6.2 with Deno 2.9.8,
V8 15.0.245.2-rusty, and TypeScript 6.0.3. They used `web-tree-sitter`
0.26.12, `tree-sitter-html` 0.23.2, and `tree-sitter-css` 0.25.0. The
dependency cache was warm.

The adjacent retained [probe](cf-view-html-2026-11-probe.ts) is the
[October 2026 HCL probe](cf-view-hcl-2026-10-probe.ts) with HTML and script
source units, and with the TOML unit of the
[September 2026 Android formats probe](cf-view-android-formats-2026-09-probe.ts)
as a control. It runs from `runtime/cli`:

```sh
cd runtime/cli
deno run --allow-read --allow-env --allow-run \
  ../../docs/history/packages/cli/cf-view-html-2026-11-probe.ts html
```

Each source repeats a unit after one line of non-ASCII comment, to exactly
100,009 UTF-8 bytes. The `html` unit is a six-line `section` element. It holds
a heading with an entity in an attribute, a paragraph with a `style` attribute
and a link with an `onclick` handler, a one-line `script` element calling a
function with an object and an array, and a one-line `style` element with a
`calc()` and a `var()`. Every unit therefore carries four embedded stretches,
1,252 in the whole source, which is far denser than the pages surveyed below.
The `html-script` source is a page holding one script of five-line functions,
and the `script` source is the same functions as a file of their own, colored
by the TypeScript and JavaScript language. Each edit renames the first
`renderItem` after the middle of the source, which in the HTML sources is
inside a script, to `renderUnit`.

Sample counts and the operations timed are the HCL probe's: 40 fresh-process
initialization samples, and 50 each of a complete highlight, a document parse
with structure, and a re-color after one edit. No deadline, retry, or sleep
participated. Each sample records the processor time the process used, in
every thread, beside the time that elapsed. Every `cf view` process loads the
TypeScript language at startup through the language registry, and HTML colors
scripts with it, so the probe loads it before it starts timing initialization.

Each of the two final rounds ran the TOML probe, then the `html`,
`html-script`, and `script` probes, then the TOML probe again. The adjacent raw
[results](cf-view-html-2026-11-results.json) contain every sample of every run,
the earlier rounds described below, and the coverage figures by repository.

## Timings

Other work shared the machine throughout, with one-minute load averages of 169
and 124 at the start of the two final rounds. The TOML control's elapsed
medians were many times the medians the Android formats report recorded. No
round comes near the test the HCL report applied, which kept a round only when
its control stayed within 1.22 times the recorded medians, so elapsed time is
recorded in the results and is not used for estimates.

Processor time varied far less from round to round. These are the medians and
95th percentiles in processor milliseconds of the final rounds, with the TOML
medians of the run before and the run after:

| Round and source | Initialization | Complete highlight | Document parse | Re-color after one edit |
| --- | ---: | ---: | ---: | ---: |
| 1, TOML before and after | 27.9, 26.1 | 33.2, 33.0 | 58.3, 53.5 | 28.9, 21.2 |
| 1, `html` | 59.5 / 80.8 | 68.2 / 101.9 | 84.9 / 121.0 | 28.8 / 56.4 |
| 1, `html-script` | 55.7 / 73.4 | 73.0 / 117.9 | 62.7 / 112.4 | 24.7 / 51.2 |
| 1, `script` | | 54.1 / 123.6 | 86.1 / 134.4 | 7.2 / 18.5 |
| 2, TOML before and after | 26.8, 27.9 | 32.8, 30.9 | 58.0, 49.1 | 18.7, 24.6 |
| 2, `html` | 58.4 / 74.3 | 67.7 / 108.2 | 71.2 / 102.6 | 22.7 / 78.2 |
| 2, `html-script` | 57.1 / 72.6 | 67.3 / 113.6 | 59.8 / 97.7 | 27.1 / 45.9 |
| 2, `script` | | 48.7 / 81.7 | 82.6 / 128.6 | 7.5 / 12.7 |

The `script` source's initialization loads the whole TypeScript language
module, which the pager loads at startup, so it is left out.

The TOML processor-time medians are 1.2 to 2.7 times the elapsed medians the
Android formats report recorded on a quiet machine. Processor time counts every
thread, and a loaded machine slows each thread's work as well as delaying it,
so it is not itself a quiet machine's elapsed time.

Over the two rounds, the ratio of the `html` processor-time median to the mean
of the two TOML medians around it ranges from 2.14 to 2.20 for initialization,
2.06 to 2.12 for the complete highlight, 1.33 to 1.52 for the document parse,
and 1.05 to 1.15 for the re-color. Multiplying the TOML 95th percentiles the
Android formats report recorded by the largest of those ratios gives an
estimate for an unloaded machine: 51.6 ms for initialization, 42.0 ms for the
complete highlight, 45.0 ms for the document parse, and 13.7 ms for the
re-color. For `html-script`, the same estimates are 48.9, 43.7, 33.2, and 15.0
ms. Each estimate is inside its maximum.

These are inferences from the control, made as the HCL and shell reports made
theirs. They assume HTML and TOML use processor time alike under load, which
is plausible because both run single-threaded parsing and querying in the same
runtime. They are also approximate in another way: they apply a ratio of
medians to a 95th percentile. Using the ratio of the 95th percentiles instead
gives up to 61.6 ms for `html`'s initialization, 44.7 for its complete
highlight, 40.3 for its document parse, and 20.3 for its re-color, and up to
46.9 for `html-script`'s complete highlight. Each of those is inside its
maximum as well.

Initialization loads two grammars, HTML's and CSS's, with their queries. The
JSON scanner and the TypeScript highlighter that color scripts add nothing to
it, because the pager has loaded them already.

Four earlier rounds measured the change before its review fixes, which brought
the type and handler rules and the incremental coloring of a changed stretch
described below. On the `html` source, they gave ratios of 1.78 to 2.12 for
initialization, 2.04 to 2.14 for the complete highlight, 1.13 to 1.44 for the
document parse, and 0.95 to 1.24 for the re-color. Their samples are in the
results file.

### Where a complete highlight goes

On the `html` source, in one process at a single moment, a complete highlight
cost 27 to 32 ms of processor time with no embedded stretches, about 40 ms when
each stretch's classes had been computed in advance, and 78 to 87 ms in full.
Finding the 1,252 stretches took about 5 ms. Coloring them with the
JavaScript, JSON, and CSS languages accounts for the rest. Called in a loop on
their own, those languages took about 20 ms for the same stretches, so roughly
half of what they cost inside a highlight is not explained by their own work;
the cause was not found. These figures are from the code before the review
fixes.

### What an edit costs

As first written, each coloring colored every embedded stretch again. In six
earlier rounds on that code, whose samples are not retained, the re-color after
one edit took 2.1 to 7.1 times as long as TOML's in elapsed time; every
keystroke on the `html` source ran about 600 TypeScript parses and 600 CSS
parses.

Each embedded stretch now carries a key, which HTML makes from the stretch's
language and its text. A coloring reuses the classes of a key it has already
colored, and a highlighter keeps the classes of its previous coloring for the
next, so a page that repeats a `style` attribute colors it once, and an edit
leaves every other stretch's classes as they were.

That alone left an edit inside a large script parsing the whole script again.
A stretch therefore also carries a slot, which names it across edits, such as
a page's third script. A highlighter keeps each stretch's coloring by slot and
hands it back on the next update. HTML colors a script, JSON block, or style
sheet in an editing highlighter through that language's own incremental
highlighter, so an edit is colored from the earlier parse. On `html-script`,
the re-color now costs 0.99 to 1.25 times TOML's, where the `script` source's
own language takes 0.29 to 0.34 times; the rest is HTML's parse and the copying
of the page's classes. A complete highlight keeps nothing from an earlier one,
so its figures above include coloring every stretch, apart from repeats within
the page.

### The structure walk

Every element is a structure entry. The walk first descended into every node,
attributes and text included, and the document parse cost 1.5 to 1.9 times
TOML's in processor time. HTML now names the node types an element can be found
inside: the document, elements, and the error nodes recovery can put an element
in. A walk restricted that way listed the same entries as an unrestricted one
after each of 14,868 single-character insertions into the three fixtures'
earlier sources, of `<`, `>`, `"`, and `/` at every offset. The
[coverage check](cf-view-html-2026-11-coverage.ts) makes that comparison when
given `--edits` and a file.

## Size, source, and build

| Dimension | HTML | Accepted maximum |
| --- | ---: | ---: |
| Compiled `cf` increase | 0.13 MiB | 10 MiB for a later grammar |
| Unpacked dependencies | 0.70 MiB | 10 MiB for a later grammar |
| Owned source | 306 lines, and 109 in the adapter and its helpers | 200 lines for a later grammar |
| Parser-specific build and deployment steps | 0 | 0 |

Built with `deno task build-binaries cf`, the binary was 187,773,026 bytes with
CSS and without HTML, and 187,905,122 bytes with HTML, an increase of 132,096
bytes. The HTML side was built before the review fixes and the reuse of an
embedded stretch's colors, which add TypeScript source and no dependency. The
WebAssembly grammar is 18,385 bytes. The binary built with HTML colored a page,
its script, and its `style` attribute.

The unpacked figure is the sum of every file in the cached package directory,
736,225 bytes. The package's two dependencies are the ones `tree-sitter-python`
already brings.

Owned source is `runtime/cli/lib/view/languages/html/html.ts`, 306 lines; the
language descriptor beside it is not counted, as those of the earlier grammars
were not. HTML also added 96 lines to the adapter, for the stretches another
language colors, the reuse of their classes, and the colorings kept by slot,
and 13 to `runtime/cli/lib/view/languages/classes.ts`, for reading a
language's colored lines back as classes. Any grammar can name embedded
stretches through those 109 lines, but HTML is the only grammar that does so
now; counted with them, HTML is 415 lines.

Most of HTML's own lines are rules that any parser would need, because they
come from the HTML standard rather than from the grammar: how a script's type
string is derived and which types are JavaScript or JSON, which attribute names
are event handlers, how character references in an attribute's value decode,
and which stretch each embedded language colors. The highlight query, the
structure rule, and the list of node types the structure walk enters take about
45 lines.

The plan holds the common runtime and the Python, Go, Bash, and HTML host
grammars together to 1,000 owned lines. At the change's merge base those files
and Go's hold 1,386 lines: the adapter's 678, the 115 of `classes.ts` that were
split out of it, Python's 126, shell's 270, which were 91 when shell was
measured, and Go's 197. With HTML they hold 1,801. Both overruns start the
comparison under "Reconsidering the dependency" in the plan; the next section is
that comparison for HTML.

## The UI package's parsers

The UI package's editor pins `@codemirror/lang-html` and `@codemirror/lang-css`,
which resolve to the Lezer grammars `@lezer/html` 1.3.13 and `@lezer/css`
1.3.0, with `@lezer/javascript` 1.5.4 and the Lezer runtime packages. It also
pins `happy-dom` 20.14.6. Lezer's CSS grammar is compared with
`tree-sitter-css` in the CSS report.

happy-dom builds a document tree for scripts to run against. Its HTML parser
tracks offsets while it scans but stores none on the nodes it builds, which was
checked by reading `lib/html-parser/HTMLParser.js` in the package, so it cannot
place colors in the source. Its package is 17.5 MiB unpacked. It is not a
candidate.

Lezer's HTML grammar is a candidate. It parses `script` and `style` elements and
`style` and event handler attributes with its own JavaScript and CSS grammars,
in one parse. The [comparison script](cf-view-html-2026-11-lezer.ts) times it on
the `html` source and edit, in the four earlier rounds above. Each sample
parses the source and gives every character the class of the narrowest
highlight tag over it, through `highlightTree` and Lezer's class highlighter.
That is less than the adapter's complete highlight, which also maps classes to
the pager's token classes, gives brackets their depth, and builds display
lines. Its timings are therefore a lower bound for a Lezer-based language. It
runs from `runtime/cli` with `--no-lock`, because the CLI does not declare
these packages.

In processor time, Lezer's medians were 10.9 to 12.0 ms for initialization, 8.4
to 8.8 ms for parsing and classifying the source, and 2.3 to 2.5 ms for doing
so again from the earlier tree after the edit. Those are 0.40 to 0.44, 0.23 to
0.26, and 0.08 to 0.11 times TOML's, against the HTML path's 2.14 to 2.20, 2.06
to 2.12, and 1.05 to 1.15 in the final rounds.

With `--corpus`, the script counts the files and lines that hold a node Lezer's
error recovery inserted. Over the 1,515 files of the coverage check, it found 7
lines in 4 files: a Jekyll layout in gVisor and three Specs files with markup
errors. The Tree-sitter grammar found 312 lines in 63 files, for the reasons
under "Coverage"; Lezer reads the omitted end tags, bare ampersands, and bare
`>` characters behind most of them.

| Dimension | Tree-sitter HTML | Lezer HTML |
| --- | --- | --- |
| Complete highlight, processor time against TOML | 2.06 to 2.12 | 0.23 to 0.26, without the pager's line building |
| Re-color after one edit, against TOML | 1.05 to 1.15 | 0.08 to 0.11, likewise |
| Initialization, against TOML | 2.14 to 2.20 | 0.40 to 0.44 |
| Files with an error over 1,515 | 63, 312 lines | 4, 7 lines |
| Marginal unpacked bytes | 0.70 MiB | 0.97 MiB |
| Marginal compiled bytes | 0.13 MiB | not measured |
| Owned source | 306 lines and 109 shared | none written |
| Parser families in the pager | one | two |

Lezer's marginal bytes are its HTML, CSS, and JavaScript grammars and its three
runtime packages, 1,015,165 bytes, since the Tree-sitter runtime stays for the
other languages either way. A Lezer HTML language would need the same rules
from the HTML standard that make up most of HTML's own source. It would also
need its own mapping from highlight tags to token classes, structure walk, and
incremental highlighter, which the Tree-sitter adapter supplies, and its CSS
and JavaScript would be colored by grammars other than the ones that color
`.css` and `.js` files.

The dimensions trade off: Lezer is faster and recovers from omitted end tags,
and it costs more unpacked bytes, a second parser family, and a second way of
coloring CSS and JavaScript. Under the plan's rule, that is not a switch, and
the choice is recorded in the plan with these figures.

## Coverage

The local checkouts of the organization's repositories hold 1,515 HTML files in
18 repositories, all named `.html`. The adjacent retained coverage check read
every one at the commits the results file lists:

```sh
cd runtime/cli
git -C REPO ls-files '*.html' '*.htm' | sed "s|^|REPO/|" | \
  deno run --allow-read --allow-env \
    ../../docs/history/packages/cli/cf-view-html-2026-11-coverage.ts
```

Every file reconstructed exactly from its colored spans. The files hold 309
`script` elements, 1,148 `style` elements, and 6,498 `style` attributes. The
embedded languages color 567 stretches as JavaScript, scripts and event
handlers together, 7 as JSON, 1,148 style sheets, and 6,498 `style` attribute
values. Of the 22,679,998 characters other than white space, 18.46 percent are
plain, almost all of it the text of elements, which is prose and is meant to
be plain. 9,254 plain characters, 0.041 percent, are outside the text of
elements: words in a script data block of a type such as `text/template`,
which no language colors, and words the CSS and JavaScript coloring leaves
without a class. Property names take 16.99 percent of the characters, strings
16.73, comments 13.11, punctuation 7.28, and tag names 6.43.

The grammar could not parse part of 63 files, 312 of their 602,384 lines.
Coloring continues through those regions, and the structure tree lists the
elements inside them without the elements that enclose them. The causes seen
in the files read were:

- 22 redirect pages in the Common Fabric website repository, 8 of their 10
  lines each, which put `meta` and `style` directly in `html` and leave the
  final `p` unclosed. HTML allows both, and the grammar does not read them.
- Text holding an ampersand followed by a space, as in `Tide & Stone`, or a
  `>`, as in `15 days > 14d`. HTML allows both in text, and the grammar reads
  each as an error, as a one-line page holding either shows. Such text is
  where the errors start in the worst of the 32 Specs files, all design
  renders, which has 60 of 1,188 lines in errors, and in a Weaver document
  whose `pre` element holds a state diagram's `-->` arrows, which has 15.
- Jekyll layouts and includes in gVisor, whose `{% %}` tags open and close
  elements in different files.
- Two copies of a website tool page whose script holds the string
  `"</script"`, which does not end the element in HTML because no space, `/`,
  or `>` follows it.

The figures above describe the files as they are. The plan discounts generated
concentrations when ordering languages: 37 files are generated by their own
statement or by a build directory in their path, 1,193 are design renders under
`design-compiler/09-generated-prompts/` in Specs, and 17 are the website's
built pages under `docs/`. The 268 others are in 15 repositories. The six
months before November 13, 2026 hold 2,854 path-change events on HTML paths,
839 of them on those 268 files' paths.
