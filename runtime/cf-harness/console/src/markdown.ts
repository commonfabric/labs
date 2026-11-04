import { html, nothing, type TemplateResult } from "lit";
import { decodeHTMLStrict as decodeEntities } from "entities";
import { Lexer, type MarkedToken, type Token, type Tokens } from "marked";

import { REFERENT_TOKEN_PATTERN } from "../../src/contracts/handle-table.ts";

/** The schemes a link in a rendered answer may point at. */
const LINK_SCHEMES = new Set(["http:", "https:"]);

/**
 * `href` and the host it goes to, when a link may point at it, and
 * `undefined` otherwise.
 */
const safeHref = (
  href: string,
): { href: string; host: string } | undefined => {
  try {
    const url = new URL(href);
    return LINK_SCHEMES.has(url.protocol)
      ? { href, host: url.host }
      : undefined;
  } catch {
    return undefined;
  }
};

/** What a rendering knows beside the source. */
interface Context {
  /** The strings return referents stand for, by token. */
  revealed: Readonly<Record<string, string>>;
}

/** The longest found string shown before it is cut. */
const MAX_FOUND_CHARS = 120;

/**
 * `found` as one line the reader can see all of: each control character, line
 * or paragraph separator, and direction mark spelled as an escape.
 */
export const visibleFound = (found: string): string =>
  found.replace(
    /[\p{Cc}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    (character) =>
      character === "\n"
        ? "\\n"
        : `\\u{${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}}`,
  );

/** `text` cut to `limit` characters, never inside one. */
export const cutFound = (text: string, limit = MAX_FOUND_CHARS): string => {
  const characters = Array.from(text);
  return characters.length <= limit
    ? text
    : `${characters.slice(0, limit).join("")}…`;
};

/**
 * `tokens` as the tokens the lexer documents. The lexer's `Token` also admits
 * a generic token whose `type` is any string, which only an extension
 * produces; this renderer installs none, so every token is one of these, and
 * a switch on `type` then narrows to each one's fields.
 */
const known = (tokens: readonly Token[] | undefined): readonly MarkedToken[] =>
  (tokens ?? []) as readonly MarkedToken[];

/** What a found string's chip says it is. */
const FOUND_BADGE = html`<span class="live-found-badge">found</span>`;

/**
 * `found` as something an agent found: isolated, so its direction cannot run
 * into the text around it, and badged, so it never reads as the answer's own
 * words. One line, with no space around it, since it may sit in a code block;
 * cut short where it is long, with the whole of it on hover.
 */
const foundChip = (found: string): TemplateResult => {
  const visible = visibleFound(found);
  return html`<bdi class="live-found" title=${visible}>${FOUND_BADGE}${
    cutFound(visible)
  }</bdi>`;
};

/**
 * `text` split at each token `pattern` matches: the text between tokens
 * through `plain`, and each token through `marked`, or left in the text where
 * `marked` returns `undefined`.
 */
export const splitAtTokens = <T>(
  text: string,
  pattern: RegExp,
  plain: (text: string) => T,
  marked: (token: string) => T | undefined,
): T[] => {
  const parts: T[] = [];
  let from = 0;
  for (const match of text.matchAll(new RegExp(pattern))) {
    const part = marked(match[0]);
    if (part === undefined) continue;
    parts.push(plain(text.slice(from, match.index)), part);
    from = match.index + match[0].length;
  }
  parts.push(plain(text.slice(from)));
  return parts;
};

/**
 * `text`, with each return referent the context reveals shown as the string
 * it stands for, marked as something an agent found rather than something the
 * answer's author wrote.
 */
const revealing = (text: string, context: Context): unknown[] =>
  splitAtTokens<unknown>(
    text,
    REFERENT_TOKEN_PATTERN,
    (plain) => plain,
    (token) =>
      Object.hasOwn(context.revealed, token)
        ? foundChip(context.revealed[token])
        : undefined,
  );

/**
 * Plain `text`, with each return referent `revealed` names shown as the
 * string it stands for, marked as found by an agent.
 */
export const revealedText = (
  text: string,
  revealed: Readonly<Record<string, string>> = {},
): unknown[] => revealing(text, { revealed });

const inline = (tokens: readonly Token[] | undefined, context: Context) =>
  known(tokens).map((token) => inlineToken(token, context));

const inlineToken = (token: MarkedToken, context: Context): unknown => {
  switch (token.type) {
    case "text":
      return textToken(token, context);
    case "escape":
      return token.text;
    case "strong":
      return html`<strong>${inline(token.tokens, context)}</strong>`;
    case "em":
      return html`<em>${inline(token.tokens, context)}</em>`;
    case "del":
      return html`<del>${inline(token.tokens, context)}</del>`;
    // A code span is written as it reads, character references included.
    case "codespan":
      return html`<code>${revealing(token.text, context)}</code>`;
    case "br":
      return html`<br>`;
    case "checkbox":
      return checkbox(token);
    // A link's label shows no found string: the owner would read it as where
    // the link goes, and the parent wrote the destination. The host it goes
    // to is shown beside it, so a label cannot pass for somewhere else.
    case "link": {
      const target = safeHref(decodeEntities(token.href));
      const label = inline(token.tokens, { revealed: {} });
      return target === undefined ? label : html`
        <a href="${target
          .href}" target="_blank" rel="noopener noreferrer">${label}</a>
        <span class="live-link-host">(${target.host})</span>
      `;
    }
    // An image in an answer is shown as its description: the pane loads
    // nothing an answer names.
    case "image":
      return decodeEntities(token.text);
    // Raw markup in the source is not rendered.
    default:
      return nothing;
  }
};

/** A task list's box, showing its state; the pane changes nothing. */
const checkbox = (token: Tokens.Checkbox): unknown =>
  token.checked
    ? html`<input type="checkbox" disabled checked>`
    : html`<input type="checkbox" disabled>`;

const textToken = (token: Tokens.Text, context: Context): unknown =>
  token.tokens === undefined
    ? revealing(decodeEntities(token.text), context)
    : inline(token.tokens, context);

const blocks = (tokens: readonly Token[], context: Context) =>
  known(tokens).map((token) => block(token, context));

const block = (token: MarkedToken, context: Context): unknown => {
  switch (token.type) {
    case "heading": {
      const content = inline(token.tokens, context);
      // A tag name cannot be bound, so each level names its own tag. An
      // answer's headings sit under the pane's own, so they start at h3.
      switch (token.depth) {
        case 1:
          return html`<h3>${content}</h3>`;
        case 2:
          return html`<h4>${content}</h4>`;
        case 3:
          return html`<h5>${content}</h5>`;
        default:
          return html`<h6>${content}</h6>`;
      }
    }
    case "paragraph":
      return html`<p>${inline(token.tokens, context)}</p>`;
    case "code":
      return html`<pre><code>${revealing(token.text, context)}</code></pre>`;
    case "blockquote":
      return html`<blockquote>${blocks(token.tokens, context)}</blockquote>`;
    case "list": {
      const items = token.items.map((item) =>
        html`<li>${blocks(item.tokens, context)}</li>`
      );
      return token.ordered
        ? html`<ol start="${
          typeof token.start === "number" ? token.start : 1
        }">${items}</ol>`
        : html`<ul>${items}</ul>`;
    }
    case "table":
      return html`
        <table>
          <thead>
            <tr>${token.header.map((cell) =>
              html`<th>${inline(cell.tokens, context)}</th>`
            )}</tr>
          </thead>
          <tbody>${token.rows.map((row) =>
            html`<tr>${
              row.map((cell) => html`<td>${inline(cell.tokens, context)}</td>`)
            }</tr>`
          )}</tbody>
        </table>
      `;
    case "hr":
      return html`<hr>`;
    case "checkbox":
      return checkbox(token);
    case "text":
      return textToken(token, context);
    // Raw markup in the source is not rendered, and what remains — a blank
    // line between blocks, a link reference definition — draws nothing.
    default:
      return nothing;
  }
};

/**
 * Renders a Markdown document as a Lit template. The document never becomes
 * markup: the lexer reads it into tokens, each token becomes a template, and
 * text reaches the page as text. Raw HTML in the source is dropped, and a
 * link is kept only when it points at a web address, with its host shown
 * beside it.
 *
 * `revealed` maps return referents to the strings they stand for. Each one
 * the document names in its text is shown as its string, on one line, cut
 * short, and marked as found by an agent; a link's destination is left as
 * written, so a found string never becomes where a link goes.
 */
export const markdownTemplate = (
  source: string,
  { revealed = {} }: { revealed?: Readonly<Record<string, string>> } = {},
): TemplateResult => html`${blocks(new Lexer().lex(source), { revealed })}`;
