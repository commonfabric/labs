/**
 * A handler or a lift whose body throws after naming a space the runtime has
 * not resolved, or asking about one the server has not answered for: the
 * runner resolves the name, or waits for the answer, and runs the body again.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("runner-cov-b pending spaces");
const home = signer.did();

const recordSchema = {
  type: "object",
  properties: { did: { type: "string" } },
} as const;

describe("runner pending spaces", () => {
  let server: MemoryV2Server.Server;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await server.close();
  });

  /** The DID the allocation record in `home` holds for `name`. */
  async function recorded(name: string): Promise<string | undefined> {
    const record = runtime.getCell(
      home,
      { inSpaceAllocation: { space: home, name } },
      recordSchema,
    );
    await record.sync();
    return record.get()?.did;
  }

  it("resolves the name a handler's body named before it threw, and runs the body again", async () => {
    const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    let runs = 0;
    const create = handler<
      { value: string },
      { children: Cell<unknown[]> }
    >({
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    }, {
      type: "object",
      properties: { children: { asCell: ["cell"] } },
      required: ["children"],
    }, ({ value }, { children }) => {
      runs++;
      const child = Child.inSpace("notebook")({ value });
      if (runs === 1) throw new Error("the first run fails");
      children.push(child);
    });
    const Root = pattern<{ children: Cell<unknown[]> }>(
      ({ children }) => ({ children, create: create({ children }) }),
      {
        type: "object",
        properties: { children: { asCell: ["cell"] } },
        required: ["children"],
      } as const,
    );
    const tx = runtime.edit();
    const children = runtime.getCell<unknown[]>(
      home,
      "children",
      undefined,
      tx,
    );
    children.set([]);
    const result = runtime.run(
      tx,
      Root,
      { children },
      runtime.getCell(home, "root", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    await result.pull();

    result.key("create").send({ value: "first" });
    await runtime.idle();
    await runtime.storageManager.synced();
    await children.pull();

    expect(runs).toBe(2);
    const spaces = (children.getRaw() as unknown[]).map((raw) =>
      parseLink(raw, children)!.space
    );
    expect(spaces).toEqual([await recorded("notebook")]);
    expect(spaces[0]).not.toBe(home);
  });

  it("waits for the answer about a space a handler's body asked about before it threw, and runs the body again", async () => {
    const { handler, pattern, spaceDeleted } =
      createTrustedBuilder(runtime).commonfabric;
    const elsewhere = (await Identity.fromPassphrase(
      "runner-cov-b pending spaces elsewhere",
    )).did() as MemorySpace;
    const answers: (boolean | undefined)[] = [];
    const ask = handler<unknown, { log: Cell<string[]> }>(
      { type: "object" },
      {
        type: "object",
        properties: { log: { asCell: ["cell"] } },
        required: ["log"],
      },
      (_event, { log }) => {
        const deleted = spaceDeleted(elsewhere);
        answers.push(deleted);
        if (deleted === undefined) throw new Error("no answer yet");
        log.push(`deleted: ${deleted}`);
      },
    );
    const Root = pattern<{ log: Cell<string[]> }>(
      ({ log }) => ({ log, ask: ask({ log }) }),
      {
        type: "object",
        properties: { log: { asCell: ["cell"] } },
        required: ["log"],
      } as const,
    );
    const tx = runtime.edit();
    const log = runtime.getCell<string[]>(home, "log", undefined, tx);
    log.set([]);
    const result = runtime.run(
      tx,
      Root,
      { log },
      runtime.getCell(home, "asking root", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await runtime.idle();
    await result.pull();

    result.key("ask").send({});
    await runtime.idle();
    await runtime.storageManager.synced();
    await log.pull();

    expect(answers).toEqual([undefined, false]);
    expect(log.get()).toEqual(["deleted: false"]);
  });

  it("resolves the name a lift's body named before it threw, and runs the body again", async () => {
    const { lift, pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    let runs = 0;
    const place = lift((value: string) => {
      runs++;
      const child = Child.inSpace("lifted")({ value });
      if (runs === 1) throw new Error("the first run fails");
      return child;
    });
    const Root = pattern<{ value: string }>(({ value }) => ({
      child: place(value),
    }));
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      Root,
      { value: "v" },
      runtime.getCell(home, "lift root", undefined, tx),
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit().settled;
    await result.pull();
    await runtime.idle();
    await runtime.storageManager.synced();

    expect(runs).toBe(2);
    const did = await recorded("lifted");
    expect(did).toBeDefined();
    expect(did).not.toBe(home);
  });
});
