import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { popFrame, pushFrame } from "../../src/builder/pattern.ts";
import { spaceOfLink } from "../../src/builder/space-access.ts";
import { Runtime } from "../../src/runtime.ts";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "../../src/storage/v2-emulate.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

const signer = await Identity.fromPassphrase("space-of-link pending signer");
const home = signer.did();

describe("spaceOfLink()", () => {
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

  it("returns `undefined` once a handler run names an `inSpace()` space that has not resolved", () => {
    const { pattern } = createTrustedBuilder(runtime).commonfabric;
    const Child = pattern<{ value: string }>(({ value }) => ({ value }));
    const tx = runtime.edit();
    const cell = runtime.getCell<unknown>(home, "named cell", undefined, tx);
    const frame = pushFrame({
      runtime,
      tx,
      space: home,
      frameKind: "handler",
      inHandler: true,
    });
    try {
      expect(spaceOfLink(cell)).toBe(home);

      Child.inSpace("unresolved room")({ value: "v" });

      expect([...frame.pendingSpaceNames!.keys()]).toEqual(["unresolved room"]);
      expect(spaceOfLink(cell)).toBeUndefined();
    } finally {
      popFrame(frame);
    }
  });
});
