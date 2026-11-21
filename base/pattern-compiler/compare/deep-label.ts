/**
 * The label of everything a value at an address holds, with each link in it
 * followed: the label consumed at each position of the value, at the
 * position alone, joined over the positions, and over the positions of the
 * value each link at one of them names.
 *
 * The comparison of stored labels reads a row this way on both sides. A
 * compiled pattern holds a view or a constructed value in place in its result
 * document, where today's runtime holds a link to a document per computed
 * part; a read of the label below the row's path that follows links on one
 * side and not on the other compares two different sets of positions.
 */
import type {
  CfcAddress,
  CfcMetadata,
} from "../../../runtime/runner/src/cfc/types.ts";
import {
  consumedEntriesForRead,
  labelForConsumedEntries,
} from "../../../runtime/runner/src/cfc/consumed-label.ts";
import { readStoredCfcMetadata } from "../../../runtime/runner/src/cfc/metadata.ts";
import { parseLink } from "../../../runtime/runner/src/link-utils.ts";
import type { NormalizedFullLink } from "../../../runtime/runner/src/link-types.ts";
import { normalizeCellScope } from "../../../runtime/runner/src/scope.ts";
import type { IExtendedStorageTransaction } from "../../../runtime/runner/src/storage/interface.ts";
import type { Atom, Label } from "./template.ts";

/** What `deepLabel` reads of the stored documents. */
export type StoredReader<A> = {
  /** The value stored at the address. */
  value(address: A): unknown;
  /** The label a read of the address alone consumes, below it excluded. */
  label(address: A): Label;
  /** The address a value names where it is a link. */
  link(value: unknown, at: A): A | undefined;
  /** The path of an address within its document. */
  path(address: A): readonly string[];
  /** The address of another path of the same document. */
  withPath(address: A, path: readonly string[]): A;
  /** A key equal for equal addresses. */
  key(address: A): string;
};

/**
 * Hears of the first position at which the walk found each atom, on each
 * axis.
 */
export type Trace<A> = (
  axis: "confidentiality" | "integrity",
  atom: Atom,
  at: A,
) => void;

/** A key of an atom that does not depend on the order of its fields. */
export const atomKey = (atom: Atom): string =>
  JSON.stringify(
    atom,
    (_, value) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        )
        : value,
  );

/**
 * The position a read of `address` reaches: each link stored at a position
 * on the way to its path is followed, as a read follows it, and `crossed`
 * hears of each such position.
 */
const reached = <A>(
  reader: StoredReader<A>,
  address: A,
  crossed: (at: A) => void,
): A => {
  let at = reader.withPath(address, []);
  for (const segment of reader.path(address)) {
    // A way of more links than this is a cycle, and the read ends there.
    for (let depth = 0; depth < 16; depth++) {
      const target = reader.link(reader.value(at), at);
      if (target === undefined) break;
      crossed(at);
      at = target;
    }
    at = reader.withPath(at, [...reader.path(at), segment]);
  }
  return at;
};

/**
 * The label of the value at `address` with each link in it followed, as the
 * head of this file says. A link names a position by a path, and the links
 * on the way to that position are followed, with the label at each joined
 * in. A position reached twice, as on a cycle of links, is read once. With
 * `descend` false, the positions below the address and
 * below each link target are not read: a read of a container's own entry,
 * through the links at its position.
 */
export const deepLabel = <A>(
  reader: StoredReader<A>,
  address: A,
  trace?: Trace<A>,
  descend = true,
): Label => {
  const confidentiality = new Map<string, Atom>();
  const integrity = new Map<string, Atom>();
  const seen = new Set<string>();
  // Each pending position, with its value where the walk already holds it.
  const pending: { at: A; value?: { held: unknown } }[] = [{ at: address }];
  while (pending.length > 0) {
    const { at, value } = pending.pop()!;
    const key = reader.key(at);
    if (seen.has(key)) continue;
    seen.add(key);
    const label = reader.label(at);
    for (const atom of label.confidentiality) {
      const key = atomKey(atom);
      if (!confidentiality.has(key)) trace?.("confidentiality", atom, at);
      confidentiality.set(key, atom);
    }
    if (label.integrity !== "neutral") {
      for (const atom of label.integrity) {
        const key = atomKey(atom);
        if (!integrity.has(key)) trace?.("integrity", atom, at);
        integrity.set(key, atom);
      }
    }
    const held = value === undefined ? reader.value(at) : value.held;
    const target = reader.link(held, at);
    if (target !== undefined) {
      pending.push({
        at: reached(reader, target, (link) => {
          const key = reader.key(link);
          if (seen.has(key)) return;
          seen.add(key);
          // The label at a link crossed is joined in as the label at a
          // link the value holds is.
          const label = reader.label(link);
          for (const atom of label.confidentiality) {
            const key = atomKey(atom);
            if (!confidentiality.has(key)) {
              trace?.("confidentiality", atom, link);
            }
            confidentiality.set(key, atom);
          }
          if (label.integrity === "neutral") return;
          for (const atom of label.integrity) {
            const key = atomKey(atom);
            if (!integrity.has(key)) trace?.("integrity", atom, link);
            integrity.set(key, atom);
          }
        }),
      });
      continue;
    }
    if (!descend || held === null || typeof held !== "object") continue;
    for (const [segment, child] of Object.entries(held)) {
      pending.push({
        at: reader.withPath(at, [...reader.path(at), segment]),
        value: { held: child },
      });
    }
  }
  return {
    confidentiality: [...confidentiality.values()],
    integrity: [...integrity.values()],
  };
};

/**
 * `deepLabel` at the position a read of `address` reaches: each link stored
 * at a position on the way to its path is followed, as a read follows it,
 * and the label stored at that link's position is joined in.
 */
export const deepLabelAlong = <A>(
  reader: StoredReader<A>,
  address: A,
  trace?: Trace<A>,
  descend = true,
): Label => {
  const crossed: Label[] = [];
  const at = reached(reader, address, (link) => {
    const label = reader.label(link);
    for (const atom of label.confidentiality) {
      trace?.("confidentiality", atom, link);
    }
    crossed.push(label);
  });
  const found = deepLabel(reader, at, trace, descend);
  const confidentiality = new Map<string, Atom>();
  const integrity = new Map<string, Atom>();
  for (const label of [...crossed, found]) {
    for (const atom of label.confidentiality) {
      confidentiality.set(atomKey(atom), atom);
    }
    if (label.integrity === "neutral") continue;
    for (const atom of label.integrity) integrity.set(atomKey(atom), atom);
  }
  return {
    confidentiality: [...confidentiality.values()],
    integrity: [...integrity.values()],
  };
};

/** The runtime's link of an address, in the scope the address names. */
const linkOf = (address: CfcAddress): NormalizedFullLink =>
  ({
    space: address.space,
    id: address.id,
    path: [...address.path],
    scope: normalizeCellScope(address.scope),
  }) as unknown as NormalizedFullLink;

/**
 * The reader of what `tx` reads of the runtime's storage: the label at a
 * position is the one a read of it in the class `consumes` consumes alone,
 * from the entries stored in its document at and above its path. With
 * `pointers`, it is joined with the confidentiality a read of the reference
 * at the position consumes, as a read that follows the link there does.
 */
export const storedReader = (
  tx: IExtendedStorageTransaction,
  consumes: "value" | "shape" = "value",
  pointers = false,
): StoredReader<CfcAddress> => {
  const metadata = new Map<string, CfcMetadata | undefined>();
  const metadataOf = (address: CfcAddress): CfcMetadata | undefined => {
    const key = JSON.stringify([
      address.space,
      address.id,
      normalizeCellScope(address.scope),
    ]);
    if (!metadata.has(key)) {
      metadata.set(
        key,
        readStoredCfcMetadata(tx, linkOf({ ...address, path: [] })),
      );
    }
    return metadata.get(key);
  };
  return {
    value: (address) => tx.readValueOrThrow(linkOf(address)),
    label: (address) => {
      const stored = metadataOf(address);
      const label = stored === undefined ? undefined : labelForConsumedEntries(
        consumedEntriesForRead(stored, address.path, {
          nonRecursive: true,
          consumes,
        }),
        address.path,
        true,
      );
      const pointer = stored === undefined || !pointers
        ? undefined
        : labelForConsumedEntries(
          consumedEntriesForRead(stored, address.path, {
            nonRecursive: true,
            consumes: "followRef",
          }),
          address.path,
          true,
        );
      return {
        confidentiality: [
          ...label?.confidentiality ?? [],
          ...pointer?.confidentiality ?? [],
        ],
        integrity: [...label?.integrity ?? []],
      };
    },
    link: (value, at) => {
      const link = parseLink(value, linkOf(at));
      // A link to a document of a user or of a session names that scope,
      // and the document is read there: the state of a `wish` for a target
      // of the home space is such a document.
      return link === undefined ? undefined : {
        space: link.space ?? at.space,
        id: link.id as string,
        scope: normalizeCellScope(link.scope),
        path: [...link.path],
      } as CfcAddress;
    },
    path: (address) => address.path,
    withPath: (address, path) => ({ ...address, path: [...path] }),
    key: (address) =>
      JSON.stringify([
        address.space,
        address.id,
        normalizeCellScope(address.scope),
        address.path,
      ]),
  };
};
