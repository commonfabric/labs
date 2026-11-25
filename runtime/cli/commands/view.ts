import { Command } from "@cliffy/command";
import { type ColorWhen, ViewError, viewMain } from "../lib/view/mod.ts";
import { cliText } from "../lib/cli-name.ts";
import {
  languageNames,
  TEMPLATE_LANGUAGE_NAMES,
} from "../lib/view/languages/language.ts";

const description = cliText(
  `Interactive, syntax-aware pager for transformed patterns, source files and diffs.

A less-like viewer for the dense output of '--show-transformed' and saved source
files. Transformed TypeScript is parsed with the same parser the transformer
uses, so blocks, closures, schemas, type positions and Common Fabric builders
(pattern/lift/handler/…) are colored exactly as the compiler sees them.
Markdown, JSON, JSONC, YAML, Python, Go, Swift, Kotlin, Rust, TOML, HCL,
Starlark, Bazel rc, Lean, C, C++, CUDA, CSS, HTML, shell, makefile, Dockerfile,
Java properties, INI, dotenv, Graphviz DOT, ProGuard, Git attributes, Git
configuration, GNU linker script, XML, CSV, TSV, assembly and SQL files use
syntax highlighting selected from language metadata, as do Go's 'go.mod',
'go.work', 'go.sum' and 'go.work.sum' files, Lean's 'lean-toolchain' files, Git,
Docker and Bazel ignore files, and '.dat' files that hold a numeric table.
Kotlin covers Gradle's '.gradle.kts' build scripts, HCL covers OpenTofu and
Terraform configuration, HTML colors its scripts as JavaScript or JSON and its
style sheets as CSS, Starlark covers Bazel's BUILD, '.bzl' and '.bazel' files,
'.bazelrc' files use the Bazel rc language, a '.h' header is colored with the
C++ grammar unless piped with '--language c', shell covers Bash and POSIX shell,
makefiles color their recipes as shell, Dockerfiles color the shell form of
their commands as shell, INI covers Ansible configuration and inventories,
dotenv covers environment files such as '.env' and '.env.example', Git
configuration covers '.gitmodules' and '.gitconfig', linker scripts cover '.ld'
and '.lds' files and the '.lds.S' and '.ld.S' files that the C preprocessor
reads first, XML covers Android manifests and resources, SVG and Apple property
lists, and SQL covers PostgreSQL, SQLite and MySQL scripts. Python interpreter
shebangs select Python, 'swift' and 'xcrun swift' shebangs select Swift,
'kotlin' shebangs select Kotlin, 'sh', 'bash', 'dash' and 'ash' shebangs select
shell, and 'make' and 'gmake' shebangs select the makefile language. Node, Deno
and Bun shebangs select the TypeScript and JavaScript language family. For a
name no language claims, source that starts with an XML declaration ('<?xml'),
after any byte order mark, selects XML. A Jinja ('.j2', '.jinja', '.jinja2') or
Terraform ('.tftpl') template is colored as the language the rest of its name
selects, with the template's own syntax colored inside it. Known binary
filenames, NUL-containing input and invalid UTF-8 select the binary language.
Its rendered view is a read-only hex dump with control pictures for bytes that
have no printable ASCII character.
Filename-free compiler output keeps TypeScript highlighting when its
transformed-module header identifies it. Other unnamed source and named files
with unrecognized syntax remain plain text. Piped source can select syntax
explicitly with '--language' or supply a virtual name with '--filename'. Either
option suppresses unified-diff auto-detection; use '--diff' instead for a diff.
The Markdown language also has a rendered view that formats headings, lists,
quotes, tables, links, emphasis and code while retaining source line positions.
Source views remain verbatim and add color only.
Directive configuration covers nginx, Apache httpd, nftables, Netdata health
alerts and sysusers.d. Logs, checksums, version files, PID files and keys are
plain text by name.

Raw unified diffs are detected automatically when their structural header is the
first nonblank line. Standard Git commit output is detected from its complete
header. Binary detection examines bytes; beyond shebangs, XML declarations and
the opening of a file whose extension several syntaxes share, such as '.conf',
source content is not used to guess a language. Piping 'git diff' in gives added
and removed lines their tints, full syntax color, a structure tree of the code
each hunk touches, and the semantic features (inferred types, go-to-definition)
answered against the CURRENT state of the workspace files the diff names.
In a diff, T hides and shows test files: those whose names follow common test
conventions, and those the repository marks with the 'test' Git attribute. A
'.gitattributes' line such as 'scripts/test-* test' marks paths as tests, and
'-test' marks paths as not tests whatever their names.

COMMON USAGE:
  cf check ./pattern.tsx --show-transformed --no-run | cf view
  git diff origin/main | cf view        # diff mode
  cf view transformed.ts                # view a saved file
  generate-source | cf view --filename script.py
  cf check ./p.tsx --show-transformed --no-run | cf view --plain | bat

KEYS (press ? in the viewer for the full list):
  mouse wheel, ↑/↓ or k/j scroll · ←/→ h/l pan · Space/PgUp page
  g/G top/bottom · / search
  structure tree: w/s sibling · a/d parent/child · Tab/⇧Tab depth-first
  Enter info card · in it: ↑/↓ pick a reference · Enter opens it · z reveals it
  v source/rendered · t look up a definition · # line numbers · \\ wrap mode
  b blame: when each line last changed, and who changed it · q quit
  P push the checked-out branch to origin, then handle its pull request
  L land the branch's pull request · O settings, such as how P and L work

When stdout is not a terminal (piped/redirected) it prints the colorized text
and exits, like less.`,
);

export const view = new Command()
  .name("view")
  .description(description)
  .example(
    cliText(`cf check ./pattern.tsx --show-transformed --no-run | cf view`),
    "Pipe transformed output into the interactive viewer.",
  )
  .example(
    cliText(`git diff origin/main | cf view`),
    "View a diff with syntax color, structure navigation and types.",
  )
  .example(
    cliText(`cf view transformed.ts`),
    "Open a previously saved transformed file.",
  )
  .option(
    "--color <when:string>",
    "Colorize: always | auto | never (auto = when stdout is a TTY).",
    { default: "auto" },
  )
  .option(
    "--plain",
    "Do not launch the interactive pager; print colorized text and exit.",
  )
  .option(
    "-n, --line-numbers",
    "Show line numbers (toggle with # in the viewer).",
  )
  .option(
    "--rendered",
    "Start in the rendered view when the input language supports one.",
  )
  .option(
    "--language <language:string>",
    `Select piped source explicitly: ${
      languageNames().join(", ")
    }. ${TEMPLATE_LANGUAGE_NAMES}`,
  )
  .option(
    "--filename <filename:string>",
    "Select piped source as though it had this filename.",
  )
  .option(
    "--diff",
    "Treat the input as a unified diff, overriding auto-detection.",
  )
  .option(
    "--no-diff",
    "Treat the input as source even if it looks like a diff.",
  )
  .arguments("[file:string]")
  .action(
    async (
      options: {
        color?: string;
        plain?: boolean;
        lineNumbers?: boolean;
        rendered?: boolean;
        language?: string;
        filename?: string;
        diff?: boolean;
      },
      file?: string,
    ) => {
      try {
        const when = (options.color ?? "auto") as ColorWhen;
        if (when !== "always" && when !== "auto" && when !== "never") {
          throw new ViewError(
            `--color must be always, auto, or never (got "${when}")`,
          );
        }
        await viewMain({
          color: when,
          plain: options.plain ?? false,
          lineNumbers: options.lineNumbers ?? false,
          rendered: options.rendered ?? false,
          language: options.language,
          filename: options.filename,
          file,
          diff: options.diff,
        });
      } catch (error) {
        // Expected, user-facing conditions print plainly without a stack trace.
        if (error instanceof ViewError) {
          console.error(error.message);
          Deno.exit(1);
        }
        throw error;
      }
    },
  );
