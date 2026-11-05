/**
 * What structural deduplication of CFC label atoms costs as a label grows.
 *
 * `uniqueCfcAtoms` is the identity behind every label join: two atoms are the
 * same atom when `deepEqual` says so, because a fabric conversion clones an
 * atom rather than sharing its reference. Joining labels is therefore
 * deduplicating their atoms, and a document that accumulates a persisted flow
 * entry per written path hands the join a list as long as the map.
 *
 * The sizes are the axis. A deduplication that compares each candidate
 * against every atom already kept costs the square of its input, so the two
 * arms below separate by a factor of the size rather than by a constant, and
 * the size is in each benchmark's name so the shape is readable off the
 * chart rather than inferred from one point.
 *
 * `distinct` is the growing-label case: every atom is new, so nothing is
 * dropped and the result is as long as the input. `repeated` is the joining
 * case: the same small set of atoms arrives over and over, as it does when
 * one clause is stamped on every entry of a map, so the result stays small
 * while the input does not.
 */

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { uniqueCfcAtoms } from "../src/cfc/observation.ts";

/** The atom shape a persisted flow label carries: one per written path. */
const linkReferenceAtom = (index: number) => ({
  type: CFC_ATOM_TYPE.LinkReference,
  source: {
    space: "did:key:z6MkfixtureSpace",
    id: "of:fixture-document",
    path: ["field", String(index)],
  },
});

const distinct = (size: number) =>
  Array.from({ length: size }, (_, index) => linkReferenceAtom(index));

/** Four atoms repeated to fill `size`, so the join keeps four of them. */
const repeated = (size: number) =>
  Array.from({ length: size }, (_, index) => linkReferenceAtom(index % 4));

const SIZES = [8, 64, 512] as const;

for (const size of SIZES) {
  const atoms = distinct(size);
  Deno.bench({
    name: `distinct ${size}`,
    group: "cfc atom dedup",
    fn: () => {
      uniqueCfcAtoms(atoms);
    },
  });
}

for (const size of SIZES) {
  const atoms = repeated(size);
  Deno.bench({
    name: `repeated ${size}`,
    group: "cfc atom dedup",
    fn: () => {
      uniqueCfcAtoms(atoms);
    },
  });
}
