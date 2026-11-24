/**
 * A verb call starts its piece, and starting a piece reads the piece's own
 * document. Where the runtime's read ceiling withholds what that document
 * carries, the call is refused before anything is sent, rather than throwing
 * past its caller: a harness run calling the verb would otherwise end on the
 * throw.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  storedFields,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { callVerb } from "../src/verb-call.ts";

const signer = await Identity.fromPassphrase("piece verb-call read ceiling");

/** The atom the piece's `note` carries: outside the runtime's ceiling. */
const SECRET_ATOM = "verb-call-read-ceiling-secret";

/** A piece with a `note` and a verb that touches only its `count`. */
const SOURCE = [
  "import { action, Default, pattern, Stream, Writable } from 'commonfabric';",
  "interface Input {",
  "  note?: Writable<string | Default<''>>;",
  "  count?: Writable<number | Default<0>>;",
  "}",
  "interface Output { note: string; count: number; bump: Stream<void>; }",
  "export default pattern<Input, Output>(({ note, count }) => {",
  "  const bump = action(() => { count.set(count.get() + 1); });",
  "  return { note, count, bump };",
  "});",
  "",
].join("\n");

describe("callVerb under a read ceiling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
      cfcReadMaxConfidentiality: ["verb-call-read-ceiling-other"],
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
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
   * Creates the piece without starting it, its stored `note` labelled
   * {@link SECRET_ATOM} when `labelled`, and returns its result cell.
   */
  const createPiece = async (
    labelled: boolean,
  ): Promise<Cell<{ count: number }>> => {
    const created = await pieces.create<{ count: number }>(SOURCE, {
      input: {},
      start: false,
    });
    const cell = created.getCell();
    if (!labelled) return cell;
    const { space, id } = cell.getAsNormalizedFullLink();
    const address = { space, scope: "space" as const, id, path: [] };
    const seed = runtime.edit();
    const stored = storedFields(seed, address);
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, address, {
      ...stored,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: ["note"],
            label: { confidentiality: [SECRET_ATOM] },
          }],
        },
      },
    });
    expect((await seed.commit().settled).ok).toBeDefined();
    return cell;
  };

  it("refuses the call, before anything is sent, when starting the piece reads above the ceiling", async () => {
    const cell = await createPiece(true);

    const call = await callVerb(
      runtime,
      cell.getAsNormalizedFullLink(),
      "bump",
      undefined,
    );

    expect(call).toEqual({
      status: "refused",
      message: 'the event for "bump" was not sent: this piece could not be ' +
        "started here, because something it reads is above this session's " +
        "read ceiling",
    });
    expect(JSON.stringify(call)).not.toContain(SECRET_ATOM);
    expect(runtime.runner.isRunning(cell)).toBe(false);
  });

  it("starts the piece and runs the verb when nothing it reads is above the ceiling", async () => {
    const cell = await createPiece(false);

    const call = await callVerb(
      runtime,
      cell.getAsNormalizedFullLink(),
      "bump",
      undefined,
    );

    expect(call.status).toBe("settled");
    expect(await cell.key("count").pull()).toBe(1);
  });
});
