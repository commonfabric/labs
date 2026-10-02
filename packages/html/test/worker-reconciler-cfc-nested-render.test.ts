import { expect } from "@std/expect";

import type { CfcAtom } from "@commonfabric/api/cfc";
import {
  CFC_ATOM_TYPE,
  CFC_CONCEPT_KIND,
  cfcAtom,
} from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { defaultRenderConfidentialityCeiling } from "@commonfabric/lib-shell/runtime";
import {
  type Cell,
  CHIP_UI,
  type JSONSchema,
  KeepAsCell,
  NAME,
  Runtime,
  TILE_UI,
  UI,
} from "@commonfabric/runner";
import { rendererVDOMSchema } from "@commonfabric/runner/schemas";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { CellRef } from "@commonfabric/runtime-client";

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

// `cf-render` shows a piece through renders of its own, each mounted from a
// reference the way the shell mounts a piece opened by its address. Each step
// builds the reconciler as the worker builds one for a mount: the shell's
// default display ceiling for the viewer, and the resolver, membership
// provider and module policy source the worker derives from it. A piece opened
// directly is mounted from its own reference. What a `cf-render` shows is
// mounted from the reference its `$cell` binding handed over, as `cf-render`
// mounts it: the bound cell itself at the full variant, the piece it currently
// names for a tile, the piece's `[NAME]` for a chip with no view of its own,
// and an exported `[TILE_UI]` or `[CHIP_UI]`. Every value a viewer may not see
// carries a string that appears nowhere else, so a search of the operations
// for it is a search for the value having escaped.
//
// `Deno.test` rather than `describe`/`it`: this package installs its fake
// clock in freeze-all mode, which hangs `settle()` off `Deno.TestContext`, and
// a `@std/testing/bdd` `it()` callback never receives that context.

Deno.test("worker reconciler CFC decisions over a cf-render's nested render", async (t) => {
  const owner = await Identity.fromPassphrase("nested render owner");
  const visitor = await Identity.fromPassphrase("nested render visitor");
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const space = owner.did();
  const sealedAtom = cfcAtom.resource("SealedEntry", owner.did());
  const ownerOnlyAtom = cfcAtom.user(owner.did());
  const SEALED = "entry-behind-the-seal";
  const OWNER_ONLY = "owner-only-margin-note";
  const PLACEHOLDER = "Content hidden by policy";

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
    expect((await tx.commit()).ok).toBeDefined();
    return runtime.getCell(space, id);
  };

  const link = (cell: Cell<unknown>) =>
    cell.getAsLink({ includeSchema: true, keepAsCell: KeepAsCell.All });

  const vnode = (
    name: string,
    children: readonly unknown[],
    props: Record<string, unknown> = {},
  ) => ({ type: "vnode", name, props, children });

  /** Writes `value` to the document named `id`, labeled with `atom`. */
  const labeled = (id: string, value: unknown, atom: CfcAtom) =>
    write(id, value, [[[], [atom]]]);

  /**
   * A piece whose view shows a heading anyone may see and, inside a render
   * boundary admitting what its owner may see, an owner-only note and a sealed
   * entry, each a document of its own that the piece also holds. `labels`
   * label the piece's own document.
   */
  const shelf = async (
    id: string,
    labels: readonly [path: string[], confidentiality: readonly CfcAtom[]][] =
      [],
  ) => {
    const sealed = await labeled(`${id}-sealed`, SEALED, sealedAtom);
    const note = await labeled(`${id}-note`, OWNER_ONLY, ownerOnlyAtom);
    return write(id, {
      [NAME]: "Reading shelf",
      [UI]: vnode("div", [
        "Shelf heading",
        vnode("cf-cfc-render-boundary", [link(note), link(sealed)], {
          maxConfidentiality: [ownerOnlyAtom],
        }),
      ]),
      note: link(note),
      entry: link(sealed),
    }, labels);
  };

  /**
   * Writes a list whose one entry links to `piece`, and returns the entry's
   * `cell` slot read under `schema`, the way a view built over a list of
   * pinned pieces declares it.
   */
  const pinned = async (
    id: string,
    piece: Cell<unknown>,
    schema: JSONSchema = true,
    labels: readonly [path: string[], confidentiality: readonly CfcAtom[]][] =
      [],
  ) => {
    const list = await write(id, { element: { cell: link(piece) } }, labels);
    return list.key("element").key("cell").asSchema(schema);
  };

  /**
   * A stored view holding `host`, inside an element named and propped as
   * `around` when one is given.
   */
  const view = (
    id: string,
    host: unknown,
    around?: { name: string; props: Record<string, unknown> },
  ) =>
    write(
      id,
      vnode("div", [
        around === undefined ? host : vnode(around.name, [host], around.props),
      ]),
    );

  /** A `cf-render` at `variant`, bound to `slot`. */
  const cfRender = (slot: Cell<unknown>, variant = "tile") =>
    vnode("cf-render", [], { variant, $cell: link(slot) });

  /** A stored view holding a tile-variant `cf-render` bound to `slot`. */
  const tileView = (
    id: string,
    slot: Cell<unknown>,
    around?: { name: string; props: Record<string, unknown> },
  ) => view(id, cfRender(slot), around);

  /**
   * Mounts what `reference` names as the worker mounts it, settles, and
   * returns what was emitted and the unmount.
   */
  const mount = async (reference: CellRef, viewer: Identity) => {
    const ops: VDomOp[] = [];
    const cancel = new WorkerReconciler({
      onOps: (batch) => {
        for (const op of batch) ops.push(op);
      },
      ...viewedBy(viewer),
    }).mount(getCell(runtime, reference).asSchema(rendererVDOMSchema));
    await t.settle();
    return {
      cancel,
      emitted: () => JSON.stringify(ops),
      bindings: (propName = "cell") =>
        ops.flatMap((op) =>
          op.op === "set-binding" && op.propName === propName
            ? [op.cellRef]
            : []
        ),
      removed: () =>
        ops.filter((op) => op.op === "remove-prop" && op.key === "cell")
          .length,
      propsSet: (key: string) =>
        ops.flatMap((op) =>
          op.op === "set-prop" && op.key === key ? [op.value] : []
        ),
      // The elements and text a render shows, in the order it builds them.
      shown: () =>
        ops.flatMap((op) =>
          op.op === "create-element"
            ? [`<${op.tagName}>`]
            : op.op === "create-text" || op.op === "update-text"
            ? [op.text]
            : []
        ),
    };
  };

  /** Mounts `cell` from its own reference, as the shell opens a piece. */
  const openDirectly = (cell: Cell<unknown>, viewer: Identity) =>
    mount(createCellRef(cell), viewer);

  /** The piece a binding's reference currently names. */
  const target = (reference: CellRef) =>
    getCell(runtime, reference).resolveAsCell();

  /**
   * Mounts what a `cf-render` was bound to, from the binding's reference, at
   * the full variant and as a tile.
   */
  const openThroughCfRender = async (
    reference: CellRef,
    viewer: Identity,
  ) => ({
    full: await mount(reference, viewer),
    tile: await mount(createCellRef(target(reference)), viewer),
  });

  /** Mounts `page` and returns how many `prop` bindings it made. */
  const boundCount = async (
    page: Cell<unknown>,
    viewer: Identity,
    propName = "cell",
  ) => {
    const mounted = await mount(createCellRef(page), viewer);
    try {
      return mounted.bindings(propName).length;
    } finally {
      mounted.cancel();
    }
  };

  try {
    await t.step(
      "renders an owner's pinned piece holding a sealed entry through `cf-render` as opening the piece directly renders it",
      async () => {
        const piece = await shelf("owner-shelf");
        const page = await mount(
          createCellRef(
            await tileView(
              "owner-shelf-view",
              await pinned("owner-shelf-pins", piece),
            ),
          ),
          owner,
        );
        const direct = await openDirectly(piece, owner);
        try {
          expect(direct.shown()).toEqual([
            "<div>",
            "Shelf heading",
            "<cf-cfc-render-boundary>",
            OWNER_ONLY,
            "<cf-cfc-blocked>",
            PLACEHOLDER,
          ]);
          expect(page.bindings()).toHaveLength(1);
          const nested = await openThroughCfRender(page.bindings()[0], owner);
          try {
            expect(nested.full.shown()).toEqual(direct.shown());
            expect(nested.tile.shown()).toEqual(direct.shown());
            for (const render of [direct, nested.full, nested.tile]) {
              expect(render.emitted()).not.toContain(SEALED);
            }
          } finally {
            nested.full.cancel();
            nested.tile.cancel();
          }
        } finally {
          page.cancel();
          direct.cancel();
        }
      },
    );

    await t.step(
      "renders a visitor the parts of that piece the visitor's ceiling admits, through `cf-render` as opening it directly",
      async () => {
        const piece = await shelf("visited-shelf");
        const page = await mount(
          createCellRef(
            await tileView(
              "visited-shelf-view",
              await pinned("visited-shelf-pins", piece),
            ),
          ),
          visitor,
        );
        const direct = await openDirectly(piece, visitor);
        try {
          expect(direct.shown()).toEqual([
            "<div>",
            "Shelf heading",
            "<cf-cfc-render-boundary>",
            "<cf-cfc-blocked>",
            PLACEHOLDER,
            "<cf-cfc-blocked>",
            PLACEHOLDER,
          ]);
          expect(page.bindings()).toHaveLength(1);
          const nested = await openThroughCfRender(
            page.bindings()[0],
            visitor,
          );
          try {
            expect(nested.full.shown()).toEqual(direct.shown());
            expect(nested.tile.shown()).toEqual(direct.shown());
            for (const render of [direct, nested.full, nested.tile]) {
              expect(render.emitted()).not.toContain(SEALED);
              expect(render.emitted()).not.toContain(OWNER_ONLY);
            }
          } finally {
            nested.full.cancel();
            nested.tile.cancel();
          }
        } finally {
          page.cancel();
          direct.cancel();
        }
      },
    );

    await t.step(
      "shows through `cf-render` the placeholder where opening the piece directly shows it",
      async () => {
        // One piece shows its sealed entry with no boundary around it. The
        // other keeps its whole view in a sealed document of its own, which
        // opening it directly replaces with a single placeholder.

        const sealed = await labeled("bare-sealed", SEALED, sealedAtom);
        const sealedView = await labeled(
          "sealed-view-ui",
          vnode("div", [SEALED]),
          sealedAtom,
        );
        const pieces = [
          await write("bare-shelf", {
            [NAME]: "Bare shelf",
            [UI]: vnode("div", ["Shelf heading", link(sealed)]),
          }),
          await write("sealed-view-shelf", {
            [NAME]: "Sealed view shelf",
            [UI]: link(sealedView),
          }),
        ];
        for (const [index, piece] of pieces.entries()) {
          for (const viewer of [owner, visitor]) {
            const page = await mount(
              createCellRef(
                await tileView(
                  `placeholder-view-${index}-${viewer.did()}`,
                  await pinned(
                    `placeholder-pins-${index}-${viewer.did()}`,
                    piece,
                  ),
                ),
              ),
              viewer,
            );
            const direct = await openDirectly(piece, viewer);
            try {
              expect(direct.shown()).toContain(PLACEHOLDER);
              expect(page.bindings()).toHaveLength(1);
              const nested = await openThroughCfRender(
                page.bindings()[0],
                viewer,
              );
              try {
                expect(nested.full.shown()).toEqual(direct.shown());
                expect(nested.tile.shown()).toEqual(direct.shown());
                for (const render of [direct, nested.full, nested.tile]) {
                  expect(render.emitted()).not.toContain(SEALED);
                }
              } finally {
                nested.full.cancel();
                nested.tile.cancel();
              }
            } finally {
              page.cancel();
              direct.cancel();
            }
          }
        }
      },
    );

    await t.step(
      "renders a chip's default name through a render of its own, which shows an admitted name and withholds a sealed one",
      async () => {
        const sealedName = await labeled(
          "chip-sealed-name",
          SEALED,
          sealedAtom,
        );
        const named = await write("chip-named", {
          [NAME]: "Reading shelf",
          [UI]: vnode("div", ["Shelf heading"]),
        });
        const secretlyNamed = await write("chip-secretly-named", {
          [NAME]: link(sealedName),
          [UI]: vnode("div", ["Shelf heading"]),
        });
        const shownNames: string[][] = [];
        for (const [index, piece] of [named, secretlyNamed].entries()) {
          const page = await mount(
            createCellRef(
              await view(
                `chip-view-${index}`,
                cfRender(await pinned(`chip-pins-${index}`, piece), "chip"),
              ),
            ),
            owner,
          );
          try {
            expect(page.bindings()).toHaveLength(1);
            const name = await mount(
              createCellRef(target(page.bindings()[0]).key(NAME)),
              owner,
            );
            try {
              shownNames.push(name.shown());
              expect(name.emitted()).not.toContain(SEALED);
            } finally {
              name.cancel();
            }
          } finally {
            page.cancel();
          }
        }
        expect(shownNames).toEqual([
          ["Reading shelf"],
          ["<cf-cfc-blocked>", PLACEHOLDER],
        ]);
      },
    );

    await t.step(
      "renders an exported tile or chip view through a render of its own, which decides what the viewer sees of it",
      async () => {
        // The sealed tile views differ only in whether they hold a view at
        // all, so a viewer who could tell them apart would learn something
        // sealed.

        const tileHolding = await labeled(
          "exported-tile-view",
          vnode("div", [SEALED]),
          sealedAtom,
        );
        const tileEmpty = await labeled("exported-tile-null", null, sealedAtom);
        const chip = await labeled(
          "exported-chip-view",
          vnode("span", [OWNER_ONLY]),
          ownerOnlyAtom,
        );
        const exported = async (id: string, key: string, views: unknown) =>
          await write(id, {
            [NAME]: "Shelf",
            [UI]: vnode("div", ["Shelf heading"]),
            [key]: views,
          });
        const cases: readonly [string, Cell<unknown>, string, Identity][] = [
          [
            "sealed tile view",
            await exported("exports-tile", TILE_UI, link(tileHolding)),
            TILE_UI,
            owner,
          ],
          [
            "sealed empty tile view",
            await exported("exports-empty-tile", TILE_UI, link(tileEmpty)),
            TILE_UI,
            owner,
          ],
          [
            "owner-only chip view, for its owner",
            await exported("exports-chip", CHIP_UI, link(chip)),
            CHIP_UI,
            owner,
          ],
          [
            "owner-only chip view, for a visitor",
            await exported("exports-chip-visited", CHIP_UI, link(chip)),
            CHIP_UI,
            visitor,
          ],
        ];
        const shownViews: Record<string, string[]> = {};
        for (const [id, piece, key, viewer] of cases) {
          const page = await mount(
            createCellRef(
              await view(
                `exported-view-${id}`,
                cfRender(
                  await pinned(`exported-pins-${id}`, piece),
                  key === TILE_UI ? "tile" : "chip",
                ),
              ),
            ),
            viewer,
          );
          try {
            expect(page.bindings()).toHaveLength(1);
            const exportedView = await mount(
              createCellRef(target(page.bindings()[0]).key(key)),
              viewer,
            );
            try {
              shownViews[id] = exportedView.shown();
              expect(exportedView.emitted()).not.toContain(SEALED);
            } finally {
              exportedView.cancel();
            }
          } finally {
            page.cancel();
          }
        }
        expect(shownViews).toEqual({
          "sealed tile view": ["<cf-cfc-blocked>", PLACEHOLDER],
          "sealed empty tile view": ["<cf-cfc-blocked>", PLACEHOLDER],
          "owner-only chip view, for its owner": ["<span>", OWNER_ONLY],
          "owner-only chip view, for a visitor": [
            "<cf-cfc-blocked>",
            PLACEHOLDER,
          ],
        });
      },
    );

    await t.step(
      "withholds the binding while the ceiling refuses the reference it hands over",
      async () => {
        // The reference is refused when the list entry holding it is
        // owner-only and the viewer is not its owner, and when the slot
        // declares a label the ceiling refuses. A declared label decides only
        // where the read consumed no stored label: once the shelf's own
        // document is labeled, its stored label decides instead.

        const piece = await shelf("refused-shelf");
        const ownedPiece = await shelf("refused-owned-shelf", [[[], [
          ownerOnlyAtom,
        ]]]);
        const declaredSealed = { ifc: { confidentiality: [sealedAtom] } };
        const cases: readonly [string, Identity, Cell<unknown>, number][] = [
          [
            "owner-only entry, for a visitor",
            visitor,
            await pinned("refused-entry-pins", piece, true, [
              [["element"], [ownerOnlyAtom]],
            ]),
            0,
          ],
          [
            "owner-only entry, for its owner",
            owner,
            await pinned("refused-entry-owner-pins", piece, true, [
              [["element"], [ownerOnlyAtom]],
            ]),
            1,
          ],
          [
            "declared sealed slot, nothing stored",
            owner,
            await pinned("refused-declared-pins", piece, declaredSealed),
            0,
          ],
          [
            "declared sealed slot, owner-only shelf",
            owner,
            await pinned(
              "refused-declared-owned-pins",
              ownedPiece,
              declaredSealed,
            ),
            1,
          ],
        ];
        const outcomes: Record<string, number> = {};
        for (const [id, viewer, slot] of cases) {
          outcomes[id] = await boundCount(
            await tileView(`refused-view-${id}`, slot),
            viewer,
          );
        }
        expect(outcomes).toEqual(
          Object.fromEntries(cases.map(([id, , , expected]) => [id, expected])),
        );
      },
    );

    await t.step(
      "withholds the binding for a piece whose own document the ceiling refuses, where opening the piece shows the placeholder",
      async () => {
        // Resolving the reference reads the label of the document it names,
        // so a refused piece document refuses the reference too. Opening the
        // piece directly shows a placeholder in its place, which this does
        // not match.

        const sealedPiece = await labeled("refused-sealed-piece", {
          [NAME]: "Sealed shelf",
          [UI]: vnode("div", [SEALED]),
        }, sealedAtom);
        const direct = await openDirectly(sealedPiece, owner);
        try {
          expect(direct.shown()).toEqual(["<cf-cfc-blocked>", PLACEHOLDER]);
          expect(
            await boundCount(
              await tileView(
                "refused-sealed-piece-view",
                await pinned("refused-sealed-piece-pins", sealedPiece),
              ),
              owner,
            ),
          ).toBe(0);
        } finally {
          direct.cancel();
        }
      },
    );

    await t.step(
      "removes the binding when a write leaves the reference refused",
      async () => {
        const piece = await shelf("relabeled-shelf");
        const value = { element: { cell: link(piece) } };
        const list = await write("relabeled-pins", value);
        const page = await mount(
          createCellRef(
            await tileView(
              "relabeled-view",
              list.key("element").key("cell").asSchema(true),
            ),
          ),
          visitor,
        );
        try {
          expect(page.bindings()).toHaveLength(1);
          expect(page.removed()).toBe(0);
          await write("relabeled-pins", value, [[["element"], [
            ownerOnlyAtom,
          ]]]);
          await t.settle();
          expect(page.removed()).toBe(1);
        } finally {
          page.cancel();
        }
      },
    );

    await t.step(
      "decides a binding inside a boundary that lowers the ceiling on everything the bound piece reaches, however the slot is declared",
      async () => {
        // The nested render starts from the root ceiling, as opening the
        // piece directly does, so it would show the owner-only note that the
        // boundary around the `cf-render` refuses.

        const piece = await write("narrowed-shelf", {
          [NAME]: "Shelf",
          [UI]: vnode("div", [
            link(await labeled("narrowed-note", OWNER_ONLY, ownerOnlyAtom)),
          ]),
        });
        const plainPiece = await write("narrowed-plain-shelf", {
          [NAME]: "Plain shelf",
          [UI]: vnode("div", ["Shelf heading"]),
        });
        const declarations: readonly [string, JSONSchema][] = [
          ["any", true],
          ["reference", { type: "unknown", asCell: ["cell"] }],
        ];
        const holdings = [["note", piece], ["plain", plainPiece]] as const;
        const outcomes: Record<string, number> = {};
        for (const [declared, schema] of declarations) {
          for (const [held, bound] of holdings) {
            outcomes[`${declared} ${held}`] = await boundCount(
              await tileView(
                `narrowed-${declared}-${held}-view`,
                await pinned(
                  `narrowed-${declared}-${held}-pins`,
                  bound,
                  schema,
                ),
                {
                  name: "cf-cfc-render-boundary",
                  props: { maxConfidentiality: [] },
                },
              ),
              owner,
            );
          }
        }
        expect(outcomes).toEqual({
          "any note": 0,
          "any plain": 1,
          "reference note": 0,
          "reference plain": 1,
        });
      },
    );

    await t.step(
      "decides a binding as at the root inside a boundary that lowers nothing, and on everything the piece reaches inside one that drops an atom",
      async () => {
        const ceiling = defaultRenderConfidentialityCeiling(owner.did());
        const bounds: readonly [string, readonly unknown[]][] = [
          ["lowers nothing", [...(ceiling.atoms ?? [])].reverse()],
          ["drops an atom", [ownerOnlyAtom]],
        ];
        const outcomes: Record<string, number> = {};
        for (const [id, maxConfidentiality] of bounds) {
          outcomes[id] = await boundCount(
            await tileView(
              `bounded-view-${id}`,
              await pinned(
                `bounded-pins-${id}`,
                await shelf(`bounded-shelf-${id}`),
              ),
              {
                name: "cf-cfc-render-boundary",
                props: { maxConfidentiality },
              },
            ),
            owner,
          );
        }
        expect(outcomes).toEqual({ "lowers nothing": 1, "drops an atom": 0 });
      },
    );

    await t.step(
      "binds a pinned piece inside a boundary that only declassifies, as at the root",
      async () => {
        // A boundary that only declassifies admits more than the root ceiling,
        // so the nested render, which starts from the root and does not take
        // the declassification with it, shows no more than the boundary
        // allows. It shows what opening the piece shows, whether the boundary
        // declassifies the piece's sealed entry or something else; a read of
        // everything the piece reaches would change only the second case,
        // withholding the piece.

        const declassified = [
          ["something else", cfcAtom.user(visitor.did())],
          ["the sealed entry", sealedAtom],
        ] as const;
        const outcomes: Record<string, unknown> = {};
        for (const [id, atom] of declassified) {
          const piece = await shelf(`declassified-shelf-${id}`);
          const page = await mount(
            createCellRef(
              await tileView(
                `declassified-shelf-view-${id}`,
                await pinned(`declassified-shelf-pins-${id}`, piece),
                {
                  name: "cf-cfc-render-boundary",
                  props: { declassifyConfidentiality: [atom] },
                },
              ),
            ),
            owner,
          );
          const direct = await openDirectly(piece, owner);
          try {
            const [binding] = page.bindings();
            const tile = binding === undefined
              ? undefined
              : await mount(createCellRef(target(binding)), owner);
            outcomes[id] = {
              bound: page.bindings().length,
              tileAsOpened: tile?.shown().join() === direct.shown().join(),
            };
            tile?.cancel();
          } finally {
            page.cancel();
            direct.cancel();
          }
        }
        expect(outcomes).toEqual({
          "something else": { bound: 1, tileAsOpened: true },
          "the sealed entry": { bound: 1, tileAsOpened: true },
        });
      },
    );

    await t.step(
      "decides a binding under a text-integrity requirement on the confidentiality of everything the bound piece reaches",
      async () => {
        // A nested render applies no text-integrity requirement, so under an
        // authorship boundary the binding is decided on a read of everything
        // the piece reaches. That read fits confidentiality only: the plain
        // piece binds, and its nested render shows its unendorsed text.

        const plainPiece = await write("integrity-plain-shelf", {
          [NAME]: "Plain shelf",
          [UI]: vnode("div", ["Shelf heading"]),
        });
        const pieces = [
          ["shelf", await shelf("integrity-shelf")],
          ["plain", plainPiece],
        ] as const;
        const outcomes: Record<string, number> = {};
        for (const [id, piece] of pieces) {
          outcomes[id] = await boundCount(
            await tileView(
              `integrity-view-${id}`,
              await pinned(`integrity-pins-${id}`, piece),
              {
                name: "cf-cfc-authorship",
                props: {
                  verifyTextIntegrity: true,
                  requiredTextIntegrity: [ownerOnlyAtom],
                },
              },
            ),
            owner,
          );
        }
        expect(outcomes).toEqual({ shelf: 0, plain: 1 });
      },
    );

    await t.step(
      "decides `cf-picker`'s items on everything they reach, as every binding outside the registry is decided",
      async () => {
        // `cf-picker` is not a nested render root in the registry, so a list
        // holding a piece with a sealed entry is withheld from its owner.

        expect(
          await boundCount(
            await view(
              "picker-view",
              vnode("cf-picker", [], {
                $items: link(
                  (await write("picker-items", {
                    items: [link(await shelf("picker-shelf"))],
                  })).key("items").asSchema(true),
                ),
              }),
            ),
            owner,
            "items",
          ),
        ).toBe(0);
      },
    );

    await t.step(
      "withholds a cell that reaches a refused document through a chain of links",
      async () => {
        // The pinned entry links to a document whose root is itself a link:
        // to a sealed piece, or to a sealed link on to a public piece. The
        // nested render would follow the chain, so the decision fits the label
        // of every document along it. A chain to a public piece that holds a
        // sealed entry binds, since the nested render decides the entry.

        const sealedPiece = await labeled("chain-sealed-piece", {
          [NAME]: "Sealed shelf",
          [UI]: vnode("div", [SEALED]),
        }, sealedAtom);
        const publicPiece = await write("chain-public-piece", {
          [NAME]: "Public shelf",
          [UI]: vnode("div", ["Shelf heading"]),
          [TILE_UI]: vnode("div", ["Public tile"]),
        });
        const sealedLink = await labeled(
          "chain-sealed-link",
          link(publicPiece),
          sealedAtom,
        );
        const chains = [
          [
            "to a piece holding a sealed entry",
            await write("chain-to-shelf", link(await shelf("chain-shelf"))),
          ],
          [
            "to a sealed piece",
            await write("chain-to-piece", link(sealedPiece)),
          ],
          [
            "through a sealed link",
            await write("chain-to-link", link(sealedLink)),
          ],
        ] as const;
        const outcomes: Record<string, number> = {};
        for (const [id, first] of chains) {
          outcomes[id] = await boundCount(
            await tileView(
              `chain-view-${id}`,
              await pinned(`chain-pins-${id}`, first),
            ),
            visitor,
          );
        }
        expect(outcomes).toEqual({
          "to a piece holding a sealed entry": 1,
          "to a sealed piece": 0,
          "through a sealed link": 0,
        });
      },
    );

    await t.step(
      "decides the same whatever schema the stored links carry, at the binding's own link or at the pinned slot's",
      async () => {
        // A stored link schema can select less than a piece's view, or reach
        // past it into what the piece holds. Neither changes the decision: it
        // binds a piece whose opening renders, the sealed entry or sealed name
        // left to the nested render, and withholds one whose own document is
        // refused.

        const sealedPiece = await labeled("stored-sealed-piece", {
          [NAME]: "Sealed shelf",
          [UI]: vnode("div", [SEALED]),
        }, sealedAtom);
        const pieces = [
          ["holding a sealed entry", await shelf("stored-shelf")],
          [
            "with a sealed name",
            await write("stored-named", {
              [NAME]: link(await labeled("stored-name", SEALED, sealedAtom)),
              [UI]: vnode("div", ["Shelf heading"]),
            }),
          ],
          ["sealed", sealedPiece],
        ] as const;
        const stored: readonly [string, JSONSchema][] = [
          ["a name only", {
            type: "object",
            properties: { [NAME]: { type: "string" } },
          }],
          ["what it holds", {
            type: "object",
            properties: { entry: true, note: true, [NAME]: true },
          }],
          ["a reference", { type: "unknown", asCell: ["cell"] }],
          ["anything", true],
        ];
        const outcomes: Record<string, number> = {};
        const expected: Record<string, number> = {};
        for (const [schemaId, schema] of stored) {
          for (const [pieceId, piece] of pieces) {
            const atBinding = await write(
              `stored-binding-${schemaId}-${pieceId}`,
              { element: { cell: link(piece) } },
            );
            const atSlot = await write(`stored-slot-${schemaId}-${pieceId}`, {
              element: { cell: link(piece.asSchema(schema)) },
            });
            const placements = [
              [
                "binding",
                atBinding.key("element").key("cell").asSchema(schema),
              ],
              ["slot", atSlot.key("element").key("cell").asSchema(true)],
            ] as const;
            for (const [placed, slot] of placements) {
              const id = `${schemaId}, ${pieceId}, at the ${placed}`;
              outcomes[id] = await boundCount(
                await tileView(`stored-view-${id}`, slot),
                visitor,
              );
              expected[id] = piece === sealedPiece ? 0 : 1;
            }
          }
        }
        expect(outcomes).toEqual(expected);

        // The decision's read lands on the piece's own document whatever the
        // stored schema, so a label written there after the binding is made
        // removes the binding, here with a reference schema stored on the
        // slot's link.
        const relabeledValue = {
          [NAME]: "Relabeled shelf",
          [UI]: vnode("div", ["Shelf heading"]),
        };
        const relabeled = await write("stored-relabeled", relabeledValue);
        const pins = await write("stored-relabeled-pins", {
          element: {
            cell: link(
              relabeled.asSchema({ type: "unknown", asCell: ["cell"] }),
            ),
          },
        });
        const page = await mount(
          createCellRef(
            await tileView(
              "stored-relabeled-view",
              pins.key("element").key("cell").asSchema(true),
            ),
          ),
          visitor,
        );
        try {
          expect(page.bindings()).toHaveLength(1);
          await write("stored-relabeled", relabeledValue, [[[], [sealedAtom]]]);
          await t.settle();
          expect(page.removed()).toBe(1);
        } finally {
          page.cancel();
        }
      },
    );
    await t.step(
      "keeps what a nested render loads under the fetch ceiling, as opening the piece does",
      async () => {
        // A binding to `cf-render` is a remote load, so it is fitted on the
        // fetch ceiling too, on the read that decides it. A material-risk
        // caveat the display admits, on a view the piece shows, binds the
        // piece, and its nested render sets no URL that view names, as
        // opening the piece sets none. On the piece's own document it
        // withholds the binding.

        const unscreened: CfcAtom = {
          type: CFC_ATOM_TYPE.Caveat,
          kind: CFC_CONCEPT_KIND.PromptInjectionRiskUnscreened,
          source: "of:untrusted-sender",
        };
        const risky = [owner.did(), unscreened];
        const PIXEL = "https://example.test/pixel.png";
        const holding = await write("risky-holding-shelf", {
          [NAME]: "Shelf",
          [UI]: vnode("div", [
            "Shelf heading",
            link(
              await write(
                "risky-view",
                vnode("img", [], { src: PIXEL }),
                [[[], risky]],
              ),
            ),
          ]),
        });
        const riskyPiece = await write("risky-piece", {
          [NAME]: "Shelf",
          [UI]: vnode("div", ["Shelf heading"]),
        }, [[[], risky]]);

        const page = await mount(
          createCellRef(
            await tileView(
              "risky-holding-view",
              await pinned("risky-holding-pins", holding),
            ),
          ),
          owner,
        );
        const direct = await openDirectly(holding, owner);
        try {
          expect(page.bindings()).toHaveLength(1);
          const tile = await mount(
            createCellRef(target(page.bindings()[0])),
            owner,
          );
          try {
            expect(tile.shown()).toEqual(direct.shown());
            expect([tile.propsSet("src"), direct.propsSet("src")]).toEqual([
              [],
              [],
            ]);
          } finally {
            tile.cancel();
          }
        } finally {
          page.cancel();
          direct.cancel();
        }
        expect(
          await boundCount(
            await tileView(
              "risky-piece-view",
              await pinned("risky-piece-pins", riskyPiece),
            ),
            owner,
          ),
        ).toBe(0);
      },
    );
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
