import {
  Parser,
  type Renderer,
  TextRenderer,
  type Token,
  type Tokens,
} from "marked";

// marked emitted an id on every heading until version 5, under a `headerIds`
// option that defaulted to on. Version 5 deprecated the option and a later
// major dropped it. The classes here put the ids back, generating the same ones
// marked 4 did so that fragment links written against the old output still
// resolve: the same slug characters, and the same `-1`/`-2` suffixes when a
// heading repeats.

const ESCAPE_REPLACEMENTS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// marked 4's two escapes. Its lexer escaped ordinary text without encoding,
// which leaves a run already shaped like an entity alone, and escaped the
// contents of a codespan outright.
const ESCAPE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESCAPE_ENCODE = /[&<>"']/g;

const escapeNoEncode = (text: string) =>
  text.replace(ESCAPE_NO_ENCODE, (char) => ESCAPE_REPLACEMENTS[char]);
const escapeEncode = (text: string) =>
  text.replace(ESCAPE_ENCODE, (char) => ESCAPE_REPLACEMENTS[char]);

// marked 4 resolved numeric entities and `&colon;`, and replaced every other
// named entity with nothing.
const UNESCAPE = /&(#(?:\d+)|(?:#x[0-9A-Fa-f]+)|(?:\w+));?/gi;

function unescape(html: string): string {
  return html.replace(UNESCAPE, (_match, entity: string) => {
    const name = entity.toLowerCase();
    if (name === "colon") return ":";
    if (name.charAt(0) === "#") {
      return name.charAt(1) === "x"
        ? String.fromCharCode(parseInt(name.substring(2), 16))
        : String.fromCharCode(+name.substring(1));
    }
    return "";
  });
}

type InlineParser = Renderer["parser"];

/**
 * Renders a heading's tokens to plain text, escaped the way marked 4's lexer
 * escaped it. Unescaping that text produces the string marked 4 slugged.
 *
 * The round trip loses characters: a bare `&`, `<`, `>` or `"` becomes an
 * entity and the entity then resolves to nothing, which happens before the slug
 * is trimmed. `Q&A` slugs to `qa`, and `# &copy; 2024` to `2024`.
 *
 * marked 4's parser walked into emphasis, strikethrough and link text and
 * rendered the tokens inside them through this same renderer. marked 18 hands
 * the whole token over instead, and its text renderer returns the token's
 * unescaped text, so the walk is done here.
 */
class SlugTextRenderer extends TextRenderer {
  #parser: InlineParser;

  constructor(parser: InlineParser) {
    super();
    this.#parser = parser;
  }

  #inline(tokens: Token[]): string {
    return this.#parser.parseInline(tokens, this);
  }

  override text({ text }: Tokens.Text | Tokens.Escape | Tokens.Tag): string {
    return escapeNoEncode(text);
  }

  override codespan({ text }: Tokens.Codespan): string {
    return escapeEncode(text);
  }

  override strong({ tokens }: Tokens.Strong): string {
    return this.#inline(tokens);
  }

  override em({ tokens }: Tokens.Em): string {
    return this.#inline(tokens);
  }

  override del({ tokens }: Tokens.Del): string {
    return this.#inline(tokens);
  }

  override link({ tokens }: Tokens.Link): string {
    return this.#inline(tokens);
  }

  /**
   * Renders an image's alt text as marked 4's lexer left it, without walking
   * into it, which is how marked 4 slugged one.
   */
  override image({ text }: Tokens.Image): string {
    return escapeNoEncode(text);
  }
}

/**
 * Turns heading text into an id, suffixing repeats to keep each one unique.
 *
 * The first `Section` heading takes `section`, the next `section-1`, and so on.
 * A slugger holds the headings it has already seen, so one is used per parse.
 */
class HeadingSlugger {
  #seen = new Map<string, number>();

  #serialize(value: string): string {
    return value
      .toLowerCase()
      .trim()
      // remove html tags
      .replace(/<[!\/a-z].*?>/gi, "")
      // remove unwanted chars: general punctuation (U+2000-U+206F),
      // supplemental punctuation (U+2E00-U+2E7F), and ASCII punctuation.
      .replace(
        /[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g,
        "",
      )
      .replace(/\s/g, "-");
  }

  slug(value: string): string {
    const original = this.#serialize(value);
    let slug = original;
    let occurrences = 0;
    if (this.#seen.has(slug)) {
      occurrences = this.#seen.get(original) ?? 0;
      do {
        occurrences++;
        slug = `${original}-${occurrences}`;
      } while (this.#seen.has(slug));
    }
    this.#seen.set(original, occurrences);
    this.#seen.set(slug, 0);
    return slug;
  }
}

/**
 * The ids for the headings of one rendered document.
 *
 * Each instance slugs against its own set of seen headings, so one is created
 * per render and the suffixes restart each time.
 */
export class HeadingIds {
  #slugger = new HeadingSlugger();
  #parser = new Parser();

  /** The id for a heading, given the tokens of its text. */
  idFor(tokens: Token[]): string {
    return this.#slugger.slug(
      unescape(
        this.#parser.parseInline(tokens, new SlugTextRenderer(this.#parser)),
      ),
    );
  }
}
