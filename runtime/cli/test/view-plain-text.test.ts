/**
 * Plain-text handling for files whose syntax `cf view` does not recognize and
 * filename-free input that is not transformed compiler output. Direct
 * documents, diffs, and live diff edits must preserve the complete input
 * without TypeScript coloring or structure.
 */

import { assertEquals } from "@std/assert";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import { parseDiff } from "../lib/view/diff.ts";
import { createDiffHighlighter } from "../lib/view/diffedit.ts";
import {
  languageForFile,
  languageForSource,
  metadataMatchesSharedExtension,
} from "../lib/view/languages/language.ts";
import { plainTextLanguage } from "../lib/view/languages/plain-text/language.ts";
import { buildView } from "../lib/view/mod.ts";
import type { Line } from "../lib/view/model.ts";

const NO_WS: DiffWorkspace = { resolve: () => null, read: () => null };

function verbatim(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

Deno.test("plain text: unknown and unnamed files select plain text", () => {
  assertEquals(languageForFile("LICENSE").id, "plain-text");
  assertEquals(languageForFile("checksums.sha256").id, "plain-text");
  assertEquals(languageForFile(undefined).id, "plain-text");
});

Deno.test("plain text: prose, logs, checksums, versions, and records are claimed by name", () => {
  for (
    const name of [
      "AUTHORS",
      "CONTRIBUTORS",
      "COPYING",
      "docs/CNAME",
      "harness/results/b1-bay.log",
      "integration-default/workload.stdout",
      "profile/baseline-on.stderr",
      "probes/existing-grant-tests.out",
      "k8s/components/flux/upstream/SHA256SUMS",
      "src/GO_SHA256SUMS",
      "MD5SUMS",
      "coverage-inputs.sha256",
      "release.sha512",
      "lib/VERSION",
      "src/PYTHON_VERSION",
      ".ops/SETUP_VERSION",
      "src/updater/protocol-version",
      ".python-version",
      ".node-version",
      ".nvmrc",
      "raw/safaridriver.pid",
      "bracket/server.pids",
      ".beads/dolt-server.port",
      "tls/p256.crt",
      "tls/p256.key",
      "certs/localhost.pem",
      "apple/scripts/github-known-hosts",
      ".ssh/known_hosts",
      "/etc/ssh/ssh_known_hosts",
      "ansible/secrets/.gitkeep",
      "docs/.nojekyll",
    ]
  ) {
    assertEquals(languageForFile(name).id, "plain-text");
    // A claimed name stays plain whatever evidence its content holds.
    assertEquals(
      languageForSource(name, '#!/bin/sh\n<?xml version="1.0"?>').id,
      "plain-text",
    );
  }
  // The name of a log whose source opens with a JSON object leaves it to
  // content evidence, which a language for structured logs can claim.
  for (const name of ["review/seed.log", "profile/baseline-on.stderr"]) {
    assertEquals(languageForFile(name).id, "plain-text");
    assertEquals(
      metadataMatchesSharedExtension(
        plainTextLanguage.metadata,
        name,
        '  {"level":"info"}',
      ),
      false,
    );
    assertEquals(
      metadataMatchesSharedExtension(plainTextLanguage.metadata, name, "ok"),
      true,
    );
  }
  // A word that only ends in `version` names no version record.
  for (
    const name of [
      "conversion",
      "versions",
      "version",
      "scripts/bump-version",
      "scripts/update-known-hosts",
      "bin/check_version",
    ]
  ) {
    assertEquals(languageForSource(name, "#!/bin/sh\necho").id, "shell");
  }
});

Deno.test("plain text: direct documents preserve source without structure", () => {
  const text = 'const rights = "reserved";\r\n\nunfinished ${value 🎉\n';
  const language = languageForFile("LICENSE");
  const lines = language.highlightLines(text, "LICENSE");
  assertEquals(verbatim(lines), text);
  assertEquals(
    lines.flatMap((line) => line.spans.map((span) => span.cls)),
    ["plain", "plain"],
  );

  const view = buildView(text, "LICENSE");
  const doc = view.doc;
  assertEquals(doc.text, text);
  assertEquals(doc.lines, lines);
  assertEquals(doc.structure, []);
  assertEquals(doc.flatStructure, []);
  assertEquals([...doc.definitions], []);
  assertEquals(view.semantics(), undefined);
  assertEquals(view.editSource.editable, true);
  assertEquals(view.editSource.parse(text), doc);
});

Deno.test("plain text: a filename takes priority over a transformed-looking header", () => {
  const text = "// transformed: /fake.ts\nexport const answer = 42;\n";
  const view = buildView(text, "compiler-output.txt");

  assertEquals(view.doc.text, text);
  assertEquals(view.doc.structure, []);
  assertEquals(
    view.doc.lines.flatMap((line) => line.spans.map((span) => span.cls)),
    ["plain", "plain"],
  );
});

Deno.test("plain text: live edits remain lossless and plain", () => {
  const initial = "terms and conditions";
  const next = "const incomplete = `terms\n🎉";
  const highlighter = languageForFile("LICENSE").createHighlighter(
    initial,
    "LICENSE",
  );
  assertEquals(verbatim(highlighter.lines), initial);
  const updated = highlighter.update(next);
  assertEquals(verbatim(updated), next);
  assertEquals(
    updated.flatMap((line) => line.spans.map((span) => span.cls)),
    ["plain", "plain"],
  );
  assertEquals(highlighter.update(next), updated);
});

Deno.test("plain text: unknown-file diffs keep source content plain", () => {
  const diff = `diff --git a/LICENSE b/LICENSE
--- a/LICENSE
+++ b/LICENSE
@@ -1 +1 @@
-const old = 1;
+const next = 2;
`;
  const model = parseDiff(diff)!;
  const { doc } = buildDiffDocument(diff, model, NO_WS);
  const contentSpans = doc.lines.slice(4, 6).flatMap((line) =>
    line.spans.filter((span) => span.col > 0)
  );
  assertEquals(
    contentSpans.map((span) => span.cls),
    ["plain", "plain"],
  );
  assertEquals(
    doc.flatStructure.map((node) => node.kind),
    ["section", "hunk"],
  );
  assertEquals(verbatim(doc.lines), diff);
});

Deno.test("plain text: editing an unknown-file diff reapplies plain coloring", () => {
  const diff = `diff --git a/LICENSE b/LICENSE
--- a/LICENSE
+++ b/LICENSE
@@ -1 +1 @@
-old terms
+new terms
`;
  const updatedText = diff.replace("new terms", "export const terms = 1;");
  const lines = createDiffHighlighter(diff).update(updatedText);
  const edited = lines[5].spans.filter((span) => span.col > 0);
  assertEquals(edited.map((span) => span.cls), ["plain"]);
  assertEquals(verbatim(lines), updatedText);
});
