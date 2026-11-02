import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { aclDocId } from "@commonfabric/memory/acl";
import { Server } from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import { resolveSpaceStoreUrl } from "@commonfabric/memory/v2/storage-path";
import env from "@/env.ts";
import { lifecycleRequestHandler } from "@/lib/pattern-lifecycle-handler.ts";
import {
  startServerExecutionHost,
  stopServerExecutionHost,
} from "@/lib/server-execution.ts";
import { memoryEngineStoreUrl, memoryServer } from "@/routes/storage/memory.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("pattern-lifecycle-handler", () => {
  describe("lifecycleRequestHandler()", () => {
    it("reads the hosted ACL through the memory service before refusing a read-only caller", async () => {
      const space = (await Identity.generate()).did();
      const owner = await Identity.generate();
      const reader = await Identity.generate();
      const isolated = new Server({
        store: new URL(`memory://handler-acl-${crypto.randomUUID()}`),
        authorizeSessionOpen: verifySessionOpenAuthorization,
        sessionOpenAuth: { audience: owner.did() },
      });
      // The space counts as hosted when its store file exists.
      const file = await Deno.makeTempFile();
      const fileInfo = await Deno.stat(file);
      const storePath = fromFileUrl(
        resolveSpaceStoreUrl(memoryEngineStoreUrl, space),
      );
      const stat = Deno.statSync.bind(Deno);
      using _hosted = stub(
        Deno,
        "statSync",
        (path) => String(path) === storePath ? fileInfo : stat(path),
      );
      using read = stub(memoryServer, "readDocument", (target, id) => {
        expect(target).toBe(space);
        expect(id).toBe(aclDocId(space));
        return Promise.resolve({
          value: { [owner.did()]: "OWNER", "*": "READ" },
        });
      });
      try {
        startServerExecutionHost({
          server: isolated,
          identity: owner,
          apiUrl: new URL("http://handler-acl.invalid"),
          envGet: (name) =>
            name === "EXPERIMENTAL_SERVER_EXECUTION"
              ? "true"
              : name === "SERVER_EXECUTION_ENSURE_SPACE_ROOTS"
              ? "false"
              : undefined,
        });
        const outcome = await lifecycleRequestHandler({
          space,
          principal: reader.did(),
          verb: "upload",
          body: { program: { main: "/main.tsx", files: [] } },
        });
        expect(outcome).toEqual({
          refusal: { code: "forbidden", message: expect.any(String) },
        });
        expect(read.calls).toHaveLength(1);
      } finally {
        await stopServerExecutionHost();
        await isolated.close();
        await Deno.remove(file);
      }
    });
  });
});
