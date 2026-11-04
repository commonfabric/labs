import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { HttpProgramResolver } from "@commonfabric/js-compiler/program";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  getPatternIdentityRef,
  getPatternSource,
  Runtime,
} from "@commonfabric/runner";
import { PatternsRoute } from "@commonfabric/runner/patterns-route.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const starterFile = "system/fabrichat/space-starter.tsx";
const starterOrigin = `system:${starterFile}`;
const retiredFiles = ["fabrichat/main.tsx", "system/fabrichat/main.tsx"];

describe("fabrichat-starter-source-lifecycle", () => {
  it("adopts a served release on a cold open and leaves retired entry points unavailable", async () => {
    const owner = await Identity.fromPassphrase("FabriChat starter releases");
    const server = newLoopbackServer();
    const patterns = fromFileUrl(new URL("..", import.meta.url));
    const temporary = await Deno.makeTempDir({ prefix: "starter-release-" });
    let route = new PatternsRoute(patterns, [], { releasedAt: 1_000 });
    const http = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) =>
        await route.serve(request) ??
          new Response("Not found", { status: 404 }),
    );
    const apiUrl = new URL(`http://127.0.0.1:${http.addr.port}`);
    let storage = EmulatedStorageManager.connectTo(server, { as: owner });
    let runtime = new Runtime({ apiUrl, storageManager: storage });
    let controller = new PiecesController(
      createSession({ identity: owner, spaceDid: owner.did() }),
      runtime,
    );
    try {
      const program = await runtime.harness.resolve(
        new HttpProgramResolver(
          new URL(`/api/patterns/${starterFile}`, apiUrl).href,
        ),
      );
      const compiled = await runtime.patternManager.compilePattern(program, {
        space: owner.did(),
      });
      const starter = await controller.runPersistent(
        compiled,
        {},
        "space conversation starter",
        { origin: starterOrigin },
      );
      await runtime.idle();
      expect(await starter.key("$NAME").pull()).toBe("FabriChat");
      expect(getPatternSource(starter)).toBe(starterOrigin);
      const initialIdentity = getPatternIdentityRef(starter)?.identity;
      expect(initialIdentity).toBe(await route.identity(starterFile));
      const link = starter.getAsNormalizedFullLink();
      await storage.synced();
      await controller.dispose();
      await runtime.dispose();
      await storage.close();

      // Keep the production import closure and change only the release's
      // displayed name. The update must accept the piece's stored `{}` input.
      const directory = join(patterns, "system", "fabrichat");
      for await (const entry of Deno.readDir(directory)) {
        if (entry.name === "space-starter.tsx") continue;
        await Deno.symlink(
          join(directory, entry.name),
          join(temporary, entry.name),
        );
      }
      const source = await Deno.readTextFile(join(patterns, starterFile));
      const nextSource = source.replace(
        '[NAME]: "FabriChat"',
        '[NAME]: "FabriChat next release"',
      );
      expect(nextSource).not.toBe(source);
      await Deno.writeTextFile(
        join(temporary, "space-starter.tsx"),
        nextSource,
      );
      route = new PatternsRoute(patterns, [{
        routePrefix: "system/fabrichat/",
        directory: temporary,
      }], { releasedAt: 2_000 });
      const nextIdentity = await route.identity(starterFile);
      expect(nextIdentity).not.toBe(initialIdentity);

      storage = EmulatedStorageManager.connectTo(server, { as: owner });
      runtime = new Runtime({ apiUrl, storageManager: storage });
      controller = new PiecesController(
        createSession({ identity: owner, spaceDid: owner.did() }),
        runtime,
      );
      const reopened = (await controller.get(link.id, true)).getCell();
      await runtime.idle();
      expect(reopened.equalLinks(starter)).toBe(true);
      expect(getPatternSource(reopened)).toBe(starterOrigin);
      expect(getPatternIdentityRef(reopened)?.identity).toBe(nextIdentity);
      expect(await reopened.key("$NAME").pull()).toBe("FabriChat next release");

      for (const file of retiredFiles) {
        for (const query of ["", "?identity"]) {
          const response = await fetch(
            new URL(`/api/patterns/${file}${query}`, apiUrl),
          );
          await response.body?.cancel();
          expect(response.status).toBe(404);
        }
      }
    } finally {
      await controller.dispose();
      await runtime.dispose();
      await storage.close();
      await http.shutdown();
      await Deno.remove(temporary, { recursive: true });
    }
  });
});
