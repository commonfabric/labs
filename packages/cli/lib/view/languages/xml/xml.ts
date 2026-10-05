/**
 * XML for the pager. One pass over the source colors tags and their
 * attributes, comments, character data sections, processing instructions,
 * declarations, and entity references, and collects every element into the
 * structure tree. Malformed markup is colored as far as it goes: a tag or an
 * attribute value that is never closed ends where the next tag begins.
 */

import type {
  Definition,
  Document,
  Line,
  StructureNode,
  TokenClass,
} from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { computeLineStarts } from "../../lines.ts";
import { linesFromClasses } from "../classes.ts";
import { structureNode, type StructureSource } from "../structure.ts";

/** An element as the scan finds it, before it has line coordinates. */
interface Element {
  readonly label: string;
  readonly startOffset: number;
  endOffset: number;
  readonly children: Element[];
}

/** An open element, with the name its end tag has to repeat. */
interface OpenElement {
  readonly name: string;
  readonly element: Element;
}

const NAME = /[^\s<>/=?!"'&;[\]]+/y;
const SPACE = /\s*/y;
const PSEUDO_ATTRIBUTE = /([^\s=?"']+)(\s*=\s*)("[^"]*"|'[^']*')/g;
const ENTITY = /&(?:#x[0-9A-Fa-f]+|#[0-9]+|[^\s<>&;"']+);/g;

/** Attributes whose value names an element in its label. */
const IDENTIFYING = /^(?:[^:]+:)?(?:name|id)$/;

/** The token classes and elements of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The elements at the top level. */
  readonly roots: Element[] = [];

  readonly #open: OpenElement[] = [];
  #at = 0;

  constructor(readonly text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    this.#scan();
  }

  #scan(): void {
    const text = this.text;
    while (this.#at < text.length) {
      const tag = text.indexOf("<", this.#at);
      const end = tag < 0 ? text.length : tag;
      this.#entities(this.#at, end);
      this.#at = end;
      if (tag >= 0) this.#markup();
    }
    for (const open of this.#open.splice(0)) {
      open.element.endOffset = text.length;
    }
  }

  #mark(start: number, end: number, cls: TokenClass): void {
    this.classes.fill(cls, start, end);
  }

  #entities(start: number, end: number): void {
    for (const match of this.text.slice(start, end).matchAll(ENTITY)) {
      const at = start + match.index;
      this.#mark(at, at + match[0].length, "keyword");
    }
  }

  /** Consume `token` at the cursor, marking it, if it is there. */
  #take(token: string, cls: TokenClass): boolean {
    if (!this.text.startsWith(token, this.#at)) return false;
    this.#mark(this.#at, this.#at + token.length, cls);
    this.#at += token.length;
    return true;
  }

  /** Consume a name at the cursor, returning it, or "" when none is there. */
  #name(cls: TokenClass): string {
    NAME.lastIndex = this.#at;
    const name = NAME.exec(this.text)?.[0] ?? "";
    this.#mark(this.#at, this.#at + name.length, cls);
    this.#at += name.length;
    return name;
  }

  #space(): void {
    SPACE.lastIndex = this.#at;
    SPACE.test(this.text);
    this.#at = SPACE.lastIndex;
  }

  /** Consume a region that runs to `close`, or to the end of the source. */
  #region(close: string, cls: TokenClass): void {
    const found = this.text.indexOf(close, this.#at);
    const stop = found < 0 ? this.text.length : found;
    this.#mark(this.#at, stop, cls);
    this.#at = stop;
    this.#take(close, "punctuation");
  }

  /** Consume a quoted value, which a tag's end or the next tag also ends. */
  #quoted(): string {
    const text = this.text;
    const quote = text[this.#at];
    let stop = this.#at + 1;
    while (stop < text.length && text[stop] !== quote && text[stop] !== "<") {
      stop++;
    }
    const value = text.slice(this.#at + 1, stop);
    if (text[stop] === quote) stop++;
    this.#mark(this.#at, stop, "string");
    this.#entities(this.#at, stop);
    this.#at = stop;
    return value;
  }

  #markup(): void {
    if (this.#take("<!--", "comment")) {
      const found = this.text.indexOf("-->", this.#at);
      const stop = found < 0 ? this.text.length : found + 3;
      this.#mark(this.#at, stop, "comment");
      this.#at = stop;
    } else if (this.#take("<![CDATA[", "punctuation")) {
      this.#region("]]>", "string");
    } else if (this.#take("<?", "punctuation")) {
      this.#instruction();
    } else if (this.#take("<!", "punctuation")) {
      this.#declaration();
    } else if (this.#take("</", "punctuation")) {
      const name = this.#name("typeName");
      this.#attributes();
      this.#close(name);
    } else {
      this.#take("<", "punctuation");
      const start = this.#at - 1;
      const name = this.#name("typeName");
      if (name === "") return;
      const { selfClosed, label } = this.#attributes();
      const element: Element = {
        label: label === undefined ? name : `${name} ${label}`,
        startOffset: start,
        endOffset: this.#at,
        children: [],
      };
      (this.#open.at(-1)?.element.children ?? this.roots).push(element);
      if (!selfClosed) this.#open.push({ name, element });
    }
  }

  /**
   * Consume a tag's attributes and its end. Returns whether the tag closed
   * itself, and the value of its first `name` or `id` attribute.
   */
  #attributes(): { selfClosed: boolean; label?: string } {
    const text = this.text;
    let attribute = "";
    let label: string | undefined;
    for (;;) {
      this.#space();
      if (this.#at >= text.length || text[this.#at] === "<") {
        return { selfClosed: false, label };
      }
      if (this.#take(">", "punctuation")) return { selfClosed: false, label };
      if (this.#take("/>", "punctuation")) return { selfClosed: true, label };
      if (this.#take("=", "operator")) continue;
      if (text[this.#at] === '"' || text[this.#at] === "'") {
        const value = this.#quoted();
        if (label === undefined && IDENTIFYING.test(attribute)) label = value;
        continue;
      }
      attribute = this.#name("propertyName");
      if (attribute === "") this.#at++;
    }
  }

  /**
   * Consume a processing instruction, which runs to `?>`. Its data is free
   * text, in which `name="value"` pairs, such as an XML declaration's, are
   * colored as attributes.
   */
  #instruction(): void {
    this.#name("keyword");
    const found = this.text.indexOf("?>", this.#at);
    const end = found < 0 ? this.text.length : found;
    const data = this.text.slice(this.#at, end);
    for (const pair of data.matchAll(PSEUDO_ATTRIBUTE)) {
      let at = this.#at + pair.index;
      for (
        const [part, cls] of [
          [pair[1], "propertyName"],
          [pair[2], "operator"],
          [pair[3], "string"],
        ] as const
      ) {
        this.#mark(at, at + part.length, cls);
        at += part.length;
      }
    }
    this.#at = end;
    this.#take("?>", "punctuation");
  }

  /** Consume a declaration such as `<!DOCTYPE`, with its internal subset. */
  #declaration(): void {
    const text = this.text;
    this.#name("keyword");
    let depth = 0;
    while (this.#at < text.length) {
      this.#space();
      const c = text[this.#at];
      if (depth === 0 && (c === ">" || c === "<")) {
        this.#take(">", "punctuation");
        return;
      }
      if (c === "[" || c === "]") {
        depth = Math.max(0, depth + (c === "[" ? 1 : -1));
        this.#take(c, "bracket");
      } else if (c === "<" && depth > 0) {
        this.#markup();
      } else if (c === '"' || c === "'") {
        this.#quoted();
      } else if (c === "%" || c === "&") {
        const stop = text.indexOf(";", this.#at);
        const end = stop < 0 ? this.#at + 1 : stop + 1;
        this.#mark(this.#at, end, "keyword");
        this.#at = end;
      } else if (this.#name("identifier") === "" && this.#at < text.length) {
        this.#at++;
      }
    }
  }

  /** Close the innermost open element named `name`, and any inside it. */
  #close(name: string): void {
    const index = this.#open.findLastIndex((open) => open.name === name);
    if (index < 0) return;
    for (const open of this.#open.splice(index)) {
      open.element.endOffset = this.#at;
    }
  }
}

/** Color `text`, one display line per source line. */
export function xmlLines(text: string): Line[] {
  const scanner = new Scanner(text);
  return linesFromClasses(text, scanner.classes);
}

/** Color `text` and build its tree of elements. */
export function xmlDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source: StructureSource = {
    text,
    lineStarts: computeLineStarts(text),
    definitions: new Map<string, Definition[]>(),
  };
  const place = (element: Element, depth: number): StructureNode =>
    structureNode(
      source,
      {
        kind: "object",
        label: element.label,
        startOffset: element.startOffset,
        endOffset: element.endOffset,
        astKind: "element",
      },
      depth,
      (inner) => element.children.map((child) => place(child, inner)),
    );
  const structure = scanner.roots.map((root) => place(root, 0));
  return {
    text,
    lines: linesFromClasses(text, scanner.classes, source.lineStarts),
    structure,
    flatStructure: flattenStructure(structure),
    definitions: source.definitions,
  };
}
