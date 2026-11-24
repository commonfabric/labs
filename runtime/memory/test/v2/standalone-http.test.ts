/** Tests what the standalone memory host answers to ordinary HTTP requests. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { StandaloneMemoryServer } from "../../v2/standalone.ts";

describe("standalone memory HTTP", () => {
  it("reports itself up on the health route", async () => {
    const server = StandaloneMemoryServer.start();
    try {
      const response = await fetch(new URL("/_health", server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "OK" });
    } finally {
      await server.close();
    }
  });

  it("reports itself up even behind a handler that answers everything", async () => {
    // Whether the host is up is the host's own business. A caller mounting a
    // broad handler would otherwise decide it, and a client whose health
    // probe fails never opens a connection at all.

    const server = StandaloneMemoryServer.start({
      serve: () => new Response("mounted", { status: 200 }),
    });
    try {
      const response = await fetch(new URL("/_health", server.url));
      expect(await response.json()).toMatchObject({ status: "OK" });
    } finally {
      await server.close();
    }
  });

  it("asks a route it does not serve to upgrade instead", async () => {
    // A bare storage host has no patterns route, and a body answered `200`
    // is one a client compiles as the source it asked for.

    const server = StandaloneMemoryServer.start();
    try {
      const response = await fetch(
        new URL(
          "/api/patterns/system/profile-create/profile-create.tsx",
          server.url,
        ),
      );
      expect(response.status).toBe(426);
      expect(response.headers.get("Upgrade")).toBe("websocket");
      expect(await response.text()).toContain("Upgrade: websocket");
    } finally {
      await server.close();
    }
  });

  it("answers with what the caller's handler returns", async () => {
    const server = StandaloneMemoryServer.start({
      serve: (request) =>
        new Response(new URL(request.url).pathname, { status: 200 }),
    });
    try {
      const response = await fetch(new URL("/anything", server.url));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("/anything");
    } finally {
      await server.close();
    }
  });

  it("cites a specification of the protocol it asks for", async () => {
    // Read the path back out of the body and resolve it, rather than matching
    // the words: a test that only checked the words would keep passing after
    // the document it names moved.

    const server = StandaloneMemoryServer.start();
    try {
      const response = await fetch(new URL("/anything", server.url));
      const cited = /\bdocs\/\S+\.md\b/.exec(await response.text())?.[0];
      expect(cited).toBeDefined();
      const repositoryRoot = new URL("../../../../", import.meta.url);
      expect((await Deno.stat(new URL(cited!, repositoryRoot))).isFile)
        .toBe(true);
    } finally {
      await server.close();
    }
  });

  it("asks a request the caller's handler declines to upgrade", async () => {
    const server = StandaloneMemoryServer.start({ serve: () => undefined });
    try {
      const response = await fetch(new URL("/anything", server.url));
      expect(response.status).toBe(426);
      expect(response.headers.get("Upgrade")).toBe("websocket");
      expect(await response.text()).toContain("Upgrade: websocket");
    } finally {
      await server.close();
    }
  });
});
