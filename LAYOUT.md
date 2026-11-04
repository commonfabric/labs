# Repository layout

This document says what each file and directory at the top of this repository
holds, and so where new code belongs.

Two terms recur. A _pattern_ is a program that runs on Common Fabric, such as an
app that a user opens. A _package_ is a directory of related source code. Most
packages are also one _workspace member_: a directory with its own `deno.jsonc`
configuration file, listed in the root `deno.jsonc`.

## Packages

A package is either a directory directly inside one of two parent directories
(`base/` and `runtime/`), or one of three directories at the top level
(`connectors/`, `dashboard/`, and `patterns/`). The file
`tasks/package-layout.ts` encodes this rule for the repository's tools.

The places are listed below in the order that dependencies run between them. A
package imports only from packages in its own place or an earlier one, and
`connectors/`, `dashboard/`, and `patterns/` share the last place.
`deno task check-dependency-direction` fails on a production import that runs
the other way. The section of `AGENTS.md` titled "Pace Layers" says more.

- `base/` holds code that the runtime is built on and that does not itself use
  the runtime. It starts with the data model, which defines the values Common
  Fabric stores and how those values are encoded, hashed, and compared
  (`data-model`), and the libraries the data model is built on: plain JavaScript
  values (`js-values`), data structures (`collections`), byte and text encodings
  (`bytes` and `text`), and hashing (`content-hash`). Other examples are JSON
  (`json`), promises and timers (`async`), the host the code runs on
  (`platform`), logging (`logger`), what the pattern compiler and the runner
  agree on (`pattern-contract`), the interface that patterns are written against
  (`api`), the schemas of the data model's values (`data-model-schema`), the
  compiler that turns a pattern's TypeScript into code the runtime can run
  (`js-compiler`, `ts-transformers`, and `schema-generator`), the client for
  language-model services (`llm`), a front-end build tool (`felt`), and the code
  that records test results (`test-support`).
- `runtime/` holds the program that runs patterns (`runner`) and everything
  built on it. Examples are the storage service (`memory`), the server that
  hosts storage and serves patterns (`toolshed`), the web front end (`shell`),
  the `cf` command-line tool (`cli`), and a runner for tests that need a browser
  (`deno-web-test`).
- `connectors/` is one package. A connector copies data from an outside service,
  such as GitHub, into Common Fabric. Each connector has a directory here that
  holds the connector, the program that runs the connector on a server, and the
  pattern that displays the data the connector copied.
- `dashboard/` is one package: the dashboard that reports on the state of
  development, such as continuous integration. It stands apart from the product,
  and uses only the libraries in `base/`.
- `patterns/` is one package. It holds the patterns, each in a directory of its
  own inside a directory for its category. The categories are listed in the
  order that dependencies run between them, and a pattern imports only from its
  own category or an earlier one:
  - `system/` holds what the runtime itself knows about, and what is core to how
    Common Fabric works: the patterns the runtime starts by name, such as Home
    and the user's profiles, the patterns those are built from, such as
    FabriChat, Loom, and FabriFile (a space's set of named files), and the
    libraries that patterns share, such as the helpers for writing
    information-flow policies (`system/cfc/`).
  - `product/` holds parts of the product that the runtime does not start by
    name.
  - `apps/` holds apps that people use but that the platform does not depend on.
  - `examples/` holds patterns that each demonstrate one capability.
  - `showcase/` holds larger demonstrations, such as games.
  - `dev/` holds patterns used to develop the platform, such as test fixtures.

  The `patterns/` directory also holds three directories that are not
  categories. `baselines/` holds a recorded description of each pattern's inputs
  and outputs, which a check compares each new version against. `integration/`
  holds the browser tests. `tools/` holds scripts and test helpers.
  `patterns/README.md` says more about each category, and `patterns/index.md`
  lists every pattern.

A package that is deployed as a container image keeps its `Dockerfile` in its
own directory. The two such files are `runtime/toolshed/Dockerfile` and
`dashboard/Dockerfile`.

## Tooling

- `tasks/` holds the repository's checks and build steps. The root `deno.jsonc`
  makes each one available as `deno task <name>`. The program that runs every
  package's tests is here too.
- `scripts/` holds scripts that a developer runs by hand. Examples are the
  scripts that start and stop the local servers, and the scripts that export and
  restore the team's Topics board.
- `bin/` holds two shell scripts, `cf` and `cfsh`, which `deno task install-cf`
  copies into a directory on `PATH`. Each script runs the `cf` command-line tool
  from the checkout that contains the current directory. `cfsh` starts the
  tool's interactive shell.

## Documentation and agent instructions

- `README.md` introduces the project. `SECURITY.md` says how to report a
  security problem.
- `AGENTS.md` holds instructions for AI coding agents. `CLAUDE.md` includes
  `AGENTS.md` for Claude Code.
- `docs/` holds the documentation. `docs/README.md` describes how it is
  organized and where a new document belongs. `docs/history/` holds records of
  past work, which are not updated.
- `skills/` holds instructions that AI coding agents load for specific tasks.
  `.agents/skills/` and `.claude/skills/` make the same files available to Codex
  and to Claude Code.
- `.claude/` holds the rest of the configuration for Claude Code, including
  instructions that it loads when it reads a file whose path matches a given
  pattern.

## Configuration

- `deno.jsonc` configures Deno for the whole repository. It lists the workspace
  members, defines the tasks that `deno task` runs, configures the formatter and
  the linter, and declares dependencies the members share. `deno.lock` records
  the exact version of each dependency.
- `mise.toml` sets the version of Deno that the `mise` tool installs.
- `ports.json` records the port each local server listens on by default. Other
  repositories, such as `loom`, read it to compute the ports that these servers
  use.
- `cubic.yaml` configures Cubic, a service that reviews pull requests.
- `.github/` holds the continuous-integration workflows. `.githooks/` holds a
  git pre-commit hook, which `scripts/install-git-hooks.sh` installs.
- `.vscode/` and `.zed/` hold settings for those editors.
- `.gitattributes`, `.gitignore`, `.denoignore`, and `.dockerignore` say how
  git, Deno, and Docker treat the files in the repository.
