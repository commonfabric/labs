import type { TokenClass } from "../../../lib/view/model.ts";

/**
 * Source evidence whose token class proves that a language highlighter ran.
 */
export interface HighlightEvidence {
  readonly text: string;
  readonly className: TokenClass;
}

/** Selection paths exercised for a language, carried by one of its fixtures. */
export interface SelectionCases {
  readonly filenames: readonly string[];
  readonly aliases: readonly string[];
  readonly shebangs?: readonly string[];
}

/**
 * One source family in the shared `cf view` language fixture corpus.
 *
 * The repository, commit, and path identify a file in the frozen coverage
 * survey. The checked-in sources reduce that file to the syntax needed by the
 * fixture contract, then adapt it into before, after, and incomplete states.
 */
export interface ViewLanguageFixture {
  readonly languageId: string;

  /** Other adapters that deliberately share this fixture's token evidence. */
  readonly highlightingPeers?: readonly string[];

  readonly surveyRepository: string;
  readonly surveyCommit: string;
  readonly surveyPath: string;
  readonly before: URL;
  readonly after: URL;
  readonly incomplete: URL;

  /** Present on the fixture that carries the language's selection routes. */
  readonly selection?: SelectionCases;
  readonly beforeEvidence: HighlightEvidence;
  readonly afterEvidence: HighlightEvidence;
  readonly incompleteEvidence: HighlightEvidence;
}

/** Text-language fixtures covered by the shared language contract. */
export const VIEW_LANGUAGE_FIXTURES: readonly ViewLanguageFixture[] = [
  {
    languageId: "typescript",
    surveyRepository: "labs",
    surveyCommit: "a09656c3342bf3e34b68c5f754c25473acb0afef",
    surveyPath: "packages/patterns/counter/counter.tsx",
    before: new URL("./typescript/before.tsx", import.meta.url),
    after: new URL("./typescript/after.tsx", import.meta.url),
    incomplete: new URL("./typescript/incomplete.fixture", import.meta.url),
    selection: {
      filenames: [
        "packages/patterns/counter/counter.tsx",
        "src/runtime.ts",
        "scripts/check.mts",
        "scripts/check.cts",
        "web/client.js",
        "web/client.jsx",
        "tools/inspect.mjs",
        "tools/inspect.cjs",
      ],
      aliases: ["typescript", "ts", "javascript", "js"],
      shebangs: [
        "#!/usr/bin/env -S deno run -A",
        "#!/usr/bin/env node",
        "#!/usr/bin/nodejs",
        "#!/usr/bin/env bun",
      ],
    },
    beforeEvidence: { text: "pattern", className: "builderCall" },
    afterEvidence: { text: "pattern", className: "builderCall" },
    incompleteEvidence: { text: "`Count: ${", className: "template" },
  },
  {
    languageId: "markdown",
    surveyRepository: "specs",
    surveyCommit: "57d00d343109b34e279a11efcb8517ff0e25e9c4",
    surveyPath: "attention-framework/README.md",
    before: new URL("./markdown/before.md", import.meta.url),
    after: new URL("./markdown/after.md", import.meta.url),
    incomplete: new URL("./markdown/incomplete.fixture", import.meta.url),
    selection: {
      filenames: [
        "attention-framework/README.md",
        "notes.markdown",
        "guide.mdown",
        "guide.mkd",
        "guide.mdx",
      ],
      aliases: ["markdown", "md"],
    },
    beforeEvidence: {
      text: "# Attention Framework",
      className: "sectionHeader",
    },
    afterEvidence: {
      text: "# Attention Framework revision",
      className: "sectionHeader",
    },
    incompleteEvidence: { text: "```ts", className: "punctuation" },
  },
  {
    languageId: "json",
    highlightingPeers: ["json-lines"],
    surveyRepository: "labs",
    surveyCommit: "a09656c3342bf3e34b68c5f754c25473acb0afef",
    surveyPath: "deno.jsonc",
    before: new URL("./json/before.jsonc", import.meta.url),
    after: new URL("./json/after.jsonc", import.meta.url),
    incomplete: new URL("./json/incomplete.fixture", import.meta.url),
    selection: {
      filenames: [
        "deno.jsonc",
        "package.json",
        "settings.jsonc.example",
        "packages/shell/public/manifest.webmanifest",
        "packages/memory/memory.tldr",
        "deno.lock",
        "bay.code-workspace",
        "ios/Package.resolved",
        "images/syzkaller/default-gvisor-config.cfg",
      ],
      aliases: ["json", "jsonc"],
    },
    beforeEvidence: { text: '"tasks"', className: "propertyName" },
    afterEvidence: { text: '"tasks"', className: "propertyName" },
    incompleteEvidence: { text: '"workspace"', className: "propertyName" },
  },
  {
    languageId: "json-lines",
    surveyRepository: "labs",
    surveyCommit: "69fcd7efa983a143d1fbe0bc8167b0a6a9be6835",
    surveyPath: "tasks/test-identity-aliases.jsonl",
    before: new URL("./json-lines/before.jsonl", import.meta.url),
    after: new URL("./json-lines/after.jsonl", import.meta.url),
    incomplete: new URL(
      "./json-lines/incomplete.fixture",
      import.meta.url,
    ),
    selection: {
      filenames: [
        "tasks/test-identity-aliases.jsonl",
        "tests/fixtures/location.point.sample.ndjson",
      ],
      aliases: ["json-lines", "jsonl", "ndjson"],
    },
    beforeEvidence: { text: '"queued"', className: "propertyName" },
    afterEvidence: { text: '"processed"', className: "propertyName" },
    incompleteEvidence: { text: '"editing"', className: "propertyName" },
  },
  {
    languageId: "yaml",
    surveyRepository: "common-cluster",
    surveyCommit: "50c7f1bb0b83dad6057b3bde73ce599f86624084",
    surveyPath: ".github/workflows/ci.yml",
    before: new URL("./yaml/before.yml", import.meta.url),
    after: new URL("./yaml/after.yml", import.meta.url),
    incomplete: new URL("./yaml/incomplete.yml", import.meta.url),
    selection: {
      filenames: [
        ".github/workflows/ci.yml",
        "deploy/config.yaml",
      ],
      aliases: ["yaml", "yml"],
    },
    beforeEvidence: { text: "jobs", className: "propertyName" },
    afterEvidence: { text: "jobs", className: "propertyName" },
    incompleteEvidence: { text: "script", className: "propertyName" },
  },
  {
    languageId: "python",
    surveyRepository: "loom",
    surveyCommit: "43a4afe18fbfc37ab8a11da8fe5011f0be81f6e7",
    surveyPath: "src/bin/loom-size-report.py",
    before: new URL("./python-loom/before.py", import.meta.url),
    after: new URL("./python-loom/after.py", import.meta.url),
    incomplete: new URL("./python-loom/incomplete.py", import.meta.url),
    selection: {
      filenames: [
        "src/bin/loom-size-report.py",
        "cfc/formal/scripts/check-architecture.py",
        "src/probe/artifact_refs.py",
        "bench/analyze.py",
        "vdso/check_vdso.py",
        "src/loom/types.pyi",
        "tools/app.pyw",
      ],
      aliases: ["python", "py"],
      shebangs: [
        "#!/usr/bin/python3",
        "#!/usr/bin/env python",
        "#!/usr/bin/env pypy3",
        "#!/usr/bin/env -S uv run --script",
      ],
    },
    beforeEvidence: { text: "count_items", className: "functionName" },
    afterEvidence: { text: "count_items", className: "functionName" },
    incompleteEvidence: { text: "count_items", className: "functionName" },
  },
  {
    languageId: "python",
    surveyRepository: "specs",
    surveyCommit: "34fb8680caa9f68005a438854fa5dc2ef15ff953",
    surveyPath: "cfc/formal/scripts/check-architecture.py",
    before: new URL("./python-specs/before.py", import.meta.url),
    after: new URL("./python-specs/after.py", import.meta.url),
    incomplete: new URL("./python-specs/incomplete.py", import.meta.url),
    beforeEvidence: { text: "closure", className: "functionName" },
    afterEvidence: { text: "closure", className: "functionName" },
    incompleteEvidence: { text: "closure", className: "functionName" },
  },
  {
    languageId: "python",
    surveyRepository: "legibility",
    surveyCommit: "ff46a8e811e0f75246b2fe1cafa8e18954dede3f",
    surveyPath: "src/probe/artifact_refs.py",
    before: new URL("./python-legibility/before.py", import.meta.url),
    after: new URL("./python-legibility/after.py", import.meta.url),
    incomplete: new URL("./python-legibility/incomplete.py", import.meta.url),
    beforeEvidence: { text: "display_date", className: "functionName" },
    afterEvidence: { text: "display_date", className: "functionName" },
    incompleteEvidence: { text: "display_date", className: "functionName" },
  },
  {
    languageId: "python",
    surveyRepository: "raia",
    surveyCommit: "a9998da33e2a04df830d684cd6eef1a3ec2a4f59",
    surveyPath: "bench/analyze.py",
    before: new URL("./python-raia/before.py", import.meta.url),
    after: new URL("./python-raia/after.py", import.meta.url),
    incomplete: new URL("./python-raia/incomplete.py", import.meta.url),
    beforeEvidence: { text: "fail_vec", className: "functionName" },
    afterEvidence: { text: "fail_vec", className: "functionName" },
    incompleteEvidence: { text: "fail_vec", className: "functionName" },
  },
  {
    languageId: "python",
    surveyRepository: "gvisor",
    surveyCommit: "0da391ef9ab8d513fba6412f4b14680917a00556",
    surveyPath: "vdso/check_vdso.py",
    before: new URL("./python-gvisor/before.py", import.meta.url),
    after: new URL("./python-gvisor/after.py", import.meta.url),
    incomplete: new URL("./python-gvisor/incomplete.py", import.meta.url),
    beforeEvidence: { text: "PageRoundDown", className: "functionName" },
    afterEvidence: { text: "PageRoundDown", className: "functionName" },
    incompleteEvidence: { text: "PageRoundDown", className: "functionName" },
  },
  {
    languageId: "plain-text",
    surveyRepository: "raia",
    surveyCommit: "6b9cc95befe5f7cf0929eb569d9a1157e62d2374",
    surveyPath: "LICENSE",
    before: new URL("./plain-text/before", import.meta.url),
    after: new URL("./plain-text/after", import.meta.url),
    incomplete: new URL("./plain-text/incomplete", import.meta.url),
    selection: {
      filenames: [
        "harness/tasks_postmortem_declines/bay_261_sticky_ids",
        "notes.txt",
        "LICENSE",
        "NOTICE",
        "LICENSE.third-party",
        "NOTICE.third-party",
      ],
      aliases: ["plain-text", "text", "plaintext"],
    },
    beforeEvidence: {
      text: "# Permission to use, copy, and modify",
      className: "plain",
    },
    afterEvidence: {
      text: "# Permission to use, copy, and distribute",
      className: "plain",
    },
    incompleteEvidence: {
      text: "# THE SOFTWARE IS PROVIDED “AS IS",
      className: "plain",
    },
  },
];
