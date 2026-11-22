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

  /** Names no language claims, under which the fixture's own source selects
   * the language. */
  readonly unclaimedFilenames?: readonly string[];
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

/**
 * The C-family languages. They read a name followed by a parenthesized list as
 * a function being declared, and a name that follows another name as a value
 * being declared. So they color the names that other languages' definitions
 * and declarations declare, such as a Python `def` name or a Kotlin `val` name,
 * in the same classes those languages do. C also reads a word followed by `:`
 * as a label, as YAML colors its keys.
 */
const C_FAMILY = ["c", "cpp", "cuda", "c-family-header"];

/** The C-family languages that use the C++ grammar. */
const CPP_GRAMMAR = ["cpp", "cuda", "c-family-header"];

/** Text-language fixtures covered by the shared language contract. */
export const VIEW_LANGUAGE_FIXTURES: readonly ViewLanguageFixture[] = [
  {
    languageId: "typescript",
    surveyRepository: "labs",
    surveyCommit: "a09656c3342bf3e34b68c5f754c25473acb0afef",
    surveyPath: "patterns/examples/counter/counter.tsx",
    before: new URL("./typescript/before.tsx", import.meta.url),
    after: new URL("./typescript/after.tsx", import.meta.url),
    incomplete: new URL("./typescript/incomplete.fixture", import.meta.url),
    selection: {
      filenames: [
        "patterns/examples/counter/counter.tsx",
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
    // A Java properties line colors the key before its `:` as a property name,
    // as JSON and YAML color their keys.
    highlightingPeers: ["json-lines", "properties"],
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
        "runtime/shell/public/manifest.webmanifest",
        "runtime/memory/memory.tldr",
        "deno.lock",
        "bay.code-workspace",
        "ios/Package.resolved",
        "android/swift/Package.resolved.android",
        "images/syzkaller/default-gvisor-config.cfg",
        "Resources/Localizable.xcstrings",
        "performance/consumed-source-dedup.cpuprofile",
        ".firebaserc",
      ],
      aliases: ["json", "jsonc"],
      unclaimedFilenames: [
        "Sources/WeaverBridge/swift-java.config",
        "tests/support/cf_harness_runtime_selection.lock",
      ],
    },
    beforeEvidence: { text: '"tasks"', className: "propertyName" },
    afterEvidence: { text: '"tasks"', className: "propertyName" },
    incompleteEvidence: { text: '"workspace"', className: "propertyName" },
  },
  {
    languageId: "json-lines",
    // Quoted strings joined by `:` read in DOT as nodes and their ports, and
    // DOT colors a port as JSON Lines colors a key.
    highlightingPeers: ["dot"],
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
    // Java properties and INI lines color the key before a `:` as a property
    // name, as YAML colors its keys, and C colors it as a label.
    highlightingPeers: ["properties", "ini", "c"],
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
    languageId: "gitignore",
    // Docker's ignore patterns and Git attributes patterns use the same `*`
    // and bracket-expression wildcards, which each language colors the same
    // way.
    highlightingPeers: ["dockerignore", "gitattributes"],
    surveyRepository: "infra",
    surveyCommit: "d17b6041f60c91fe83c66e914cd62c5e9084a517",
    surveyPath: ".gitignore",
    before: new URL("./gitignore-infra/before", import.meta.url),
    after: new URL("./gitignore-infra/after", import.meta.url),
    incomplete: new URL("./gitignore-infra/incomplete", import.meta.url),
    selection: {
      filenames: [
        ".gitignore",
        "apple/Vendor/coreai-kit/.gitignore",
        ".denoignore",
        ".worktreeinclude",
      ],
      aliases: ["gitignore"],
    },
    beforeEvidence: { text: "*", className: "regex" },
    afterEvidence: { text: "[co]", className: "regex" },
    incompleteEvidence: { text: "*", className: "regex" },
  },
  {
    languageId: "dockerignore",
    // Git's ignore patterns and Git attributes patterns use the same `**`
    // wildcard, which each language colors the same way.
    highlightingPeers: ["gitignore", "gitattributes"],
    surveyRepository: "infra",
    surveyCommit: "d17b6041f60c91fe83c66e914cd62c5e9084a517",
    surveyPath: "memory-router/Dockerfile.build.dockerignore",
    before: new URL("./dockerignore-infra/before", import.meta.url),
    after: new URL("./dockerignore-infra/after", import.meta.url),
    incomplete: new URL("./dockerignore-infra/incomplete", import.meta.url),
    selection: {
      filenames: [
        ".dockerignore",
        "fly/pds/.dockerignore",
        "memory-router/Dockerfile.build.dockerignore",
        "memory-router/scripts/Dockerfile.systemd.dockerignore",
      ],
      aliases: ["dockerignore"],
    },
    beforeEvidence: { text: "**", className: "regex" },
    afterEvidence: { text: "**", className: "regex" },
    incompleteEvidence: { text: "**", className: "regex" },
  },
  {
    languageId: "bazelignore",
    // Git and Docker patterns separate their directories with `/` as Bazel
    // separates those of a path, and color it the same way.
    highlightingPeers: ["gitignore", "dockerignore", "gitattributes"],
    surveyRepository: "gvisor",
    surveyCommit: "82e8d12aed0ff0b736b1c937799b910beec68eb9",
    surveyPath: ".bazelignore",
    before: new URL("./bazelignore-gvisor/before", import.meta.url),
    after: new URL("./bazelignore-gvisor/after", import.meta.url),
    incomplete: new URL("./bazelignore-gvisor/incomplete", import.meta.url),
    selection: {
      filenames: [".bazelignore"],
      aliases: ["bazelignore"],
    },
    beforeEvidence: { text: "/", className: "punctuation" },
    afterEvidence: { text: "/", className: "punctuation" },
    incompleteEvidence: { text: "/", className: "punctuation" },
  },
  {
    languageId: "python",
    // A Python `def` line is also a Lean definition, and Lean colors the name
    // it declares as Python does. Starlark runs on the Python grammar and
    // query, and colors Python's syntax as Python does.
    highlightingPeers: ["lean", ...C_FAMILY, "starlark"],
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
    // A Python `def` line is also a Lean definition, and Lean colors the name
    // it declares as Python does.
    highlightingPeers: ["lean", ...C_FAMILY, "starlark"],
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
    // A Python `def` line is also a Lean definition, and Lean colors the name
    // it declares as Python does.
    highlightingPeers: ["lean", ...CPP_GRAMMAR, "starlark"],
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
    // A Python `def` line is also a Lean definition, and Lean colors the name
    // it declares as Python does.
    highlightingPeers: ["lean", "starlark"],
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
    // A Python `def` line is also a Lean definition, and Lean colors the name
    // it declares as Python does.
    highlightingPeers: ["lean", "c", "starlark"],
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
    languageId: "go",
    surveyRepository: "gvisor",
    surveyCommit: "47ba6b91051f28ef5ba6a46ad653f044fc513d87",
    surveyPath: "tools/cfc-rootfs/ref.go",
    before: new URL("./go-gvisor/before.go", import.meta.url),
    after: new URL("./go-gvisor/after.go", import.meta.url),
    incomplete: new URL("./go-gvisor/incomplete.go", import.meta.url),
    selection: {
      filenames: [
        "tools/cfc-rootfs/ref.go",
        "internal/agent/recovery_cleaner.go",
        "internal/palette/hotkeys_test.go",
        "cmd/sandbox-runner/main.go",
        "pkg/sentry/kernel/task.go",
      ],
      aliases: ["go", "golang"],
    },
    beforeEvidence: { text: "digestPattern", className: "binding" },
    afterEvidence: { text: "digestPattern", className: "binding" },
    incompleteEvidence: { text: "digestPattern", className: "binding" },
  },
  {
    languageId: "go",
    surveyRepository: "common-cluster",
    surveyCommit: "955034f2604f9852307aae21ce69f51ce31e909d",
    surveyPath: "internal/agent/recovery_cleaner.go",
    before: new URL("./go-common-cluster/before.go", import.meta.url),
    after: new URL("./go-common-cluster/after.go", import.meta.url),
    incomplete: new URL("./go-common-cluster/incomplete.go", import.meta.url),
    beforeEvidence: { text: "agent", className: "interfaceName" },
    afterEvidence: { text: "agent", className: "interfaceName" },
    incompleteEvidence: { text: "agent", className: "interfaceName" },
  },
  {
    languageId: "go",
    surveyRepository: "bay",
    surveyCommit: "c94ac40fcc3fe36ebf2dc20e2ba085565b4d5497",
    surveyPath: "internal/palette/hotkeys.go",
    before: new URL("./go-bay/before.go", import.meta.url),
    after: new URL("./go-bay/after.go", import.meta.url),
    incomplete: new URL("./go-bay/incomplete.go", import.meta.url),
    beforeEvidence: { text: "already", className: "binding" },
    afterEvidence: { text: "already", className: "binding" },
    incompleteEvidence: { text: "already", className: "binding" },
  },
  {
    languageId: "go",
    surveyRepository: "run-orchestrator",
    surveyCommit: "2216c160ee59e4e5680632b7e6a45a2d8b4ad269",
    surveyPath: "cmd/sandbox-runner/main.go",
    before: new URL("./go-run-orchestrator/before.go", import.meta.url),
    after: new URL("./go-run-orchestrator/after.go", import.meta.url),
    incomplete: new URL("./go-run-orchestrator/incomplete.go", import.meta.url),
    beforeEvidence: { text: "logger", className: "binding" },
    afterEvidence: { text: "logger", className: "binding" },
    incompleteEvidence: { text: "logger", className: "binding" },
  },
  {
    languageId: "go",
    surveyRepository: "raia",
    surveyCommit: "e94f785c67cc4630a3f37e46bac4840ed42f720c",
    surveyPath: "harness/tasks_pilot_bay/bay_325_describe_backoff/visible/internal/describe/describe_test.go",
    before: new URL("./go-raia/before.go", import.meta.url),
    after: new URL("./go-raia/after.go", import.meta.url),
    incomplete: new URL("./go-raia/incomplete.go", import.meta.url),
    beforeEvidence: { text: "describe", className: "interfaceName" },
    afterEvidence: { text: "describe", className: "interfaceName" },
    incompleteEvidence: { text: "describe", className: "interfaceName" },
  },
  {
    languageId: "go-mod",
    surveyRepository: "gvisor",
    surveyCommit: "8e713b88a0f3dc68053cc066c11b78e8ade0850a",
    surveyPath: "go.mod",
    before: new URL("./go-mod-gvisor/before.mod", import.meta.url),
    after: new URL("./go-mod-gvisor/after.mod", import.meta.url),
    incomplete: new URL("./go-mod-gvisor/incomplete.mod", import.meta.url),
    selection: {
      filenames: ["go.mod", "tools/cfc-vm/agent/go.mod", "go.work"],
      aliases: ["go-mod", "gomod", "gowork"],
    },
    beforeEvidence: { text: "gvisor.dev/gvisor", className: "interfaceName" },
    afterEvidence: { text: "gvisor.dev/gvisor", className: "interfaceName" },
    incompleteEvidence: { text: "gvisor.dev/gvisor", className: "interfaceName" },
  },
  {
    languageId: "go-sum",
    surveyRepository: "gvisor",
    surveyCommit: "8e713b88a0f3dc68053cc066c11b78e8ade0850a",
    surveyPath: "go.sum",
    before: new URL("./go-sum-gvisor/before.sum", import.meta.url),
    after: new URL("./go-sum-gvisor/after.sum", import.meta.url),
    incomplete: new URL("./go-sum-gvisor/incomplete.sum", import.meta.url),
    selection: {
      filenames: ["go.sum", "gmessages-client/go.sum", "go.work.sum"],
      aliases: ["go-sum", "gosum"],
    },
    beforeEvidence: { text: "/go.mod", className: "keyword" },
    afterEvidence: { text: "/go.mod", className: "keyword" },
    incompleteEvidence: { text: "/go.mod", className: "keyword" },
  },
  {
    languageId: "swift",
    surveyRepository: "fabric-mobile",
    surveyCommit: "94ae27c19a5accba06ccc84172a6e0f7bc16259c",
    surveyPath:
      "plugins/tauri-plugin-loom-location/ios/Sources/LoomLocationPlugin/LoomLocationPlugin.swift",
    before: new URL("./swift-fabric-mobile/before.swift", import.meta.url),
    after: new URL("./swift-fabric-mobile/after.swift", import.meta.url),
    incomplete: new URL(
      "./swift-fabric-mobile/incomplete.swift",
      import.meta.url,
    ),
    selection: {
      filenames: [
        "plugins/tauri-plugin-loom-location/ios/Sources/LoomLocationPlugin/LoomLocationPlugin.swift",
        "plugins/tauri-plugin-loom-location/ios/Package.swift",
        "tools/cfc-sandbox/Package.swift",
        "Package@swift-5.9.swift",
        "icontact/extract-contacts.swift",
        "ios/FabricBeacon/Beacon/Barometer.swift",
      ],
      aliases: ["swift"],
      shebangs: [
        "#!/usr/bin/swift",
        "#!/usr/bin/env swift",
        "#!/usr/bin/xcrun swift",
        "#!/usr/bin/env xcrun swift",
      ],
    },
    beforeEvidence: { text: "startBeacon", className: "functionName" },
    afterEvidence: { text: "startBeacon", className: "functionName" },
    incompleteEvidence: { text: "startBeacon", className: "functionName" },
  },
  {
    languageId: "swift",
    // A Swift `let` declaration of one name is also a Rust one, and Rust
    // colors the name it binds as Swift does.
    highlightingPeers: ["rust", "c"],
    surveyRepository: "gvisor",
    surveyCommit: "bb309e286c61e1a5a5f9893666443a9ea31c4f17",
    surveyPath: "tools/cfc-sandbox/Package.swift",
    before: new URL("./swift-gvisor/before.swift", import.meta.url),
    after: new URL("./swift-gvisor/after.swift", import.meta.url),
    incomplete: new URL("./swift-gvisor/incomplete.swift", import.meta.url),
    beforeEvidence: { text: "package", className: "binding" },
    afterEvidence: { text: "package", className: "binding" },
    incompleteEvidence: { text: "package", className: "binding" },
  },
  {
    languageId: "swift",
    surveyRepository: "loom",
    surveyCommit: "43a4afe18fbfc37ab8a11da8fe5011f0be81f6e7",
    surveyPath: "src/services/loom-daemon/attention/usps_vision.swift",
    before: new URL("./swift-loom/before.swift", import.meta.url),
    after: new URL("./swift-loom/after.swift", import.meta.url),
    incomplete: new URL("./swift-loom/incomplete.swift", import.meta.url),
    beforeEvidence: { text: "guard", className: "controlKeyword" },
    afterEvidence: { text: "guard", className: "controlKeyword" },
    incompleteEvidence: { text: "guard", className: "controlKeyword" },
  },
  {
    languageId: "swift",
    highlightingPeers: ["c"],
    surveyRepository: "loom-scripts",
    surveyCommit: "fb0f2eb1031c548992b4e76bd79f79c30b7c548e",
    surveyPath: "icontact/extract-contacts.swift",
    before: new URL("./swift-loom-scripts/before.swift", import.meta.url),
    after: new URL("./swift-loom-scripts/after.swift", import.meta.url),
    incomplete: new URL(
      "./swift-loom-scripts/incomplete.swift",
      import.meta.url,
    ),
    beforeEvidence: { text: "labelString", className: "functionName" },
    afterEvidence: { text: "labelString", className: "functionName" },
    incompleteEvidence: { text: "labelString", className: "functionName" },
  },
  {
    languageId: "kotlin",
    // Directive configuration colors the word that opens a statement as a
    // keyword, as Kotlin colors the `suspend` modifier that opens a line.
    highlightingPeers: ["directive", ...CPP_GRAMMAR],
    surveyRepository: "commonfabric-weaver",
    surveyCommit: "776e81bca0cbee698d99808973212273b62af8d0",
    surveyPath:
      "android/app/src/main/java/com/commontools/CommonFabricWeaver/IOSPeopleSummaryRepository.kt",
    before: new URL("./kotlin-weaver/before.kt", import.meta.url),
    after: new URL("./kotlin-weaver/after.kt", import.meta.url),
    incomplete: new URL("./kotlin-weaver/incomplete.kt", import.meta.url),
    selection: {
      filenames: [
        "android/app/src/main/java/com/commontools/CommonFabricWeaver/IOSPeopleSummaryRepository.kt",
        "android/app/build.gradle.kts",
        "android/settings.gradle.kts",
        "scripts/release.main.kts",
      ],
      aliases: ["kotlin", "kt"],
      shebangs: ["#!/usr/bin/env kotlin"],
    },
    beforeEvidence: { text: "read", className: "functionName" },
    afterEvidence: { text: "read", className: "functionName" },
    incompleteEvidence: { text: "suspend", className: "keyword" },
  },
  {
    languageId: "kotlin",
    highlightingPeers: C_FAMILY,
    surveyRepository: "commonfabric-weaver",
    surveyCommit: "e88977de1086357c148795a3d8560ff164ba2278",
    surveyPath: "android/app/build.gradle.kts",
    before: new URL(
      "./kotlin-weaver-gradle/before.gradle.kts",
      import.meta.url,
    ),
    after: new URL("./kotlin-weaver-gradle/after.gradle.kts", import.meta.url),
    incomplete: new URL(
      "./kotlin-weaver-gradle/incomplete.gradle.kts",
      import.meta.url,
    ),
    beforeEvidence: { text: "uploadKeystore", className: "binding" },
    afterEvidence: { text: "uploadKeystore", className: "binding" },
    incompleteEvidence: { text: "uploadKeystore", className: "binding" },
  },
  {
    languageId: "rust",
    surveyRepository: "infra",
    surveyCommit: "808299e59e8e07d4a283dc129e73079ec4977ac8",
    surveyPath: "memory-router/src/state.rs",
    before: new URL("./rust-infra/before.rs", import.meta.url),
    after: new URL("./rust-infra/after.rs", import.meta.url),
    incomplete: new URL("./rust-infra/incomplete.rs", import.meta.url),
    selection: {
      filenames: [
        "memory-router/src/state.rs",
        "memory-router/fuzz/fuzz_targets/parsers.rs",
        "memory-router/src/worker/tests.rs",
        "projects/fabrival/src/fabrival-rust/fvi/src/main.rs",
        "images/basic/rust/helloworld.rs",
      ],
      aliases: ["rust", "rs"],
    },
    beforeEvidence: { text: "track_holdings", className: "functionName" },
    afterEvidence: { text: "track_watch_usage", className: "functionName" },
    incompleteEvidence: {
      text: "track_watch_usage",
      className: "functionName",
    },
  },
  {
    languageId: "rust",
    highlightingPeers: C_FAMILY,
    surveyRepository: "danfuzz-land",
    surveyCommit: "1b1dd23ebf2e774ed52dd95cb317c5cc7f4f124f",
    surveyPath:
      "projects/fabrival/src/fabrival-rust/fabrival/src/identifier.rs",
    before: new URL("./rust-danfuzz-land/before.rs", import.meta.url),
    after: new URL("./rust-danfuzz-land/after.rs", import.meta.url),
    incomplete: new URL("./rust-danfuzz-land/incomplete.rs", import.meta.url),
    beforeEvidence: { text: "is_identifier", className: "functionName" },
    afterEvidence: { text: "has_a_limit_of_100", className: "functionName" },
    incompleteEvidence: {
      text: "rejects_non_identifiers",
      className: "functionName",
    },
  },
  {
    languageId: "rust",
    highlightingPeers: C_FAMILY,
    surveyRepository: "gvisor",
    surveyCommit: "a5f0778c3895302c448f4db3b977aeae2b4dfc59",
    surveyPath: "images/basic/rust/helloworld.rs",
    before: new URL("./rust-gvisor/before.rs", import.meta.url),
    after: new URL("./rust-gvisor/after.rs", import.meta.url),
    incomplete: new URL("./rust-gvisor/incomplete.rs", import.meta.url),
    beforeEvidence: { text: "main", className: "functionName" },
    afterEvidence: { text: "main", className: "functionName" },
    incompleteEvidence: { text: "main", className: "functionName" },
  },
  {
    languageId: "toml",
    // An INI section header is a TOML table header, and INI colors its name
    // as TOML colors a table's.
    highlightingPeers: ["ini"],
    surveyRepository: "labs",
    surveyCommit: "fbdd14d3fa220dfffcb52a423d1180e514c5134b",
    surveyPath: "mise.toml",
    before: new URL("./toml-labs/before.toml", import.meta.url),
    after: new URL("./toml-labs/after.toml", import.meta.url),
    incomplete: new URL("./toml-labs/incomplete.toml", import.meta.url),
    selection: {
      filenames: [
        "mise.toml",
        "android/gradle/libs.versions.toml",
        "images/basic/rust/Cargo.toml",
        "Cargo.lock",
        "cfc/lakefile.toml",
        "pyproject.toml",
      ],
      aliases: ["toml"],
    },
    beforeEvidence: { text: "tools", className: "interfaceName" },
    afterEvidence: { text: "tools", className: "interfaceName" },
    incompleteEvidence: { text: "tools", className: "interfaceName" },
  },
  {
    languageId: "hcl",
    surveyRepository: "infra",
    surveyCommit: "3ae071216e1aad454f2465e8d57164d6c38c90e3",
    surveyPath: "tofu/ci-runners/alerts.tf",
    before: new URL("./hcl-infra/before.tf", import.meta.url),
    after: new URL("./hcl-infra/after.tf", import.meta.url),
    incomplete: new URL("./hcl-infra/incomplete.tf", import.meta.url),
    selection: {
      filenames: [
        "tofu/ci-runners/alerts.tf",
        "tofu/ci-runners/prod.tfvars",
        "tofu/iam/.terraform.lock.hcl",
        "tofu/shell/override.tofu",
        "tofu/shell/prod.tfbackend",
        "tests/main.tftest.hcl",
      ],
      aliases: ["hcl", "opentofu", "tofu", "terraform", "tf"],
    },
    beforeEvidence: { text: "reconcile_passes", className: "interfaceName" },
    afterEvidence: { text: "controller_errors", className: "interfaceName" },
    incompleteEvidence: {
      text: "controller_errors",
      className: "interfaceName",
    },
  },
  {
    languageId: "lean",
    surveyRepository: "specs",
    surveyCommit: "57d00d343109b34e279a11efcb8517ff0e25e9c4",
    surveyPath: "cfc/formal/Cfc/LabelTransitions/OutputDispatch.lean",
    before: new URL("./lean-specs/before.lean", import.meta.url),
    after: new URL("./lean-specs/after.lean", import.meta.url),
    incomplete: new URL("./lean-specs/incomplete.lean", import.meta.url),
    selection: {
      filenames: [
        "cfc/formal/Cfc/LabelTransitions/OutputDispatch.lean",
        "cfc/formal/Main.lean",
        "economical-model/theory/lean/DualEconomy.lean",
      ],
      aliases: ["lean", "lean4"],
    },
    beforeEvidence: { text: "inductive", className: "storageKeyword" },
    afterEvidence: { text: "theorem", className: "storageKeyword" },
    incompleteEvidence: { text: "structure", className: "storageKeyword" },
  },
  {
    languageId: "lean-toolchain",
    surveyRepository: "specs",
    surveyCommit: "57d00d343109b34e279a11efcb8517ff0e25e9c4",
    surveyPath: "cfc/formal/lean-toolchain",
    before: new URL("./lean-toolchain-specs/before", import.meta.url),
    after: new URL("./lean-toolchain-specs/after", import.meta.url),
    incomplete: new URL("./lean-toolchain-specs/incomplete", import.meta.url),
    selection: {
      filenames: [
        "cfc/formal/lean-toolchain",
        "economical-model/theory/lean/lean-toolchain",
      ],
      aliases: ["lean-toolchain"],
    },
    beforeEvidence: { text: "leanprover/lean4", className: "typeName" },
    afterEvidence: { text: "leanprover/lean4", className: "typeName" },
    incompleteEvidence: { text: "leanprover/lean4", className: "typeName" },
  },
  {
    languageId: "c",
    // The C++ grammar, which C++, CUDA, and headers use, reads these C
    // declarations as the C grammar does.
    highlightingPeers: CPP_GRAMMAR,
    surveyRepository: "gvisor",
    surveyCommit: "53489c2820a58bc82aa788447660474d493489d0",
    surveyPath: "pkg/sentry/platform/systrap/sysmsg/sighandler_amd64.c",
    before: new URL("./c-gvisor/before.c", import.meta.url),
    after: new URL("./c-gvisor/after.c", import.meta.url),
    incomplete: new URL("./c-gvisor/incomplete.c", import.meta.url),
    selection: {
      filenames: [
        "pkg/sentry/platform/systrap/sysmsg/sighandler_amd64.c",
        "runtime/fuse/verify-structs.c",
      ],
      aliases: ["c"],
    },
    beforeEvidence: { text: "__export_start", className: "functionName" },
    afterEvidence: { text: "__export_sighandler", className: "functionName" },
    incompleteEvidence: {
      text: "__export_sighandler",
      className: "functionName",
    },
  },
  {
    languageId: "c",
    highlightingPeers: CPP_GRAMMAR,
    surveyRepository: "labs",
    surveyCommit: "74705eea154f43c67bb9942e65a59954b726ed1e",
    surveyPath: "packages/fuse/verify-structs.c",
    before: new URL("./c-labs/before.c", import.meta.url),
    after: new URL("./c-labs/after.c", import.meta.url),
    incomplete: new URL("./c-labs/incomplete.c", import.meta.url),
    beforeEvidence: { text: "main", className: "functionName" },
    afterEvidence: { text: "main", className: "functionName" },
    incompleteEvidence: { text: "main", className: "functionName" },
  },
  {
    languageId: "cpp",
    // CUDA and headers use the C++ language's grammar, and Lean colors the
    // name a `class` or `namespace` declares as C++ does.
    highlightingPeers: ["cuda", "c-family-header", "lean"],
    surveyRepository: "gvisor",
    surveyCommit: "cebe1c52b7203cb4de7ab9a61f5cd63805ed3448",
    surveyPath: "test/syscalls/linux/cfc_test.cc",
    before: new URL("./cpp-gvisor/before.cc", import.meta.url),
    after: new URL("./cpp-gvisor/after.cc", import.meta.url),
    incomplete: new URL("./cpp-gvisor/incomplete.cc", import.meta.url),
    selection: {
      filenames: [
        "test/syscalls/linux/cfc_test.cc",
        "src/main.cpp",
        "src/main.cxx",
        "src/main.c++",
        "include/util.hh",
        "include/util.hpp",
        "include/util.hxx",
        "include/util.h++",
        "include/util.tcc",
      ],
      aliases: ["cpp", "c++", "cxx"],
    },
    beforeEvidence: { text: "CFCTest", className: "interfaceName" },
    afterEvidence: { text: "CFCTest", className: "interfaceName" },
    incompleteEvidence: { text: "CFCTest", className: "interfaceName" },
  },
  {
    languageId: "cuda",
    // Directive configuration colors the word that opens a line as a keyword,
    // as CUDA colors its qualifiers.
    highlightingPeers: ["cpp", "c-family-header", "directive"],
    surveyRepository: "gvisor",
    surveyCommit: "7c2bcddc13c1729e345cfd9a75b910822e4ddcd1",
    surveyPath: "images/gpu/cuda-tests/cuda_malloc.cu",
    before: new URL("./cuda-gvisor/before.cu", import.meta.url),
    after: new URL("./cuda-gvisor/after.cu", import.meta.url),
    incomplete: new URL("./cuda-gvisor/incomplete.cu", import.meta.url),
    selection: {
      filenames: [
        "images/gpu/cuda-tests/cuda_malloc.cu",
        "images/gpu/cuda-tests/cuda_test_util.cuh",
      ],
      aliases: ["cuda"],
    },
    beforeEvidence: { text: "__global__", className: "keyword" },
    afterEvidence: { text: "__global__", className: "keyword" },
    incompleteEvidence: { text: "__global__", className: "keyword" },
  },
  {
    languageId: "c-family-header",
    highlightingPeers: ["c", "cpp", "cuda", "lean"],
    surveyRepository: "gvisor",
    surveyCommit: "2c1c4a5516248ba575cc17a4fbe569e540469160",
    surveyPath: "test/util/fs_util.h",
    before: new URL("./c-family-header-gvisor/before.h", import.meta.url),
    after: new URL("./c-family-header-gvisor/after.h", import.meta.url),
    incomplete: new URL(
      "./c-family-header-gvisor/incomplete.h",
      import.meta.url,
    ),
    selection: {
      filenames: ["test/util/fs_util.h"],
      aliases: ["c-family-header", "h"],
    },
    beforeEvidence: { text: "gvisor", className: "interfaceName" },
    afterEvidence: { text: "RENAME_EXCHANGE", className: "binding" },
    incompleteEvidence: { text: "gvisor", className: "interfaceName" },
  },
  {
    languageId: "starlark",
    // GNU make's `load` directive starts a line as Starlark's `load` statement
    // does, and make colors it as a keyword too. Directive configuration colors
    // the word that opens a line as a keyword.
    highlightingPeers: ["make", "directive"],
    surveyRepository: "gvisor",
    surveyCommit: "e5b1277ac5f1e431780b2aacb2c4ac0d335c27d3",
    surveyPath: "runsc/container/BUILD",
    before: new URL("./starlark-gvisor/before.BUILD", import.meta.url),
    after: new URL("./starlark-gvisor/after.BUILD", import.meta.url),
    incomplete: new URL("./starlark-gvisor/incomplete.BUILD", import.meta.url),
    selection: {
      filenames: [
        "runsc/container/BUILD",
        "tools/defs.bzl",
        "MODULE.bazel",
        "external/tools/plugin-stack/plugin-stack.BUILD",
        "pkg/BUILD.bazel",
        "REPO.bazel",
        "WORKSPACE",
        "WORKSPACE.bazel",
        "WORKSPACE.bzlmod",
        ".drone.star",
      ],
      aliases: ["starlark", "bazel", "bzl", "star"],
    },
    beforeEvidence: { text: "load", className: "keyword" },
    afterEvidence: { text: "load", className: "keyword" },
    incompleteEvidence: { text: "load", className: "keyword" },
  },
  {
    languageId: "bazelrc",
    surveyRepository: "gvisor",
    surveyCommit: "eae8b050925fb1ce0b3cfc324daa166ae6b72000",
    surveyPath: ".bazelrc",
    before: new URL("./bazelrc-gvisor/before.bazelrc", import.meta.url),
    after: new URL("./bazelrc-gvisor/after.bazelrc", import.meta.url),
    incomplete: new URL("./bazelrc-gvisor/incomplete.bazelrc", import.meta.url),
    selection: {
      filenames: [".bazelrc", "tools/user.bazelrc"],
      aliases: ["bazelrc"],
    },
    beforeEvidence: { text: "race", className: "interfaceName" },
    afterEvidence: { text: "race", className: "interfaceName" },
    incompleteEvidence: { text: "race", className: "interfaceName" },
  },
  {
    languageId: "shell",
    // `local` is also a Lean declaration modifier, which Lean colors as shell
    // colors the declaration.
    highlightingPeers: ["lean"],
    surveyRepository: "infra",
    surveyCommit: "e86055db01424713770930acc24b5a20d2e96448",
    surveyPath: "k8s/scripts/force-sync-externalsecrets.sh",
    before: new URL("./shell-infra/before.sh", import.meta.url),
    after: new URL("./shell-infra/after.sh", import.meta.url),
    incomplete: new URL("./shell-infra/incomplete.sh", import.meta.url),
    selection: {
      filenames: [
        "k8s/scripts/force-sync-externalsecrets.sh",
        "scripts/completion.bash",
        "install.command",
        ".bashrc",
        ".profile",
        // Git hooks and extensionless programs select shell through the
        // fixture's `bash` shebang.
        ".githooks/pre-commit",
        ".ops/hooks/post-merge",
        "android/gradlew",
        "images/arm-qemu/initramfs/init",
      ],
      aliases: ["shell", "sh", "bash"],
      shebangs: [
        "#!/bin/sh",
        "#!/bin/bash",
        "#!/usr/bin/env bash",
        "#!/usr/bin/env sh",
        "#!/bin/dash",
      ],
    },
    beforeEvidence: { text: "force_sync_and_wait", className: "functionName" },
    afterEvidence: { text: "read_status_snapshot", className: "functionName" },
    incompleteEvidence: { text: "local", className: "storageKeyword" },
  },
  {
    languageId: "shell",
    highlightingPeers: C_FAMILY,
    surveyRepository: "loom",
    surveyCommit: "12d633c0e865491b4d006c883f4201eab1edcaec",
    surveyPath: "src/bin/check-deno-setup-gate.sh",
    before: new URL("./shell-loom/before.sh", import.meta.url),
    after: new URL("./shell-loom/after.sh", import.meta.url),
    incomplete: new URL("./shell-loom/incomplete.sh", import.meta.url),
    beforeEvidence: {
      text: "setup_version_from_file",
      className: "functionName",
    },
    afterEvidence: {
      text: "setup_version_from_file",
      className: "functionName",
    },
    incompleteEvidence: { text: "fi", className: "controlKeyword" },
  },
  {
    languageId: "make",
    surveyRepository: "infra",
    surveyCommit: "574f4a94cebb04cd12134146a25f0d7ba804da67",
    surveyPath: "tofu/postmark/Makefile",
    before: new URL("./make-infra/before.mk", import.meta.url),
    after: new URL("./make-infra/after.mk", import.meta.url),
    incomplete: new URL("./make-infra/incomplete.mk", import.meta.url),
    selection: {
      filenames: [
        "tofu/postmark/Makefile",
        "website/assets/logos/makefile",
        "GNUmakefile",
        "tools/bazel.mk",
      ],
      aliases: ["make", "makefile", "mk"],
      shebangs: ["#!/usr/bin/make -f", "#!/usr/bin/env make"],
    },
    beforeEvidence: { text: "servers", className: "functionName" },
    afterEvidence: { text: "verify-domains", className: "functionName" },
    incompleteEvidence: { text: "if", className: "callName" },
  },
  {
    languageId: "properties",
    // A shell or make variable assignment, an HCL or DOT attribute, an INI
    // key, and a dotenv variable are each a `name=value` line, and shell,
    // make, HCL, DOT, INI, and dotenv color the name as properties files
    // color their keys.
    highlightingPeers: ["hcl", "shell", "make", "ini", "dot", "dotenv"],
    surveyRepository: "commonfabric-weaver",
    surveyCommit: "b457431c6f5e32305a2e6feb7901f8d05a9b2f6e",
    surveyPath: "android/gradle/wrapper/gradle-wrapper.properties",
    before: new URL("./properties-weaver/before.properties", import.meta.url),
    after: new URL("./properties-weaver/after.properties", import.meta.url),
    incomplete: new URL(
      "./properties-weaver/incomplete.properties",
      import.meta.url,
    ),
    selection: {
      filenames: [
        "android/gradle/wrapper/gradle-wrapper.properties",
        "android/gradle.properties",
        "local.properties",
      ],
      aliases: ["properties", "java-properties"],
    },
    beforeEvidence: { text: "distributionUrl", className: "propertyName" },
    afterEvidence: { text: "distributionUrl", className: "propertyName" },
    incompleteEvidence: { text: "distributionUrl", className: "propertyName" },
  },
  {
    languageId: "ini",
    // An INI `name=value` line is a valid make assignment and a valid DOT
    // attribute, and make and DOT color the name as INI colors its keys. An
    // Ansible inventory host line is also a Git attributes line, whose
    // attributes color as the host's variables. Rust reads the host line as an
    // expression ending in a field access, and colors the field, which is the
    // host's variable, as INI colors it.
    highlightingPeers: ["make", "dot", "gitattributes", "rust"],
    surveyRepository: "infra",
    surveyCommit: "cfe4ac630b0b1e223d57bed12ae02fa6c53b9eb2",
    surveyPath: "ansible/rapids-inventory.ini",
    before: new URL("./ini-infra/before.ini", import.meta.url),
    after: new URL("./ini-infra/after.ini", import.meta.url),
    incomplete: new URL("./ini-infra/incomplete.ini", import.meta.url),
    selection: {
      filenames: [
        "ansible/rapids-inventory.ini",
        "ansible/ansible.cfg",
        "pytest.ini",
        ".codespellrc",
      ],
      aliases: ["ini", "dosini", "cfg"],
    },
    beforeEvidence: { text: "ansible_user", className: "propertyName" },
    afterEvidence: { text: "ansible_user", className: "propertyName" },
    incompleteEvidence: { text: "ansible_user", className: "propertyName" },
  },
  {
    languageId: "dot",
    surveyRepository: "gvisor",
    surveyCommit: "bb309e286c61e1a5a5f9893666443a9ea31c4f17",
    surveyPath: "pkg/sentry/kernel/g3doc/run_states.dot",
    before: new URL("./dot-gvisor/before.dot", import.meta.url),
    after: new URL("./dot-gvisor/after.dot", import.meta.url),
    incomplete: new URL("./dot-gvisor/incomplete.dot", import.meta.url),
    selection: {
      filenames: ["pkg/sentry/kernel/g3doc/run_states.dot", "space.gv"],
      aliases: ["dot", "graphviz", "gv"],
    },
    beforeEvidence: { text: "subgraph", className: "storageKeyword" },
    afterEvidence: { text: "subgraph", className: "storageKeyword" },
    incompleteEvidence: { text: "subgraph", className: "storageKeyword" },
  },
  {
    languageId: "dotenv",
    // A dotenv line is a `name=value` line, and properties files, INI, shell,
    // make, and HCL color the name as dotenv colors a variable's.
    highlightingPeers: ["properties", "ini", "shell", "make", "hcl"],
    surveyRepository: "labs",
    surveyCommit: "60cd866374f5b59bdf16c8469ad3f71cd35ac040",
    surveyPath: "runtime/toolshed/.env.example",
    before: new URL("./dotenv-labs/before.env", import.meta.url),
    after: new URL("./dotenv-labs/after.env", import.meta.url),
    incomplete: new URL("./dotenv-labs/incomplete.env", import.meta.url),
    selection: {
      filenames: [
        "runtime/toolshed/.env.example",
        "runtime/toolshed/.env.test",
        ".env",
        ".env.development.local",
        "airtable/config.env.example",
        "memory-router/deploy/toolshed-env.example",
      ],
      aliases: ["dotenv"],
      unclaimedFilenames: [
        "ansible/roles/ci-mac/files/brew.env",
        "k8s/components/kyverno/release.env",
      ],
    },
    beforeEvidence: { text: "LOG_LEVEL", className: "propertyName" },
    afterEvidence: { text: "LOG_LEVEL", className: "propertyName" },
    incompleteEvidence: { text: "LOG_LEVEL", className: "propertyName" },
  },
  {
    languageId: "dotenv",
    // Shell colors the operator of a `${NAME:-default}` expansion as dotenv
    // does.
    highlightingPeers: ["shell"],
    surveyRepository: "commonfabric-weaver",
    surveyCommit: "c62f7166d063baab093da0874f745b490c02c643",
    surveyPath: "apple/scripts/asc-account.env",
    before: new URL("./dotenv-weaver/before.env", import.meta.url),
    after: new URL("./dotenv-weaver/after.env", import.meta.url),
    incomplete: new URL("./dotenv-weaver/incomplete.env", import.meta.url),
    beforeEvidence: { text: ":-", className: "operator" },
    afterEvidence: { text: ":-", className: "operator" },
    incompleteEvidence: { text: ":-", className: "operator" },
  },
  {
    languageId: "proguard",
    // A ProGuard option line is a directive statement, and directive
    // configuration colors the option that opens it as ProGuard does.
    highlightingPeers: ["directive"],
    surveyRepository: "commonfabric-weaver",
    surveyCommit: "df01b1c67c027f3b3de39a5bd85e2f84312d6495",
    surveyPath: "android/app/proguard-rules.pro",
    before: new URL("./proguard-weaver/before.pro", import.meta.url),
    after: new URL("./proguard-weaver/after.pro", import.meta.url),
    incomplete: new URL("./proguard-weaver/incomplete.pro", import.meta.url),
    selection: {
      filenames: [
        "android/app/proguard-rules.pro",
        "library/consumer-rules.pro",
        "rules/keep-jni.pro",
      ],
      aliases: ["proguard", "r8"],
    },
    beforeEvidence: { text: "-keep", className: "keyword" },
    afterEvidence: { text: "-keep", className: "keyword" },
    incompleteEvidence: { text: "-keep", className: "keyword" },
  },
  {
    languageId: "gitattributes",
    // Ignore files write the same wildcards in their patterns, and color
    // them the same way.
    highlightingPeers: ["gitignore", "dockerignore"],
    surveyRepository: "labs",
    surveyCommit: "f94ac6bb1b1206bebe19228f4305edb7201fd97e",
    surveyPath: ".gitattributes",
    before: new URL("./gitattributes-labs/before.gitattributes", import.meta.url),
    after: new URL("./gitattributes-labs/after.gitattributes", import.meta.url),
    incomplete: new URL(
      "./gitattributes-labs/incomplete.gitattributes",
      import.meta.url,
    ),
    selection: {
      filenames: [".gitattributes", "src/.gitattributes"],
      aliases: ["gitattributes"],
    },
    beforeEvidence: { text: "**", className: "regex" },
    afterEvidence: { text: "**", className: "regex" },
    incompleteEvidence: { text: "**", className: "regex" },
  },
  {
    languageId: "gitattributes",
    // Ignore files write the same wildcards in their patterns, and color
    // them the same way.
    highlightingPeers: ["gitignore", "dockerignore"],
    surveyRepository: "commonfabric-weaver",
    surveyCommit: "470efd7ecc4a90702d60c761eb5780c04f6546cd",
    surveyPath: ".gitattributes",
    before: new URL(
      "./gitattributes-weaver/before.gitattributes",
      import.meta.url,
    ),
    after: new URL("./gitattributes-weaver/after.gitattributes", import.meta.url),
    incomplete: new URL(
      "./gitattributes-weaver/incomplete.gitattributes",
      import.meta.url,
    ),
    beforeEvidence: { text: "**", className: "regex" },
    afterEvidence: { text: "**", className: "regex" },
    incompleteEvidence: { text: "**", className: "regex" },
  },
  {
    languageId: "gitattributes",
    // A pattern followed by one `name=value` attribute is also an Ansible
    // inventory host line, whose variable INI colors as Git attributes color
    // the attribute. A `name=value` attribute is also a DOT attribute, whose
    // value DOT colors as Git attributes color the attribute's value.
    highlightingPeers: ["ini", "dot"],
    surveyRepository: "loom",
    surveyCommit: "f788015adc43cc8d7b3b3bb7f50f2066428a6dbc",
    surveyPath: "src/.gitattributes",
    before: new URL("./gitattributes-loom/before.gitattributes", import.meta.url),
    after: new URL("./gitattributes-loom/after.gitattributes", import.meta.url),
    incomplete: new URL(
      "./gitattributes-loom/incomplete.gitattributes",
      import.meta.url,
    ),
    beforeEvidence: { text: "ours", className: "string" },
    afterEvidence: { text: "ours", className: "string" },
    incompleteEvidence: { text: "ours", className: "string" },
  },
  {
    languageId: "gitattributes",
    // Ignore files write the same wildcards in their patterns, and color
    // them the same way.
    highlightingPeers: ["gitignore", "dockerignore"],
    surveyRepository: "infra",
    surveyCommit: "cc5cd853a3c76ae8de1104525d4b2a64c0653aca",
    surveyPath: ".gitattributes",
    before: new URL(
      "./gitattributes-infra/before.gitattributes",
      import.meta.url,
    ),
    after: new URL("./gitattributes-infra/after.gitattributes", import.meta.url),
    incomplete: new URL(
      "./gitattributes-infra/incomplete.gitattributes",
      import.meta.url,
    ),
    beforeEvidence: { text: "*", className: "regex" },
    afterEvidence: { text: "*", className: "regex" },
    incompleteEvidence: { text: "*", className: "regex" },
  },
  {
    languageId: "xml",
    // An attribute alone on its line is a dotenv `name=value` line, and dotenv
    // colors the name as XML colors an attribute's.
    highlightingPeers: ["dotenv"],
    surveyRepository: "commonfabric-weaver",
    surveyCommit: "6cc0468bdafdf8dc44cd86faba60ff5912ead945",
    surveyPath: "android/app/src/main/AndroidManifest.xml",
    before: new URL("./xml-weaver/before.xml", import.meta.url),
    after: new URL("./xml-weaver/after.xml", import.meta.url),
    incomplete: new URL("./xml-weaver/incomplete.xml", import.meta.url),
    selection: {
      filenames: [
        "android/app/src/main/AndroidManifest.xml",
        "android/app/src/main/res/values/styles.xml",
        "android/app/src/main/res/drawable/fabric_logo.xml",
        "apple/FabricWeaver/FabricWeaver.entitlements",
        "apple/FabricWeaver/PrivacyInfo.xcprivacy",
        "apple/FabricWeaver/Info.plist",
        "docs/images/logo.svg",
        "FabricWeaver.xcworkspace/contents.xcworkspacedata",
      ],
      aliases: ["xml", "svg", "plist"],
      unclaimedFilenames: [
        "apple/FabricWeaver/Base.lproj/Main.storyboard",
        "apple/FabricWeaver/MainMenu.xib",
      ],
    },
    beforeEvidence: {
      text: "android:allowBackup",
      className: "propertyName",
    },
    afterEvidence: { text: "android:allowBackup", className: "propertyName" },
    incompleteEvidence: {
      text: "android:allowBackup",
      className: "propertyName",
    },
  },
  {
    languageId: "org",
    surveyRepository: "gvisor",
    surveyCommit: "bb309e286c61e1a5a5f9893666443a9ea31c4f17",
    surveyPath: "scenarios.org",
    before: new URL("./org-gvisor/before.org", import.meta.url),
    after: new URL("./org-gvisor/after.org", import.meta.url),
    incomplete: new URL("./org-gvisor/incomplete.org", import.meta.url),
    selection: {
      filenames: ["scenarios.org", "cfc-gvisor.org", "notes/PLAN.ORG"],
      aliases: ["org", "orgmode"],
    },
    beforeEvidence: { text: "Scenarios", className: "sectionHeader" },
    afterEvidence: { text: "TODO", className: "keyword" },
    incompleteEvidence: { text: "#+begin_src", className: "keyword" },
  },
  {
    languageId: "directive",
    surveyRepository: "infra",
    surveyCommit: "d17b6041f60c91fe83c66e914cd62c5e9084a517",
    surveyPath: "ansible/roles/netdata/files/health.d/web_log.conf",
    before: new URL("./directive-infra/before.conf", import.meta.url),
    after: new URL("./directive-infra/after.conf", import.meta.url),
    incomplete: new URL("./directive-infra/incomplete.conf", import.meta.url),
    selection: {
      filenames: [
        "images/benchmarks/nginx/nginx.conf",
        "images/benchmarks/nginx/nginx_gofer.conf",
        "images/benchmarks/httpd/apache2-tmpdir.conf",
        "httpd.conf",
        "public/.htaccess",
        "files/cve-2026-98432.nft",
        "/etc/nftables.conf",
      ],
      aliases: [
        "directive",
        "nginx",
        "apache",
        "apacheconf",
        "nftables",
        "nft",
        "netdata",
        "sysusers",
      ],
      shebangs: ["#!/usr/sbin/nft -f"],
      unclaimedFilenames: ["netdata/health.d/web_log.conf"],
    },
    beforeEvidence: { text: "template", className: "keyword" },
    afterEvidence: { text: "template", className: "keyword" },
    incompleteEvidence: { text: "crit", className: "keyword" },
  },
  {
    languageId: "directive",
    surveyRepository: "gvisor",
    surveyCommit: "82e8d12aed0ff0b736b1c937799b910beec68eb9",
    surveyPath: "images/benchmarks/nginx/nginx.conf",
    before: new URL("./directive-gvisor/before.conf", import.meta.url),
    after: new URL("./directive-gvisor/after.conf", import.meta.url),
    incomplete: new URL("./directive-gvisor/incomplete.conf", import.meta.url),
    beforeEvidence: { text: "daemon", className: "keyword" },
    afterEvidence: { text: "sendfile", className: "keyword" },
    incompleteEvidence: { text: "root", className: "keyword" },
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
        "AUTHORS",
        "docs/CNAME",
        "harness/results/b1-bay.log",
        "integration-default/workload.stdout",
        "profile/baseline-off.stderr",
        "probes/existing-grant-tests.out",
        "k8s/components/flux/upstream/SHA256SUMS",
        "src/GO_SHA256SUMS",
        "coverage-inputs.sha256",
        "lib/VERSION",
        "src/DENO_VERSION",
        "src/updater/protocol-version",
        ".python-version",
        "docs/history/tutorials/.nvmrc",
        "round5/raw/safaridriver.pid",
        "round5/raw/server.pids",
        ".beads/dolt-server.port",
        "tls/server.crt",
        "tls/server.key",
        "certs/localhost.pem",
        "ansible/secrets/.gitkeep",
        "docs/.nojekyll",
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
  {
    languageId: "dockerfile",
    surveyRepository: "common-cluster",
    surveyCommit: "5abd12028c06b63ff953fa09ed56918461ac209a",
    surveyPath: "Dockerfile",
    before: new URL("./dockerfile-common-cluster/before.dockerfile", import.meta.url),
    after: new URL("./dockerfile-common-cluster/after.dockerfile", import.meta.url),
    incomplete: new URL(
      "./dockerfile-common-cluster/incomplete.dockerfile",
      import.meta.url,
    ),
    selection: {
      filenames: [
        "Dockerfile",
        "Dockerfile.k8s-sandbox-service",
        "memory-router/Dockerfile.build",
        "images/arm-qemu/Dockerfile.x86_64",
        "images/benchmarks/build-grpc/Dockerfile.aarch64",
        "dockerfile",
        "Containerfile",
        "Containerfile.dev",
        "images/build.dockerfile",
        "images/build.Containerfile",
      ],
      aliases: ["dockerfile", "docker", "containerfile"],
    },
    beforeEvidence: { text: "builder", className: "functionName" },
    afterEvidence: { text: "builder", className: "functionName" },
    incompleteEvidence: { text: "--from", className: "parameter" },
  },
  {
    languageId: "dockerfile",
    // An instruction line is a directive statement, a word and its arguments,
    // and the directive configuration language colors its first word as a
    // keyword, as this fixture's evidence is.
    highlightingPeers: ["directive"],
    surveyRepository: "infra",
    surveyCommit: "5b65688a0431cda75329734aa7784ba6fb3f76bb",
    surveyPath: "fly/pds/Dockerfile",
    before: new URL("./dockerfile-infra/before.dockerfile", import.meta.url),
    after: new URL("./dockerfile-infra/after.dockerfile", import.meta.url),
    incomplete: new URL("./dockerfile-infra/incomplete.dockerfile", import.meta.url),
    beforeEvidence: { text: "build", className: "functionName" },
    afterEvidence: { text: "build", className: "functionName" },
    incompleteEvidence: { text: "EXPOSE", className: "keyword" },
  },
  {
    languageId: "dockerfile",
    // An instruction line is a directive statement, a word and its arguments,
    // and the directive configuration language colors its first word as a
    // keyword, as this fixture's evidence is.
    highlightingPeers: ["directive"],
    surveyRepository: "gvisor",
    surveyCommit: "90dc8548a354d618d05c968111931ba2c4764dd6",
    surveyPath: "images/default/Dockerfile",
    before: new URL("./dockerfile-gvisor/before.dockerfile", import.meta.url),
    after: new URL("./dockerfile-gvisor/after.dockerfile", import.meta.url),
    incomplete: new URL("./dockerfile-gvisor/incomplete.dockerfile", import.meta.url),
    beforeEvidence: { text: "ENTRYPOINT", className: "keyword" },
    afterEvidence: { text: "gcloud", className: "functionName" },
    incompleteEvidence: { text: "WORKDIR", className: "keyword" },
  },
];
