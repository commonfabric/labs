import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { SessionRegistry } from "@commonfabric/memory/v2/server";
import { LoopbackStorageManager } from "../../src/executor/loopback-storage.ts";
import { inServingContext } from "../../src/executor/serving-context.ts";
import { newLoopbackServer } from "../../src/storage/v2-emulate.ts";

const service = await Identity.fromPassphrase("loopback storage service");

describe("LoopbackStorageManager", () => {
  describe("static members", () => {
    describe("connect()", () => {
      it("attributes its space sessions to one runtime and distinguishes another runtime", async () => {
        const sessions = new SessionRegistry();
        const server = newLoopbackServer({ sessions });
        const clientBuild = { application: "toolshed", gitSha: "a".repeat(40) };
        const manager = LoopbackStorageManager.connect(server, {
          as: service,
          clientBuild,
        });
        const other = LoopbackStorageManager.connect(server, {
          as: service,
          clientBuild,
        });
        const spaces = [
          service.did(),
          (await Identity.generate()).did(),
        ] as MemorySpace[];
        try {
          for (const space of spaces) {
            const result = await manager.open(space).sync(
              "of:loopback-identity",
              { path: [], schema: false },
            );
            expect(result.error).toBeUndefined();
          }
          const first = sessions.sessionsForSpace(spaces[0])[0]?.client;
          const second = sessions.sessionsForSpace(spaces[1])[0]?.client;
          expect(first).toMatchObject(clientBuild);
          expect(first?.instanceId).toEqual(expect.any(String));
          expect(second).toEqual(first);
          const result = await other.open(spaces[0]).sync(
            "of:loopback-other-runtime",
            { path: [], schema: false },
          );
          expect(result.error).toBeUndefined();
          const reports = sessions.sessionsForSpace(spaces[0]).map((session) =>
            session.client
          );
          // Admission probes can leave detached sessions in the registry.
          expect(reports.length).toBeGreaterThanOrEqual(2);
          for (const report of reports) {
            expect(report).toMatchObject(clientBuild);
          }
          expect(new Set(reports.map((report) => report?.instanceId)).size)
            .toBe(2);
        } finally {
          await manager.close();
          await other.close();
          await server.close();
        }
      });

      it("takes each server frame in the serving context, whatever sent the request", async () => {
        // The read is sent from outside the serving context, which is also
        // the context the turn delivering its reply carries.
        const server = newLoopbackServer();
        const seen: boolean[] = [];
        const manager = LoopbackStorageManager.connect(
          server,
          { as: service },
          () => seen.push(inServingContext()),
        );
        try {
          const result = await manager.open(service.did() as MemorySpace)
            .sync("of:loopback-storage-probe", { path: [], schema: false });
          expect(result.error).toBeUndefined();
        } finally {
          await manager.close();
          await server.close();
        }
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((serving) => serving)).toBe(true);
      });
    });
  });
});
