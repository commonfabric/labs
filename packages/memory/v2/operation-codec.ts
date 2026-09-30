import { rebaseUpdates, type Update } from "@codemirror/collab";
import { ChangeSet, StateEffect, Text } from "@codemirror/state";
import type { FabricValue } from "@commonfabric/api";
import { hashStringOf } from "@commonfabric/data-model";
import { isObjectNotArray } from "@commonfabric/utils/types";
import { CODEMIRROR_CHANGESET_CODEC, encodeMemoryBoundary } from "../v2.ts";

export { CODEMIRROR_CHANGESET_CODEC } from "../v2.ts";

export type OperationCodecInput = {
  materialized: FabricValue;
  submitted: FabricValue;
  intervening: readonly FabricValue[];
};

export type OperationCodecResult = {
  materialized: FabricValue;
  operations: FabricValue[];
};

export type OperationCodec = {
  readonly id: string;
  integrate(input: OperationCodecInput): OperationCodecResult;
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

export const operationBaselineHash = (value: FabricValue): string =>
  hashStringOf(encodeMemoryBoundary(value));

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
};

export const createDefaultOperationCodecRegistry = () =>
  new OperationCodecRegistry([codeMirrorChangeSetCodec]);
