/**
 * Contract shape of the session-local handle table: short opaque tokens that
 * stand in for cell addresses in model-visible text, so a transcript never
 * has to carry a full LLM-friendly link. Shapes and token grammar only — the
 * minting and swapping machinery lives in `../handle-table.ts`.
 */

import type { JSONSchema } from "@commonfabric/api";
import type { FabricValue } from "@commonfabric/data-model";

import type { IFCLabel } from "@commonfabric/runner/cfc";

import type { HarnessSkillAcquisition } from "./skill.ts";

/** Discriminator value of a {@link HarnessHandleTable}. */
export const HARNESS_HANDLE_TABLE_TYPE = "cf-harness.handle-table";

/**
 * Referent category of an address-table entry. Non-cell document referents
 * live in {@link HarnessHandleTable.referents} under the distinct `cfh:v:`
 * token prefix rather than widening this address-only entry shape.
 */
export type HarnessHandleKind = "address";

/** A restriction on which harness position may consume an address handle. */
export type HarnessHandleCapability = "skill-context";

/** Prefix of every address-handle token (`cfh:a:<suffix>`). */
export const ADDRESS_HANDLE_TOKEN_PREFIX = "cfh:a:";

/**
 * Alphabet a token suffix is drawn from: the digits `2`-`9` and the lowercase
 * letters minus `i`, `l`, `o`, and `u` — 30 characters with no
 * easily-confused glyphs, so a token survives being retyped.
 */
export const HANDLE_TOKEN_ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";

/**
 * Number of alphabet characters in every minted token suffix. Minting is
 * fixed-width: a suffix collision re-derives a fresh five-character suffix
 * rather than extending the token, so no token is a prefix of another.
 */
export const MIN_HANDLE_TOKEN_SUFFIX_LENGTH = 5;

/**
 * Matches address-handle tokens in free text: `cfh:a:` followed by five or
 * more {@link HANDLE_TOKEN_ALPHABET} characters. Detection deliberately stays
 * open-ended even though minted suffixes are exactly five characters: a
 * longer alphabet run swallowed whole resolves to no entry and passes through
 * unknown, so a token abutting alphabet text is never substituted inside it.
 * Global, and therefore stateful under `exec()` — take a fresh copy via
 * `new RegExp(HANDLE_TOKEN_PATTERN)` where a shared `lastIndex` could leak
 * between calls.
 */
export const HANDLE_TOKEN_PATTERN = new RegExp(
  `cfh:a:[${HANDLE_TOKEN_ALPHABET}]{${MIN_HANDLE_TOKEN_SUFFIX_LENGTH},}`,
  "g",
);

/** Prefix of every referent-handle token (`cfh:v:<suffix>`). */
export const REFERENT_HANDLE_TOKEN_PREFIX = "cfh:v:";

/** Matches referent-handle tokens in free text, as the address pattern does. */
export const REFERENT_TOKEN_PATTERN = new RegExp(
  `cfh:v:[${HANDLE_TOKEN_ALPHABET}]{${MIN_HANDLE_TOKEN_SUFFIX_LENGTH},}`,
  "g",
);

/** Matches a token of either kind in free text. */
export const ANY_HANDLE_TOKEN_PATTERN = new RegExp(
  `cfh:[av]:[${HANDLE_TOKEN_ALPHABET}]{${MIN_HANDLE_TOKEN_SUFFIX_LENGTH},}`,
  "g",
);

/**
 * A referent a run holds that is not a cell: content a tool observed — a Loom
 * row — with the label it was admitted under. The token stands for it in
 * model-visible text, and a result that names the token gets a document
 * minted from this record and a link to it.
 *
 * The content and label reach a model-visible surface nowhere through this
 * entry: the model saw the content when the tool returned it, and
 * `describe_handle` reports the label's atom types alone.
 */
export interface HarnessHandleReferent {
  /** The full token, prefix included (`cfh:v:<suffix>`). */
  token: string;

  kind: "document";

  /** The tool that observed the referent. */
  source: string;

  /** The content as the model saw it, JSON. */
  value: FabricValue;

  /** The label the content was admitted under. */
  label: IFCLabel;

  /**
   * Where that label came from: the row's own `ifc`, or the label of the
   * query, assigned because the row carried none.
   */
  labelSource: "row" | "query";
}

/**
 * One handle: a token and the address it stands for.
 */
export interface HarnessHandleEntry {
  /** The full token, prefix included (`cfh:a:<suffix>`). */
  token: string;

  kind: HarnessHandleKind;

  /**
   * Canonical reference serialized by the runner's `renderCellReference()`.
   * Complete addresses include their space and scope; unresolved references
   * omit the unknown space and use an implicit base scope.
   */
  ref: string;

  /**
   * The runner's `addressKey()` of the referent's normalized link. Entry
   * identity: minting the same address twice returns the existing token.
   */
  addressKey: string;

  /**
   * An absent capability is a general address handle. `skill-context` is a
   * narrower capability: the address may be materialized only by the
   * `delegate_task` `skillHandle` slot. Generic resolvers keep its token
   * opaque, so adding a new value-handle consumer does not inherit access.
   */
  capability?: HarnessHandleCapability;

  /**
   * Shape of the value at the referent, when a mint knew it — the compiled
   * pattern's result schema behind a `run_pattern` result reference. Absent
   * means the shape was never free to capture, not that the referent has none:
   * no mint reads the cell to fill this in.
   */
  schema?: JSONSchema;

  /**
   * Where {@link HarnessHandleEntry.schema} came from. `harness` means a
   * harness step supplied it out of its own work — the schema a pattern WE
   * compiled and ran declares — which is the only provenance a mint records.
   *
   * A schema is disclosed to a model only under that provenance. The
   * difference is not fussiness: a schema that arrived with data is data, and
   * property names are a channel wide enough to carry whatever whoever wrote
   * them wanted said. An entry whose schema has no provenance — one adopted
   * from state this code did not write — reads as shapeless rather than as
   * trusted.
   */
  schemaSource?: "harness";

  /**
   * Where the value behind a `skill-context` handle was fetched from, recorded
   * by the host step that fetched it. The entry is the only durable place that
   * knows: the parent holds a token, the child holds text, and neither can say
   * which commit the bytes came from. Carrying it here is what lets the
   * activation record a delegation writes name that commit.
   *
   * Absent on every handle whose value the harness did not fetch from an
   * external source. A model can neither write nor read this field; it reaches
   * a model-visible surface nowhere.
   */
  acquisition?: HarnessSkillAcquisition;
}

/**
 * The session-local handle table. `salt` is the owning run's id, fixed at
 * creation, so token derivation is deterministic within a run and disjoint
 * across runs. The version stays `1` across the optional
 * {@link HarnessHandleEntry.schema}: an entry without one is well-formed, so
 * a table persisted before schemas were captured loads unchanged. The same
 * holds for {@link HarnessHandleTable.referents}.
 */
export interface HarnessHandleTable {
  type: typeof HARNESS_HANDLE_TABLE_TYPE;
  version: 1;
  salt: string;
  entries: HarnessHandleEntry[];

  /**
   * The non-cell referents the run holds. Optional for the reason `schema`
   * is: a table persisted without any is well-formed.
   */
  referents?: HarnessHandleReferent[];
}
