/**
 * Go checksum files (`go.sum` and `go.work.sum`) for the pager. Each line
 * names a module path, a version, and a hash, separated by white space. A
 * version that ends in `/go.mod` names the hash of that version's module file
 * alone. The structure tree lists each module path once, over the run of lines
 * that name it.
 */

import type { Document, Line, StructureNode, TokenClass } from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import {
  type LocatedEntry,
  structureNode,
  structureSource,
} from "../structure.ts";

const WORD = /\S+/g;
const WORD_CLASSES: readonly TokenClass[] = ["identifier", "number", "string"];
const MODULE_FILE = "/go.mod";

class Scanner {
  readonly classes: (TokenClass | undefined)[];
  readonly modules: LocatedEntry[] = [];

  constructor(readonly text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    let lineStart = 0;
    for (const line of text.split("\n")) {
      const words = [...line.matchAll(WORD)];
      words.forEach(({ 0: word, index }, position) => {
        const at = lineStart + index;
        const end = at + word.length;
        const suffix = position === 1 && word.endsWith(MODULE_FILE)
          ? MODULE_FILE.length
          : 0;
        this.classes.fill(WORD_CLASSES.at(position), at, end - suffix);
        this.classes.fill("keyword", end - suffix, end);
      });
      const [first] = words;
      const last = words.at(-1);
      if (first !== undefined && last !== undefined) {
        this.#module(
          first[0],
          lineStart + first.index,
          lineStart + last.index + last[0].length,
        );
      }
      lineStart += line.length + 1;
    }
  }

  /** Extends the entry for the module named at `at`, or starts one. */
  #module(path: string, at: number, end: number): void {
    const last = this.modules.at(-1);
    if (last?.name === path) {
      this.modules[this.modules.length - 1] = { ...last, endOffset: end };
      return;
    }
    this.modules.push({
      kind: "variable",
      label: path,
      name: path,
      nameOffset: at,
      startOffset: at,
      endOffset: end,
      astKind: "module",
    });
  }
}

/** Color `text`, one display line per source line. */
export function goSumLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list the modules it holds hashes for. */
export function goSumDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source = structureSource(text);
  const structure: StructureNode[] = scanner.modules.map((entry) =>
    structureNode(source, entry, 0, () => [])
  );
  return {
    text,
    lines: linesFromClasses(text, scanner.classes, source.lineStarts),
    structure,
    flatStructure: flattenStructure(structure),
    definitions: source.definitions,
  };
}
