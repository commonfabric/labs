import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import {
  entityIdFrom,
  getMetaLink,
  Runtime,
  type RuntimeProgram,
  type URI,
} from "@commonfabric/runner";
import {
  argumentDocumentOf,
  compiledPointerOf,
} from "@commonfabric/runner/compiled/setup";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import {
  compiledInstantiatePiece,
  readServedInstantiateReceipt,
  ServedLifecycleRefusal,
} from "../src/ops/served-lifecycle.ts";
import { resolveSlugTargetCell } from "../src/slugs.ts";

const signer = await Identity.fromPassphrase("compiled instantiate tests");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: "import { pattern } from 'commonfabric';\n" +
      "export default pattern<{ n: number }, { n: number }>(({ n }) => ({ n }));\n",
  }],
};

describe("compiledInstantiatePiece()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const session = createSession({
      identity: signer,
      spaceDid: await runtime.createSpace(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** The value the replica holds at the root of the entity `id`. */
  const held = (id: string): unknown =>
    runtime.readTx().readValueOrThrow({
      space: pieces.getSpace(),
      id: id as URI,
      path: [],
      scope: "space",
    });

  it("writes what the serving runtime starts the piece from, a receipt that names the source, and the argument in the result's metadata", async () => {
    const receipt = await compiledInstantiatePiece(pieces, {
      program: PROGRAM,
      argument: { n: 3 },
      register: true,
      requestKey: "first",
      actingUser: signer.did(),
    });

    const result = `of:${receipt.pieceId}`;
    const { source } = held(compiledPointerOf(result)) as { source: string };
    expect(JSON.parse(held(source) as string).main).toBe("/main.tsx");
    expect(held(argumentDocumentOf(result))).toEqual({ n: 3 });
    expect(held(result)).toBeUndefined();
    const piece = runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(receipt.pieceId),
    );
    expect(getMetaLink(piece, "argument")?.id).toBe(argumentDocumentOf(result));
    expect(receipt.pattern).toEqual({ identity: source, symbol: "default" });
    expect(receipt.registration).toEqual({ status: "pending" });
    expect(
      await readServedInstantiateReceipt(pieces, "first", signer.did()),
    ).toEqual(receipt);
  });

  it("returns the receipt the first attempt of a request key left, and sets no second piece up", async () => {
    const request = {
      program: PROGRAM,
      argument: { n: 1 },
      requestKey: "again",
      actingUser: signer.did(),
    };
    const first = await compiledInstantiatePiece(pieces, request);
    const second = await compiledInstantiatePiece(pieces, {
      ...request,
      argument: { n: 2 },
    });

    expect(second).toEqual(first);
    expect(held(argumentDocumentOf(`of:${first.pieceId}`))).toEqual({ n: 1 });
  });

  it("names the piece by the slug it was asked for, and refuses a slug that names something else unless forced", async () => {
    const named = await compiledInstantiatePiece(pieces, {
      program: PROGRAM,
      slug: "counted",
      requestKey: "named",
      actingUser: signer.did(),
    });
    expect(named.slug).toBe("counted");
    expect(
      (await resolveSlugTargetCell(pieces, "counted")).getAsNormalizedFullLink()
        .id,
    ).toBe(`of:${named.pieceId}`);

    const refusal = await compiledInstantiatePiece(pieces, {
      program: PROGRAM,
      slug: "counted",
      requestKey: "taken",
      actingUser: signer.did(),
    }).then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(ServedLifecycleRefusal);
    expect((refusal as ServedLifecycleRefusal).code).toBe("slug-taken");

    const forced = await compiledInstantiatePiece(pieces, {
      program: PROGRAM,
      slug: "counted",
      force: true,
      requestKey: "forced",
      actingUser: signer.did(),
    });
    expect(
      (await resolveSlugTargetCell(pieces, "counted")).getAsNormalizedFullLink()
        .id,
    ).toBe(`of:${forced.pieceId}`);
  });
});
