/**
 * The labels an update of a piece's source leaves on the result document of a
 * sub-pattern the piece hands a confidentiality-labeled cell to. The update
 * sets the changed sub-pattern up again over its stored argument, and nothing
 * the sub-pattern's result holds depends on what that setup reads of the
 * argument: the labeled cell reaches the result only as a reference, which
 * carries its own restriction. So the result document stores no label after
 * the update, as it stores none after the piece is created, and a display
 * that is not cleared for the cell still shows the sub-pattern's view.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import {
  type Cell,
  pullFromServer,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import type { ExecutorHost } from "@commonfabric/runner/executor/host";
import {
  type ServingMemoryServer,
  startServingMemoryServer,
} from "@commonfabric/runner/executor/serving-memory-server.deno";
import {
  EmulatedStorageManager,
  StorageManager,
} from "@commonfabric/runner/storage/cache.deno";
import { cfcLabelViewForResolvedCell } from "@commonfabric/runner/cfc";
import { readStoredCfcMetadata } from "../../runner/src/cfc/metadata.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  confirmServedInstantiate,
  confirmServedSetSource,
  servedInstantiatePiece,
  servedSetPieceSource,
  servedUploadPattern,
} from "../src/ops/served-lifecycle.ts";

const signer = await Identity.fromPassphrase("sub-pattern update labels");
const servedSpace = (await Identity.fromPassphrase(
  "sub-pattern update labels served space",
)).did() as MemorySpace;
const service = await Identity.fromPassphrase(
  "sub-pattern update labels service",
);

/** The policy module, apart from the main one, so its identity stays put. */
const POLICY = `/// <cts-enable />
import { type Confidential } from "commonfabric";
import {
  exchangeRule,
  exchangeRules,
  type PolicyOf,
  THIS_POLICY,
} from "commonfabric/cfc";

export const neverRelease = exchangeRule({
  appliesTo: THIS_POLICY,
  pre: { integrity: ["never-present-atom"] },
  post: { dropClause: true },
});
export const rules = exchangeRules([neverRelease]);
export type BySealedPolicy<T> = Confidential<
  T,
  readonly [PolicyOf<typeof rules>]
>;
export type ByAtom<T> = Confidential<T, readonly ["demo-secret"]>;
`;

/** The atom each clause shape carries, as a stored label prints it. */
const CLAUSE_MARK = {
  policy: '"symbol":"rules"',
  atom: '"demo-secret"',
} as const;

type Clause = keyof typeof CLAUSE_MARK;

/** How the sub-pattern declares the slot it is handed the labeled cell in. */
type Slot = "declared" | "plain";

/**
 * What the sub-pattern does with the labeled cell: nothing, read it into a
 * computed it returns beside its view, or render that computed in its view.
 */
type Reading = "none" | "returns" | "renders";

/** An owner cell typed so its writer is named, or plainly. */
const OWNERS = {
  "authorized": "WriteAuthorizedBy<Record<string, never>, typeof retainOwner>",
  "plain": "Record<string, never>",
} as const;

type Owner = keyof typeof OWNERS;

/**
 * The piece's program: a labeled cell and an owner cell, both handed to the
 * sub-pattern `View`, whose view shows the owner cell and, by `reading`, what
 * it computes from the labeled one. `version` changes the main module; with
 * `editView` it changes `View`'s own body too.
 */
const program = (
  options: {
    clause: Clause;
    slot: Slot;
    owner: Owner;
    version: string;
    editView: boolean;
    reading?: Reading;
  },
): RuntimeProgram => {
  const labeled = options.clause === "policy" ? "BySealedPolicy" : "ByAtom";
  const slotType = options.slot === "declared"
    ? `${labeled}<number> | undefined`
    : "number | undefined";
  const title = options.editView ? options.version : "";
  const reading = options.reading ?? "none";
  const view = reading === "none"
    ? `({ owner }) => ({ [UI]: <div title="${title}">{owner}</div> })`
    : `({ secret, owner }) => {
    const shown = computed(() => ((secret ?? 0) > 0 ? "on" : "off"));
    return {
      [UI]: <div title="${title}">{owner}${
      reading === "renders" ? "{shown}" : ""
    }</div>,
      shown,
    };
  }`;
  return {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: `/// <cts-enable />
import {
  computed,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import type { ${labeled} } from "./policy.ts";

export const retainOwner = handler<void, Record<string, never>>(() => {});
type Owner = ${OWNERS[options.owner]};

const View = pattern<{ secret: ${slotType}; owner: Owner }, any>(
  ${view},
);

export default pattern<Record<string, never>, any>(() => {
  const secret = new Writable.perSpace<${labeled}<number>>(
    0 as ${labeled}<number>,
  );
  const owner = new Writable.perSpace<Owner>({} as Owner);
  const view = View({ secret, owner });
  return { [NAME]: "Mini", [UI]: view[UI], secret, owner };
});
// ${options.version}
`,
      },
      { name: "/policy.ts", contents: POLICY },
    ],
  };
};

/**
 * Every stored label entry on the document `cell` resolves to, read through
 * `runtime`. Reading the whole map, of every observation class, sees an entry
 * at the document's root that the label at a path below it would not.
 */
const documentEntries = (runtime: Runtime, cell: Cell<unknown>): unknown[] => {
  const tx = runtime.edit();
  try {
    const { space, id, scope } = cell.withTx(tx).resolveAsCell()
      .getAsNormalizedFullLink();
    return readStoredCfcMetadata(tx, { space, id, scope })?.labelMap
      .entries ?? [];
  } finally {
    tx.abort("label read");
  }
};

/**
 * Every stored label entry on the document a piece's `$UI` resolves to, the
 * sub-pattern's result document.
 */
const viewEntries = (runtime: Runtime, piece: Cell<unknown>): unknown[] =>
  documentEntries(runtime, piece.key("$UI"));

/** Whether the entries `entries` carry the clause shape `clause`. */
const carries = (entries: unknown, clause: Clause): boolean =>
  JSON.stringify(entries).includes(CLAUSE_MARK[clause]);

/**
 * Whether a display not cleared for the clause `clause` is kept from a
 * piece's view: the label it reads for `$UI` carries the clause.
 */
const viewHidden = (piece: Cell<unknown>, clause: Clause): boolean =>
  carries(cfcLabelViewForResolvedCell(piece.key("$UI")) ?? [], clause);

/**
 * Every stored label entry on the document of the computed the sub-pattern
 * of `piece` returns beside its view.
 */
const shownEntries = (runtime: Runtime, piece: Cell<unknown>): unknown[] => {
  const tx = runtime.edit();
  try {
    const view = piece.key("$UI").withTx(tx).resolveAsCell()
      .getAsNormalizedFullLink();
    return documentEntries(
      runtime,
      runtime.getCellFromLink({ ...view, path: ["shown"] }),
    );
  } finally {
    tx.abort("address read");
  }
};

describe("sub-pattern-update-labels", () => {
  describe("an update run by the piece's own runtime", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let pieces: PiecesController;

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("http://toolshed.test"),
        storageManager,
      });
      pieces = new PiecesController(
        createSession({
          identity: signer,
          spaceDid: await runtime.createSpace(),
        }),
        runtime,
      );
      await pieces.synced();
    });

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
    });

    /**
     * Creates a piece from `first`, updates it to `next`, and returns the
     * labels on the labeled cell and on the sub-pattern's result document,
     * before and after.
     */
    const labelsAround = async (
      first: RuntimeProgram,
      next: RuntimeProgram,
      clause: Clause,
    ) => {
      const piece = await pieces.create(first, { input: {} });
      await runtime.idle();
      const cell = piece.getCell();
      const labels = () => ({
        secret: carries(documentEntries(runtime, cell.key("secret")), clause),
        view: carries(viewEntries(runtime, cell), clause),
      });
      const before = labels();
      await piece.setPattern(next);
      await runtime.idle();
      return { before, after: labels() };
    };

    for (const slot of ["declared", "plain"] as const) {
      for (const owner of ["authorized", "plain"] as const) {
        for (const editView of [false, true]) {
          it(`leaves the result document unlabeled across an edit (${owner} owner, ${slot} slot${editView ? ", View edited" : ""})`, async () => {
            const options = { clause: "policy" as const, slot, owner };
            const { before, after } = await labelsAround(
              program({ ...options, version: "v1", editView }),
              program({ ...options, version: "v2", editView }),
              "policy",
            );

            expect(before).toEqual({ secret: true, view: false });
            expect(after).toEqual(before);
          });
        }
      }

      it(`leaves the result document unlabeled across an edit under a plain atom (${slot} slot)`, async () => {
        const options = {
          clause: "atom" as const,
          slot,
          owner: "plain" as const,
          editView: true,
        };
        const { before, after } = await labelsAround(
          program({ ...options, version: "v1" }),
          program({ ...options, version: "v2" }),
          "atom",
        );

        expect(before).toEqual({ secret: true, view: false });
        expect(after).toEqual(before);
      });
    }

    it("leaves the result document unlabeled across an update to the same source", async () => {
      const same = program({
        clause: "policy",
        slot: "declared",
        owner: "authorized",
        version: "v1",
        editView: false,
      });
      const { before, after } = await labelsAround(same, same, "policy");

      expect(before).toEqual({ secret: true, view: false });
      expect(after).toEqual(before);
    });
    describe("a view that reads the labeled cell", () => {
      // The sub-pattern computes from the labeled cell, so its setup
      // instantiates an action over it, and certifies that action's reads by
      // resolving the cell through the sub-pattern's argument. The action's
      // own run reads the cell and labels what it computes; the sub-pattern's
      // result, which only refers to that, stays as a fresh piece has it.

      const options = {
        clause: "policy" as const,
        slot: "declared" as const,
        owner: "plain" as const,
      };

      for (const reading of ["returns", "renders"] as const) {
        for (const editView of [true, false]) {
          it(`keeps the result document's labels as created across an update that ${editView ? "edits the view" : "changes only the parent"} (the computed ${reading === "renders" ? "rendered" : "returned"})`, async () => {
            const piece = await pieces.create(
              program({ ...options, version: "v1", editView, reading }),
              { input: {} },
            );
            await runtime.idle();
            const cell = piece.getCell();
            await cell.key("$UI").pull();
            await runtime.idle();
            const created = viewEntries(runtime, cell);
            expect(viewHidden(cell, "policy")).toBe(false);

            await piece.setPattern(
              program({ ...options, version: "v2", editView, reading }),
            );
            await runtime.idle();
            await cell.key("$UI").pull();
            await runtime.idle();

            expect(viewEntries(runtime, cell)).toEqual(created);
            expect(viewHidden(cell, "policy")).toBe(false);
            // The computed's output keeps the cell's clause. The cell's own
            // label and the slot's carry the one clause, so this does not
            // tell which of them its run took; the runner's
            // `cfc-static-read-targets` tests pin the slot's, under an atom
            // of its own.
            if (reading === "renders") {
              expect(carries(shownEntries(runtime, cell), "policy")).toBe(
                true,
              );
            }
          });
        }
      }
    });
  });

  describe("an update the serving runtime runs", () => {
    // Under server execution the update is a served lifecycle verb, and the
    // serving loop sets the sub-pattern up again when it swaps the piece to
    // the new pattern, after the verb commits.

    const space = servedSpace;
    let serving: ServingMemoryServer;
    let host: ExecutorHost;
    let session: Session;
    let cleanups: (() => Promise<void>)[];

    beforeEach(async () => {
      serving = await startServingMemoryServer({
        apiUrl: new URL(import.meta.url),
        serviceIdentity: service,
        policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
        // The verbs below are closures over the host, which a loop in a
        // worker cannot take.
        worker: false,
      });
      host = serving.host.host!;
      session = createSession({ identity: service, spaceDid: space as DID });
      cleanups = [];
    });

    afterEach(async () => {
      await host.close();
      for (const cleanup of cleanups.reverse()) await cleanup();
      await serving.close();
    });

    /** Runs a lifecycle verb on the space's serving runtime. */
    const served = <T>(
      name: string,
      run: (pieces: PiecesController) => Promise<T>,
      confirm?: (runtime: Runtime, receipt: T) => Promise<void>,
    ): Promise<T> =>
      host.runLifecycleVerb(space, {
        name,
        run: (runtime) =>
          run(
            new PiecesController(session, runtime, {
              deferSpaceCellSync: true,
            }),
          ),
        ...(confirm === undefined ? {} : { confirm }),
      });

    /**
     * The labels a client reads on the sub-pattern's result document of
     * `pieceId`, once it has asked the server for the piece's view, as a
     * rendering client does.
     */
    const servedViewEntries = async (pieceId: string) => {
      const manager = EmulatedStorageManager.connectTo(serving.server, {
        as: signer,
      });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
      });
      cleanups.push(async () => {
        await runtime.dispose();
        await manager.close();
      });
      const pieces = new PiecesController(session, runtime, {
        deferSpaceCellSync: true,
      });
      await pieces.ready;
      const cell = (await pieces.get(pieceId, false)).getCell();
      await pullFromServer(runtime, cell.key("$UI"));
      const view = cell.key("$UI").resolveAsCell();
      await runtime.getCellFromLink({
        ...view.getAsNormalizedFullLink(),
        path: [],
      }).sync();
      return viewEntries(runtime, cell);
    };

    it("leaves the result document unlabeled across an edit of the sub-pattern", async () => {
      const options = {
        clause: "policy" as const,
        slot: "declared" as const,
        owner: "plain" as const,
        editView: true,
      };
      const created = await served(
        "instantiate",
        (pieces) =>
          servedInstantiatePiece(pieces, {
            source: { program: program({ ...options, version: "v1" }) },
            actingUser: signer.did(),
          }),
        (runtime, receipt) =>
          confirmServedInstantiate(runtime, space, receipt, signer.did()),
      );
      expect(carries(await servedViewEntries(created.pieceId), "policy"))
        .toBe(false);
      const candidate = (await served(
        "upload",
        (pieces) =>
          servedUploadPattern(pieces, program({ ...options, version: "v2" })),
      )).ref;

      await served(
        "setsrc",
        (pieces) =>
          servedSetPieceSource(pieces, {
            pieceId: created.pieceId,
            pattern: candidate,
            actingUser: signer.did(),
          }),
        (runtime, receipt) => confirmServedSetSource(runtime, space, receipt),
      );

      expect(carries(await servedViewEntries(created.pieceId), "policy"))
        .toBe(false);
    });

    it("leaves the result document of a view that reads the labeled cell unlabeled across an edit of the sub-pattern", async () => {
      // The serving runtime sets the sub-pattern up again at its swap to the
      // new pattern, which instantiates the action the view computes with.
      // The update the piece's own runtime runs, above, is the case that
      // stamps the view when that instantiation joins the slot's label; this
      // pins the served route's outcome, which that join does not reach.

      const options = {
        clause: "policy" as const,
        slot: "declared" as const,
        owner: "plain" as const,
        editView: true,
        reading: "renders" as const,
      };
      const created = await served(
        "instantiate",
        (pieces) =>
          servedInstantiatePiece(pieces, {
            source: { program: program({ ...options, version: "v1" }) },
            actingUser: signer.did(),
          }),
        (runtime, receipt) =>
          confirmServedInstantiate(runtime, space, receipt, signer.did()),
      );
      expect(carries(await servedViewEntries(created.pieceId), "policy"))
        .toBe(false);
      const candidate = (await served(
        "upload",
        (pieces) =>
          servedUploadPattern(pieces, program({ ...options, version: "v2" })),
      )).ref;

      await served(
        "setsrc",
        (pieces) =>
          servedSetPieceSource(pieces, {
            pieceId: created.pieceId,
            pattern: candidate,
            actingUser: signer.did(),
          }),
        (runtime, receipt) => confirmServedSetSource(runtime, space, receipt),
      );

      expect(carries(await servedViewEntries(created.pieceId), "policy"))
        .toBe(false);
    });
  });
});
