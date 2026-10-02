/**
 * Reconciles the `minted` component of a document's label map with one
 * transaction's writes. A minted entry states that the value at its path was
 * written through a schema that stamped it (`ifc.addIntegrity`), so it holds
 * only while that value stands: a write that changes the value, or part of
 * it, withdraws the stamp unless the writing transaction's own schema stamps
 * what it wrote with the same atoms.
 *
 * A stamp minted through an item schema is stored once, at the schema's `*`
 * path, while every value that path matches carries it. The first write that
 * leaves a matching value without the stamp replaces the `*` entry with one
 * entry per value that still carries it.
 */

import type { FabricValue } from "@commonfabric/api";
import type { CfcAtom } from "@commonfabric/api/cfc";
import { isKeyableObjectOrArray } from "@commonfabric/data-model";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { deepEqual } from "@commonfabric/utils/deep-equal";

import { encodePointer, pathsOverlap } from "../../../memory/v2/path.ts";
import { isPrimitiveCellLink } from "../link-types.ts";
import { uniqueCfcAtoms } from "./atoms.ts";
import { principalClaimSpelling } from "./represents-principal.ts";
import type { LabelEntryOrigin, LabelMapEntry } from "./types.ts";

/** The origin of an entry holding integrity a write's own schema minted. */
export const MINTED_ORIGIN: LabelEntryOrigin = "minted";

/**
 * Returns whether `atom`, named by a schema's `ifc.addIntegrity`, is a stamp
 * on the value a write leaves. The exception is a principal claim, which is
 * store policy: owner adoption and writer authorization read it from the
 * declared component, where it stays.
 */
export const isValueStamp = (atom: unknown): boolean =>
  principalClaimSpelling(atom) === undefined;

/** One stamp a transaction's own schema mints. */
export type IntegrityMint = {
  /** Schema position minting the stamp, `*` standing for any item or entry. */
  readonly path: readonly string[];

  /** Atoms minted there, after the runtime-minted gate. */
  readonly integrity: readonly CfcAtom[];
};

/** What one transaction did to a document, as the reconciliation reads it. */
export type MintedReconcileInput = {
  /** The document's stored `minted` entries. */
  readonly existing: readonly LabelMapEntry[];

  /** The stamps the transaction's own schema mints on this document. */
  readonly mints: readonly IntegrityMint[];

  /** Value paths at which the transaction changed the document. */
  readonly changedPaths: readonly (readonly string[])[];

  /**
   * Value paths the transaction wrote, whether or not the value changed. A
   * mint reaches a value it rewrote unchanged; only a change withdraws a
   * stamp.
   */
  readonly attemptedPaths: readonly (readonly string[])[];

  /**
   * Reads the document's value as the transaction leaves it. Called only when
   * a mint or a stored entry has to be resolved against the value.
   */
  readonly value: () => FabricValue | undefined;
};

/** A value position a `*` path resolves to. */
type Position = {
  readonly path: readonly string[];

  /**
   * Whether the position holds a reference. The value behind a reference is
   * another document's, labeled by that document's own entries, so a
   * reference carries no stamp here.
   */
  readonly reference: boolean;
};

const isPattern = (path: readonly string[]): boolean => path.includes("*");

const hasAtom = (atoms: readonly CfcAtom[], atom: CfcAtom): boolean =>
  atoms.some((candidate) => deepEqual(candidate, atom));

const containsAtoms = (
  atoms: readonly CfcAtom[],
  within: readonly CfcAtom[],
): boolean => atoms.every((atom) => hasAtom(within, atom));

const sameAtoms = (
  left: readonly CfcAtom[],
  right: readonly CfcAtom[],
): boolean =>
  left.length === right.length && containsAtoms(left, right) &&
  containsAtoms(right, left);

const overlapsAny = (
  path: readonly string[],
  others: readonly (readonly string[])[],
): boolean => others.some((other) => pathsOverlap(path, other));

/**
 * The changed paths that overlap a position, found without walking all of
 * them: a transaction that rewrites a long list element by element changes as
 * many paths as the list has positions to ask about.
 */
type ChangeIndex = {
  /** The changed paths at, above or below `position`. */
  overlapping(position: readonly string[]): (readonly string[])[];
};

const changeIndexOf = (
  changedPaths: readonly (readonly string[])[],
): ChangeIndex => {
  const at = new Map<string, readonly string[]>();
  const beneath = new Map<string, (readonly string[])[]>();
  for (const path of changedPaths) {
    at.set(encodePointer(path), path);
    for (let depth = 0; depth < path.length; depth++) {
      const key = encodePointer(path.slice(0, depth));
      const paths = beneath.get(key);
      if (paths === undefined) {
        beneath.set(key, [path]);
      } else {
        paths.push(path);
      }
    }
  }
  return {
    overlapping(position) {
      const paths: (readonly string[])[] = [];
      for (let depth = 0; depth <= position.length; depth++) {
        const path = at.get(encodePointer(position.slice(0, depth)));
        if (path !== undefined) paths.push(path);
      }
      for (const path of beneath.get(encodePointer(position)) ?? []) {
        paths.push(path);
      }
      return paths;
    },
  };
};

/**
 * The positions of `value` that `pattern` matches, limited to those at, above
 * or below `within`. A `*` segment matches each element of an array and each
 * entry of a record. The walk stops at a reference, which it reports as a
 * position only where the pattern ends on it.
 */
const matchingPositions = (
  value: FabricValue | undefined,
  pattern: readonly string[],
  within: readonly string[] = [],
): Position[] => {
  const positions: Position[] = [];
  const walk = (current: unknown, path: readonly string[]): void => {
    const depth = path.length;
    if (depth === pattern.length) {
      positions.push({ path, reference: isPrimitiveCellLink(current) });
      return;
    }
    if (isPrimitiveCellLink(current) || !isKeyableObjectOrArray(current)) {
      return;
    }
    const isArray = Array.isArray(current);
    const holds = (key: string): boolean =>
      (!isArray || isArrayIndexPropertyName(key)) &&
      Object.hasOwn(current, key);
    const segment = depth < within.length ? within[depth]! : pattern[depth]!;
    if (segment !== "*") {
      if (pattern[depth] !== "*" && pattern[depth] !== segment) return;
      if (holds(segment)) {
        walk((current as Record<string, unknown>)[segment], [...path, segment]);
      }
      return;
    }
    for (const key of Object.keys(current)) {
      if (holds(key)) {
        walk((current as Record<string, unknown>)[key], [...path, key]);
      }
    }
  };
  walk(value, []);
  return positions;
};

/**
 * The positions `pattern` matches that some path of `written` reaches: the
 * positions at or beneath a written path, and the positions a write landed
 * inside.
 */
const reachedPositions = (
  value: () => FabricValue | undefined,
  pattern: readonly string[],
  written: readonly (readonly string[])[],
): Map<string, Position> => {
  const reached = new Map<string, Position>();
  for (const path of written) {
    const within = path.slice(0, pattern.length);
    if (
      !within.every((segment, index) =>
        pattern[index] === "*" || pattern[index] === segment
      )
    ) {
      continue;
    }
    for (const position of matchingPositions(value(), pattern, within)) {
      reached.set(encodePointer(position.path), position);
    }
  }
  return reached;
};

/**
 * Returns whether a transaction that changed `changedPaths` changed a value a
 * stored minted entry labels, so that the entry has to be reconciled. A `*`
 * entry is taken to be reached by any change at, above or below its container.
 */
export const mintedEntryReached = (
  entryPath: readonly string[],
  changedPaths: readonly (readonly string[])[],
): boolean => {
  const first = entryPath.indexOf("*");
  const concrete = first === -1 ? entryPath : entryPath.slice(0, first);
  return overlapsAny(concrete, changedPaths);
};

/**
 * Returns the `minted` entries a document holds once a transaction's writes
 * have landed.
 *
 * A stored entry keeps an atom through a change at or above its path only
 * where the transaction mints that atom at or above the path, and through a
 * change beneath its path only where the transaction mints it at or above
 * what changed: a value whose changed part carries the atom still carries it
 * whole. An entry whose position is left holding nothing, or a reference, is
 * dropped.
 *
 * A stored `*` entry survives while every value it matches keeps all of its
 * atoms by that rule. Otherwise it is replaced by an entry at each matched
 * value, holding the atoms that value keeps. Each mint lands at the values
 * its path matches that the transaction wrote, references excepted. A mint
 * through a `*` path that leaves every value the path matches carrying
 * exactly its atoms is stored at that path.
 */
export const reconcileMintedEntries = (
  input: MintedReconcileInput,
): LabelMapEntry[] => {
  const { existing, mints, changedPaths, attemptedPaths } = input;
  if (existing.length === 0 && mints.length === 0) return [];

  let read = false;
  let cached: FabricValue | undefined;
  const value = (): FabricValue | undefined => {
    if (!read) {
      cached = input.value();
      read = true;
    }
    return cached;
  };

  // What the mints leave at each position they reach.
  const minted = new Map<
    string,
    { path: readonly string[]; integrity: CfcAtom[] }
  >();
  const mintedPatterns = new Map<string, IntegrityMint>();
  for (const mint of mints) {
    if (mint.integrity.length === 0) continue;
    const patternKey = encodePointer(mint.path);
    mintedPatterns.set(patternKey, {
      path: mint.path,
      integrity: uniqueCfcAtoms([
        ...(mintedPatterns.get(patternKey)?.integrity ?? []),
        ...mint.integrity,
      ]),
    });
    for (
      const [key, position] of reachedPositions(
        value,
        mint.path,
        attemptedPaths,
      )
    ) {
      if (position.reference) continue;
      minted.set(key, {
        path: position.path,
        integrity: uniqueCfcAtoms([
          ...(minted.get(key)?.integrity ?? []),
          ...mint.integrity,
        ]),
      });
    }
  }

  // The atoms the transaction's mints leave on whatever sits at `path`: those
  // minted at the path or above it.
  const mintedOver = (path: readonly string[]): CfcAtom[] => {
    const atoms: CfcAtom[] = [];
    for (let depth = 0; depth <= path.length; depth++) {
      const over = minted.get(encodePointer(path.slice(0, depth)));
      if (over !== undefined) {
        for (const atom of over.integrity) atoms.push(atom);
      }
    }
    return atoms;
  };
  // What the transaction's changes leave standing of `atoms`, stamped on the
  // value at `position`.
  const changes = changeIndexOf(changedPaths);
  const surviving = (
    position: readonly string[],
    atoms: readonly CfcAtom[],
  ): readonly CfcAtom[] => {
    let kept = atoms;
    for (const changed of changes.overlapping(position)) {
      const over = mintedOver(
        changed.length > position.length ? changed : position,
      );
      kept = kept.filter((atom) => hasAtom(over, atom));
      if (kept.length === 0) break;
    }
    return kept;
  };

  // The stamp each concrete position carries, and the `*` entries kept whole.
  const stamps = new Map<
    string,
    { path: readonly string[]; integrity: CfcAtom[] }
  >();
  const templates = new Map<
    string,
    { path: readonly string[]; integrity: CfcAtom[] }
  >();
  const stamp = (path: readonly string[], atoms: readonly CfcAtom[]): void => {
    if (atoms.length === 0) return;
    const key = encodePointer(path);
    stamps.set(key, {
      path,
      integrity: uniqueCfcAtoms([
        ...(stamps.get(key)?.integrity ?? []),
        ...atoms,
      ]),
    });
  };

  const storedPatterns = new Set<string>();
  for (const entry of existing) {
    const atoms = entry.label.integrity ?? [];
    if (atoms.length === 0) continue;
    if (!isPattern(entry.path)) {
      // A change elsewhere can leave the entry's position holding nothing: a
      // list shortened past the entry's index changes only the indices that
      // moved and the length.
      if (
        changedPaths.length === 0 ||
        matchingPositions(value(), entry.path).some((position) =>
          !position.reference
        )
      ) {
        stamp(entry.path, surviving(entry.path, atoms));
      }
      continue;
    }
    storedPatterns.add(encodePointer(entry.path));
    const changed = mintedEntryReached(entry.path, changedPaths)
      ? reachedPositions(value, entry.path, changedPaths)
      : new Map<string, Position>();
    const keptAt = new Map<string, readonly CfcAtom[]>();
    for (const [key, position] of changed) {
      keptAt.set(
        key,
        position.reference ? [] : surviving(position.path, atoms),
      );
    }
    if ([...keptAt.values()].every((kept) => kept.length === atoms.length)) {
      const key = encodePointer(entry.path);
      templates.set(key, {
        path: entry.path,
        integrity: uniqueCfcAtoms([
          ...(templates.get(key)?.integrity ?? []),
          ...atoms,
        ]),
      });
      continue;
    }
    for (const position of matchingPositions(value(), entry.path)) {
      if (position.reference) continue;
      stamp(
        position.path,
        keptAt.get(encodePointer(position.path)) ?? atoms,
      );
    }
  }

  for (const { path, integrity } of minted.values()) stamp(path, integrity);

  // A mint through a `*` path that left every value the path matches carrying
  // exactly its atoms is stored once, at that path.
  for (const [patternKey, mint] of mintedPatterns) {
    if (!isPattern(mint.path) || storedPatterns.has(patternKey)) continue;
    const all = matchingPositions(value(), mint.path);
    if (
      all.length === 0 ||
      !all.every((position) =>
        !position.reference &&
        sameAtoms(
          stamps.get(encodePointer(position.path))?.integrity ?? [],
          mint.integrity,
        )
      )
    ) {
      continue;
    }
    for (const position of all) stamps.delete(encodePointer(position.path));
    templates.set(patternKey, {
      path: mint.path,
      integrity: [...mint.integrity],
    });
  }

  // A position under a kept `*` entry needs an entry of its own only for the
  // atoms the `*` entry does not already state.
  const entries: LabelMapEntry[] = [];
  for (const template of templates.values()) {
    entries.push({
      path: template.path,
      label: { integrity: template.integrity },
      origin: MINTED_ORIGIN,
    });
  }
  for (const { path, integrity } of stamps.values()) {
    const covered = [...templates.values()].filter((template) =>
      template.path.length === path.length &&
      template.path.every((segment, index) =>
        segment === "*" || segment === path[index]
      )
    ).flatMap((template) => template.integrity);
    if (containsAtoms(integrity, covered)) continue;
    entries.push({ path, label: { integrity }, origin: MINTED_ORIGIN });
  }
  return entries;
};
