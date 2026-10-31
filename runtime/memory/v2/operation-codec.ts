import { rebaseUpdates, type Update } from "@codemirror/collab";
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
};

export type OperationCodecResult = {
  materialized: FabricValue;
  operations: FabricValue[];
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
   * operations map to the same ranges in every process. Throws when an anchor
   * lies outside the value it is stated against.
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

const codeMirrorChangeSetCodec: OperationCodec = {
  id: CODEMIRROR_CHANGESET_CODEC,
  integrate({ materialized, submitted, intervening }) {
    if (typeof materialized !== "string") {
      throw new Error("CodeMirror operations require a string field");
    }
    const over = intervening.flatMap(decodePayload);
    const seenDedupeIds = new Set(
      over.flatMap(({ dedupeId }) => dedupeId === undefined ? [] : [dedupeId]),
    );
    const acceptedWithDuplicates = rebaseUpdates(
      decodePayload(submitted).map(({ update }) => update),
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
    return {
      materialized: document.toString(),
      operations: accepted.map((update) => ({
        updates: [encodeUpdate(update)],
      })),
    };
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
    const baseLength = changes.length === 0
      ? materialized.length
      : changes[0].length;
    let mapped = anchors.map((anchor) => {
      if (
        !Number.isSafeInteger(anchor.from) ||
        !Number.isSafeInteger(anchor.to) ||
        anchor.from < 0 || anchor.to < anchor.from || anchor.to > baseLength
      ) {
        throw new Error(
          `CodeMirror anchor ${anchor.id} lies outside the field's ${baseLength} code units`,
        );
      }
      return { ...anchor };
    });
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
