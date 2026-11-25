/**
 * Jinja templates, with the default delimiters that Ansible uses: `{{ … }}`
 * puts the value of an expression into the output, `{% … %}` is a tag such as
 * `if` or `for`, and `{# … #}` is a comment. A `-` or `+` just inside a
 * delimiter controls the white space around it. The text between `{% raw %}`
 * and `{% endraw %}` is output as written. Everything outside those regions
 * is the text of the file the template produces, which the host language
 * colors.
 *
 * Inside an expression or a tag, a closing delimiter ends the region only
 * outside strings and braces, so `{{ {"a": 1} }}` is one region. Jinja's own
 * lexer reads a closing delimiter inside an unclosed `(` or `[` as an error at
 * that point, so the region ends there. A region that is not closed runs to
 * the end of the source.
 */

import type { TokenClass } from "../../model.ts";
import type {
  TemplateRegion,
  TemplateScan,
  TemplateSyntax,
} from "../template.ts";

/**
 * One alternative per token shape, tried in order: white space, string,
 * number, name, operator, bracket, punctuation. Anything else, such as an
 * unclosed quote, is one character of its own.
 */
const TOKEN =
  /(\s+)|("(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*')|(\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)|([\p{ID_Start}_][\p{ID_Continue}]*)|(\/\/|\*\*|==|!=|<=|>=|[-+*\/%~<>=|!])|([()[\]{}])|([.,:])|([\s\S])/uy;

/** The opening bracket each closing bracket closes. */
const MATCHING: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

/** What follows a name that is called. */
const CALL = /\s*\(/y;

/** The tags that open a template region in the host's text. */
const OPENER = /\{([{%#])/g;

/** The tag that ends a `raw` block. */
const END_RAW = /\{%[-+]?\s*endraw\s*[-+]?%\}/g;

/** Tags and words that steer which parts of a template are output. */
const CONTROL_KEYWORDS = new Set([
  "break",
  "continue",
  "elif",
  "else",
  "endfor",
  "endif",
  "for",
  "if",
  "recursive",
]);

/** The other tags, operators spelled as words, and `none`. */
const KEYWORDS = new Set([
  "and",
  "as",
  "autoescape",
  "block",
  "call",
  "context",
  "do",
  "endautoescape",
  "endblock",
  "endcall",
  "endfilter",
  "endmacro",
  "endraw",
  "endset",
  "endtrans",
  "endwith",
  "extends",
  "filter",
  "from",
  "ignore",
  "import",
  "in",
  "include",
  "is",
  "macro",
  "missing",
  "none",
  "None",
  "not",
  "or",
  "pluralize",
  "raw",
  "required",
  "scoped",
  "set",
  "trans",
  "with",
  "without",
]);

const BOOLEANS = new Set(["true", "false", "True", "False"]);

/** Tags whose names, up to an `=` or `in`, bind variables. */
const BINDING_TAGS = new Set(["for", "set", "with"]);

/** Tags whose first name declares something that is called or filled in. */
const DECLARING_TAGS = new Set(["block", "macro"]);

/** The regions and classes of one source, from one pass over it. */
class Scanner {
  readonly regions: TemplateRegion[] = [];
  readonly classes: (TokenClass | undefined)[];

  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
    this.classes = new Array<TokenClass | undefined>(text.length);
    let at = 0;
    for (;;) {
      OPENER.lastIndex = at;
      const opener = OPENER.exec(text);
      if (opener === null) return;
      const start = opener.index;
      const kind = opener[1];
      if (kind === "#") {
        const close = text.indexOf("#}", start + 2);
        const end = close < 0 ? text.length : close + 2;
        this.classes.fill("comment", start, end);
        this.regions.push({ start, end, fill: " " });
        at = end;
        continue;
      }
      const { end, tag } = this.#tag(start, kind === "{" ? "}}" : "%}");
      this.regions.push({ start, end, fill: kind === "{" ? "_" : " " });
      at = end;
      if (tag === "raw") {
        END_RAW.lastIndex = end;
        at = END_RAW.exec(text)?.index ?? text.length;
      }
    }
  }

  /**
   * Colors the expression or tag that opens at `start` and closes with
   * `close`. Returns where it ends, and a tag's name.
   */
  #tag(start: number, close: string): { end: number; tag?: string } {
    const text = this.#text;
    const statement = close === "%}";
    let at = start + 2;
    if (text[at] === "-" || text[at] === "+") at++;
    this.classes.fill("template", start, at);
    let tag: string | undefined;
    const open: string[] = [];
    let previous = "";
    let testing = false;
    let binding = false;
    let declaring = false;
    for (;;) {
      if (open.at(-1) !== "{") {
        const marker = text[at] === "-" || text[at] === "+" ? 1 : 0;
        if (text.startsWith(close, at + marker)) {
          const end = at + marker + close.length;
          this.classes.fill("template", at, end);
          return { end, tag };
        }
      }
      TOKEN.lastIndex = at;
      const token = TOKEN.exec(text);
      if (token === null) return { end: text.length, tag };
      const [
        word,
        space,
        string,
        number,
        name,
        operator,
        bracket,
        punctuation,
      ] = token;
      const end = at + word.length;
      if (space !== undefined) {
        at = end;
        continue;
      }
      let cls: TokenClass | undefined;
      const tested: boolean = testing;
      const negation: boolean = tested && name === "not";
      testing = name === "is" || negation;
      if (string !== undefined) cls = "string";
      else if (number !== undefined) cls = "number";
      else if (negation) cls = "keyword";
      else if (name !== undefined) {
        cls = tested
          ? "callName"
          : this.#nameClass(name, end, previous, binding, declaring);
        if (statement && tag === undefined) {
          tag = name;
          binding = BINDING_TAGS.has(name);
          declaring = DECLARING_TAGS.has(name);
        } else {
          declaring = false;
          if (name === "in") binding = false;
        }
      } else if (operator !== undefined) {
        cls = "operator";
        if (operator === "=") binding = false;
      } else if (bracket !== undefined) {
        cls = "bracket";
        if ("([{".includes(bracket)) open.push(bracket);
        else if (MATCHING[bracket] === open.at(-1)) open.pop();
      } else if (punctuation !== undefined) {
        cls = "punctuation";
        // Each of a `with` tag's comma-separated assignments binds a name.
        if (tag === "with" && punctuation === "," && open.length === 0) {
          binding = true;
        }
      }
      if (cls !== undefined) this.classes.fill(cls, at, end);
      previous = word;
      at = end;
    }
  }

  /** The class of a name that ends at `end`, after the token `previous`. */
  #nameClass(
    name: string,
    end: number,
    previous: string,
    binding: boolean,
    declaring: boolean,
  ): TokenClass {
    if (previous === ".") return "propertyName";
    if (previous === "|") return "callName";
    if (CONTROL_KEYWORDS.has(name)) return "controlKeyword";
    if (KEYWORDS.has(name)) return "keyword";
    if (BOOLEANS.has(name)) return "boolean";
    if (declaring) return "functionName";
    if (binding) return "binding";
    CALL.lastIndex = end;
    return CALL.test(this.#text) ? "callName" : "identifier";
  }
}

/** Jinja, the template syntax of Ansible's `.j2` templates. */
export const jinjaSyntax: TemplateSyntax = {
  id: "jinja",
  suffixes: [".j2", ".jinja2", ".jinja"],
  aliases: ["jinja2", "j2"],
  scan(text: string): TemplateScan {
    const scanner = new Scanner(text);
    return { regions: scanner.regions, classes: scanner.classes };
  },
};
