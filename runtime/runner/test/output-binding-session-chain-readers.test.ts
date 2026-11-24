/**
 * What a session-scoped output chain means for readers in other sessions. A
 * run whose reads narrowed to session places its result in its own session
 * instance and leaves the broad location holding a link to it. A later run
 * whose reads did not narrow writes behind that link, into the session
 * instance of whichever session ran it, so nothing a later run computes
 * reaches the broad location. A reader in a session that has never run the
 * computation follows the link to an instance of its own that does not exist.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { createSigilLinkFromParsedLink, parseLink } from "../src/link-utils.ts";
import { sendValueToBinding } from "../src/pattern-binding.ts";
import type { CellScope } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "output binding session chain readers",
);
const space = signer.did();

describe("output-binding-session-chain-readers", () => {
  let server: MemoryV2Server.Server;
  let sessions: { runtime: Runtime; manager: EmulatedStorageManager }[];
  let seq = 0;

  beforeEach(() => {
    server = newSharedServer();
    sessions = [];
    seq++;
  });

  afterEach(async () => {
    for (const { runtime, manager } of sessions) {
      await runtime.dispose();
      await manager.close();
    }
    await server.close();
  });

  /** A runtime with a session of its own on the shared server. */
  const openSession = (): Runtime => {
    const manager = EmulatedStorageManager.connectTo(server, { as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    sessions.push({ runtime, manager });
    return runtime;
  };

  /** One run of the computation in `runtime`'s session: its result `value`,
   * sent to the output location the way a lift's result is, with the scope
   * its reads narrowed to. */
  const run = async (
    runtime: Runtime,
    value: unknown,
    narrowestReadScope: CellScope | undefined,
  ) => {
    const outcome = await runtime.editWithRetry((tx) => {
      const output = runtime.getCell<unknown>(
        space,
        `output-${seq}`,
        undefined,
        tx,
      );
      const result = runtime.getCell<unknown>(
        space,
        `result-${seq}`,
        undefined,
        tx,
      );
      sendValueToBinding(
        tx,
        result,
        undefined,
        createSigilLinkFromParsedLink(output.getAsNormalizedFullLink(), {
          overwrite: "redirect",
        }),
        value,
        narrowestReadScope === undefined ? {} : { narrowestReadScope },
      );
    });
    expect(outcome.error).toBeUndefined();
    await runtime.storageManager.synced();
  };

  /** The output location as `runtime`'s session reads it. */
  const outputIn = async (runtime: Runtime) => {
    const output = runtime.getCell<unknown>(space, `output-${seq}`);
    await output.sync();
    return output;
  };

  it("leaves a reader in another session without a value once a narrowed run placed the output", async () => {
    const first = openSession();
    await run(first, ["placed by a narrowed run"], "session");
    await run(first, ["computed from space data"], undefined);

    const reader = openSession();
    const seen = await outputIn(reader);

    expect(seen.get()).toBeUndefined();
    expect(parseLink(seen.getRaw(), seen)).toMatchObject({
      id: seen.getAsNormalizedFullLink().id,
      scope: "session",
    });
    expect((await outputIn(first)).get()).toEqual([
      "computed from space data",
    ]);
  });

  it("writes each session's later run into that session's own copy", async () => {
    const first = openSession();
    await run(first, ["placed by a narrowed run"], "session");

    const second = openSession();
    await run(second, ["computed by the second session"], undefined);
    await run(first, ["computed by the first session"], undefined);

    expect((await outputIn(first)).get()).toEqual([
      "computed by the first session",
    ]);
    expect((await outputIn(second)).get()).toEqual([
      "computed by the second session",
    ]);
    const third = openSession();
    expect((await outputIn(third)).get()).toBeUndefined();
  });
});
