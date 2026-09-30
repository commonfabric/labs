import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";

import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  cfcLabelViewForCellWithStatus,
  cfcLabelViewForResolvedCellWithStatus,
  cfcLabelViewForResolvedTarget,
} from "../src/cfc/label-view.ts";

const signer = await Identity.fromPassphrase("runner-cfc-label-view-resolved");

/**
 * `cfcLabelViewForResolvedCellWithStatus` answers "what is the label here"
 * about a path a person selected, so it reads the doc that path RESOLVES to
 * rather than only the doc it started in. The one-hop reader it builds on
 * follows a link the path lands ON; a path that CROSSES one part way through
 * — a sqlite query result, whose rows each split into their own entity doc —
 * needs the runtime's own resolution to reach the doc holding the label.
 */
describe("cfcLabelViewForResolvedCellWithStatus", () => {
  const space = signer.did();

  /**
   * The storage manager is closed in the OUTER `finally`, so it is released
   * whether the runtime was ever constructed and whether disposing it rejected
   * — an emulated manager holds a loopback server, and one left open outlives
   * the test that opened it.
   */
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
    expect((await tx.commit()).error).toBeUndefined();
  };

  it("reaches a label two docs away, behind a link the path CROSSES", async () => {
    await withRuntime(async (runtime) => {
      // The shape a labeled query result stores: the row is its own doc and
      // carries the per-column label; the query doc only links to it.
      const row = runtime.getCell<{ secret: string }>(space, "resolved-row", {
        type: "object",
        additionalProperties: true,
        properties: {
          secret: { type: "string", ifc: { confidentiality: ["finance"] } },
        },
      });
      await commit(runtime, (tx) => {
        row.withTx(tx).set({ secret: "top secret" });
      });

      const query = runtime.getCell<Record<string, unknown>>(
        space,
        "resolved-query",
      );
      await commit(runtime, (tx) => {
        query.withTx(tx).key("result").key(0).setRawUntyped(row.getAsLink());
      });

      const leaf = query.key("result").key(0).key("secret");
      // The one-hop reader starts in the query doc and never arrives.
      expect(cfcLabelViewForCellWithStatus(leaf).view).toBeUndefined();

      const reference = {
        path: [],
        observes: "followRef",
        label: {
          integrity: [{
            type: "https://commonfabric.org/cfc/atom/LinkReference",
            source: { space, id: row.getAsNormalizedFullLink().id, path: [] },
            target: {
              space,
              id: query.getAsNormalizedFullLink().id,
              path: ["result", "0"],
            },
          }],
        },
      };
      const status = cfcLabelViewForResolvedCellWithStatus(leaf);
      expect(status.readFailed).toBe(false);
      expect(status.view?.entries).toEqual([
        reference,
        { path: [], label: { confidentiality: ["finance"] } },
      ]);

      // Selecting the ROW reports one entry per labeled column.
      const atRow = cfcLabelViewForResolvedCellWithStatus(
        query.key("result").key(0),
      );
      expect(atRow.view?.entries).toEqual([
        reference,
        { path: ["secret"], label: { confidentiality: ["finance"] } },
      ]);
    });
  });

  it("keeps the SLOT's own label beside the target's — strictly additive", async () => {
    await withRuntime(async (runtime) => {
      // Two labels at one selection: one declared on the slot the path names,
      // one stored on the doc its value links to. Both belong in the answer;
      // reading only the resolved doc would drop the slot's.
      const target = runtime.getCell<string>(space, "additive-target", {
        type: "string",
        ifc: { confidentiality: ["from-target"] },
      });
      await commit(runtime, (tx) => {
        target.withTx(tx).set("linked value");
      });

      const holder = runtime.getCell<{ body: string }>(
        space,
        "additive-holder",
        {
          type: "object",
          properties: {
            body: { type: "string", ifc: { confidentiality: ["from-slot"] } },
          },
        },
      );
      await commit(runtime, (tx) => {
        holder.withTx(tx).set({ body: "placeholder" });
      });
      await commit(runtime, (tx) => {
        holder.withTx(tx).key("body").setRawUntyped(target.getAsLink());
      });

      const slot = holder.key("body");
      const atoms = (status: { view?: { entries: ReadonlyArray<unknown> } }) =>
        ((status.view?.entries ?? []) as Array<
          { label: { confidentiality?: string[] } }
        >).flatMap((entry) => entry.label.confidentiality ?? []).sort();

      // Whatever the one-hop reader finds is still in the resolved answer.
      const onehop = atoms(cfcLabelViewForCellWithStatus(slot));
      const resolved = atoms(cfcLabelViewForResolvedCellWithStatus(slot));
      for (const atom of onehop) expect(resolved).toContain(atom);
      expect(resolved).toContain("from-slot");
      expect(resolved).toContain("from-target");

      // The resolved target's own view leaves the slot's label out, since
      // that label describes the link rather than the value it reaches.
      expect(atoms({ view: cfcLabelViewForResolvedTarget(slot) })).toEqual([
        "from-target",
      ]);
    });
  });

  it("fails CLOSED when the resolution itself throws", async () => {
    await withRuntime(async (runtime) => {
      // A link that points at itself: the runtime's resolution runs out of
      // hops and throws. That is a FAILED read, not an absent label — a
      // reader that swallowed it would report unlabeled for a doc it never
      // managed to look at.
      const loop = runtime.getCell<Record<string, unknown>>(
        space,
        "resolved-loop",
      );
      await commit(runtime, (tx) => {
        loop.withTx(tx).key("self").set("placeholder");
      });
      await commit(runtime, (tx) => {
        loop.withTx(tx).key("self").setRawUntyped(
          loop.key("self").getAsLink(),
        );
      });

      const status = cfcLabelViewForResolvedCellWithStatus(loop.key("self"));
      expect(status.readFailed).toBe(true);
    });
  });

  it("answers a non-cell exactly as the one-hop reader does", () => {
    // A value that is not a cell has no link to resolve. The resolved reader
    // hands back the one-hop answer untouched — no view, and not a failure.
    for (const value of ["plain string", 42, { body: "object" }, undefined]) {
      const status = cfcLabelViewForResolvedCellWithStatus(value);
      expect(status).toEqual(cfcLabelViewForCellWithStatus(value));
      expect(status.readFailed).toBe(false);
      expect(status.view).toBeUndefined();
    }
  });

  it("fails closed when a link getter throws", () => {
    const broken = {
      getAsNormalizedFullLink(): never {
        throw new Error("no link here");
      },
    };
    const status = cfcLabelViewForResolvedCellWithStatus(broken);
    expect(status.readFailed).toBe(true);
    expect(status.view).toBeUndefined();
  });

  it("reports no label, and no failure, for a cell without a runtime", async () => {
    await withRuntime((runtime) => {
      // A link with nothing to resolve it against: without a runtime there is
      // no doc to read, which is an absent label rather than a failed read.
      const link = runtime.getCell<string>(space, "resolved-no-runtime")
        .getAsNormalizedFullLink();
      const detached = { getAsNormalizedFullLink: () => link };
      const status = cfcLabelViewForResolvedCellWithStatus(detached);
      expect(status.readFailed).toBe(false);
      expect(status.view).toBeUndefined();
      return Promise.resolve();
    });
  });
});
