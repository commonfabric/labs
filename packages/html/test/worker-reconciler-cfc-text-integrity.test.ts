import { expect } from "@std/expect";

import type { CfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { type Cell, KeepAsCell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerVNode } from "../src/worker/types.ts";

// A render boundary that requires text integrity shows text only when the
// document holding the text carries the required integrity, whatever the
// documents the read passed through on the way to it carry. Every
// unendorsed string below appears nowhere else, so a search of the emitted
// operations for it is a search for the text having been shown.
//
// `Deno.test` rather than `describe`/`it`: this package installs its fake
// clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
// a `@std/testing/bdd` `it()` callback never receives that context.

Deno.test("worker reconciler CFC text integrity across links", async (t) => {
  const signer = await Identity.fromPassphrase(
    "worker reconciler cfc text integrity",
  );
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const endorsed = { kind: "signed-release", subject: "release-2026" };
  const UNENDORSED = "forged-release-note";
  const ENDORSED = "signed-release-note";
  const PLACEHOLDER = "Content hidden by integrity policy";

  /**
   * Writes `value` to the cell named `id`, with a stored label map holding
   * `entries`, or with no label map when it is undefined.
   */
  const writeLabeled = async (
    id: string,
    value: unknown,
    entries?: readonly unknown[],
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(signer.did(), id, undefined, tx);
    writeSeedEnvelopeDoc(tx, signer.did());
    seedStoredEnvelope(tx, {
      space: signer.did(),
      id: cell.getAsNormalizedFullLink().id!,
      type: "application/json",
      path: [],
    }, {
      value: value as never,
      ...(entries === undefined ? {} : {
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: { version: 1, entries: entries as never },
        },
      }),
    });
    expect((await tx.commit()).ok).toBeDefined();
    return runtime.getCell<unknown>(signer.did(), id);
  };

  /**
   * Writes `value` to the cell named `id`, with a stored label whose integrity
   * is `integrity`, or with no label when it is undefined.
   */
  const write = (id: string, value: unknown, integrity?: readonly CfcAtom[]) =>
    writeLabeled(
      id,
      value,
      integrity === undefined
        ? undefined
        : [{ path: [], label: { integrity } }],
    );

  const link = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });

  /**
   * `table.row.name`, where `table` is labeled `tableIntegrity` and `row`
   * links to a document labeled `rowIntegrity` that holds `name`.
   */
  const crossing = async (
    id: string,
    name: string,
    { tableIntegrity, rowIntegrity }: {
      tableIntegrity?: readonly CfcAtom[];
      rowIntegrity?: readonly CfcAtom[];
    },
  ) => {
    const row = await write(`${id}-row`, { name }, rowIntegrity);
    await write(`${id}-table`, { row: link(row) }, tableIntegrity);
    return runtime.getCell(signer.did(), `${id}-table`).key("row").key("name");
  };

  /** A boundary requiring `[endorsed]` of the text in `children`. */
  const boundary = (children: unknown[]): WorkerVNode => ({
    type: "vnode",
    name: "cf-cfc-authorship",
    props: { verifyTextIntegrity: true, requiredTextIntegrity: endorsed },
    children: children as never,
  });

  /** Mounts `tree`, settles, and returns what was emitted and the unmount. */
  const mount = async (tree: WorkerVNode) => {
    const ops: VDomOp[] = [];
    const cancel = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
    }).mount(tree);
    await t.settle();
    return {
      cancel,
      emitted: () => JSON.stringify(ops),
      texts: () =>
        ops.flatMap((op) =>
          op.op === "create-text" || op.op === "update-text" ? [op.text] : []
        ),
      propsSet: (key: string) =>
        ops.flatMap((op) =>
          op.op === "set-prop" && op.key === key ? [op.value] : []
        ),
    };
  };

  try {
    await t.step(
      "hides text read across a link when the linked document lacks the required integrity",
      async () => {
        const unendorsed = await crossing("text-forged", UNENDORSED, {
          tableIntegrity: [endorsed],
        });
        const admitted = await crossing("text-signed", ENDORSED, {
          tableIntegrity: [endorsed],
          rowIntegrity: [endorsed],
        });
        const page = await mount(boundary([unendorsed, admitted]));
        try {
          expect(page.emitted()).not.toContain(UNENDORSED);
          expect(page.texts()).toEqual([PLACEHOLDER, ENDORSED]);

          // Relabeling the linked document decides the text again: the one
          // that loses the integrity is hidden, the one that gains it shown.
          await write("text-signed-row", { name: ENDORSED });
          await write("text-forged-row", { name: UNENDORSED }, [endorsed]);
          await t.settle();
          expect(page.texts()).toEqual([
            PLACEHOLDER,
            ENDORSED,
            PLACEHOLDER,
            UNENDORSED,
          ]);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "hides text at a path that ends on a link to a document without the required integrity",
      async () => {
        // `table.row`, where `row` is itself a link to a document holding text.
        const landing = async (id: string, text: string) => {
          const row = await write(`${id}-text`, text);
          await write(`${id}-table`, { row: link(row) }, [endorsed]);
          return runtime.getCell(signer.did(), `${id}-table`).key("row");
        };
        const page = await mount(
          boundary([await landing("text-landing", UNENDORSED)]),
        );
        try {
          expect(page.emitted()).not.toContain(UNENDORSED);
          expect(page.texts()).toEqual([PLACEHOLDER]);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "shows text read across a link from a document without the required integrity",
      async () => {
        const signed = await crossing("text-unendorsed-table", ENDORSED, {
          rowIntegrity: [endorsed],
        });
        const page = await mount(boundary([signed]));
        try {
          expect(page.texts()).toEqual([ENDORSED]);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "hides a text-integrity property read across a link when the linked document lacks the required integrity",
      async () => {
        const unendorsed = await crossing("prop-forged", UNENDORSED, {
          tableIntegrity: [endorsed],
        });
        const admitted = await crossing("prop-signed", ENDORSED, {
          tableIntegrity: [endorsed],
          rowIntegrity: [endorsed],
        });
        const page = await mount(boundary([{
          type: "vnode",
          name: "cf-chat-message",
          props: { name: unendorsed, content: admitted },
          children: [],
        }]));
        try {
          expect(page.emitted()).not.toContain(UNENDORSED);
          expect(page.propsSet("name")).toEqual([PLACEHOLDER]);
          expect(page.propsSet("content")).toEqual([ENDORSED]);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "derives the required authorship from the author profile a link reaches",
      async () => {
        const represents = {
          kind: "represents-principal",
          subject: signer.did(),
        };
        const authored = await write("author-text", { body: ENDORSED }, [
          { kind: "authored-by", subject: signer.did() },
        ]);
        // `author` is `table.row`, where `row` links to a profile.
        const authoredUnder = async (
          id: string,
          integrity: {
            tableIntegrity?: readonly CfcAtom[];
            rowIntegrity?: readonly CfcAtom[];
          },
        ) => {
          const profile = await write(
            `${id}-profile`,
            { name: "Profile" },
            integrity.rowIntegrity,
          );
          await write(
            `${id}-table`,
            { row: link(profile) },
            integrity.tableIntegrity,
          );
          return await mount({
            type: "vnode",
            name: "cf-cfc-authorship",
            props: {
              verifyTextIntegrity: true,
              author: runtime.getCell(signer.did(), `${id}-table`).key("row"),
            },
            children: [authored.key("body") as never],
          });
        };
        const unrepresented = await authoredUnder("author-unrepresented", {
          tableIntegrity: [represents],
        });
        const represented = await authoredUnder("author-represented", {
          rowIntegrity: [represents],
        });
        try {
          expect(unrepresented.texts()).toEqual([PLACEHOLDER]);
          expect(represented.texts()).toEqual([ENDORSED]);
        } finally {
          unrepresented.cancel();
          represented.cancel();
        }
      },
    );

    await t.step(
      "hides text inside or around an author that represents no one",
      async () => {
        const text = await write("nested-author-text", { body: ENDORSED }, [
          endorsed,
        ]);
        const profile = await write("nested-author-profile", {
          name: "Profile",
        });
        const page = await mount(boundary([
          text.key("body"),
          {
            type: "vnode",
            name: "cf-cfc-authorship",
            props: { verifyTextIntegrity: true, author: profile },
            children: [text.key("body") as never],
          },
        ]));
        // The same boundaries nested the other way round.
        const inverted = await mount({
          type: "vnode",
          name: "cf-cfc-authorship",
          props: { verifyTextIntegrity: true, author: profile },
          children: [boundary([text.key("body")])],
        });
        try {
          expect(inverted.texts()).toEqual([PLACEHOLDER]);
          expect(inverted.propsSet("textIntegrityState").at(-1)).toBe(
            "blocked",
          );
          expect(page.texts()).toEqual([ENDORSED, PLACEHOLDER]);
        } finally {
          inverted.cancel();
          page.cancel();
        }
      },
    );

    await t.step(
      "hides text whose only integrity is on an entry describing a link",
      async () => {
        // An entry a link carried, as one left at a slot whose link was
        // replaced by text, describes the link rather than the text.
        const stale = await writeLabeled("text-link-entry", {
          name: UNENDORSED,
        }, [{
          path: ["name"],
          label: { integrity: [endorsed] },
          origin: "link",
        }]);
        const page = await mount(boundary([stale.key("name")]));
        try {
          expect(page.emitted()).not.toContain(UNENDORSED);
          expect(page.texts()).toEqual([PLACEHOLDER]);
        } finally {
          page.cancel();
        }
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
