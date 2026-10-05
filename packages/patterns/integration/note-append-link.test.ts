/**
 * Verifies that a piece id seen from *inside* a pattern corresponds to the same
 * piece id seen from *outside* it.
 *
 * The note pattern's `appendLink` builds a `[[name (id)]]` wiki-link whose id is
 * derived internally — `entityRefToString` over a cell's `entityId`. This test
 * invokes `appendLink` from outside the pattern and asserts the embedded id is
 * exactly `target.id`, the same piece's id as reported by `create` (the
 * runtime's external-facing identity). It thus guards against the in-pattern id
 * being self-consistent yet disagreeing with the external view — a mismatch an
 * in-pattern assertion can't catch, since it only has the same internal
 * machinery to recompute the id with.
 */
import { createTestSpace, env } from "@commonfabric/integration";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertStringIncludes } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL } = env;

describe("note appendLink integration", () => {
  let identity: Identity;
  let cc: PiecesController;
  let host: PieceController;
  let target: PieceController;
  const cancels: Array<() => void> = [];

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: await createTestSpace(identity),
      apiUrl: new URL(API_URL),
      identity,
    });
    const sourcePath = join(import.meta.dirname!, "..", "notes", "note.tsx");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath },
    );
    host = await cc.create(program, {
      input: { title: "Host Note", content: "" },
      start: true,
    });
    target = await cc.create(program, {
      input: { title: "Target Note", content: "" },
      start: true,
    });
    // Keep both pieces reactive (pull mode) so handlers run on send.
    cancels.push(cc.getResult(host.getCell()).sink(() => {}));
    cancels.push(cc.getResult(target.getCell()).sink(() => {}));
    // `create` resolves once the piece exists, not once its result has been
    // derived: the pattern runs on whichever side the space's execution
    // posture puts it, so under server execution the value arrives over the
    // wire afterwards. Sending the event reads through the payload's link to
    // hold it against the stream's contract, so the target has to be loaded
    // before it can be linked to.
    await waitForCellValue(
      cc.runtime,
      target.getCell(),
      (v) => v !== undefined,
    );
  });

  afterAll(async () => {
    for (const c of cancels) c();
    if (cc) await cc.dispose();
  });

  it("appends a [[name (id)]] link carrying the target's real id", async () => {
    // Invoke appendLink (a Stream) by setting its event on the result cell,
    // passing the target piece's cell as the mentionable.
    await host.result.set(
      { piece: target.getCell() },
      ["appendLink"],
    );
    await cc.runtime.idle();
    await cc.synced();

    const content = await host.result.get(["content"]) as string;
    assert(typeof content === "string", "content is not a string");

    // External oracle: the id embedded in the wiki-link must be the target's
    // authoritative id (`target.id` from create) — confirming the pattern's
    // entityRefToString output agrees with the runtime's id seen from *outside*
    // the pattern, not just with itself.
    assertStringIncludes(content, `[[📝 Target Note (${target.id})]]`);
  });
});
