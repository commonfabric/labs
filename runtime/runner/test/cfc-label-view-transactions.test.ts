import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  cfcLabelViewForCellWithStatus,
  cfcLabelViewForResolvedCellWithStatus,
} from "../src/cfc/label-view.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-label-view-transactions",
);

/**
 * A label read of a cell bound to no transaction reads through a transaction
 * of its own. The reads it is made of — the cell's own stored labels, the
 * labels along the links its path follows, and the labels of the document
 * the path resolves to — share that one transaction, so the second resolution
 * of the same link is served from the first's memo and the same stored
 * envelope is read once. A cell bound to a live transaction reads through
 * it and opens none.
 */
describe("label-view transactions", () => {
  const space = signer.did();

  const withRuntime = async (
    body: (runtime: Runtime) => Promise<void>,
  ) => {
    const storageManager = StorageManager.emulate({ as: signer });
    try {
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      try {
        await body(runtime);
      } finally {
        await runtime.dispose();
      }
    } finally {
      await storageManager.close();
    }
  };

  const commit = async (runtime: Runtime, write: (tx: never) => void) => {
    const tx = runtime.edit();
    write(tx as never);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
  };

  /** Runs `read` and returns how many transactions the runtime opened for it. */
  const transactionsOpenedBy = (runtime: Runtime, read: () => void) => {
    const edit = runtime.edit.bind(runtime);
    let opened = 0;
    runtime.edit = ((...args: Parameters<typeof runtime.edit>) => {
      opened += 1;
      return edit(...args);
    }) as typeof runtime.edit;
    try {
      read();
    } finally {
      runtime.edit = edit;
    }
    return opened;
  };

  // A labeled row behind a link the path crosses: the read resolves the
  // link to reach the row's label, and reads the query document's own.
  const linkedRow = async (runtime: Runtime) => {
    const row = runtime.getCell<{ secret: string }>(space, "tx-row", {
      type: "object",
      additionalProperties: true,
      properties: {
        secret: { type: "string", ifc: { confidentiality: ["finance"] } },
      },
    });
    await commit(runtime, (tx) => {
      row.withTx(tx).set({ secret: "top secret" });
    });
    const query = runtime.getCell<Record<string, unknown>>(space, "tx-query");
    await commit(runtime, (tx) => {
      query.withTx(tx).key("result").key(0).setRawUntyped(row.getAsLink());
    });
    return query.key("result").key(0).key("secret");
  };

  it("opens one transaction for a resolved label read of a cell bound to none", async () => {
    await withRuntime(async (runtime) => {
      const leaf = await linkedRow(runtime);
      let status;
      const opened = transactionsOpenedBy(runtime, () => {
        status = cfcLabelViewForResolvedCellWithStatus(leaf);
      });
      expect(opened).toBe(1);
      expect(status).toEqual({
        readFailed: false,
        view: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: ["finance"] } }],
        },
      });
    });
  });

  it("opens one transaction for a label read of a cell bound to none", async () => {
    await withRuntime(async (runtime) => {
      const leaf = await linkedRow(runtime);
      let status;
      const opened = transactionsOpenedBy(runtime, () => {
        status = cfcLabelViewForCellWithStatus(leaf);
      });
      expect(opened).toBe(1);
      expect(status).toEqual({
        readFailed: false,
        view: {
          version: 1,
          entries: [{ path: [], label: { confidentiality: ["finance"] } }],
        },
      });
    });
  });

  it("reports a failed read, and throws nothing, when the transaction cannot be opened", async () => {
    await withRuntime(async (runtime) => {
      const leaf = await linkedRow(runtime);
      const edit = runtime.edit.bind(runtime);
      runtime.edit = (() => {
        throw new Error("no transaction for this read");
      }) as typeof runtime.edit;
      try {
        expect(cfcLabelViewForResolvedCellWithStatus(leaf)).toEqual({
          view: undefined,
          readFailed: true,
        });
        expect(cfcLabelViewForCellWithStatus(leaf)).toEqual({
          view: undefined,
          readFailed: true,
        });
      } finally {
        runtime.edit = edit;
      }
    });
  });

  it("opens no transaction for a cell bound to a live one", async () => {
    await withRuntime(async (runtime) => {
      const leaf = await linkedRow(runtime);
      const tx = runtime.edit();
      try {
        const bound = leaf.withTx(tx);
        let view;
        const opened = transactionsOpenedBy(runtime, () => {
          view = cfcLabelViewForResolvedCellWithStatus(bound).view;
        });
        expect(opened).toBe(0);
        expect(view).toEqual({
          version: 1,
          entries: [{ path: [], label: { confidentiality: ["finance"] } }],
        });
      } finally {
        tx.abort();
      }
    });
  });
});
