// Tallies the JSON lines `summary-reporter.mjs` writes:
//
//   node nodejs/tools/tally.mjs <file.jsonl>...
//
// Prints test counts by status, file counts by status, and the most common
// failure messages (with the number of files each appears in). A file that
// failed without reporting any test (one that did not load, as a rule) is
// tallied under the first error line on its stderr.

import * as fs from "node:fs";

const tests = { pass: 0, fail: 0, skip: 0, cancelled: 0 };
const files = new Map();
const testedFiles = new Set();
const stderrError = new Map();
const causes = new Map();

function addCause(message, file) {
  const entry = causes.get(message) ?? { count: 0, files: new Set() };
  entry.count++;
  entry.files.add(file);
  causes.set(message, entry);
}

for (const path of process.argv.slice(2)) {
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    const r = JSON.parse(line);
    if (r.kind === "stderr") {
      const m = /^\s*(\w*Error\b.*|Uncaught.*)$/.exec(r.text.trimEnd());
      const key = r.file.replace(/^.*?\/test\//, "test/");
      if (m && !stderrError.has(key)) stderrError.set(key, m[1].slice(0, 300));
      continue;
    }
    if (r.kind === "file") {
      files.set(r.file, r.status);
      continue;
    }
    if (r.kind === "test") {
      tests[r.status]++;
      testedFiles.add(r.file);
      if (r.status === "fail") addCause(r.error ?? "(no error)", r.file);
    }
  }
}

const fileCounts = { pass: 0, fail: 0 };
for (const [file, status] of files) {
  fileCounts[status] = (fileCounts[status] ?? 0) + 1;
  if (status === "fail" && !testedFiles.has(file)) {
    const key = file.replace(/^.*?\/test\//, "test/");
    addCause(`[load] ${stderrError.get(key) ?? "(no stderr error)"}`, file);
  }
}

console.log("tests:", JSON.stringify(tests));
console.log("files reported at top level:", JSON.stringify(fileCounts));
console.log("top failure causes (tests, files, message):");
const sorted = [...causes].sort((a, b) => b[1].files.size - a[1].files.size);
for (const [message, { count, files: fs }] of sorted.slice(0, 50)) {
  console.log(
    `${String(count).padStart(5)} ${String(fs.size).padStart(4)}  ${message}`,
  );
}
