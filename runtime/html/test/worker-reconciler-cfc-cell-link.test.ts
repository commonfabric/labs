import { expect } from "@std/expect";

import type { CfcAtom } from "@commonfabric/api/cfc";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { defaultRenderConfidentialityCeiling } from "@commonfabric/lib-shell/runtime";
import {
  type Cell,
  type JSONSchema,
  KeepAsCell,
  NAME,
  Runtime,
} from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import {
  renderConfidentialityResolverFor,
  renderMembershipProviderFor,
  renderModulePolicySourceFor,
  renderSpaceAccessProviderFor,
} from "../../runtime-client/src/backends/runtime-processor.ts";
import {
  createCellRef,
  getCell,
} from "../../runtime-client/src/backends/utils.ts";
import type { VDomOp } from "../src/vdom-ops.ts";
import { WorkerReconciler } from "../src/worker/reconciler.ts";
import type { WorkerReconcilerOptions } from "../src/worker/types.ts";

// A `cf-cell-link` shows what its `$cell` binding names only through reads
// of its own: it follows the reference to the cell it lands on, and asks the
// worker for that cell's `[NAME]`, which the host's read gate decides on its
// own. So the binding is handed over wherever the viewer may see the
// reference, whatever the bound cell's schema reaches beyond it. The worked
// case is a FabriChat room's row: the link to the room carries the room's
// schema, which reads each profile on its roster, and a profile someone else
// owns is beyond the viewer's display ceiling. Each step builds the
// reconciler as the worker builds one for a mount, under the shell's default
// display ceiling for the viewer.
//
// `Deno.test` rather than `describe`/`it`: this package installs its fake
// clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
// a `@std/testing/bdd` `it()` callback never receives that context.

Deno.test("worker reconciler CFC decisions over a cf-cell-link's binding", async (t) => {
  const owner = await Identity.fromPassphrase("cell link owner");
  const other = await Identity.fromPassphrase("cell link other member");
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const space = owner.did();
  const OTHER_NAME = "other-members-own-name";

  /** Reconciler options for `viewer`, as the worker builds them for a mount. */
  const viewedBy = (viewer: Identity): Partial<WorkerReconcilerOptions> => {
    const ceiling = defaultRenderConfidentialityCeiling(viewer.did());
    const membershipProvider = renderMembershipProviderFor(
      runtime,
      viewer,
      ceiling,
    );
    const modulePolicySource = renderModulePolicySourceFor(runtime, ceiling);
    return {
      renderConfidentialityCeiling: ceiling,
      resolveRenderConfidentiality: renderConfidentialityResolverFor(
        runtime,
        viewer,
        ceiling,
        viewer.did(),
        membershipProvider,
        modulePolicySource,
      ),
      membershipProvider,
      modulePolicySource,
      spaceAccess: renderSpaceAccessProviderFor(runtime),
    };
  };

  /**
   * Writes `value` to the document named `id`, with stored labels giving each
   * path in `labels` its confidentiality.
   */
  const write = async (
    id: string,
    value: unknown,
    labels: readonly [path: string[], confidentiality: readonly CfcAtom[]][] =
      [],
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, id, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      space,
      id: cell.getAsNormalizedFullLink().id!,
      type: "application/json",
      path: [],
    }, {
      value: value as never,
      ...(labels.length === 0 ? {} : {
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: labels.map(([path, confidentiality]) => ({
              path,
              label: { confidentiality },
            })),
          },
        },
      }),
    });
    expect((await tx.commit().settled).ok).toBeDefined();
    return runtime.getCell(space, id);
  };

  const link = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });

  const vnode = (
    name: string,
    children: readonly unknown[],
    props: Record<string, unknown> = {},
  ) => ({ type: "vnode", name, props, children });

  // The schema a room's link stores: it reads each profile on the roster, the
  // profile's name among it, rather than only naming the profile.
  const roomSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      roster: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" } } },
      },
    },
  } as const satisfies JSONSchema;

  /**
   * A room whose roster lists a profile of `profileOwner`'s, labeled as
   * theirs alone, and a page listing the room as a row's `cf-cell-link`,
   * bound through the row's slot under `roomSchema`.
   */
  const roomRowPage = async (id: string, profileOwner: Identity) => {
    const profile = await write(`${id}-profile`, { name: OTHER_NAME }, [
      [[], [cfcAtom.user(profileOwner.did())]],
    ]);
    const room = await write(`${id}-room`, {
      [NAME]: "Team chat",
      title: "Team chat",
      roster: [link(profile)],
    });
    const rows = await write(`${id}-rows`, {
      element: { room: link(room) },
    });
    const slot = rows.key("element").key("room").asSchema(roomSchema);
    return write(
      `${id}-page`,
      vnode("div", [
        vnode("cf-cell-link", [], { label: "Team chat", $cell: link(slot) }),
      ]),
    );
  };

  /** Mounts `page` for `viewer`, and returns its `cell` bindings and text. */
  const mount = async (page: Cell<unknown>, viewer: Identity) => {
    const ops: VDomOp[] = [];
    const cancel = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
      ...viewedBy(viewer),
    }).mount(
      getCell(runtime, createCellRef(page)).asSchema(rendererVDOMSchema),
    );
    await t.settle();
    cancel();
    return {
      bindings:
        ops.filter((op) => op.op === "set-binding" && op.propName === "cell")
          .length,
      emitted: JSON.stringify(ops),
    };
  };

  try {
    await t.step(
      "binds a row's link to a room whose roster holds only the viewer's own profile",
      async () => {
        const mounted = await mount(await roomRowPage("own", owner), owner);
        expect(mounted.bindings).toBe(1);
      },
    );

    await t.step(
      "binds a row's link to a room whose roster holds a profile only its owner may see",
      async () => {
        const mounted = await mount(await roomRowPage("shared", other), owner);
        expect(mounted.bindings).toBe(1);
        // The binding hands over the reference, and nothing the roster holds.
        expect(mounted.emitted).not.toContain(OTHER_NAME);
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
