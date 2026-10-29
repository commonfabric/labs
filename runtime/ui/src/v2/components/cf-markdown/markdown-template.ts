/**
 * Builds the Lit template for a markdown document.
 *
 * The document never becomes markup. marked reads it into tokens, and this
 * module turns those tokens into a template whose tags and attribute names it
 * writes itself; every piece of the document reaches the page through a
 * binding, which Lit puts in a text node or an attribute value rather than
 * parsing. Markup in the source is therefore text, and no combination of
 * characters in it can add an element, an attribute, or an event handler.
 *
 * Two things the source can still reach are handled here. A URL is checked
 * against the scheme allowlist in `safe-url.ts` before it goes into an `href`
 * or a `src`. Raw HTML, which markdown allows and marked reports as an `html`
 * token, is dropped. What that costs depends on where it was written: inline
 * HTML is one token per tag, so `<b>bold</b>` loses the tags and keeps the
 * word between them, while a block of HTML is a single token holding the whole
 * block, so its text goes with it.
 *
 * Building a template touches no DOM, but resolving the character references
 * in a run of text does, so this module runs in a browser.
 */

import { matchLLMFriendlyLink } from "@commonfabric/runtime-client";
import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { Lexer, type Token, type Tokens } from "marked";

import { safeImageUrl, safeUrl } from "../../core/safe-url.ts";
import { HeadingIds } from "./heading-id.ts";

import "../cf-cell-link/index.ts";
import "../cf-copy-button/index.ts";

/** What a rendered document reports back to the component that owns it. */
export interface MarkdownCallbacks {
  /**
   * A task-list checkbox was toggled. `index` counts checkboxes across the
   * whole document, in the order they appear.
   */
  checkboxToggled(index: number, checked: boolean): void;
}

/** Scratch element {@link decodeEntities} parses into; created on first use. */
let scratch: HTMLElement | undefined;

/**
 * Resolves the HTML character references in a run of markdown text.
 *
 * marked leaves them as written, because the renderer it ships hands its
 * output to an HTML parser that resolves them. This one does not, so `&amp;`
 * would otherwise reach the page as four characters rather than one.
 *
 * The `innerHTML` assignment cannot produce an element: `<` and `>` are
 * replaced by their own references first, and every markup construct needs a
 * `<`. What comes back is the single text node the parser built.
 */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  scratch ??= document.createElement("div");
  scratch.innerHTML = text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return scratch.textContent ?? "";
}

class MarkdownTemplate {
  #callbacks: MarkdownCallbacks;
  #headingIds = new HeadingIds();
  #checkboxes = 0;

  constructor(callbacks: MarkdownCallbacks) {
    this.#callbacks = callbacks;
  }

  blocks(tokens: Token[]): unknown {
    return tokens.map((token) => this.#block(token));
  }

  #block(token: Token): unknown {
    switch (token.type) {
      case "heading":
        return this.#heading(token as Tokens.Heading);
      case "paragraph":
        return html`<p>${this.#inline((token as Tokens.Paragraph).tokens)}</p>`;
      case "code":
        return this.#code(token as Tokens.Code);
      case "blockquote":
        return html`<blockquote>
          ${this.blocks((token as Tokens.Blockquote).tokens)}
        </blockquote>`;
      case "list":
        return this.#list(token as Tokens.List);
      case "table":
        return this.#table(token as Tokens.Table);
      case "hr":
        return html`<hr>`;
      case "text":
        return this.#text(token as Tokens.Text);
      case "checkbox":
        return this.#checkbox(token as Tokens.Checkbox);
      // Raw markup in the source is not rendered. What remains — a blank line
      // between blocks, a link reference definition — draws nothing.
      case "html":
      default:
        return nothing;
    }
  }

  #inline(tokens: Token[]): unknown {
    return tokens.map((token) => this.#inlineToken(token));
  }

  #inlineToken(token: Token): unknown {
    switch (token.type) {
      case "text":
        return this.#text(token as Tokens.Text);
      // A backslash escape carries the character it escaped, already resolved.
      case "escape":
        return (token as Tokens.Escape).text;
      case "strong":
        return html`<strong>${
          this.#inline((token as Tokens.Strong).tokens)
        }</strong>`;
      case "em":
        return html`<em>${this.#inline((token as Tokens.Em).tokens)}</em>`;
      case "del":
        return html`<del>${this.#inline((token as Tokens.Del).tokens)}</del>`;
      case "codespan":
        return html`<code>${(token as Tokens.Codespan).text}</code>`;
      case "br":
        return html`<br>`;
      case "link":
        return this.#link(token as Tokens.Link);
      case "image":
        return this.#image(token as Tokens.Image);
      case "checkbox":
        return this.#checkbox(token as Tokens.Checkbox);
      // Raw markup in the source is not rendered.
      case "html":
      default:
        return nothing;
    }
  }

  #text(token: Tokens.Text): unknown {
    if (token.tokens) return this.#inline(token.tokens);
    return decodeEntities(token.text);
  }

  #heading(token: Tokens.Heading): unknown {
    const id = this.#headingIds.idFor(token.tokens);
    const content = this.#inline(token.tokens);
    // A tag name cannot be bound, so each level names its own tag.
    switch (token.depth) {
      case 1:
        return html`<h1 id=${id}>${content}</h1>`;
      case 2:
        return html`<h2 id=${id}>${content}</h2>`;
      case 3:
        return html`<h3 id=${id}>${content}</h3>`;
      case 4:
        return html`<h4 id=${id}>${content}</h4>`;
      case 5:
        return html`<h5 id=${id}>${content}</h5>`;
      default:
        return html`<h6 id=${id}>${content}</h6>`;
    }
  }

  #code(token: Tokens.Code): unknown {
    const language = (token.lang ?? "").match(/^\S*/)?.[0] ?? "";
    const text = `${token.text.replace(/\n$/, "")}\n`;
    return html`
      <div class="code-block-container">
        <pre><code
              class=${language ? `language-${language}` : nothing}
            >${text}</code></pre>
        <cf-copy-button
          class="code-copy-button"
          .text=${text}
          variant="ghost"
          size="sm"
          icon-only
        ></cf-copy-button>
      </div>
    `;
  }

  #list(token: Tokens.List): unknown {
    const items = token.items.map((item) =>
      html`<li>${this.blocks(item.tokens)}</li>`
    );
    if (!token.ordered) return html`<ul>${items}</ul>`;
    const start = typeof token.start === "number" && token.start !== 1
      ? token.start
      : nothing;
    return html`<ol start=${start}>${items}</ol>`;
  }

  #checkbox(token: Tokens.Checkbox): unknown {
    const index = this.#checkboxes++;
    // A reader can toggle the box, which leaves the DOM disagreeing with the
    // document. `live` compares the binding against what the box currently
    // holds rather than against what was last rendered, so the next render
    // puts the box back to what the document says.
    return html`
      <input
        type="checkbox"
        .checked=${live(token.checked)}
        @change=${(event: Event) =>
          this.#callbacks.checkboxToggled(
            index,
            (event.target as HTMLInputElement).checked,
          )}
      >
    `;
  }

  #table(token: Tokens.Table): unknown {
    const header = token.header.map((cell) => this.#cell(cell));
    const rows = token.rows.map((row) =>
      html`<tr>${row.map((cell) => this.#cell(cell))}</tr>`
    );
    const body = rows.length === 0 ? nothing : html`<tbody>${rows}</tbody>`;
    // The wrapper scrolls a table wider than the screen instead of letting it
    // overflow the markdown block; the column widths in the component's CSS
    // keep a table from cramming its columns to fit.
    return html`
      <div class="table-scroll">
        <table><thead><tr>${header}</tr></thead>${body}</table>
      </div>
    `;
  }

  #cell(cell: Tokens.TableCell): unknown {
    const align = cell.align ?? nothing;
    const content = this.#inline(cell.tokens);
    return cell.header
      ? html`<th align=${align}>${content}</th>`
      : html`<td align=${align}>${content}</td>`;
  }

  /**
   * Renders a link. This template and `#image()` below sit inline in a run of
   * text, so each one stays on a single line: a line break inside it would put
   * a space beside the element.
   */
  #link(token: Tokens.Link): unknown {
    const label = decodeEntities(token.text);
    const link = token.href;
    // A link whose target is a cell rather than a document renders as a pill
    // that resolves the cell. The runner decides what one looks like, in both
    // the plain `/of:bafy.../field` form and the cross-space
    // `/@did:key:.../of:bafy.../field` one.
    if (matchLLMFriendlyLink.test(link)) {
      return html`<cf-cell-link .link=${link} .label=${label}></cf-cell-link>`;
    }
    const content = this.#inline(token.tokens);
    const href = safeUrl(link);
    if (href === null) return content;
    const title = token.title ? decodeEntities(token.title) : nothing;
    return html`<a href=${href} title=${title}>${content}</a>`;
  }

  #image(token: Tokens.Image): unknown {
    const src = safeImageUrl(token.href);
    const alt = decodeEntities(token.text);
    if (src === null) return alt;
    const title = token.title ? decodeEntities(token.title) : nothing;
    return html`<img src=${src} alt=${alt} title=${title}>`;
  }
}

/**
 * Renders a markdown document as a Lit template.
 *
 * A fresh builder per call restarts the duplicate-heading suffixes and the
 * checkbox numbering, so the same document always renders the same ids and
 * reports the same checkbox indices.
 */
export function markdownTemplate(
  source: string,
  callbacks: MarkdownCallbacks,
): unknown {
  if (!source) return nothing;
  const tokens = Lexer.lex(source, { breaks: true, gfm: true });
  return new MarkdownTemplate(callbacks).blocks(tokens);
}
