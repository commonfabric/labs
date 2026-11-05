import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createFactoryShell } from "@commonfabric/data-model/fabric-factory";
import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { getMetaCell } from "../src/link-utils.ts";
import { sendValueToBinding } from "../src/pattern-binding.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { Cell } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "factory artifact publication test",
);
const destinationSpace = signer.did();
const REF = {
  identity: "PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "publicationFactory",
} as const;
const unavailableFactory = createFactoryShell({
  kind: "module",
  ref: REF,
  argumentSchema: true,
  resultSchema: true,
}) as FabricValue;

describe("Factory@1 artifact publication fences", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    runtime.patternManager.isArtifactAvailableInSpace = () => false;
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      tx.abort(new Error("test cleanup"));
    }
    await runtime.dispose();
    await storageManager.close();
  });

  function expectedUnavailableMessage(): string {
    return `Factory artifact ${REF.identity} is not available in space ${destinationSpace}`;
  }

  it("rejects an unavailable factory before a normal output binding write", () => {
    const resultCell = runtime.getCell<{ factory?: FabricValue }>(
      destinationSpace,
      "unavailable factory output binding",
      undefined,
      tx,
    );
    const argumentCellLink = getMetaCell(resultCell, "argument", tx)
      .getAsNormalizedFullLink();

    expect(() =>
      sendValueToBinding(
        tx,
        resultCell,
        argumentCellLink,
        { $alias: { cell: "result", path: ["factory"] } },
        unavailableFactory,
      )
    ).toThrow(expectedUnavailableMessage());
    expect(resultCell.key("factory").getRaw()).toBeUndefined();
  });

  it("checks the outer factory before writing an alias nested under an array", () => {
    const resultCell = runtime.getCell<{ nested?: number }>(
      destinationSpace,
      "unavailable factory nested array binding",
      undefined,
      tx,
    );
    const argumentCellLink = getMetaCell(resultCell, "argument", tx)
      .getAsNormalizedFullLink();
    const metadata = {
      kind: "pattern" as const,
      ref: REF,
      argumentSchema: true,
      resultSchema: true,
      paramsSchema: true,
    };
    const bindingFactory = createFactoryShell({
      ...metadata,
      params: {
        items: [{ $alias: { cell: "result", path: ["nested"] } }],
      },
    });
    const valueFactory = createFactoryShell({
      ...metadata,
      params: { items: [123] },
    });

    expect(() =>
      sendValueToBinding(
        tx,
        resultCell,
        argumentCellLink,
        bindingFactory,
        valueFactory,
      )
    ).toThrow(expectedUnavailableMessage());
    expect(resultCell.key("nested").getRaw()).toBeUndefined();
  });

  it("rejects an unavailable factory before a query-result Cell write", () => {
    const destination = runtime.getCell<{ factory?: FabricValue }>(
      destinationSpace,
      "unavailable factory query result",
      {
        type: "object",
        properties: { factory: { asCell: ["cell"] } },
      },
      tx,
    );
    destination.set({ factory: null });
    const writable = destination.get() as unknown as {
      factory: Cell<FabricValue>;
    };

    expect(() => {
      writable.factory.set(unavailableFactory);
    }).toThrow(expectedUnavailableMessage());
    expect(destination.key("factory").getRaw()).toBeNull();
  });
});
