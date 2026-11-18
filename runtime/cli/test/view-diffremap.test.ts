/**
 * Projecting a workspace file's structure tree into the coordinates of a diff
 * hunk, as a diff document shows it.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { parseDiff } from "../lib/view/diff.ts";
import { buildDiffDocument, type DiffWorkspace } from "../lib/view/diffdoc.ts";
import type { StructureNode } from "../lib/view/model.ts";

describe("diffremap", () => {
  it("places every key of a long one-line JSON file at its diff offset and column", () => {
    // Twenty thousand entries on one line, every other key holding a
    // surrogate pair, so that a column differs from its UTF-16 offset.
    const entries: string[] = [];
    const expected: { text: string; startCol: number; endCol: number }[] = [];
    let col = 2; // past the `+` marker and the opening brace
    for (let i = 0; i < 20_000; i++) {
      const entry = i % 2 === 0 ? `"𝑻${i}":${i}` : `"k${i}":${i}`;
      const width = entry.length - (i % 2 === 0 ? 1 : 0);
      entries.push(entry);
      expected.push({ text: entry, startCol: col, endCol: col + width });
      col += width + 1;
    }
    const newLine = `{${entries.join(",")}}`;
    const oldLine = newLine.replace(`"𝑻0":0`, `"𝑻0":-1`);
    const diff = [
      "diff --git a/data.json b/data.json",
      "--- a/data.json",
      "+++ b/data.json",
      "@@ -1 +1 @@",
      `-${oldLine}`,
      `+${newLine}`,
      "",
    ].join("\n");
    const workspace: DiffWorkspace = {
      resolve: (path) => `/workspace/${path}`,
      read: () => `${newLine}\n`,
    };

    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);

    const [file] = doc.structure;
    const [hunk] = file.children;
    const placed = hunk.children.map((node: StructureNode) => ({
      text: doc.text.slice(node.startOffset, node.endOffset),
      startCol: node.startCol,
      endCol: node.endCol,
    }));
    expect(placed).toEqual(expected);
  });

  it("ends a node that continues past the hunk at the end of the hunk's last line", () => {
    const diff = [
      "diff --git a/settings.ini b/settings.ini",
      "--- a/settings.ini",
      "+++ b/settings.ini",
      "@@ -1,2 +1,2 @@",
      " [s]",
      "-a=1",
      "+a=2",
      "",
    ].join("\n");
    const workspace: DiffWorkspace = {
      resolve: (path) => `/workspace/${path}`,
      read: () => "[s]\na=2\nb=3\nc=4\n",
    };

    const { doc } = buildDiffDocument(diff, parseDiff(diff)!, workspace);

    const [file] = doc.structure;
    const [hunk] = file.children;
    const [section] = hunk.children;
    expect({
      text: doc.text.slice(section.startOffset, section.endOffset),
      startCol: section.startCol,
      endCol: section.endCol,
    }).toEqual({ text: "[s]\n-a=1\n+a=2", startCol: 1, endCol: 4 });
  });
});
