import { expect } from "@std/expect";

import { isDeepFrozen } from "@commonfabric/data-model";
import {
  FabricUnavailable,
  isUnavailable,
} from "@commonfabric/data-model/availability";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";
import { TEST_MEMORY_SERVER_AUTH } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("fetch reload preservation");
const space = signer.did();

class LoopbackSessionFactory implements SessionFactory {
  constructor(private readonly server: MemoryV2Server.Server) {}

  async create(spaceId: MemorySpace, sessionSigner?: Signer) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.server),
    });
    const session = await client.mount(
      spaceId,
      {},
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: sessionSigner?.did() },
      }),
    );
    return { client, session };
  }
}

class SharedServerStorageManager extends StorageManager {
  static overServer(
    as: Identity,
    server: MemoryV2Server.Server,
  ): SharedServerStorageManager {
    return new SharedServerStorageManager(
      { as, memoryHost: new URL("memory://") } as Options,
      new LoopbackSessionFactory(server),
    );
  }
}

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      "import { fetchProgram, fetchText, pattern } from 'commonfabric';",
      "export default pattern(() => ({",
      "  text: fetchText({ url: 'https://fetch.test/value.txt' }),",
      "  program: fetchProgram({ url: 'https://fetch.test/program.ts' }),",
      "  failedProgram: fetchProgram({ url: 'https://fetch.test/failure.ts' }),",
      "}));",
    ].join("\n"),
  }],
};

Deno.test("fetch results and claims survive a cold runtime reload", async () => {
  const server = new MemoryV2Server.Server({
    authorizeSessionOpen(message) {
      const principal = (message.authorization as { principal?: unknown })
        ?.principal;
      return typeof principal === "string" ? principal : undefined;
    },
    sessionOpenAuth: TEST_MEMORY_SERVER_AUTH.sessionOpenAuth,
  });
  const storageA = SharedServerStorageManager.overServer(signer, server);
  const storageB = SharedServerStorageManager.overServer(signer, server);
  const originalFetch = globalThis.fetch;
  let phase: "create" | "reload" = "create";
  let createFetches = 0;
  let reloadFetches = 0;
  const failure = new TypeError("durable program resolution failure");
  failure.stack = "durable program resolver stack";
  failure.cause = { code: "ECONNRESET" };
  (failure as TypeError & { retryable: boolean }).retryable = true;
  globalThis.fetch = (
    input: string | URL | Request,
  ): Promise<Response> => {
    if (phase === "create") createFetches++;
    else reloadFetches++;
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    if (url.endsWith("failure.ts")) {
      return Promise.reject(failure);
    }
    return Promise.resolve(
      url.endsWith("program.ts")
        ? new Response("export const durable = true;\n", { status: 200 })
        : new Response("durable text", { status: 200 }),
    );
  };

  const runtimeA = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storageA,
  });
  let runtimeADisposed = false;
  let runtimeB: Runtime | undefined;
  try {
    const compiled = await runtimeA.patternManager.compilePattern(PROGRAM, {
      space,
    });
    const tx = runtimeA.edit();
    const resultA = runtimeA.getCell(
      space,
      "fetch-reload-result",
      compiled.resultSchema,
      tx,
    );
    const runningA = runtimeA.run(tx, compiled, {}, resultA);
    await tx.commit().settled;
    for (let index = 0; index < 6; index++) {
      await runningA.pull();
      await runtimeA.settled();
      await runtimeA.idle();
    }
    await runtimeA.patternManager.flushCompileCacheWrites();
    await storageA.synced();

    expect(resultA.key("text").getAsQueryResult()).toBe("durable text");
    expect(
      (resultA.key("program").getAsQueryResult() as {
        files?: Array<{ contents?: string }>;
      }).files?.[0]?.contents,
    ).toContain("durable = true");
    const createdError = resultA.key("failedProgram").resolveAsCell()
      .getRaw() as FabricUnavailable;
    expect(createdError.reason).toBe("error");
    expect(createdError.errorKind).toBe("general");
    expect(createdError.errorMessage).toBe(
      "durable program resolution failure",
    );
    expect(createFetches).toBe(3);

    // Force the cold runtime to recover the terminal value from fetchProgram's
    // durable cache rather than the separately-persisted result child.
    runtimeA.runner.stop(resultA);
    const clearResultTx = runtimeA.edit();
    resultA.key("failedProgram").withTx(clearResultTx).resolveAsCell().setRaw(
      undefined,
    );
    await clearResultTx.commit().settled;
    await storageA.synced();
    await runtimeA.dispose();
    runtimeADisposed = true;

    phase = "reload";
    runtimeB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
    await runtimeB.patternManager.compilePattern(PROGRAM, { space });
    const reloadTx = runtimeB.edit();
    const resultB = runtimeB.getCell(
      space,
      "fetch-reload-result",
      compiled.resultSchema,
      reloadTx,
    );
    await reloadTx.commit().settled;
    const reloadValues: unknown[] = [];
    const cancelText = resultB.key("text").sink((value) => {
      reloadValues.push(value);
    });
    const cancelProgram = resultB.key("program").sink((value) => {
      reloadValues.push(value);
    });
    const cancelFailedProgram = resultB.key("failedProgram").sink((value) => {
      reloadValues.push(value);
    });
    try {
      expect(await runtimeB.start(resultB)).toBe(true);
      for (let index = 0; index < 6; index++) {
        await resultB.pull();
        await runtimeB.settled();
        await runtimeB.idle();
      }
    } finally {
      cancelText();
      cancelProgram();
      cancelFailedProgram();
    }

    expect(resultB.key("text").getAsQueryResult()).toBe("durable text");
    expect(
      (resultB.key("program").getAsQueryResult() as {
        files?: Array<{ contents?: string }>;
      }).files?.[0]?.contents,
    ).toContain("durable = true");
    const reloadedError = resultB.key("failedProgram").resolveAsCell()
      .getRaw() as FabricUnavailable;
    expect(reloadedError.reason).toBe("error");
    expect(reloadedError.errorKind).toBe("general");
    expect(reloadedError.errorMessage).toBe(
      "durable program resolution failure",
    );
    expect(isDeepFrozen(reloadedError)).toBe(true);
    expect(reloadFetches).toBe(0);
    // A cold replica may briefly publish pending while the builtin's private
    // cache/result cells load. It must not surface a false mismatch or issue
    // another request, and each field must converge to its durable terminal
    // success/error value.
    expect(
      reloadValues.filter(isUnavailable).every((value) =>
        value.reason === "pending" || value.reason === "error"
      ),
    ).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    if (runtimeB) await runtimeB.dispose();
    else await storageB.close();
    if (!runtimeADisposed) await runtimeA.dispose();
    await server.close();
  }
});
