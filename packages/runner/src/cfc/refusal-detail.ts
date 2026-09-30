// Why: a refusal that names only what it refused leaves the refused party with
// nothing to do about it.
//
// `sink-request confidentiality exceeds ceiling for fetchText: "medical"` is a
// complete statement of the verdict and a useless instruction. It says a
// confidentiality atom reached an egress that does not admit it; it does not
// say WHICH of the transaction's reads carried that atom in. An agent holding
// three inputs and one refusal cannot tell which input to drop, so it either
// drops all of them (losing the run) or retries unchanged (refused again).
//
// A refusal detail answers the second question. It names the boundary that
// refused, the atoms outside it, and the reads that carried each one — and it
// states, as a checkable property rather than a promise, whether those reads
// account for every offending atom. When they do, dropping them is a REMEDY:
// the same operation over the remaining inputs meets the ceiling. When they do
// not, the detail says so, and the caller learns that taint minimization alone
// will not clear this one.
//
// A clause is matched by `deepEqual`, the structural identity `uniqueCfcAtoms`
// and the ceiling-membership test already decide by. It has to be that one and
// not a rendering: `{a:1,b:2}` and `{b:2,a:1}` are ONE clause to CFC and two
// strings to `JSON.stringify`, so a rendered key would split a clause two
// reads carried, name only the first, and call the remedy complete — and
// dropping that read would leave the other read's identical clause behind,
// refused again. `-0` and `0` fail the other way: two clauses to CFC, one
// string, so a rendering would attribute an offending atom to an innocent
// read. Rendering stays what it is, a display form.
//
// The detail rides ALONGSIDE the reason string, never inside it. The reason is
// prose for a person and a matcher; encoding a structure into it would make
// every consumer a parser and every rewording a breaking change.
//
// Every type here is a `type` alias rather than an `interface` on purpose: a
// detail travels on the `cfc.prepare-reject` telemetry marker, and a marker
// crosses the runtime-client IPC boundary as a `FabricValue`. An interface
// carries no implicit index signature, so it does not satisfy
// `FabricPlainObject`, and the whole marker union stops being serializable.

import { deepEqual, deepEqualKey } from "@commonfabric/utils/deep-equal";

import type { CfcConfClause } from "./clause.ts";
import type { CfcAddress } from "./types.ts";

/**
 * One read that carried a confidentiality clause into a transaction, paired
 * with the label-map entry path that carried it. The collector in `prepare.ts`
 * builds these; a gate that refuses matches the ones behind its offending
 * clauses into {@link CfcRefusalInput}s.
 *
 * `atom` is the clause itself rather than a rendering of it, because matching
 * is by `deepEqual` — see the module comment for what a rendered key gets
 * wrong, in both directions.
 */
export type ConsumedAtomSource = {
  readonly atom: CfcConfClause;
  readonly read: CfcAddress;
  readonly labelPath: readonly string[];
};

/**
 * How an atom is rendered wherever it is DISPLAYED — in a reason string and in
 * a detail. One function, so a consumer reading a detail's atoms against a
 * reason's prose compares identical text. Never an identity: see the module
 * comment.
 */
export const renderCfcAtom = (atom: unknown): string => JSON.stringify(atom);

/** Which gate refused. Named for the rule, so a consumer can branch on it. */
export type CfcRefusalGate = "sink-ceiling" | "writer-fit";

/**
 * One read that carried offending confidentiality into a refused operation.
 *
 * `read` is the address the transaction actually read; `labelPath` is the
 * label-map entry path inside that document which carried the atoms. The two
 * differ whenever a read of a container picks up a label declared on a field
 * inside it — which is the common case, and the one where naming only the
 * document would under-specify the remedy.
 */
export type CfcRefusalInput = {
  readonly read: CfcAddress;
  readonly labelPath: readonly string[];

  /** The offending atoms this read contributed, rendered for display. */
  readonly atoms: readonly string[];
};

/**
 * How completely {@link CfcRefusalDetail.inputs} accounts for the refusal.
 *
 * - `complete` — every offending clause is attributed to a named read.
 *   Dropping all of them clears this refusal.
 * - `partial` — some offending clause is attributed to no named read.
 *   Dropping the named ones narrows the flow without necessarily clearing it.
 * - `none` — nothing was attributed. The gate still refused; the detail adds
 *   no remedy beyond the reason.
 *
 * An exchange-rule rewrite is the ordinary way to land below `complete`: the
 * gate decides on a REWRITTEN label whose clauses need not be any clause a
 * read contributed, so a clause can be genuinely offending and genuinely
 * unattributable. Reporting that honestly is the point — a confident wrong
 * remedy costs more than an admitted gap.
 */
export type CfcRefusalAttribution = "complete" | "partial" | "none";

/**
 * A refusal, described in terms a caller can act on.
 *
 * Every field is data a consumer reads structurally: the harness turns
 * `inputs` into the argument names an agent passed, and a console renders the
 * boundary and the atoms. Nothing here is meant to be parsed out of prose.
 */
export type CfcRefusalDetail = {
  readonly gate: CfcRefusalGate;

  /** The sink whose ceiling refused, for `sink-ceiling`. */
  readonly sink?: string;

  /** The write the rule refused, for `writer-fit`. */
  readonly target?: CfcAddress;

  /** Clauses outside what the boundary admits, rendered for display. */
  readonly offendingAtoms: readonly string[];

  /** The reads that carried them, deduplicated by address and label path. */
  readonly inputs: readonly CfcRefusalInput[];

  readonly attribution: CfcRefusalAttribution;

  /**
   * The plain reason text this detail describes, verbatim — the pairing key
   * between the structured detail and the reason list a refusal carries. The
   * commit boundary keeps only the details whose reason survived into the
   * refusal, and each prepare pass describes only its own verdict, so a detail
   * recorded for a reason that did not refuse never rides along.
   */
  readonly reason: string;
};

/**
 * Match `offending` clauses to the reads that carried them, and say how
 * completely the result accounts for the refusal.
 *
 * One pass produces both, because they are two readings of the same match:
 * computing them separately would let a caller act on inputs the attribution
 * does not describe.
 */
export const describeRefusalInputs = (
  offending: readonly unknown[],
  sources: readonly ConsumedAtomSource[],
): {
  inputs: readonly CfcRefusalInput[];
  attribution: CfcRefusalAttribution;
} => {
  const byRead = new Map<
    string,
    {
      read: CfcAddress;
      labelPath: readonly string[];
      atoms: string[];
      rendered: Set<string>;
    }
  >();
  // Equal clauses share a key; collisions still use structural equality.
  const sourcesByClause = new Map<string, ConsumedAtomSource[]>();
  for (const source of sources) {
    const key = deepEqualKey(source.atom);
    const bucket = sourcesByClause.get(key);
    if (bucket === undefined) sourcesByClause.set(key, [source]);
    else bucket.push(source);
  }
  let unattributed = 0;
  for (const clause of offending) {
    const rendered = renderCfcAtom(clause);
    let matched = false;
    for (const source of sourcesByClause.get(deepEqualKey(clause)) ?? []) {
      if (!deepEqual(source.atom, clause)) continue;
      matched = true;
      const key = JSON.stringify([
        source.read.space,
        source.read.id,
        source.read.scope,
        source.read.path,
        source.labelPath,
      ]);
      const existing = byRead.get(key);
      if (existing === undefined) {
        byRead.set(key, {
          read: source.read,
          labelPath: source.labelPath,
          atoms: [rendered],
          rendered: new Set([rendered]),
        });
      } else if (!existing.rendered.has(rendered)) {
        existing.rendered.add(rendered);
        existing.atoms.push(rendered);
      }
    }
    if (!matched) unattributed += 1;
  }
  const inputs = [...byRead.values()].map(({ read, labelPath, atoms }) => ({
    read,
    labelPath,
    atoms,
  }));
  return {
    inputs,
    attribution: inputs.length === 0
      ? "none"
      : unattributed === 0
      ? "complete"
      : "partial",
  };
};
