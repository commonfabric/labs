/**
 * The local copy of a Topics board that `deno task topics` reads, and what it
 * reads out of it. The copy holds raw documents of the board's space, each with the
 * revision it was read at, so a refresh asks the server only for documents
 * whose revision moved. Topics are assembled from those documents by following
 * the links between them the way the runtime resolves a link, without running
 * the Topics pattern, so a read costs no pattern execution and writes nothing.
 *
 * The layout read here is the one `packages/patterns/topics/main.tsx` and
 * `packages/patterns/topics/topic.tsx` store: the board's input document maps
 * each Topic number to its piece under `names`, a piece document links its
 * input document as `argument`, and a Topic's input document holds the title,
 * the body, and the comment and link records, each record usually a document
 * of its own.
 */

import { isKeyableObjectOrArray } from "@commonfabric/data-model";
import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import { maxOf, minOf } from "@commonfabric/utils/math";
import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * A document value reduced to JSON. A link is written as a {@link LinkMark};
 * a fabric value that is neither a link nor plain data (a byte sequence, for
 * one) is dropped, since nothing a Topic reader shows is held in one.
 */
export type Plain =
  | null
  | boolean
  | number
  | string
  | Plain[]
  | { [key: string]: Plain };

/**
 * A link inside a {@link Plain} value: the document it names (absent for the
 * document holding the link), that document's space where the link names one,
 * and the path inside that document's value.
 */
export type LinkMark = {
  $link: { id?: string; space?: string; path: string[] };
};

/**
 * One document of the copy: the revision it was read at, and its value. A
 * document held without a value is held for its revision alone, which spares
 * the server resending one the copy never reads, such as a content-addressed
 * schema.
 */
export interface HeldDoc {
  seq: number;
  value?: Plain;
}

/** What the copy persists between runs. */
export interface MirrorData {
  /** The DID of the board's space, once a refresh has named it. */
  space?: string;

  /**
   * The board's input document, once read from the board's piece. A piece's
   * input document is fixed when the piece is made; `deno task topics
   * sync --rebuild` reads it again regardless.
   */
  boardInput?: string;

  /**
   * The piece and input document each entry of the board's `names` map leads
   * to, keyed by the document the entry links. An entry usually links a
   * document that only links onward to the piece.
   */
  pieces: Record<string, PieceInput>;

  docs: Record<string, HeldDoc>;
}

/**
 * Where a `names` entry leads: the Topic piece's document, and its input
 * document.
 *
 * The documents between an entry and its piece are not watched, because
 * watching one makes the server send the piece document it links, whole. The
 * board's namespace never moves a number to another Topic, and a write names
 * the entry rather than the piece, so it reaches whatever piece the entry
 * leads to when it is made.
 */
export interface PieceInput {
  piece: string;
  input: string;
}

/** A Topic as the client shows it. */
export interface Topic {
  /** The board's number for the Topic, the `42` of `top/42`. */
  number: string;

  /**
   * The document the board's `names` map links for the Topic, `of:` and all:
   * the address the board hands out for it.
   */
  address: string;

  /** The Topic piece's document id. */
  piece: string;

  title: string;
  body: string;
  createdAt: number;
  createdBy: string;

  /** The newest of every timestamp the Topic holds, as the board orders by. */
  lastActivityAt: number;

  comments: TopicComment[];
  links: TopicLink[];

  /** The documents `mention` has recorded references to, as linked. */
  mentions: string[];
}

export interface TopicComment {
  author: string;
  body: string;
  sentAt: number;
  editedAt?: number;
  removed: boolean;
}

export interface TopicLink {
  kind: string;
  url: string;
  label: string;
  addedBy: string;
  addedAt?: number;
  removed: boolean;
}

/**
 * Reduces a decoded document value to {@link Plain}, returning `undefined`
 * for a value with no plain form.
 */
export function toPlain(value: unknown): Plain | undefined {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (isLinkRef(value)) {
    const { id, space, path } = linkRefPayload(value);
    const link: LinkMark["$link"] = {
      path: Array.isArray(path) ? path.map(String) : [],
    };
    if (typeof id === "string") link.id = id;
    if (typeof space === "string") link.space = space;
    return { $link: link };
  }
  if (Array.isArray(value)) return value.map((item) => toPlain(item) ?? null);
  if (!isKeyableObjectOrArray(value)) return undefined;
  const plain: { [key: string]: Plain } = {};
  for (const [key, item] of Object.entries(value)) {
    const reduced = toPlain(item);
    if (reduced !== undefined) plain[key] = reduced;
  }
  return plain;
}

/** The link a value is, or `undefined` when it is not one. */
export function linkOf(
  value: Plain | undefined,
): LinkMark["$link"] | undefined {
  if (!isObjectNotArray(value) || Object.keys(value).length !== 1) {
    return undefined;
  }
  const link = value.$link;
  if (!isObjectNotArray(link) || !Array.isArray(link.path)) return undefined;
  const { id, space } = link;
  return {
    path: link.path.map(String),
    ...(typeof id === "string" ? { id } : {}),
    ...(typeof space === "string" ? { space } : {}),
  };
}

/** A value read out of the copy, with the document it was read from. */
interface Position {
  doc: string;
  value: Plain | undefined;
}

/**
 * Reads values out of a copy's documents, recording every document a read
 * touched and every one it needed and the copy lacks. A link into another
 * space reads as nothing: a Topic's content lives in its board's space.
 */
export class DocReader {
  readonly #touched = new Set<string>();
  readonly #missing = new Set<string>();
  readonly #data: MirrorData;
  readonly #space: string;
  readonly #absent: ReadonlySet<string>;

  /**
   * `absent` names documents the server was asked for and does not hold;
   * they read as nothing rather than as missing.
   */
  constructor(
    data: MirrorData,
    space: string,
    absent: ReadonlySet<string> = new Set(),
  ) {
    this.#data = data;
    this.#space = space;
    this.#absent = absent;
  }

  /** Every document a read so far touched. */
  get touched(): ReadonlySet<string> {
    return this.#touched;
  }

  /** Every document a read so far needed and the copy lacks. */
  get missing(): ReadonlySet<string> {
    return this.#missing;
  }

  /** The root of document `id`'s value. */
  root(id: string): Position {
    return this.follow({ doc: id, value: { $link: { id, path: [] } } });
  }

  /** The value `at` stands for, with every link on the way followed. */
  follow(at: Position): Position {
    const seen = new Set<string>();
    let current = at;
    for (;;) {
      const link = linkOf(current.value);
      if (link === undefined) return current;
      if (link.space !== undefined && link.space !== this.#space) {
        return { doc: current.doc, value: undefined };
      }
      const id = link.id ?? current.doc;
      const key = JSON.stringify([id, link.path]);
      if (seen.has(key)) {
        throw new Error(`The link to \`${id}\` at \`${key}\` is a cycle.`);
      }
      seen.add(key);
      this.#touched.add(id);
      const held = this.#data.docs[id];
      if (held?.value === undefined) {
        if (!this.#absent.has(id)) this.#missing.add(id);
        return { doc: id, value: undefined };
      }
      current = link.path.reduce<Position>(
        (position, key) => this.child(position, key),
        { doc: id, value: held.value },
      );
    }
  }

  /** The value at `key` under `at`. */
  child(at: Position, key: string): Position {
    const { doc, value } = this.follow(at);
    if (Array.isArray(value)) {
      return { doc, value: /^\d+$/.test(key) ? value[Number(key)] : undefined };
    }
    return { doc, value: isObjectNotArray(value) ? value[key] : undefined };
  }

  /** The elements of the array at `at`, each followed. */
  items(at: Position): Position[] {
    const { doc, value } = this.follow(at);
    return Array.isArray(value)
      ? value.map((item) => this.follow({ doc, value: item }))
      : [];
  }

  text(at: Position, key: string): string {
    const { value } = this.follow(this.child(at, key));
    return typeof value === "string" ? value : "";
  }

  number(at: Position, key: string): number | undefined {
    const { value } = this.follow(this.child(at, key));
    return typeof value === "number" ? value : undefined;
  }

  /**
   * The author record at `key` as `Name (kind)`, falling back to the legacy
   * display name stored under `legacyKey`.
   */
  author(at: Position, key: string, legacyKey: string): string {
    const author = this.child(at, key);
    const name = this.text(author, "name").trim();
    const kind = this.text(author, "kind").trim();
    if (name !== "") return kind === "" ? name : `${name} (${kind})`;
    return this.text(at, legacyKey).trim();
  }
}

/**
 * The documents the board's `names` map links, by Topic number. The links are
 * not followed: the copy keeps no piece documents. A key that is not a number
 * names no Topic, as the board's own namespace reads it.
 */
export function topicPieces(
  reader: DocReader,
  boardInput: string,
): Map<string, string> {
  const names = reader.follow(reader.child(reader.root(boardInput), "names"));
  const pieces = new Map<string, string>();
  if (!isObjectNotArray(names.value)) return pieces;
  for (const [number, entry] of Object.entries(names.value)) {
    const link = linkOf(entry);
    if (/^(0|[1-9][0-9]*)$/.test(number) && link?.id !== undefined) {
      pieces.set(number, link.id);
    }
  }
  return pieces;
}

/**
 * Assembles the Topic whose input document is `input`. A Topic with
 * documents the copy lacks assembles with those parts empty, and the reader's
 * `missing` names them.
 */
export function assembleTopic(
  reader: DocReader,
  number: string,
  address: string,
  { piece, input }: PieceInput,
): Topic {
  const root = reader.root(input);
  const comments = reader.items(reader.child(root, "comments")).map((at) => ({
    author: reader.author(at, "author", "authorName"),
    body: reader.text(at, "body"),
    sentAt: reader.number(at, "sentAt") ?? 0,
    ...optionalNumber("editedAt", reader.number(at, "editedAt")),
    removedAt: reader.number(at, "removedAt"),
  }));
  const links = reader.items(reader.child(root, "links")).map((at) => ({
    kind: reader.text(at, "kind") || "web",
    url: reader.text(at, "url"),
    label: reader.text(at, "label"),
    addedBy: reader.author(at, "addedBy", "addedByName"),
    ...optionalNumber("addedAt", reader.number(at, "addedAt")),
    removedAt: reader.number(at, "removedAt"),
  }));
  const createdAt = reader.number(root, "createdAt") ?? 0;
  const lastActivityAt = maxOf([
    createdAt,
    reader.number(root, "bodyUpdatedAt") ?? 0,
    reader.number(root, "titleUpdatedAt") ?? 0,
    ...comments.flatMap((c) => [c.sentAt, c.editedAt ?? 0, c.removedAt ?? 0]),
    ...links.flatMap((l) => [l.addedAt ?? 0, l.removedAt ?? 0]),
  ]);
  const mentioned = reader.follow(reader.child(root, "mentioned")).value;
  return {
    number,
    address,
    piece,
    title: reader.text(root, "title"),
    body: reader.text(root, "body"),
    createdAt,
    createdBy: reader.author(root, "createdBy", "createdByName"),
    lastActivityAt,
    comments: comments.map(({ removedAt, ...comment }) => ({
      ...comment,
      removed: removedAt !== undefined,
    })),
    links: links.map(({ removedAt, ...link }) => ({
      ...link,
      removed: removedAt !== undefined,
    })),
    mentions: Array.isArray(mentioned)
      ? mentioned.flatMap((entry) => linkOf(entry)?.id ?? [])
      : [],
  };
}

/**
 * Whether the Topic input document `input` holds a title, comments, and links
 * where the Topics pattern stores them. A Topic stored some other way reads
 * as blank, so a caller reports it rather than showing it as empty.
 */
export function storedAsExpected(reader: DocReader, input: string): boolean {
  const root = reader.root(input);
  const at = (key: string) => reader.follow(reader.child(root, key)).value;
  return typeof at("title") === "string" && Array.isArray(at("comments")) &&
    Array.isArray(at("links"));
}

function optionalNumber<K extends string>(
  key: K,
  value: number | undefined,
): { [P in K]?: number } {
  const result: { [P in K]?: number } = {};
  if (value !== undefined) result[key] = value;
  return result;
}

/** A Topic that matched a search, with the lines that matched. */
export interface SearchHit {
  topic: Topic;
  snippets: string[];
}

/** Lines of context shown for each matching Topic. */
const SNIPPETS_PER_TOPIC = 3;

/** Characters of a matching line shown around its first match. */
const SNIPPET_WIDTH = 200;

/**
 * The Topics matching every one of `patterns` somewhere in the title, the
 * body, a comment, a link, or the name of an author, or in those of them
 * `fields` names, newest activity first, less those whose titles match a
 * pattern of `exclude`. Retracted comments and links are not searched. With
 * no patterns, every Topic not excluded matches.
 */
export function searchTopics(
  topics: readonly Topic[],
  patterns: readonly RegExp[],
  { fields = FIELDS, exclude = [] }: SearchScope = {},
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const topic of topics) {
    if (exclude.some((pattern) => pattern.test(topic.title))) continue;
    const sections = topicSections(topic).filter(({ field }) =>
      fields.includes(field)
    );
    if (!patterns.every((p) => sections.some(({ text }) => p.test(text)))) {
      continue;
    }
    const snippets = sections.flatMap(({ field, label, text }) =>
      field === "title" || field === "authors"
        ? []
        : text.split("\n").flatMap((line) => {
          const at = firstMatch(line, patterns);
          return at === undefined ? [] : [`${label}: ${excerpt(line, at)}`];
        })
    ).slice(0, SNIPPETS_PER_TOPIC);
    hits.push({ topic, snippets });
  }
  return hits.sort((a, b) => b.topic.lastActivityAt - a.topic.lastActivityAt);
}

/** The parts of a Topic a search term can match. */
export const FIELDS = [
  "title",
  "body",
  "comments",
  "links",
  "authors",
] as const;

/** One of {@link FIELDS}. */
export type Field = typeof FIELDS[number];

/** Where a search looks, and which Topics it leaves out by their titles. */
export interface SearchScope {
  /** The parts a term may match, every part when not given. */
  fields?: readonly Field[];

  /** Patterns a Topic's title matches to be left out. */
  exclude?: readonly RegExp[];
}

/**
 * The searchable parts of a Topic: each is one of {@link FIELDS}, with a
 * label a match is shown under and the text it matches.
 */
function topicSections(
  topic: Topic,
): { field: Field; label: string; text: string }[] {
  const comments = presentComments(topic);
  const links = topic.links.filter((link) => !link.removed);
  return [
    { field: "title", label: "title", text: topic.title },
    { field: "body", label: "body", text: topic.body },
    ...comments.map((comment, index) => ({
      field: "comments" as const,
      label: `comment ${index + 1} (${comment.author})`,
      text: comment.body,
    })),
    ...links.map((link) => ({
      field: "links" as const,
      label: "link",
      text: `${link.label} ${link.url}`,
    })),
    ...[
      topic.createdBy,
      ...comments.map((comment) => comment.author),
      ...links.map((link) => link.addedBy),
    ].map((text) => ({ field: "authors" as const, label: "author", text })),
  ];
}

function firstMatch(
  line: string,
  patterns: readonly RegExp[],
): number | undefined {
  const found = patterns.map((pattern) => line.search(pattern)).filter((at) =>
    at >= 0
  );
  return found.length === 0 ? undefined : minOf(found);
}

function excerpt(line: string, at: number): string {
  const trimmed = line.trim();
  const offset = at - (line.length - line.trimStart().length);
  if (trimmed.length <= SNIPPET_WIDTH) return trimmed;
  const start = Math.max(
    0,
    Math.min(offset - 60, trimmed.length - SNIPPET_WIDTH),
  );
  const end = start + SNIPPET_WIDTH;
  return (start > 0 ? "…" : "") + trimmed.slice(start, end) +
    (end < trimmed.length ? "…" : "");
}

/** The moment a listing is made, and the time zone it is read in. */
export interface Now {
  now: number;
  timeZone: string;
}

/**
 * When `at` was, as seen at `now`: an age within the last day (`just now`,
 * `12m ago`, `5h ago`), and otherwise the day in the time zone, as
 * `2026-10-18`; `-` for a missing timestamp. Ten columns wide, so a listing's
 * titles line up.
 */
function when(at: number, { now, timeZone }: Now): string {
  const minutes = Math.floor((now - at) / 60_000);
  const label = at <= 0
    ? "-"
    : minutes < 1
    ? "just now"
    : minutes < 60
    ? `${minutes}m ago`
    : minutes < 24 * 60
    ? `${Math.floor(minutes / 60)}h ago`
    : new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  return label.padEnd(10);
}

/** `2026-10-18 14:31Z`. */
function minute(at: number): string {
  return at > 0
    ? new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z"
    : "-";
}

/** The comments that are not retracted, oldest first, as the Topic shows them. */
function presentComments(topic: Topic): TopicComment[] {
  return topic.comments.filter((comment) => !comment.removed).toSorted((a, b) =>
    a.sentAt - b.sentAt
  );
}

/** `1 comment`, `2 comments`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * One line naming a Topic: its number, when it was last active as seen at
 * `now`, its title, and its size.
 */
export function formatTopicLine(topic: Topic, now: Now): string {
  const present = presentComments(topic).length;
  return `top/${topic.number}  ${when(topic.lastActivityAt, now)}  ` +
    topic.title +
    (present === 0 ? "" : `  [${count(present, "comment")}]`);
}

/**
 * A whole Topic as Markdown: a header, the body, the links, and the thread.
 * Retracted comments and links are left out, as the Topic's own view leaves
 * them out.
 */
export function formatTopic(
  topic: Topic,
  address: string,
  window: ThreadWindow = {},
): string {
  const comments = presentComments(topic);
  const shown = threadOf(topic, window);
  const links = topic.links.filter((link) => !link.removed);
  const lines = [
    `# top/${topic.number}: ${topic.title}`,
    "",
    `Address: ${address}`,
    `Created ${minute(topic.createdAt)}` +
    (topic.createdBy === "" ? "" : ` by ${topic.createdBy}`) +
    `; last activity ${minute(topic.lastActivityAt)}; ` +
    `${count(comments.length, "comment")}; ${count(links.length, "link")}.`,
    "",
    topic.body.trim() === "" ? "(no body)" : topic.body.trimEnd(),
  ];
  if (links.length > 0) {
    lines.push("", "## Links", "");
    for (const link of links) {
      const label = link.label === "" || link.label === link.url
        ? ""
        : ` ${link.label}`;
      lines.push(
        `- [${link.kind}]${label} <${link.url}>` +
          (link.addedBy === "" ? "" : ` (${link.addedBy})`),
      );
    }
  }
  if (comments.length > 0) {
    lines.push("", "## Comments");
    if (shown.length < comments.length) {
      lines.push("", `${shown.length} of ${comments.length} shown.`);
    }
    for (const { number, comment } of shown) {
      const edited = comment.editedAt === undefined
        ? ""
        : `, edited ${minute(comment.editedAt)}`;
      lines.push(
        "",
        `### ${number}. ${comment.author || "unknown"}, ` +
          `${minute(comment.sentAt)}${edited}`,
        "",
        comment.body.trimEnd(),
      );
    }
  }
  return lines.join("\n");
}

/** Which of a long thread's comments to show. */
export interface ThreadWindow {
  /** Only comments sent at or after this time, in milliseconds. */
  since?: number;

  /** Only the last this many comments, after `since`. */
  last?: number;
}

/**
 * The comments of `topic` that `window` shows, oldest first, each with its
 * number in the whole thread.
 */
export function threadOf(
  topic: Topic,
  { since, last }: ThreadWindow,
): { number: number; comment: TopicComment }[] {
  const numbered = presentComments(topic).map((comment, index) => ({
    number: index + 1,
    comment,
  })).filter(({ comment }) => since === undefined || comment.sentAt >= since);
  return last === undefined
    ? numbered
    : numbered.slice(Math.max(0, numbered.length - last));
}

/**
 * A Topic as plain data for a program to read: its present comments, those
 * `window` shows, numbered in the whole thread, and its present links.
 */
export function topicRecord(topic: Topic, window: ThreadWindow = {}) {
  return {
    number: topic.number,
    address: `/${topic.address}`,
    title: topic.title,
    body: topic.body,
    createdAt: topic.createdAt,
    createdBy: topic.createdBy,
    lastActivityAt: topic.lastActivityAt,
    comments: threadOf(topic, window).map(({ number, comment }) => ({
      number,
      author: comment.author,
      body: comment.body,
      sentAt: comment.sentAt,
      ...(comment.editedAt === undefined ? {} : { editedAt: comment.editedAt }),
    })),
    links: topic.links.filter((link) => !link.removed).map((link) => ({
      kind: link.kind,
      url: link.url,
      label: link.label,
      addedBy: link.addedBy,
      ...(link.addedAt === undefined ? {} : { addedAt: link.addedAt }),
    })),
    mentions: topic.mentions,
  };
}
