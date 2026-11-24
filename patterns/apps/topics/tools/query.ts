/**
 * What the Topics browser's search box asks for, and the indexes it answers
 * from: who has written on the board, and which Topics refer to which.
 *
 * A query is words separated by spaces. A plain word is a case-insensitive
 * regular expression a Topic matches as `deno task topics search` matches a
 * term. `by:<name>` keeps the Topics someone whose name matches wrote, filed,
 * or linked on; `in:<fields>` limits where plain words match, as `--in` does;
 * `is:unread` keeps the Topics with activity the person has not seen, and
 * `is:settled` and `is:open` the Topics whose titles do and do not begin
 * with a settled mark such as `[RESOLVED]`. A word in double quotes is
 * matched literally, and an author's name in them whole, so
 * `by:"Egory L7 (agent)"` names one author. A Topic's number, written `42`,
 * `#42`, or `top/42`, puts that Topic first.
 */

import {
  type Field,
  FIELDS,
  matches,
  type SearchHit,
  searchTopics,
  type Topic,
} from "./mirror.ts";

/** A query, as {@link parseQuery} reads it. */
export interface Query {
  terms: RegExp[];
  authors: RegExp[];
  fields?: Field[];
  is: ("unread" | "settled" | "open")[];

  /** A Topic number the query names, which is listed first. */
  number?: string;
}

/** A title marking its Topic as settled: resolved, landed, and the like. */
const SETTLED =
  /^\s*\[(RESOLVED|OBSOLETE|DUPLICATE|DUP|LANDED|DONE|CLOSED|FIXED|WONTFIX|SUPERSEDED|MERGED|ABANDONED)\b/i;

/** Whether `topic`'s title marks it as settled. */
export function settled(topic: Topic): boolean {
  return SETTLED.test(topic.title);
}

/**
 * The words of `text`, a quoted run counting as one, its quotes kept; a
 * backslash in quotes stands for the character after it.
 */
function words(text: string): string[] {
  return [...text.matchAll(/(?:[^\s"]+|"(?:[^"\\]|\\.)*"?)+/g)].map((m) =>
    m[0]
  );
}

/**
 * The pattern a query's value stands for, case-insensitively: quoted, its
 * text literally, the whole of what it matches when `whole` is set and the
 * quote is closed; otherwise the value as a regular expression, literally
 * when it is not a valid one.
 */
function patternOf(value: string, whole = false): RegExp {
  const quoted = /^"((?:[^"\\]|\\.)*)("?)$/.exec(value);
  if (quoted !== null) {
    const text = literal(quoted[1].replace(/\\(.)/g, "$1"));
    return new RegExp(whole && quoted[2] === '"' ? `^${text}$` : text, "i");
  }
  try {
    return new RegExp(value, "i");
  } catch {
    return new RegExp(literal(value), "i");
  }
}

/**
 * A regular expression matching `text` literally, written as a person would
 * write it, unlike `RegExp.escape`, which also escapes a leading letter.
 */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** The query `text` is. */
export function parseQuery(text: string): Query {
  const query: Query = { terms: [], authors: [], is: [] };
  for (const word of words(text)) {
    const [, key, value] = /^(by|in|is):(.*)$/i.exec(word) ?? [];
    switch (key?.toLowerCase()) {
      case "by":
        // A `by:` still being typed asks for nothing yet.
        if (value !== "") query.authors.push(patternOf(value, true));
        continue;
      case "in": {
        const named = value.split(",").map((part) => part.trim().toLowerCase());
        const fields = FIELDS.filter((field) => named.includes(field));
        // A field the board does not have makes the whole word a plain one,
        // which matches nothing, rather than being passed over.
        if (fields.length === named.length) {
          query.fields = fields;
          continue;
        }
        break;
      }
      case "is": {
        const state = value.toLowerCase();
        if (state === "unread" || state === "settled" || state === "open") {
          query.is.push(state);
          continue;
        }
        break;
      }
    }
    const number = /^(?:top\/|#)?(\d+)$/.exec(word)?.[1];
    if (number !== undefined) query.number ??= number;
    query.terms.push(patternOf(word));
  }
  return query;
}

/** What a query is answered against beyond the Topics themselves. */
export interface Answering {
  /** Whether `topic` has activity the person has not seen. */
  unread(topic: Topic): boolean;

  /** Whether settled Topics are left out unless the query asks for them. */
  hideSettled: boolean;
}

/**
 * The Topics of `topics` that `query` asks for, most recently active first,
 * with the lines that matched, the Topic its number names first; and how
 * many settled Topics it left out only because they are settled. The Topic
 * a number in the query names is listed whatever else the query says.
 */
export function answer(
  topics: readonly Topic[],
  query: Query,
  { unread, hideSettled }: Answering,
): { hits: SearchHit[]; hidden: number } {
  const named = topics.find((topic) => topic.number === query.number);
  const wanted = (topic: Topic) =>
    query.authors.every((pattern) =>
      authorsOf(topic).some((name) => matches(name, pattern))
    ) &&
    query.is.every((state) =>
      state === "unread"
        ? unread(topic)
        : state === "settled"
        ? settled(topic)
        : !settled(topic)
    );
  const asked = searchTopics(topics, query.terms, { fields: query.fields })
    .filter(({ topic }) => topic !== named && wanted(topic));
  const keep = hideSettled && !query.is.includes("settled")
    ? asked.filter(({ topic }) => !settled(topic))
    : asked;
  return {
    hits: named === undefined
      ? keep
      : [{ topic: named, snippets: [] }, ...keep],
    hidden: asked.length - keep.length,
  };
}

/** Everyone who filed, commented on, or linked on `topic`. */
function authorsOf(topic: Topic): string[] {
  return [
    topic.createdBy,
    ...topic.comments.filter((c) => !c.removed).map((c) => c.author),
    ...topic.links.filter((l) => !l.removed).map((l) => l.addedBy),
  ].filter((name) => name !== "");
}

/** Someone who has written on the board, and how much. */
export interface Author {
  /** The name as the board stores it: `Sol (agent)`. */
  name: string;
  filed: number;
  comments: number;
  links: number;

  /** The numbers of the Topics they wrote on. */
  topics: Set<string>;

  /** When they last wrote. */
  last: number;
}

/** Everyone who has written on `topics`, most recently active first. */
export function authors(topics: readonly Topic[]): Author[] {
  const byName = new Map<string, Author>();
  const note = (
    name: string,
    topic: Topic,
    at: number,
    kind: "filed" | "comments" | "links",
  ) => {
    if (name === "") return;
    let author = byName.get(name);
    if (author === undefined) {
      author = {
        name,
        filed: 0,
        comments: 0,
        links: 0,
        topics: new Set(),
        last: 0,
      };
      byName.set(name, author);
    }
    author[kind]++;
    author.topics.add(topic.number);
    author.last = Math.max(author.last, at);
  };
  for (const topic of topics) {
    note(topic.createdBy, topic, topic.createdAt, "filed");
    for (const comment of topic.comments) {
      if (!comment.removed) {
        note(comment.author, topic, comment.sentAt, "comments");
      }
    }
    for (const link of topic.links) {
      if (!link.removed) note(link.addedBy, topic, link.addedAt ?? 0, "links");
    }
  }
  return [...byName.values()].sort((a, b) =>
    b.last - a.last || a.name.localeCompare(b.name)
  );
}

/** How the Topics of a board refer to each other. */
export interface References {
  /** The Topics each Topic mentions or cites, by number. */
  out: Map<string, Set<string>>;

  /** The Topics that mention or cite each Topic, by number. */
  in: Map<string, Set<string>>;
}

/** A Topic cited in prose as `top/42`. */
const CITED = /\btop\/(\d+)\b/g;

/**
 * Which of `topics` refer to which: by a mention recorded on the Topic, or
 * by citing it as `top/<number>` in its body or a comment.
 */
export function references(topics: readonly Topic[]): References {
  const numbers = new Set(topics.map((topic) => topic.number));
  const byReference = new Map<string, string>();
  for (const topic of topics) {
    byReference.set(topic.address, topic.number);
    byReference.set(topic.piece, topic.number);
  }
  const out = new Map<string, Set<string>>();
  const into = new Map<string, Set<string>>();
  const add = (from: string, to: string | undefined) => {
    if (to === undefined || to === from || !numbers.has(to)) return;
    if (!out.has(from)) out.set(from, new Set());
    out.get(from)?.add(to);
    if (!into.has(to)) into.set(to, new Set());
    into.get(to)?.add(from);
  };
  for (const topic of topics) {
    for (const mention of topic.mentions) {
      add(topic.number, byReference.get(mention));
    }
    const prose = [
      topic.body,
      ...topic.comments.filter((c) => !c.removed).map((c) => c.body),
    ];
    for (const text of prose) {
      for (const match of text.matchAll(CITED)) add(topic.number, match[1]);
    }
  }
  return { out, in: into };
}

/**
 * The family a name belongs to: its first word, less the kind the board
 * appends, so that the agents `Egory L7 (agent)`, `Egory ωG5 (agent)`, and
 * `Egory-E1 (agent)` are all of the family `Egory`.
 */
export function family(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim().split(/[\s-]+/)[0] ??
    "";
}

/**
 * `list` gathered into families, each counting what its members wrote,
 * most recently active first.
 */
export function families(list: readonly Author[]): Author[] {
  const byFamily = new Map<string, Author>();
  for (const author of list) {
    const name = family(author.name);
    const gathered = byFamily.get(name) ??
      { name, filed: 0, comments: 0, links: 0, topics: new Set(), last: 0 };
    gathered.filed += author.filed;
    gathered.comments += author.comments;
    gathered.links += author.links;
    for (const topic of author.topics) gathered.topics.add(topic);
    gathered.last = Math.max(gathered.last, author.last);
    byFamily.set(name, gathered);
  }
  return [...byFamily.values()].sort((a, b) =>
    b.last - a.last || a.name.localeCompare(b.name)
  );
}

/** The query naming the Topics `author`, or a family of authors, wrote on. */
export function byQuery(author: string, isFamily: boolean): string {
  return isFamily
    ? `by:^${literal(author)}\\b`
    : `by:"${author.replace(/["\\]/g, "\\$&")}"`;
}
