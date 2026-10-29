import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IWriteOptions,
} from "../src/storage/interface.ts";
import {
  type FabricPlainObject,
  type FabricValue,
  isFabricArray,
  isFabricPlainObject,
  isValidFabricValue,
} from "@commonfabric/data-model";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

/**
 * The schema document CFC-metadata SEEDS reference. The commit boundary
 * validates a metadata `schemaHash` like any other schema reference —
 * backed by a verifying document or refused — so a fixture that seeds
 * stored label state names this real document and installs it in the
 * same transaction with {@link writeSeedEnvelopeDoc}.
 */
export const SEED_ENVELOPE_SCHEMA = {
  type: "object",
  title: "cfc-test-seed-envelope",
} as const satisfies JSONSchema;

export const SEED_ENVELOPE_SCHEMA_HASH: string = internSchemaAsTaggedHashString(
  SEED_ENVELOPE_SCHEMA,
);

/** Installs the seed envelope document so the seeding commit verifies. */
export const writeSeedEnvelopeDoc = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
): void => {
  tx.writeOrThrow({
    space,
    scope: "space",
    id: `cid:${SEED_ENVELOPE_SCHEMA_HASH}` as URI,
    path: [],
  }, { value: SEED_ENVELOPE_SCHEMA });
};

/**
 * Writes a stored document envelope with the runtime's own authority.
 *
 * A document's reserved siblings — the `cfc` label map and `source` — are the
 * runtime's to write, and the write chokepoint records any other writer that
 * changes one. A fixture stands outside the runtime and still needs stored
 * label state, in shapes the derivation pass does not produce: a forged atom,
 * a version this build cannot read, a record carrying no label map. This runs
 * the write inside the privileged persistence scope, the same scope
 * `prepareBoundaryCommit()` lands a derived label map in, so the seed is not
 * recorded as the forgery it resembles.
 */
export const seedStoredEnvelope = (
  tx: IExtendedStorageTransaction,
  address: IMemorySpaceAddress,
  value: FabricValue,
  options?: IWriteOptions,
): void => {
  (tx as ExtendedStorageTransaction).accessForTestingOnly
    .privilegedSystemWrite(address, value, options);
};

/**
 * The fields the stored document at `document` holds, its `value` among them,
 * or none when it holds nothing, read through `tx`.
 *
 * @throws When the document holds something other than a record of fields.
 */
export const storedFields = (
  tx: IExtendedStorageTransaction,
  document: IMemorySpaceAddress,
): FabricPlainObject => {
  const stored = tx.readOrThrow(document);
  if (stored === undefined) return {};
  if (!isFabricPlainObject(stored)) {
    throw new Error(`The document ${document.id} holds no record of fields.`);
  }
  return stored;
};

/**
 * `value` as a stored value, such as a link a cell's `getAsLink()` makes.
 *
 * @throws When `value` is not one a document can store.
 */
export const asStoredValue = (value: unknown): FabricValue => {
  if (!isValidFabricValue(value)) {
    throw new Error("The value is not one a document can store.");
  }
  return value;
};

/**
 * The list `value` holds, or an empty one when it holds nothing.
 *
 * @throws When `value` holds something other than a list.
 */
export const storedList = (value: FabricValue): readonly FabricValue[] => {
  if (value === undefined) return [];
  if (!isFabricArray(value)) throw new Error("The value holds no list.");
  return value;
};

/**
 * Labels the document at `address` as the profile `principal` owns: a
 * `represents-principal` claim naming `principal` at its root, which is what
 * the rule for whose own profile a profile is (`profileOwnerAt()`) reads, as
 * a profile its owner set up carries one. The claim joins the label the
 * document already stores, if any, and otherwise is its whole label, with the
 * seed envelope document it then references installed beside it, all in `tx`.
 */
export const seedProfileOwner = (
  tx: IExtendedStorageTransaction,
  address: Omit<IMemorySpaceAddress, "path">,
  principal: string,
): void => {
  const at = { ...address, path: ["cfc"] };
  const entry = {
    path: [],
    label: {
      integrity: [{ kind: "represents-principal", subject: principal }],
    },
    origin: "declared",
  };
  const stored = tx.readOrThrow(at);
  if (stored !== undefined && isFabricPlainObject(stored)) {
    const { labelMap } = stored;
    if (labelMap !== undefined && isFabricPlainObject(labelMap)) {
      seedStoredEnvelope(tx, at, {
        ...stored,
        labelMap: {
          ...labelMap,
          entries: [...storedList(labelMap.entries), entry],
        },
      });
      return;
    }
  }
  writeSeedEnvelopeDoc(tx, address.space);
  seedStoredEnvelope(tx, at, {
    version: 1,
    schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
    labelMap: { version: 1, entries: [entry] },
  });
};
