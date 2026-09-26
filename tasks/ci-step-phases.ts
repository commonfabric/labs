// Which phase of a job a CI step belongs to, read from the marker emoji its
// name starts with. scripts/ci-gantt.ts splits each job bar by phase with this,
// and tasks/ci-workflow.test.ts uses it to find the work steps a bound is
// required on. The vocabulary lives in docs/development/CI_PERFORMANCE.md
// ("Step phase markers") and is mirrored in PHASE_MARKERS below.

export type Phase = "setup" | "work" | "shutdown" | "other";

// Marker emoji -> phase. Each emoji maps to exactly one phase; when a step's
// natural emoji would land it in the wrong phase, the step name is changed to a
// marker that fits (see docs/development/CI_PERFORMANCE.md). Matching ignores a
// trailing variation selector, so the base emoji covers both the plain and the
// selector-suffixed form of a glyph.
export const PHASE_MARKERS: [string, Phase][] = [
  // setup: fetch code, install tools and dependencies, restore caches,
  // authenticate, and bring test servers and devices up before the real work.
  ["📥", "setup"], // checkout / download inputs
  ["🦕", "setup"], // set up Deno
  ["🔍", "setup"], // verify lock file & install, resolve refs
  ["📦", "setup"], // install packages, cache dependencies
  ["♻️", "setup"], // restore/save build caches
  ["🛡️", "setup"], // relax sandbox for browser tests
  ["🔧", "setup"], // enable devices
  ["⚙️", "setup"], // set up external SDKs
  ["🔑", "setup"], // authenticate to a cloud
  ["🔌", "setup"], // start a local server for tests
  ["⏳", "setup"], // wait for a service to be ready
  ["💾", "setup"], // restore/save caches
  ["🗃️", "setup"], // restore a cached native library
  ["🧮", "setup"], // compute a cache identity
  // work: the job's actual purpose.
  ["🔎", "work"], // checks (format, type, patterns, attestations)
  ["🚧", "work"], // guard that fails the build on a banned pattern
  ["🩹", "work"], // check for unresolved merge-conflict markers
  ["✅", "work"], // validate an artifact a previous step produced
  ["🗺️", "work"], // plan a run's lanes, or what one lane runs
  ["🧪", "work"], // run tests
  ["🧩", "work"], // run integration tests
  ["🔁", "work"], // replay captured fixtures under today's source
  ["🧹", "work"], // lint
  ["🧭", "work"], // check skill facts
  ["📄", "work"], // type-check docs
  ["🏗️", "work"], // build binaries/assets
  ["🏋️", "work"], // run benchmarks
  ["📊", "work"], // produce performance metrics / status reports
  ["🧬", "work"], // combine coverage
  ["📝", "work"], // generate attestations
  ["🔐", "work"], // sign binaries
  ["🚀", "work"], // deploy
  ["💬", "work"], // post a PR comment
  // shutdown: post-work reports, artifact uploads, log capture, teardown.
  ["🧾", "shutdown"], // write coverage report
  ["📤", "shutdown"], // upload artifacts
  ["📋", "shutdown"], // capture logs on failure
];

const stripVS = (s: string) => s.replace(/\uFE0F/g, "");

export function phaseOf(stepName: string): Phase {
  const name = stepName.trim();
  // A leading marker wins, so a step named "💬 Post …" is classified by its
  // marker rather than the "Post " rule below.
  const norm = stripVS(name);
  for (const [emoji, phase] of PHASE_MARKERS) {
    if (norm.startsWith(stripVS(emoji))) return phase;
  }
  // Injected steps carry no marker; their wording is not ours to set. Current
  // jobs use the "job" pair and the "Post …" steps. Retained records can also
  // contain the "runner" pair.
  if (name.startsWith("Post ")) return "shutdown";
  if (name === "Set up job" || name === "Set up runner") return "setup";
  if (name === "Complete job" || name === "Complete runner") return "shutdown";
  return "other";
}
