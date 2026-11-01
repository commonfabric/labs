import type { Update } from "@codemirror/collab";
import {
  type ChangeDesc,
  ChangeSet,
  StateEffect,
  Text,
} from "@codemirror/state";
import type { FabricValue } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/js-values/types";
import { CODEMIRROR_CHANGESET_CODEC, type FieldAnchor } from "../v2.ts";

export { CODEMIRROR_CHANGESET_CODEC, operationBaselineHash } from "../v2.ts";

export type OperationCodecInput = {
  materialized: FabricValue;
  submitted: FabricValue;
  intervening: readonly FabricValue[];

  /**
   * Anchors stated against the value `submitted` yields at its base, the
   * document the submitting client holds, to be mapped to the value after the
   * integration.
   */
  anchors?: readonly FieldAnchor[];
};

export type OperationCodecResult = {
  materialized: FabricValue;
  operations: FabricValue[];

  /**
   * The input's `anchors` stated against `materialized`; present when the
   * input carried any.
   */
  anchors?: FieldAnchor[];
};

/**
 * Anchors stated against the value before `operations`, to be mapped through
 * them. `materialized` is the value after `operations`: with none, the value
 * the anchors are stated against.
 */
export type OperationCodecAnchorInput = {
  anchors: readonly FieldAnchor[];
  materialized: FabricValue;
  operations: readonly FabricValue[];
};

export type OperationCodec = {
  readonly id: string;
  integrate(input: OperationCodecInput): OperationCodecResult;

  /**
   * Maps `anchors` through integrated `operations`, in order, and returns
   * them stated against the value after. Deterministic: the same anchors and
   * operations map to the same ranges in every process, and `integrate` maps
   * the anchors it is given by the same rule. Throws when an anchor lies
   * outside the value it is stated against.
   */
  mapAnchors(input: OperationCodecAnchorInput): FieldAnchor[];
};

/**
 * Maps one range through one change description, as the CodeMirror codec maps
 * every anchor and a CodeMirror editor maps a mark: the start with
 * association 1, so text inserted at it stays outside; the end with
 * association -1, likewise; a range the change empties collapses to the point
 * where its start lands with association -1, and an empty range stays a point
 * before text inserted at it.
 */
export const mapAnchorRange = <T extends { from: number; to: number }>(
  range: T,
  changes: ChangeDesc,
): T => {
  if (range.from === range.to) {
    const point = changes.mapPos(range.from, -1);
    return { ...range, from: point, to: point };
  }
  const from = changes.mapPos(range.from, 1);
  const to = changes.mapPos(range.to, -1);
  if (to <= from) {
    const point = changes.mapPos(range.from, -1);
    return { ...range, from: point, to: point };
  }
  return { ...range, from, to };
};

export class OperationCodecRegistry {
  readonly #codecs = new Map<string, OperationCodec>();

  constructor(codecs: readonly OperationCodec[] = []) {
    for (const codec of codecs) this.register(codec);
  }

  register(codec: OperationCodec): void {
    if (!/@[1-9][0-9]*$/.test(codec.id)) {
      throw new Error(
        `operation codec id requires a version suffix: ${codec.id}`,
      );
    }
    if (this.#codecs.has(codec.id)) {
      throw new Error(`operation codec already registered: ${codec.id}`);
    }
    this.#codecs.set(codec.id, codec);
  }

  require(id: string): OperationCodec {
    const codec = this.#codecs.get(id);
    if (!codec) throw new Error(`unknown operation codec: ${id}`);
    return codec;
  }

  ids(): string[] {
    return [...this.#codecs.keys()].sort();
  }
}

type CodeMirrorUpdateWire = {
  clientId: string;
  changes: FabricValue;
  dedupeId?: string;
};

type DecodedCodeMirrorUpdate = {
  update: Update;
  dedupeId?: string;
};

const codeMirrorDedupeEffect = StateEffect.define<string>();

const codeMirrorDedupeId = (update: Update): string | undefined => {
  const dedupeId = update.effects?.find((effect) =>
    effect.is(codeMirrorDedupeEffect)
  )?.value;
  return typeof dedupeId === "string" ? dedupeId : undefined;
};

const decodeUpdate = (value: unknown): DecodedCodeMirrorUpdate => {
  if (
    !isObjectNotArray(value) ||
    typeof (value as { clientId?: unknown }).clientId !== "string" ||
    (value as { clientId: string }).clientId.length === 0 ||
    (value as { clientId: string }).clientId.length > 256
  ) {
    throw new Error("CodeMirror operation updates require a clientId");
  }
  const dedupeId = (value as { dedupeId?: unknown }).dedupeId;
  if (
    dedupeId !== undefined &&
    (typeof dedupeId !== "string" || dedupeId.length === 0 ||
      dedupeId.length > 4096)
  ) {
    throw new Error("CodeMirror operation dedupeId is malformed");
  }
  const keys = Object.keys(value);
  if (
    (keys.length !== 2 && keys.length !== 3) ||
    !keys.includes("clientId") || !keys.includes("changes") ||
    (keys.length === 3 && !keys.includes("dedupeId"))
  ) {
    throw new Error(
      "CodeMirror operation updates contain unsupported fields",
    );
  }
  return {
    update: {
      clientID: (value as { clientId: string }).clientId,
      changes: ChangeSet.fromJSON(
        (value as { changes: Parameters<typeof ChangeSet.fromJSON>[0] })
          .changes,
      ),
      ...(dedupeId === undefined
        ? {}
        : { effects: [codeMirrorDedupeEffect.of(dedupeId)] }),
    },
    ...(dedupeId === undefined ? {} : { dedupeId }),
  };
};

const decodePayload = (payload: FabricValue): DecodedCodeMirrorUpdate[] => {
  if (
    !isObjectNotArray(payload) ||
    !Array.isArray((payload as { updates?: unknown }).updates)
  ) {
    throw new Error("CodeMirror operation payload requires an updates array");
  }
  if (
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, "updates")
  ) {
    throw new Error("CodeMirror operation payload contains unsupported fields");
  }
  return (payload as { updates: unknown[] }).updates.map(decodeUpdate);
};

const encodeUpdate = (
  update: Update,
): CodeMirrorUpdateWire => ({
  clientId: update.clientID,
  changes: update.changes.toJSON() as FabricValue,
  ...(() => {
    const dedupeId = codeMirrorDedupeId(update);
    return dedupeId === undefined ? {} : { dedupeId };
  })(),
});

/** Copies of `anchors`, each checked to lie within `length` code units. */
const anchorsWithin = (
  anchors: readonly FieldAnchor[],
  length: number,
): FieldAnchor[] =>
  anchors.map((anchor) => {
    if (
      !Number.isSafeInteger(anchor.from) ||
      !Number.isSafeInteger(anchor.to) ||
      anchor.from < 0 || anchor.to < anchor.from || anchor.to > length
    ) {
      throw new Error(
        `CodeMirror anchor ${anchor.id} lies outside the field's ${length} code units`,
      );
    }
    return { ...anchor };
  });

/**
 * `rebaseUpdates` from `@codemirror/collab`, kept here so that the other side
 * of the rebase comes back with it. `complement` is the one change
 * description that takes the document `updates` yields to the document
 * `rebased` yields over `over`'s: `over` without the updates `updates`
 * already holds, composed and mapped as the library maps them, so the two
 * sides stay the two sides of one rebase (CodeMirror's `ChangeSet.map`
 * contract). It is absent when nothing in `over` is foreign to `updates`.
 */
const rebase = (
  updates: readonly Update[],
  over: readonly Update[],
): { rebased: Update[]; complement: ChangeDesc | undefined } => {
  let changes: ChangeDesc | undefined;
  let skip = 0;
  for (const update of over) {
    const own = skip < updates.length ? updates[skip] : undefined;
    if (own !== undefined && own.clientID === update.clientID) {
      if (changes !== undefined) changes = changes.mapDesc(own.changes, true);
      skip++;
    } else {
      changes = changes === undefined
        ? update.changes.desc
        : changes.composeDesc(update.changes);
    }
  }
  const remaining = updates.slice(skip);
  if (changes === undefined) return { rebased: remaining, complement: changes };
  let complement = changes;
  const rebased = remaining.map((update) => {
    const updateChanges = update.changes.map(complement);
    complement = complement.mapDesc(update.changes, true);
    return {
      changes: updateChanges,
      ...(update.effects === undefined
        ? {}
        : { effects: StateEffect.mapEffects(update.effects, complement) }),
      clientID: update.clientID,
    };
  });
  return { rebased, complement };
};

const codeMirrorChangeSetCodec: OperationCodec = {
  id: CODEMIRROR_CHANGESET_CODEC,
  integrate({ materialized, submitted, intervening, anchors }) {
    if (typeof materialized !== "string") {
      throw new Error("CodeMirror operations require a string field");
    }
    const over = intervening.flatMap(decodePayload);
    const seenDedupeIds = new Set(
      over.flatMap(({ dedupeId }) => dedupeId === undefined ? [] : [dedupeId]),
    );
    const submittedUpdates = decodePayload(submitted).map(({ update }) =>
      update
    );
    const { rebased: acceptedWithDuplicates, complement } = rebase(
      submittedUpdates,
      over.map(({ update }) => update),
    );
    const accepted: Update[] = [];
    // `rebaseUpdates` must see the submitted batch intact so it can recognize
    // the client's already-integrated prefix. Semantic duplicates are removed
    // afterwards. `suppressed` maps the kept document to the ordinary OT
    // result, letting later updates move back across any removed rewrite.
    let suppressed = ChangeSet.empty(materialized.length).desc;
    for (const update of acceptedWithDuplicates) {
      const dedupeId = codeMirrorDedupeId(update);
      if (dedupeId !== undefined && seenDedupeIds.has(dedupeId)) {
        suppressed = suppressed.composeDesc(update.changes.desc);
        continue;
      }
      if (dedupeId !== undefined) seenDedupeIds.add(dedupeId);
      if (suppressed.empty) {
        accepted.push(update);
        continue;
      }
      const changes = update.changes.map(suppressed.invertedDesc);
      accepted.push({ ...update, changes });
      suppressed = suppressed.mapDesc(changes.desc, true);
    }
    let document = Text.of(materialized.split("\n"));
    for (const update of accepted) {
      document = update.changes.apply(document);
    }
    const result: OperationCodecResult = {
      materialized: document.toString(),
      operations: accepted.map((update) => ({
        updates: [encodeUpdate(update)],
      })),
    };
    if (anchors === undefined) return result;
    // The anchors are stated against the submitting client's document: the
    // base with every submitted update applied, whose length the last update
    // ends at, or the base itself, which the first intervening update was
    // made over, or the field when nothing was.
    const clientLength = submittedUpdates.length > 0
      ? submittedUpdates[submittedUpdates.length - 1].changes.newLength
      : over.length > 0
      ? over[0].update.changes.length
      : materialized.length;
    // The rebase's complement takes that document to the ordinary rebase
    // result; the suppressed duplicates' inverse takes it to the kept
    // document.
    let mapped = anchorsWithin(anchors, clientLength);
    if (complement !== undefined) {
      mapped = mapped.map((anchor) => mapAnchorRange(anchor, complement));
    }
    if (!suppressed.empty) {
      mapped = mapped.map((anchor) =>
        mapAnchorRange(anchor, suppressed.invertedDesc)
      );
    }
    return { ...result, anchors: mapped };
  },
  mapAnchors({ anchors, materialized, operations }) {
    if (typeof materialized !== "string") {
      throw new Error("CodeMirror anchors require a string field");
    }
    const changes = operations.flatMap(decodePayload).map(({ update }) =>
      update.changes
    );
    // The anchors are stated against the value before the operations: its
    // length is what the first change set was made over, and the field's
    // own length when there is nothing to map through.
    let mapped = anchorsWithin(
      anchors,
      changes.length === 0 ? materialized.length : changes[0].length,
    );
    // One change set at a time, as an editor maps through each transaction:
    // a range one change empties stays a point through the rest.
    for (const changeSet of changes) {
      mapped = mapped.map((anchor) => mapAnchorRange(anchor, changeSet.desc));
    }
    return mapped;
  },
};

export const createDefaultOperationCodecRegistry = () =>
  new OperationCodecRegistry([codeMirrorChangeSetCodec]);
