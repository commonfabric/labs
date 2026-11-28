/**
 * Template syntaxes layered over a host language. A template's filename is
 * the name of the file it produces followed by the template's suffix, as
 * `deploy.sh.j2` is a Jinja template of a shell script, so the host is the
 * language the rest of the name selects. The host colors the source with every
 * region the template syntax owns hidden from it, and the template syntax
 * colors its own regions. The structure tree is the host's.
 */

import type {
  Definition,
  Document,
  Line,
  StructureNode,
  TokenClass,
} from "../model.ts";
import { flattenStructure } from "../model.ts";
import { linesFromClasses } from "./classes.ts";
import { lineIndexOf } from "../lines.ts";
import { structureSource } from "./structure.ts";
import type { Language } from "./language.ts";
import { plainTextLanguage } from "./plain-text/language.ts";

/** A stretch of source that a template syntax owns, such as `{{ name }}`. */
export interface TemplateRegion {
  readonly start: number;
  readonly end: number;

  /**
   * The character the host reads in place of each of the region's
   * characters, line breaks included, as the template's output holds none of
   * them: such as `_` where the template puts a value into the host's text,
   * and a space where it puts nothing there, as a control tag or a comment
   * does. Where the fill is a word character, the host reads the region as a
   * mark unique to it instead, padded with `9`s: `_`, then the region's index
   * among the regions with such a fill in base 60, written with the digits and
   * letters other than `1` and `9`, then `9`, as `_a99999`, which reads as a
   * name wherever a name or a value can stand. A host whose values are all
   * literals reads `1`, then the index in base 8, written with the digits
   * other than `1` and `9`, then `9`, as the number `1399999`. A mark's first
   * character appears nowhere else in one, and the first `9` ends it, so no
   * mark is part of another, and a region skips any mark that the source
   * already holds. A region too short for its mark reads as the mark's first
   * character and then `9`s, as `_99`, which is no region's mark and is no
   * part of one; a region one character long reads as that first character
   * alone.
   */
  readonly fill: string;
}

/** The regions a template syntax owns in a source, and their token classes. */
export interface TemplateScan {
  /** The regions, in order, none overlapping another. */
  readonly regions: readonly TemplateRegion[];

  /** The token class of each character inside a region. */
  readonly classes: readonly (TokenClass | undefined)[];
}

/** A template syntax that layers over the language of the file it produces. */
export interface TemplateSyntax {
  /** The identifier of the syntax over plain text, such as `"jinja"`. */
  readonly id: string;

  /** The suffixes, with their leading dots, compared without case. */
  readonly suffixes: readonly string[];

  /** Other names for the syntax over plain text. */
  readonly aliases: readonly string[];

  /** The regions of `text` and their classes. */
  scan(text: string): TemplateScan;
}

/** `fileName` without the template suffix it ends with, or undefined when it
 * ends with none of the syntax's suffixes. */
export function templateHostName(
  syntax: TemplateSyntax,
  fileName: string,
): string | undefined {
  const lower = fileName.toLowerCase();
  const suffix = syntax.suffixes.find((suffix) =>
    lower.endsWith(suffix.toLowerCase())
  );
  return suffix === undefined
    ? undefined
    : fileName.slice(0, fileName.length - suffix.length);
}

const layered = new Map<TemplateSyntax, Map<Language, Language>>();

/** `source` with its line breaks, and the white space around them, read as
 * one space. */
function oneLine(source: string): string {
  return source.replace(/\s*[\r\n]+\s*/g, " ");
}

/** A character of a word, as the fill `_` is. */
const WORD = /\w/;

/**
 * The language of `syntax` layered over `host`, the same object for each
 * pair. Its identifier is the syntax's over plain text and `syntax-host`
 * otherwise, such as `jinja-shell`.
 */
export function templateLanguage(
  syntax: TemplateSyntax,
  host: Language,
): Language {
  let byHost = layered.get(syntax);
  if (byHost === undefined) {
    byHost = new Map();
    layered.set(syntax, byHost);
  }
  let language = byHost.get(host);
  if (language === undefined) {
    language = layer(syntax, host);
    byHost.set(host, language);
  }
  return language;
}

function layer(syntax: TemplateSyntax, host: Language): Language {
  const plain = host === plainTextLanguage;
  const numbers = host.literalValues === true;
  const prepare = host.prepare;
  const hostName = (fileName: string | undefined) =>
    fileName === undefined
      ? undefined
      : templateHostName(syntax, fileName) ?? fileName;
  return {
    id: plain ? syntax.id : `${syntax.id}-${host.id}`,

    input: { kind: "text", decoder: host.input.decoder },

    metadata: {
      extensions: [],
      filenames: [],
      filenamePatterns: [],
      aliases: plain ? syntax.aliases : [],
      interpreters: [],
      signatures: [],
      sharedExtensions: [],
    },

    ...(prepare === undefined ? {} : { prepare: () => prepare.call(host) }),

    parseDocument(text, fileName) {
      const scan = syntax.scan(text);
      const marks = marksOf(text, scan.regions, numbers);
      const hidden = hide(text, scan.regions, marks);
      const document = host.parseDocument(hidden, hostName(fileName));
      return {
        ...reveal(document, text, scan.regions, marks, hidden, numbers),
        text,
        lines: overlay(text, scan, document.lines),
      };
    },

    highlightLines(text, fileName) {
      const scan = syntax.scan(text);
      const hidden = hide(
        text,
        scan.regions,
        sameMarks(scan.regions, numbers),
      );
      return overlay(
        text,
        scan,
        host.highlightLines(hidden, hostName(fileName)),
      );
    },

    highlightFullFileOnDiffEdit: true,

    createHighlighter(initial, fileName) {
      let text = initial;
      let scan = syntax.scan(text);
      const hostHighlighter = host.createHighlighter(
        hide(text, scan.regions, sameMarks(scan.regions, numbers)),
        hostName(fileName),
      );
      let lines = overlay(text, scan, hostHighlighter.lines);
      return {
        get lines() {
          return lines;
        },
        update(next) {
          if (next === text) return lines;
          text = next;
          scan = syntax.scan(text);
          const hidden = hide(
            text,
            scan.regions,
            sameMarks(scan.regions, numbers),
          );
          lines = overlay(
            text,
            scan,
            hostHighlighter.update(hidden),
          );
          return lines;
        },
      };
    },

    hunkStructure: (ctx) => host.hunkStructure(ctx),
  };
}

/** `text` with each region's characters, line breaks included, replaced as
 * {@link TemplateRegion.fill} describes, starting with its mark. */
function hide(
  text: string,
  regions: readonly TemplateRegion[],
  marks: readonly (string | undefined)[],
): string {
  let hidden = "";
  let at = 0;
  regions.forEach(({ start, end, fill }, index) => {
    const mark = marks[index];
    const length = end - start;
    hidden += text.slice(at, start) +
      (mark === undefined
        ? fill.repeat(length)
        : mark.length <= length
        ? mark + "9".repeat(length - mark.length)
        : mark[0] + "9".repeat(length - 1));
    at = end;
  });
  return hidden + text.slice(at);
}

/** What each region starts with when it has room, as
 * {@link TemplateRegion.fill} describes, in the form for literal values where
 * `numbers` is set, or undefined for a region whose fill is not a word
 * character. */
function marksOf(
  text: string,
  regions: readonly TemplateRegion[],
  numbers: boolean,
): (string | undefined)[] {
  const [start, digits] = numbers ? ["1", "02345678"] : ["_", NAME_DIGITS];
  const inSource = new Set(text.match(numbers ? NUMBER_MARK : NAME_MARK));
  let count = 0;
  const next = (): string => {
    let index = "";
    let rest = count++;
    do {
      index = digits[rest % digits.length] + index;
      rest = Math.floor(rest / digits.length);
    } while (rest > 0);
    return `${start}${index}9`;
  };
  return regions.map(({ fill }) => {
    if (!WORD.test(fill)) return undefined;
    let mark = next();
    while (inSource.has(mark)) mark = next();
    return mark;
  });
}

/**
 * One mark for every region whose fill is a word character, which reads as
 * the unique marks do. Coloring does not depend on which region a mark
 * names, and with one mark for all, an edit that adds a region, or that
 * changes which marks the source holds, changes only the text the host reads
 * around that edit.
 */
function sameMarks(
  regions: readonly TemplateRegion[],
  numbers: boolean,
): (string | undefined)[] {
  const mark = numbers ? "1" : "_";
  return regions.map(({ fill }) => WORD.test(fill) ? mark : undefined);
}

/** The digits of a name-shaped mark's index. */
const NAME_DIGITS =
  "02345678abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Every stretch of source that could read as a mark of each shape, so that
 * no region takes a mark the source already holds. */
const NAME_MARK = /_[02-8a-zA-Z]*9/g;
const NUMBER_MARK = /1[02-8]*9/g;

/** A mark of each shape and the `9`s after it. */
const PADDED_NAME_MARK = /_[02-8a-zA-Z]*9+/g;
const PADDED_NUMBER_MARK = /1[02-8]*9+/g;

/** The start of a mark of each shape that a host cut short with `…`. */
const CUT_NAME_MARK = /_[02-8a-zA-Z]*(?=…)/g;
const CUT_NUMBER_MARK = /1[02-8]*(?=…)/g;

/** Color `text` with the template's classes inside its regions and the
 * host's, read from the host's lines, everywhere else. A region whose
 * brackets do not balance, as one being typed may not, colors them as
 * punctuation, so that they leave the nesting of the host's brackets as it
 * is. */
function overlay(
  text: string,
  scan: TemplateScan,
  hostLines: readonly Line[],
): Line[] {
  const classes = new Array<TokenClass | undefined>(text.length);
  let offset = 0;
  for (const line of hostLines) {
    for (const { cls, text: spanText } of line.spans) {
      if (cls !== "plain" && cls !== "whitespace") {
        classes.fill(cls, offset, offset + spanText.length);
      }
      offset += spanText.length;
    }
    offset++;
  }
  if (offset !== text.length + 1) {
    throw new Error("The host's lines do not reconstruct the hidden source");
  }
  for (const { start, end } of scan.regions) {
    let depth = 0;
    let balanced = true;
    for (let i = start; i < end; i++) {
      classes[i] = scan.classes[i];
      if (classes[i] !== "bracket") continue;
      depth += "([{".includes(text[i]) ? 1 : -1;
      if (depth < 0) balanced = false;
    }
    if (balanced && depth === 0) continue;
    for (let i = start; i < end; i++) {
      if (classes[i] === "bracket") classes[i] = "punctuation";
    }
  }
  return linesFromClasses(text, classes);
}

/**
 * The host's structure with its labels and names spelled as the source spells
 * them, as `check_{{ env }}` rather than the `check__09999999` the host read,
 * with a region spelled whole wherever an entry reaches into it, its line
 * breaks and the white space around them read as one space. An entry that
 * starts or ends inside a region is widened to the whole region, and columns
 * are counted in the source, where a character outside the Basic Multilingual
 * Plane that the host read as two fill characters is one column.
 *
 * A name the host read at its entry's name offset, or just past it, as past a
 * quote, is that stretch of the source. In a label, or any other name, each
 * mark is replaced by its region's source; since no region takes a mark the
 * source holds, a mark in a value can only be its own region's. A definition
 * follows the entry it declares, and every definition's lines are counted in
 * the source.
 */
function reveal(
  document: Document,
  text: string,
  regions: readonly TemplateRegion[],
  marks: readonly (string | undefined)[],
  hidden: string,
  numbers: boolean,
): Pick<Document, "structure" | "flatStructure" | "definitions"> {
  /** Each named entry as revealed, by its offset and name as the host read
   * them. */
  const renamed = new Map<string, StructureNode>();
  const { columnOf, lineStarts } = structureSource(text);
  /** The index of the first region that ends after `offset`. */
  const firstRegion = (offset: number): number => {
    let low = 0;
    let high = regions.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (regions[middle].end <= offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  /** The region with `offset` inside it, after its first character. */
  const regionAround = (offset: number): TemplateRegion | undefined => {
    const region = regions[firstRegion(offset)];
    return region !== undefined && region.start < offset ? region : undefined;
  };
  /** The source from `from` to `to`, with each region it touches spelled
   * whole. */
  const spellRange = (from: number, to: number): string => {
    let spelled = "";
    let at = from;
    for (
      let r = firstRegion(from);
      r < regions.length && regions[r].start < to;
      r++
    ) {
      const { start, end } = regions[r];
      spelled += text.slice(at, Math.max(at, start)) +
        oneLine(text.slice(start, end));
      at = end;
    }
    return spelled + (at < to ? text.slice(at, to) : "");
  };
  const regionOf = new Map<string, TemplateRegion>();
  regions.forEach((region, index) => {
    const mark = marks[index];
    if (mark !== undefined) regionOf.set(mark, region);
  });
  /**
   * `value`, which the host read inside the entry `node`, with each start of
   * a mark that a host cut short with `…`, as a host that shortens labels can,
   * replaced by its region's source. A cut text is a mark's start when the
   * value before it is what the host read from the start of the entry, or of
   * its name, up to a region whose mark the cut text starts, so that a `…`
   * before it is one the source holds there, not one the host put in.
   */
  const spellCuts = (value: string, node: StructureNode): string =>
    value.replace(
      numbers ? CUT_NUMBER_MARK : CUT_NAME_MARK,
      (cut: string, offset: number) => {
        const before = value.slice(0, offset);
        const regionAt = (anchor: number | undefined) => {
          if (
            anchor === undefined || !hidden.startsWith(before + cut, anchor)
          ) {
            return undefined;
          }
          const start = anchor + before.length;
          const r = firstRegion(start);
          return regions[r]?.start === start && marks[r]?.startsWith(cut)
            ? regions[r]
            : undefined;
        };
        const region = regionAt(node.startOffset) ?? regionAt(node.nameOffset);
        return region === undefined
          ? cut
          : oneLine(text.slice(region.start, region.end));
      },
    );
  /** `value` with each mark in it, and the `9`s padding it, replaced by its
   * region's source. */
  const spellMarks = (value: string): string =>
    value.replace(numbers ? PADDED_NUMBER_MARK : PADDED_NAME_MARK, (read) => {
      const mark = read.slice(0, read.indexOf("9") + 1);
      const region = regionOf.get(mark);
      if (region === undefined) return read;
      const padding = Math.min(
        read.length - mark.length,
        region.end - region.start - mark.length,
      );
      return oneLine(text.slice(region.start, region.end)) +
        read.slice(mark.length + padding);
    });
  const revealNode = (node: StructureNode): StructureNode => {
    const { nameOffset } = node;
    let name = node.name;
    let label = spellCuts(node.label, node);
    if (name !== undefined) {
      let spelled: string;
      // Which of the name's occurrences in the label the host built it into.
      let earlier = 0;
      const at = nameOffset === undefined
        ? -1
        : hidden.slice(nameOffset, node.endOffset).indexOf(name);
      if (
        nameOffset !== undefined && at >= 0 &&
        !WORD.test(hidden.slice(nameOffset, nameOffset + at))
      ) {
        const start = nameOffset + at;
        spelled = spellRange(start, start + name.length);
        for (
          let found = hidden.indexOf(name, node.startOffset);
          found >= 0 && found < start;
          found = hidden.indexOf(name, found + 1)
        ) {
          earlier++;
        }
      } else {
        spelled = spellMarks(spellCuts(name, node));
      }
      // The name is spelled into the label before the marks are, so that it
      // is spelled there even where it reaches into a region too short for a
      // mark, or where the host cut it short.
      let index = -1;
      do {
        index = label.indexOf(name, index + 1);
      } while (index >= 0 && earlier-- > 0);
      if (index >= 0) {
        label = label.slice(0, index) + spelled +
          label.slice(index + name.length);
      }
      name = spelled;
    }
    label = spellMarks(label);
    const startOffset = regionAround(node.startOffset)?.start ??
      node.startOffset;
    const endOffset = regionAround(node.endOffset)?.end ?? node.endOffset;
    const startLine = lineIndexOf(lineStarts, startOffset);
    const endLine = lineIndexOf(
      lineStarts,
      Math.max(startOffset, endOffset - 1),
    );
    const revealed = {
      ...node,
      label,
      ...(name === undefined ? {} : { name }),
      startOffset,
      endOffset,
      startLine,
      endLine,
      startCol: columnOf(startLine, startOffset),
      endCol: columnOf(endLine, endOffset),
      children: node.children.map(revealNode),
    };
    if (node.name !== undefined) {
      renamed.set(`${node.startOffset} ${node.name}`, revealed);
    }
    return revealed;
  };
  const structure = document.structure.map(revealNode);
  const definitions = new Map<string, Definition[]>();
  for (const declarations of document.definitions.values()) {
    for (const declaration of declarations) {
      const node = renamed.get(
        `${declaration.startOffset} ${declaration.name}`,
      );
      const revealed = node === undefined
        ? {
          ...declaration,
          startLine: lineIndexOf(lineStarts, declaration.startOffset),
          endLine: lineIndexOf(
            lineStarts,
            Math.max(declaration.startOffset, declaration.endOffset - 1),
          ),
        }
        : {
          ...declaration,
          name: node.name ?? declaration.name,
          startLine: node.startLine,
          endLine: node.endLine,
          startOffset: node.startOffset,
          endOffset: node.endOffset,
        };
      const named = definitions.get(revealed.name) ?? [];
      named.push(revealed);
      definitions.set(revealed.name, named);
    }
  }
  return {
    structure,
    flatStructure: flattenStructure(structure),
    definitions,
  };
}
