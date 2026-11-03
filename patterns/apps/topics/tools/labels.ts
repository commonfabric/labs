/**
 * What Contextual Flow Control (CFC) says of a part of a Topic, read from
 * the label envelope its document stores beside its value: who may learn it
 * (its confidentiality, an AND of clauses, each an OR of principals), what
 * vouches for it (its integrity), and which principals
 * that integrity says wrote it. The envelope is read, its labels resolved,
 * and the part's label found, by the runtime's own functions, as a content
 * read of the part resolves it; an envelope or a label document that cannot
 * be read leaves the part marked unreadable rather than unlabeled.
 */

import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  integrityLabels,
  type LabelDisplayFit,
} from "@commonfabric/html/display-fit-atoms";
import type { CfcConfClause, IFCLabel } from "@commonfabric/runner/cfc";
import { wholeValueLabel } from "@commonfabric/runner/cfc/consumed-label";
import { redactCaveatSourcesForDisplay } from "@commonfabric/runner/cfc/label-view-core";
import { cfcLabelViewFromMetadata } from "@commonfabric/runner/cfc/label-view-state";
import {
  type CfcLabelDocumentReader,
  interpretStoredEnvelope,
  resolveStoredCfcMetadata,
} from "@commonfabric/runner/cfc/metadata";
import { exactPrincipalAttestations } from "@commonfabric/runner/cfc/represents-principal";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import {
  activityOf,
  type Plain,
  type Topic,
  type TopicComment,
  type TopicLink,
} from "./mirror.ts";

/** What CFC says of one part of a Topic. */
export interface PartLabels {
  /**
   * The part's label as a display fits it against its ceiling: who may
   * learn any of it, and what vouches for all of it.
   */
  label: IFCLabel;

  /**
   * Who may learn the part: every clause must hold, and a clause holds for
   * any one of its alternatives, each written as text, a caveat's source
   * left out.
   */
  confidentiality: string[][];

  /** What vouches for all of the part as it stands, each atom as text. */
  integrity: string[];

  /**
   * The principals that integrity says wrote the part, read as the runtime
   * reads an `authored-by` attestation.
   */
  authors: string[];

  /**
   * Set when the document's labels could not be read, or its authorship
   * was spelled otherwise than the runtime mints it, which is not the same
   * as its having no labels.
   */
  unreadable?: true;
}

/** What is said of a part whose labels could not be read. */
export const UNREADABLE: PartLabels = {
  label: {},
  confidentiality: [],
  integrity: [],
  authors: [],
  unreadable: true,
};

/** A document's value at a path, with the envelope the document stores. */
export interface Labeled {
  id: string;

  /** The envelope, `null` for none, absent when it is not known. */
  cfc: Plain | null | undefined;
  path: readonly string[];
}

/**
 * What CFC says of a part of a Topic shown as the values `parts`, reached
 * by following links from the slots `reached`, as the runtime would say it
 * of a value it shows. Who may learn the part is the confidentiality of
 * everything a content read of each value consumes, and of each slot, read
 * whole in every class, a link's own label included. What vouches for the
 * part, and who wrote it, is what the label view at every value's own
 * position says, as the runtime's text boundary and authorship read it.
 * It is `undefined` when no document says anything; an envelope that is
 * not known or cannot be read, or an authorship claim spelled otherwise
 * than the runtime mints it, leaves the part unreadable. `read` reads a
 * content-addressed label document an envelope names by reference, as the
 * runtime reads one.
 */
export function labelsAt(
  parts: readonly Labeled[],
  reached: readonly Labeled[],
  read: CfcLabelDocumentReader,
): PartLabels | undefined {
  const metadataOf = (labeled: Labeled) => {
    if (labeled.cfc === undefined) {
      throw new Error(`The labels of \`${labeled.id}\` are not known.`);
    }
    const stored = interpretStoredEnvelope(labeled.id, labeled.cfc);
    return stored === undefined
      ? undefined
      : resolveStoredCfcMetadata(stored, read);
  };
  const confidentiality: CfcConfClause[] = [];
  const add = (label: IFCLabel | undefined) => {
    for (const clause of label?.confidentiality ?? []) {
      if (!confidentiality.some((held) => deepEqual(held, clause))) {
        confidentiality.push(clause);
      }
    }
  };
  let labeled = false;
  const vouched: { integrity: CfcAtom[]; authors: string[] }[] = [];
  try {
    for (const slot of reached) {
      const metadata = metadataOf(slot);
      if (metadata === undefined) continue;
      labeled = true;
      add(wholeValueLabel(metadata, slot.path, "all"));
    }
    for (const part of parts) {
      const metadata = metadataOf(part);
      if (metadata === undefined) {
        vouched.push({ integrity: [], authors: [] });
        continue;
      }
      labeled = true;
      add(wholeValueLabel(metadata, part.path));
      const view = cfcLabelViewFromMetadata(metadata, [...part.path]);
      const authors = exactPrincipalAttestations(view, "authored-by", false);
      if (authors === undefined) return UNREADABLE;
      vouched.push({
        integrity: view === undefined ? [] : [...integrityLabels(view)],
        authors,
      });
    }
  } catch {
    return UNREADABLE;
  }
  if (!labeled) return undefined;
  // What vouches for every value shown vouches for the part.
  const [first, ...rest] = vouched;
  const integrity = (first?.integrity ?? []).filter((atom) =>
    rest.every((other) => other.integrity.some((held) => deepEqual(held, atom)))
  );
  const authors = (first?.authors ?? []).filter((author) =>
    rest.every((other) => other.authors.includes(author))
  );
  const label = { confidentiality, integrity };
  const [shown] = redactCaveatSourcesForDisplay({
    version: 1,
    entries: [{ path: [], label }],
  }).entries;
  return {
    label,
    confidentiality: (shown.label.confidentiality ?? []).map((clause) =>
      isObjectNotArray(clause) && Array.isArray(clause.anyOf)
        ? clause.anyOf.map(atomText)
        : [atomText(clause)]
    ),
    integrity: (shown.label.integrity ?? []).map(atomText),
    authors,
  };
}

/**
 * An atom as text: a principal or fact by the last part of its type and
 * its fields, `User(did:key:z6Mk…x1Yz)`; one named by its kind,
 * `authored-by(did:key:…)`; and a string as itself.
 */
export function atomText(atom: unknown): string {
  if (typeof atom === "string") return atom;
  if (!isObjectNotArray(atom)) return JSON.stringify(atom) ?? String(atom);
  const { type, kind, ...fields } = atom;
  const name = typeof type === "string"
    ? type.split("/").pop() ?? type
    : typeof kind === "string"
    ? kind
    : "atom";
  const values = Object.values(fields).map((value) =>
    typeof value === "string" ? shortDid(value) : JSON.stringify(value)
  );
  return values.length === 0 ? name : `${name}(${values.join(", ")})`;
}

/** A DID cut to its start and end, which tell DIDs apart; other text whole. */
export function shortDid(text: string): string {
  return /^did:/.test(text) && text.length > 28
    ? `${text.slice(0, 18)}…${text.slice(-4)}`
    : text;
}

/**
 * Whether a display whose ceiling `fit` decides admits a part labeled
 * `labels`: one with no labels, or with labels it can read and that fit.
 */
export function admits(
  fit: LabelDisplayFit,
  labels: PartLabels | undefined,
): boolean {
  return labels === undefined ||
    (labels.unreadable !== true && fit(labels.label));
}

/**
 * `topics` as a display whose ceiling `fit` decides may hold them: each
 * part the display does not admit blanked, its labels kept to say so, so
 * that nothing a view draws, searches, or edits holds what it withheld.
 */
export function redact(
  topics: readonly Topic[],
  fit: LabelDisplayFit,
): Topic[] {
  return topics.map((topic) => {
    const comments = topic.comments.map((comment): TopicComment =>
      admits(fit, comment.labels) ? comment : {
        author: "",
        body: "",
        sentAt: 0,
        // Whether it was taken back is withheld too.
        removed: false,
        withheld: true,
        ...(comment.labels === undefined ? {} : { labels: comment.labels }),
      }
    );
    const links = topic.links.map((link): TopicLink =>
      admits(fit, link.labels) ? link : {
        kind: "",
        url: "",
        label: "",
        addedBy: "",
        removed: false,
        withheld: true,
        ...(link.labels === undefined ? {} : { labels: link.labels }),
      }
    );
    const shown = admits(fit, topic.labels);
    const updatedAt = shown ? topic.updatedAt : 0;
    return {
      ...topic,
      ...(shown ? {} : {
        title: "",
        body: "",
        createdBy: "",
        createdAt: 0,
        updatedAt,
        mentions: [],
        withheld: true,
      }),
      comments,
      links,
      // Only the times of what is shown say when the Topic was active.
      lastActivityAt: activityOf(updatedAt, comments, links),
    };
  });
}
