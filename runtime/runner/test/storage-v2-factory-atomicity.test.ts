import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import type { FabricValue } from "@commonfabric/data-model";
import {
  createFactoryShell,
  registerFabricFactory,
  trySealedFactoryState,
} from "@commonfabric/data-model/fabric-factory";
import { toDocumentPath } from "@commonfabric/memory/v2";

import type {
  IStorageManager,
  MemorySpace,
  State,
} from "../src/storage/interface.ts";
import { V2StorageTransaction } from "../src/storage/v2-transaction.ts";

const SPACE = "did:test:factory-storage-atomicity" as MemorySpace;
const REF = {
  identity: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "factory",
} as const;
const ADDRESS = {
  space: SPACE,
  scope: "space" as const,
  id: "of:factory-storage-atomicity" as const,
  type: "application/json" as const,
  path: toDocumentPath(["value"]),
};

const shell = (symbol: string = REF.symbol) =>
  createFactoryShell({
    kind: "module",
    ref: { ...REF, symbol },
  });

const managerWith = (value: FabricValue): IStorageManager => {
  const document = value === undefined ? undefined : { value };
  const state: State = {
    the: ADDRESS.type,
    of: ADDRESS.id,
    is: document,
  } as State;
  const replica = {
    did: () => SPACE,
    get: () => state,
    getDocument: () => document,
    hasPendingWrite: () => false,
  };
  return {
    open: () => ({ replica }),
  } as unknown as IStorageManager;
};

Deno.test("storage v2 freezes and seals a live factory returned by a transaction read", () => {
  const live = registerFabricFactory(() => undefined, "module", {
    kind: "module",
    rootToken: {},
    ref: REF,
  });
  assertEquals(Object.isFrozen(live), false);
  assertEquals(trySealedFactoryState(live), undefined);

  const tx = new V2StorageTransaction(managerWith(live));
  const result = tx.read(ADDRESS);

  assert(result.ok);
  assertStrictEquals(result.ok.value, live);
  assert(Object.isFrozen(result.ok.value));
  assertEquals(trySealedFactoryState(live), {
    kind: "module",
    ref: REF,
  });
});

Deno.test("storage v2 rejects an arbitrary function returned by a transaction read", () => {
  const arbitrary = (() => undefined) as unknown as FabricValue;
  const tx = new V2StorageTransaction(managerWith(arbitrary));

  assertThrows(
    () => tx.read(ADDRESS),
    Error,
    "arbitrary function",
  );
});

Deno.test("storage v2 treats equal factory shells as a no-op and changed state as a root-value write", () => {
  const equalTx = new V2StorageTransaction(managerWith(shell()));
  const equalWrite = equalTx.write(ADDRESS, shell());
  assert(equalWrite.ok);
  assertEquals([...equalTx.getWriteDetails(SPACE)], []);

  const changedTx = new V2StorageTransaction(managerWith(shell()));
  const replacement = shell("replacement");
  const changedWrite = changedTx.write(ADDRESS, replacement);
  assert(changedWrite.ok);
  const details = [...changedTx.getWriteDetails(SPACE)];
  assertEquals(details.length, 1);
  assertEquals([...details[0].address.path], ["value"]);
  assertStrictEquals(details[0].value, replacement);
});

Deno.test("storage v2 carries one keyed wire preparation without committing it locally", () => {
  const tx = new V2StorageTransaction(managerWith(undefined));
  const preparation = {
    key: "artifact:factory",
    prepare: () => [{
      op: "ensure" as const,
      id: "pattern:factory" as const,
      type: "application/json" as const,
      value: { value: { kind: "source" } },
    }],
  };

  tx.addNativeCommitPreparation(SPACE, preparation);
  tx.addNativeCommitPreparation(SPACE, preparation);

  const native = tx.getNativeCommit(SPACE);
  assertEquals(native?.operations, []);
  assertEquals(native?.preparations, [preparation]);
  assertEquals([...tx.getWriteDetails(SPACE)], []);
});

Deno.test("storage v2 removes keyed wire preparation from the current draft", () => {
  const tx = new V2StorageTransaction(managerWith(undefined));
  tx.addNativeCommitPreparation(SPACE, {
    key: "artifact:factory",
    prepare: () => [],
  });

  tx.removeNativeCommitPreparation(SPACE, "artifact:factory");

  assertEquals(tx.getNativeCommit(SPACE), undefined);
});

Deno.test("storage v2 rejects a native preparation when its transaction aborts locally", () => {
  const tx = new V2StorageTransaction(managerWith(undefined));
  const reason = new Error("local transaction rejection");
  let observed: unknown;
  tx.addNativeCommitPreparation(SPACE, {
    key: "artifact:factory",
    prepare: () => [],
    onRejected: (value) => {
      observed = value;
    },
  });

  const result = tx.abort(reason);

  assert(result.ok);
  assertStrictEquals(observed, reason);
});
