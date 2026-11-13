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

/** An owner cell typed so its writer is named, or plainly. */
const OWNERS = {
  "authorized": "WriteAuthorizedBy<Record<string, never>, typeof retainOwner>",
  "plain": "Record<string, never>",
} as const;

type Owner = keyof typeof OWNERS;

/**
 * The piece's program: a labeled cell and an owner cell, both handed to the
 * sub-pattern `View`, whose view shows only the owner cell. `version` changes
 * the main module; with `editView` it changes `View`'s own body too.
 */
const program = (
  options: {
    clause: Clause;
    slot: Slot;
    owner: Owner;
    version: string;
    editView: boolean;
  },
): RuntimeProgram => {
  const labeled = options.clause === "policy" ? "BySealedPolicy" : "ByAtom";
  const slotType = options.slot === "declared"
    ? `${labeled}<number> | undefined`
    : "number | undefined";
  const title = options.editView ? options.version : "";
  return {
    main: "/main.tsx",
    files: [
      {
        name: "/main.tsx",
        contents: `/// <cts-enable />
import {
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
  ({ owner }) => ({ [UI]: <div title="${title}">{owner}</div> }),
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
    const link = cell.withTx(tx).resolveAsCell().getAsNormalizedFullLink();
    return readStoredCfcMetadata(tx, { ...link, path: [] })?.labelMap
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
  });
});
