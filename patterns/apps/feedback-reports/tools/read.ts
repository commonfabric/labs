/**
 * Reads a reports board's reports out of a local copy of its space, the way
 * the Topics client reads a Topics board: raw documents with their revisions
 * and CFC label envelopes, refreshed over a memory session of their own, with
 * nothing run and nothing committed. Each report carries the principals its
 * `authored-by` label names, which is who sent it.
 *
 * The layout read here is the one `../main.tsx` stores: the board's input
 * document holds `reports`, a list whose records are usually documents of
 * their own, and `topicOf`, each report's id to the Topic it was filed
 * under.
 */

import { isObjectNotArray } from "@commonfabric/js-values/types";

import {
  DocReader,
  type MirrorData,
  type Plain,
} from "../../topics/tools/mirror.ts";
import {
  applyDocs,
  type DocSource,
  heldContent,
  holding,
  locateBoard,
} from "../../topics/tools/sync.ts";

/** A position a {@link DocReader} read. */
type Position = ReturnType<DocReader["root"]>;

/** A report as the client reads it. */
export interface Report {
  /** The report's id, unique on the board. */
  id: string;

  /** The report's name, a label two reports may share. */
  name: string;
  kind: string;
  words?: string;

  /** The structured part, every field as stored, unknown ones included. */
  structured: { [key: string]: Plain };
  createdAt: number;

  /** The Topic the report was filed under, absent for a new report. */
  topic?: string;

  /** The principals the link's `authored-by` label names: who linked the
   * report. Present with `topic`. */
  topicAuthors?: string[];

  /** Set when the link's labels could not be read. */
  topicUnreadable?: true;

  /**
   * The principals the report's `authored-by` label names: its sender. Empty
   * when nothing attests who wrote it.
   */
  authors: string[];

  /**
   * Set when the report's labels could not be read, which leaves its sender
   * unknown rather than absent.
   */
  unreadable?: true;
}

/** The fields of a report whose labels say who wrote it. */
const ATTESTED_FIELDS = ["id", "name", "kind", "structured", "createdAt"];

/** The deepest a stored value is followed, past which it reads as nothing. */
const MAX_DEPTH = 32;

/**
 * Brings `data` up to date with the reports board whose piece is `board`,
 * in place, and returns its reports in the order they arrived.
 */
export async function readReports(
  data: MirrorData,
  board: string,
  source: DocSource,
): Promise<Report[]> {
  const { boardInput } = await locateBoard(data, board, source);
  const absent = new Set<string>();
  applyDocs(
    data,
    await source.fetch(
      heldContent(data),
      Object.entries(data.docs).map(([id, doc]) => holding(id, doc)),
    ),
    absent,
  );
  for (;;) {
    const reader = new DocReader(data, source.space, absent);
    const reports = assembleReports(reader, boardInput);
    if (reader.missing.size === 0) return reports;
    // Documents the copy has no value for; any that still has none after the
    // fetch reads as nothing.
    const ids = [...reader.missing];
    applyDocs(data, await source.fetch(ids, []), absent);
    for (const id of ids) {
      if (data.docs[id]?.value === undefined) absent.add(id);
    }
  }
}

/**
 * The reports of the board whose input document is `boardInput`, as far as
 * `reader`'s copy holds them; its `missing` names what else they need.
 */
export function assembleReports(
  reader: DocReader,
  boardInput: string,
): Report[] {
  const root = reader.root(boardInput);
  const linksAt = reader.child(root, "topicOf");
  const topicOf = objectOf(reader, linksAt);
  return reader.items(reader.child(root, "reports")).map((at) => {
    const id = reader.text(at, "id");
    const words = reader.follow(reader.child(at, "words")).value;
    const structured = objectOf(reader, reader.child(at, "structured"));
    const topic = topicOf?.[id];
    const labels = reader.labels(at, ATTESTED_FIELDS);
    const linked = typeof topic === "string" && topic !== "";
    const linkLabels = linked ? reader.labels(linksAt, [id]) : undefined;
    return {
      id,
      name: reader.text(at, "name"),
      kind: reader.text(at, "kind"),
      ...(typeof words === "string" ? { words } : {}),
      structured: structured ?? {},
      createdAt: reader.number(at, "createdAt") ?? 0,
      ...(linked
        ? {
          topic,
          topicAuthors: linkLabels?.authors ?? [],
          ...(linkLabels?.unreadable ? { topicUnreadable: true } : {}),
        }
        : {}),
      authors: labels?.authors ?? [],
      ...(labels?.unreadable ? { unreadable: true } : {}),
    };
  });
}

/** The value at `at` with every link inside it followed, as plain data. */
function plainOf(reader: DocReader, at: Position, depth: number): Plain {
  const { value } = reader.follow(at);
  if (depth > MAX_DEPTH) return null;
  if (Array.isArray(value)) {
    return reader.items(at).map((item) => plainOf(reader, item, depth + 1));
  }
  return objectOf(reader, at, depth) ?? value ?? null;
}

/**
 * The object at `at` with every link inside it followed, as plain data, or
 * `undefined` when the value there is not an object.
 */
function objectOf(
  reader: DocReader,
  at: Position,
  depth = 0,
): { [key: string]: Plain } | undefined {
  const { value } = reader.follow(at);
  if (!isObjectNotArray(value)) return undefined;
  const plain: { [key: string]: Plain } = {};
  for (const key of Object.keys(value)) {
    plain[key] = plainOf(reader, reader.child(at, key), depth + 1);
  }
  return plain;
}
