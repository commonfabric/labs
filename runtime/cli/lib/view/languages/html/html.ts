import "tree-sitter-html/package.json" with { type: "json" };

import { decodeHTMLAttribute } from "entities";
import type { Line } from "../../model.ts";
import { classesFromLines } from "../classes.ts";
import { cssGrammar } from "../css/css.ts";
import { createJsonHighlighter, jsonHighlightLines } from "../json/json.ts";
import type { Highlighter } from "../language.ts";
import {
  createHighlighter,
  type EmbeddedClasses,
  type EmbeddedColoring,
  type EmbeddedStretch,
  prepareGrammar,
  type SyntaxNode,
  tokenClasses,
  type TreeSitterGrammar,
} from "../treesitter/adapter.ts";
import type * as ScriptHighlighting from "../typescript/parse.ts";

/**
 * Capture names are token classes. Order carries meaning: the narrowest
 * capture over a character colors it, and between captures of the same extent
 * the earliest pattern wins.
 */
const HIGHLIGHT_QUERY = `
(comment) @comment
(doctype) @keyword
[(tag_name) (erroneous_end_tag_name)] @typeName
(attribute_name) @propertyName
[(attribute_value) (quoted_attribute_value)] @string
(entity) @keyword
"=" @operator
["<" ">" "</" "/>" "<!"] @punctuation
`;

/** How a language colors a stretch of a page. */
interface EmbeddedLanguage {
  /** The token class of each character of `text`, or undefined while the
   * language loads. */
  classes(text: string): EmbeddedClasses | undefined;

  /** A highlighter of `text` that colors an edit from its earlier work, or
   * undefined while the language loads. */
  highlighter?(text: string): Highlighter | undefined;
}

/** The highlighter of a page's scripts, once the grammar has loaded it. */
let scripts: typeof ScriptHighlighting | undefined;

/** Each language that colors part of a page. */
const LANGUAGES = {
  javaScript: {
    classes: (text) =>
      scripts && classesFromLines(scripts.highlightDocument(text, "script.js")),
    highlighter: (text) => scripts?.createHighlighter(text, "script.js"),
  },
  json: {
    classes: (text) => classesFromLines(jsonHighlightLines(text)),
    highlighter: createJsonHighlighter,
  },
  css: {
    classes: (text) => tokenClasses(cssGrammar, text),
    highlighter: (text) => createHighlighter(cssGrammar, text),
  },
  // A `style` attribute's declarations are colored inside a rule's braces,
  // where the grammar reads a last declaration with no semicolon after it.
  declarations: {
    classes: (text) =>
      tokenClasses(cssGrammar, `x{${text}}`)?.slice(2, 2 + text.length),
  },
} satisfies Record<string, EmbeddedLanguage>;

type Colorer = keyof typeof LANGUAGES;

/** The coloring of a highlighter's lines, which colors an edit through it. */
function highlighted(
  highlighter: Highlighter,
  lines: readonly Line[],
): EmbeddedColoring {
  return {
    classes: classesFromLines(lines),
    update: (text) => highlighted(highlighter, highlighter.update(text)),
  };
}

/** The coloring of `text` in `language`, through a highlighter that colors
 * later edits when `editing`, or undefined while the language loads. */
function coloring(
  language: EmbeddedLanguage,
  text: string,
  editing: boolean,
): EmbeddedColoring | undefined {
  const highlighter = editing ? language.highlighter?.(text) : undefined;
  if (highlighter !== undefined) {
    return highlighted(highlighter, highlighter.lines);
  }
  const classes = language.classes(text);
  return classes && { classes };
}

/** The type strings, in lowercase, that make a `script` element's text
 * JavaScript: a module, and the HTML standard's JavaScript MIME types. */
const JAVASCRIPT_TYPES = new Set(
  `module application/ecmascript application/javascript application/x-ecmascript
  application/x-javascript text/ecmascript text/javascript text/javascript1.0
  text/javascript1.1 text/javascript1.2 text/javascript1.3 text/javascript1.4
  text/javascript1.5 text/jscript text/livescript text/x-ecmascript
  text/x-javascript`.split(/\s+/),
);

/** The names, after `on`, of the event handler attributes of the HTML
 * standard's global and window event handlers, and of the pointer, touch,
 * animation, transition, selection, scroll snap, fullscreen, orientation, and
 * SVG animation events. */
const HANDLED_EVENTS = new Set(
  `abort afterprint animationcancel animationend animationiteration
  animationstart auxclick beforeinput beforematch beforeprint beforetoggle
  beforeunload begin blur cancel canplay canplaythrough change click close
  command contextlost contextmenu contextrestored copy cuechange cut dblclick
  drag dragend dragenter dragleave dragover dragstart drop durationchange
  emptied end ended error focus formdata fullscreenchange fullscreenerror
  gotpointercapture hashchange input invalid keydown keypress keyup
  languagechange load loadeddata loadedmetadata loadstart lostpointercapture
  message messageerror mousedown mouseenter mouseleave mousemove mouseout
  mouseover mouseup offline online orientationchange pagehide pagereveal
  pageshow pageswap paste pause play playing pointercancel pointerdown
  pointerenter pointerleave pointermove pointerout pointerover pointerrawupdate
  pointerup popstate progress ratechange rejectionhandled repeat reset resize
  scroll scrollend scrollsnapchange scrollsnapchanging securitypolicyviolation
  seeked seeking select selectionchange selectstart slotchange stalled storage
  submit suspend timeupdate toggle touchcancel touchend touchmove touchstart
  transitioncancel transitionend transitionrun transitionstart
  unhandledrejection unload volumechange waiting webkitanimationend
  webkitanimationiteration webkitanimationstart webkittransitionend wheel`
    .split(/\s+/),
);

/** The white space the HTML standard removes from around an attribute's
 * value. */
const AROUND_ASCII_SPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

/** `text` with ASCII letters alone in lowercase, as HTML compares names and
 * types. */
const lowered = (text = "") =>
  text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/**
 * The language of a `script` element's text, from the type string the HTML
 * standard derives from its `type` and `language` attributes: JavaScript for a
 * classic script or a module, JSON for an import map, speculation rules, or a
 * data block of a JSON type, and none for any other data block.
 */
function scriptColorer(tag: SyntaxNode): Colorer | undefined {
  const type = attributeValue(tag, "type");
  const language = attributeValue(tag, "language");
  const value = type === "" || (type === undefined && !language)
    ? "text/javascript"
    : lowered(type?.replace(AROUND_ASCII_SPACE, "") ?? `text/${language}`);
  if (JAVASCRIPT_TYPES.has(value)) return "javaScript";
  const essence = value.split(";")[0].replace(AROUND_ASCII_SPACE, "");
  return value === "importmap" || value === "speculationrules" ||
      essence === "application/json" || essence === "text/json" ||
      essence.endsWith("+json")
    ? "json"
    : undefined;
}

/** The value of the attribute named `name` on a start tag. */
function attributeValue(tag: SyntaxNode, name: string): string | undefined {
  for (const attribute of tag.namedChildren) {
    if (lowered(attribute.firstNamedChild?.text) !== name) continue;
    return decoded(valueNode(attribute)?.text ?? "").text;
  }
  return undefined;
}

/** What may be a character reference in an attribute's value. A named one
 * with no semicolon is text when a letter, digit, or `=` follows it. */
const REFERENCE =
  /&(?:#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[A-Za-z][A-Za-z0-9]*(?:;|(?![A-Za-z0-9=])))/g;

/** An attribute's value as the page means it, with each character reference
 * read as the character it stands for, and for each character of the value as
 * written, the offset of the character it is read as. */
function decoded(written: string): { text: string; readAs: number[] } {
  let text = "";
  const readAs: number[] = [];
  const copy = (from: number, to: number) => {
    for (let at = from; at < to; at++) readAs.push(text.length + at - from);
    text += written.slice(from, to);
  };
  let copied = 0;
  for (const { index, 0: reference } of written.matchAll(REFERENCE)) {
    const character = decodeHTMLAttribute(reference);
    if (character === reference) continue;
    copy(copied, index);
    for (let at = 0; at < reference.length; at++) readAs.push(text.length);
    text += character;
    copied = index + reference.length;
  }
  copy(copied, written.length);
  return { text, readAs };
}

/** A coloring of an attribute's decoded value, read back onto the value as
 * written. */
function asWritten(
  coloring: EmbeddedColoring,
  readAs: readonly number[],
): EmbeddedColoring {
  return {
    classes: readAs.map((offset) => coloring.classes[offset]),
    update: coloring.update,
  };
}

/** An attribute's value, without the quotes around it. */
function valueNode(attribute: SyntaxNode): SyntaxNode | undefined {
  const value = attribute.namedChildren[1];
  return value?.type === "quoted_attribute_value"
    ? value.firstNamedChild ?? undefined
    : value ?? undefined;
}

/** The language of the stretch of source `node` holds, when another language
 * colors it: a `script` or `style` element's text, or the value of an event
 * handler or `style` attribute. */
function embeddedColorer(node: SyntaxNode): Colorer | undefined {
  if (node.type === "attribute") {
    const name = lowered(node.firstNamedChild?.text);
    if (name === "style") return "declarations";
    return name.startsWith("on") && HANDLED_EVENTS.has(name.slice(2))
      ? "javaScript"
      : undefined;
  }
  // The parse puts the start tag before the text it opens, even when the
  // element is never closed.
  const tag = node.previousNamedSibling;
  const name = tag?.type === "start_tag"
    ? lowered(tag.firstNamedChild?.text)
    : "";
  if (tag && name === "script") return scriptColorer(tag);
  // The standard compares a style sheet's type without removing white space.
  const type = tag && lowered(attributeValue(tag, "type"));
  return name === "style" && (type === "" || type === "text/css")
    ? "css"
    : undefined;
}

/**
 * HTML for the pager, on the shared Tree-sitter adapter: the highlight query
 * that names a token class for each piece of markup, the rule that makes each
 * element a structure entry labeled with its tag name and its `id` or `name`,
 * and the stretches another language colors. A `script` element's text is
 * colored as JavaScript or JSON as its `type` and `language` attributes say, an
 * event handler attribute's value as JavaScript, and a `style` element's text
 * and a `style` attribute's value as CSS, with an attribute's character
 * references read as the characters they stand for. Loading, coloring,
 * incremental editing, and the structure walk are the adapter's.
 *
 * The grammar package supplies the compiled parser. Its own highlight query is
 * not used, because its capture names are not the pager's token classes.
 */
export const htmlGrammar: TreeSitterGrammar = {
  id: "html",

  wasmUrl: () => import.meta.resolve("tree-sitter-html/tree-sitter-html.wasm"),

  highlightQuery: HIGHLIGHT_QUERY,

  // Error recovery can hold an element inside an error node.
  structureParents: new Set(["document", "element", "ERROR"]),

  async prepareEmbedded() {
    // The TypeScript compiler the script highlighter runs on is large and
    // reads the environment as it loads, so the grammar loads it when a page
    // is shown, and a module that only lists the grammars, such as the binary
    // build, does not.
    // deno-lint-ignore cf-imports/no-inline-module-import
    const loading = import("../typescript/parse.ts");
    [scripts] = await Promise.all([loading, prepareGrammar(cssGrammar)]);
  },

  structureEntry(node) {
    const tag = node.type.endsWith("element") ? node.firstNamedChild : null;
    const name = tag?.firstNamedChild;
    if (tag === null || name?.type !== "tag_name") return undefined;
    const id = [attributeValue(tag, "id"), attributeValue(tag, "name")]
      .map((value) => value?.replace(/\s+/g, " ").trim()).find(Boolean);
    return { kind: "object", label: id ? `${name.text} ${id}` : name.text };
  },

  *embedded(root): Iterable<EmbeddedStretch> {
    const counts = new Map<Colorer, number>();
    for (const node of root.descendantsOfType(["raw_text", "attribute"])) {
      const value = node.type === "attribute" ? valueNode(node) : node;
      const colorer = value && embeddedColorer(node);
      if (!value || !colorer) continue;
      const written = value.text;
      const { text, readAs } = node.type === "attribute"
        ? decoded(written)
        : { text: written, readAs: undefined };
      const ordinal = counts.get(colorer) ?? 0;
      counts.set(colorer, ordinal + 1);
      yield {
        start: value.startIndex,
        end: value.endIndex,
        key: `${colorer}\n${written}`,
        slot: `${colorer}\n${ordinal}`,
        color: (editing, earlier) => {
          const colored = earlier?.update?.(text) ??
            coloring(LANGUAGES[colorer], text, editing);
          return colored && readAs ? asWritten(colored, readAs) : colored;
        },
      };
    }
  },
};
