/**
 * A runtime's security posture, and what it means for two of them to agree.
 *
 * One runtime acts as one principal under one enforcement configuration. A
 * client that attaches asserts the posture it believes it is joining, and this
 * is where that assertion is settled. Both ends build a context, so the pieces
 * live here rather than on either side of the IPC.
 */

import { deepEqual } from "@commonfabric/utils/deep-equal";
import { clausesEqual } from "@commonfabric/runner/cfc/clause";
import {
  buildCfcTrustConfig,
  type CfcTrustConfigInput,
} from "@commonfabric/runner/cfc/trust";
import type { CfcConfClause } from "@commonfabric/runner/cfc";

import type { RuntimeSecurityContext } from "@/protocol/mod.ts";

/**
 * Every field of `T`, each one required and keeping its own type, `undefined`
 * included. A literal held to this names every field the type declares, so a
 * field added to `T` and left out of a literal that builds one is a type error
 * rather than a value that reads as absent.
 */
export type EveryFieldOf<T> = { [K in keyof Required<T>]: T[K] };

/**
 * One spelling for one origin. A `URL` round-trip settles the variance two
 * documents can differ by while meaning the same host -- an absent trailing
 * slash, a default port written out -- so that agreeing on a backend does not
 * depend on agreeing on how to write it. A value no `URL` can parse is left as
 * it stands and compares literally, which is what an unparseable host
 * deserves.
 */
export function normalizeOrigin(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

/**
 * A host map whose origins are spelled one way, or `undefined` where there is
 * no map. An empty map and an absent one are the same posture -- every space
 * resolving to the backend -- and both read as `undefined` here, so the two
 * spellings of "no per-space hosts" do not refuse each other.
 */
export function normalizeSpaceHostMap(
  map: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (map === undefined) return undefined;
  const entries = Object.entries(map);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([space, origin]) => [space, normalizeOrigin(origin)]),
  );
}

/**
 * Every field a {@link RuntimeSecurityContext} carries, as a record so that a
 * field added to that type and not to this one is a type error. What an attach
 * is checked against has to be the whole context: a field nobody compares is a
 * posture a second document can hold while the first believes otherwise.
 */
const SECURITY_CONTEXT_FIELDS: Record<
  keyof Required<RuntimeSecurityContext>,
  true
> = {
  apiUrl: true,
  cfcEnforcementMode: true,
  cfcFlowLabels: true,
  cfcReadMaxConfidentiality: true,
  cfcReadOnExceed: true,
  cfcTrustConfig: true,
  experimental: true,
  identity: true,
  renderConfidentialityCeiling: true,
  renderDeclassificationPolicy: true,
  spaceDid: true,
  spaceHostMap: true,
  trustSnapshot: true,
};

/**
 * A read ceiling compares by clause with the runner's own structural clause
 * equality (`clausesEqual`, insensitive to the order of an `anyOf`'s
 * alternatives, opaque on a malformed shape) and as a multiset of clauses,
 * since a ceiling is a conjunction: two documents that spell one ceiling in
 * another order hold the same posture, and a byte comparison would fail the
 * attach over spelling. Imported through the `cfc/clause` subpath rather than
 * the CFC barrel: this file is loaded on the browser's main thread, and the
 * barrel reaches modules that refuse to run there.
 */
function readCeilingsEqual(
  left: readonly CfcConfClause[] | undefined,
  right: readonly CfcConfClause[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  const used = new Array<boolean>(right.length).fill(false);
  for (const clause of left) {
    const at = right.findIndex((candidate, i) =>
      !used[i] && clausesEqual(clause, candidate)
    );
    if (at === -1) return false;
    used[at] = true;
  }
  return true;
}

/**
 * A trust configuration compares by the digest the runner gives the
 * configuration it normalizes (`buildCfcTrustConfig`), which is what a
 * runtime holds and evaluates concept guards under. Key order, a key written
 * as `undefined`, and an empty list written out or left out are spelling, not
 * posture. The order of statements, delegations, and edges is kept, as the
 * runner's digest keeps it. A configuration the runner refuses to normalize is
 * one no runtime booted with, so it agrees with nothing. Imported through the
 * `cfc/trust` subpath for the reason given at {@link readCeilingsEqual}.
 */
function trustConfigsEqual(
  left: CfcTrustConfigInput | undefined,
  right: CfcTrustConfigInput | undefined,
): boolean {
  const digestOf = (config: CfcTrustConfigInput | undefined) => {
    try {
      return { digest: buildCfcTrustConfig(config)?.digest };
    } catch {
      return undefined;
    }
  };
  const [a, b] = [digestOf(left), digestOf(right)];
  return a !== undefined && b !== undefined && a.digest === b.digest;
}

/**
 * The fields on which `asserted` and `running` disagree, in a fixed order, or
 * an empty list where they agree throughout.
 *
 * Compared field by field rather than as two whole objects: the two are built
 * in different documents and one of them crossed an encoding, so a posture
 * carried as an absent property in one and as an explicit `undefined` in the
 * other is the same posture and compares equal here.
 */
export function securityContextDifferences(
  asserted: RuntimeSecurityContext,
  running: RuntimeSecurityContext,
): string[] {
  const fields = Object.keys(SECURITY_CONTEXT_FIELDS).sort() as (
    keyof RuntimeSecurityContext
  )[];
  return fields.filter((field) =>
    field === "cfcReadMaxConfidentiality"
      ? !readCeilingsEqual(asserted[field], running[field])
      : field === "cfcTrustConfig"
      ? !trustConfigsEqual(asserted[field], running[field])
      : !deepEqual(asserted[field], running[field])
  );
}
