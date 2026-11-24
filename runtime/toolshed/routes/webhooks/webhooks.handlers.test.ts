import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type JSONSchema,
  Runtime,
  WebhookConfigSchema,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import * as Engine from "@commonfabric/memory/v2/engine";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { linkRefPayloadToString } from "@commonfabric/runner/shared";
import env from "@/env.ts";
import { createTestApp } from "@/lib/create-app.ts";
import { identity } from "@/lib/identity.ts";
import { sha256 } from "@/lib/sha2.ts";
import {
  createAclServer,
  genesisAcl,
  LoopbackSessionFactory,
  TestStorageManager,
} from "@/test/support/memory-acl.ts";
import { refuseCommits } from "@/test/support/refuse-commits.ts";
import { createWebhooksRouter } from "./webhooks.handlers.ts";
import {
  getRegistration,
  getServiceIndex,
  saveRegistration,
  verifyWebhookSecret,
  type WebhookRegistration,
} from "./webhooks.utils.ts";

/** A pattern whose `bump` stream's handler adds one to `value`. */
const BUMP_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const bump = handler<unknown, { value: Writable<number> }>(",
  "  (_ev, { value }) => { value.set((value.get() ?? 0) + 1); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; bump: Stream<unknown> }",
  ">(({ value }) => ({ value, bump: bump({ value }) }));",
].join("\n");

/** A pattern whose `explode` stream's handler throws. */
const THROW_PATTERN = [
  "import { handler, pattern, Stream, Writable } from 'commonfabric';",
  "const explode = handler<unknown, { value: Writable<number> }>(",
  "  () => { throw new Error('handler exploded deliberately'); },",
  ");",
  "export default pattern<",
  "  { value: Writable<number> },",
  "  { value: number; explode: Stream<unknown> }",
  ">(({ value }) => ({ value, explode: explode({ value }) }));",
].join("\n");

const STREAM_SCHEMA: JSONSchema = {
  asCell: ["stream"],
  type: "object",
  properties: { data: { type: "string" } },
};

/** The `fcl1:` wire form of `cell`'s address. */
const wireOf = (cell: Cell<unknown>): string => {
  const link = cell.getAsNormalizedFullLink();
  return linkRefPayloadToString({
    id: link.id,
    space: link.space,
    path: link.path.map(String),
  });
};

const user = await Identity.fromPassphrase("webhooks handlers user");
const space = user.did();
const otherSpace = (await Identity.fromPassphrase("webhooks other")).did();

describe("webhooks.handlers", () => {
  let runtime: Runtime;
  let teardown: (() => Promise<void>)[];
  let inbox: Cell<unknown>;
  let config: Cell<unknown>;
  let received: Cell<unknown>;

  beforeEach(() => {
    teardown = [];
  });

  afterEach(async () => {
    for (const step of teardown.reverse()) await step();
  });

  /**
   * Builds a runtime over fresh emulated storage, with an inbox stream whose
   * events land in `received`.
   */
  const start = async () => {
    // The toolshed's own identity signs, so its service space, where the
    // registrations live, is the signer's space.
    const storageManager = StorageManager.emulate({ as: identity });
    runtime = new Runtime({
      apiUrl: new URL("https://webhooks-handlers-test.invalid"),
      storageManager,
      experimental: { serverExecution: false },
    });
    teardown.push(() => storageManager.close(), () => runtime.dispose());
    const tx = runtime.edit();
    inbox = runtime.getCell(space, "webhook-inbox", STREAM_SCHEMA, tx);
    config = runtime.getCell(space, "webhook-config", undefined, tx);
    received = runtime.getCell<unknown>(
      space,
      "webhook-received",
      undefined,
      tx,
    );
    received.set(null);
    await tx.commit().settled;
    runtime.scheduler.addEventHandler((eventTx, event) => {
      received.withTx(eventTx).send(event);
    }, inbox.getAsNormalizedFullLink());
  };

  const app = () =>
    createTestApp(createWebhooksRouter({ runtime: () => runtime }));

  const create = (body: Record<string, string>) =>
    app().request("/api/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  /** Creates a webhook into `inbox`, returning its id and secret. */
  const createWebhook = async (name = "github") => {
    const res = await create({
      name,
      cellLink: wireOf(inbox),
      confidentialCellLink: wireOf(config),
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    const written = runtime.getCellFromLink(
      config.getAsNormalizedFullLink(),
      WebhookConfigSchema,
    );
    await written.sync();
    return { id: id as string, secret: written.get().secret };
  };

  const deliver = (id: string, token: string | undefined, body: string) =>
    app().request(`/api/webhooks/${id}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body,
    });

  describe("create", () => {
    beforeEach(start);

    it("saves the registration and writes the URL and secret to the confidential cell", async () => {
      const res = await create({
        name: "github",
        cellLink: wireOf(inbox),
        confidentialCellLink: wireOf(config),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        id: expect.stringMatching(/^wh_/),
        name: "github",
      });

      const written = runtime.getCellFromLink(
        config.getAsNormalizedFullLink(),
        WebhookConfigSchema,
      );
      await written.sync();
      expect(written.get().url).toBe(`${env.API_URL}/api/webhooks/${body.id}`);

      const registration = await getRegistration(runtime, body.id);
      expect(registration).toMatchObject({
        id: body.id,
        name: "github",
        cellLink: wireOf(inbox),
        createdBy: space,
        enabled: true,
      });
      expect(
        await verifyWebhookSecret(
          written.get().secret,
          registration!.secretHash,
        ),
      ).toBe(true);
      expect(await getServiceIndex(runtime, space)).toEqual([body.id]);
    });

    it("returns the secret only through the confidential cell, never in the response", async () => {
      const res = await create({
        name: "github",
        cellLink: wireOf(inbox),
        confidentialCellLink: wireOf(config),
      });
      expect(JSON.stringify(await res.json())).not.toContain("whsec_");
    });

    it("returns 400 for a malformed confidential cell link, saving nothing", async () => {
      const res = await create({
        name: "github",
        cellLink: wireOf(inbox),
        confidentialCellLink: "not-a-cell-link",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Invalid confidentialCellLink format",
      });
      expect(await getServiceIndex(runtime, space)).toEqual([]);
    });

    it("creates the webhook when the space's index refuses the write, leaving it unlisted", async () => {
      const index = `of:${await sha256(`cf:webhooks-for:${space}`)}`;
      const refused = refuseCommits(
        runtime,
        { name: "AuthorizationError", message: "the space refused the write" },
        (written) => written.includes(index),
      );

      const res = await create({
        name: "github",
        cellLink: wireOf(inbox),
        confidentialCellLink: wireOf(config),
      });

      expect(res.status).toBe(200);
      const { id } = await res.json();
      expect(refused()).toBe(1);
      expect(await getRegistration(runtime, id)).toMatchObject({
        id,
        createdBy: space,
        enabled: true,
      });
      expect(await getServiceIndex(runtime, space)).toEqual([]);
    });
  });

  describe("ingest", () => {
    describe("with `serverExecution` false", () => {
      beforeEach(start);

      it("delivers a payload carrying the webhook's secret into the target stream", async () => {
        const { id, secret } = await createWebhook();
        const res = await deliver(
          id,
          secret,
          JSON.stringify({ data: "hello" }),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ received: true });
        await runtime.scheduler.idle();
        expect(await received.pull()).toEqual({ data: "hello" });
      });
    });

    describe("with `serverExecution` true", () => {
      // The delivery is acknowledged once a serving host has run the
      // stream's handler, so these stand up a memory server, a serving host
      // over it, and a pattern whose handler the host runs.

      let server: MemoryV2Server.Server;

      /** Runs `source` in `space`, returning its result cell. */
      const standUp = async (source: string, name: string) => {
        const compiled = await runtime.patternManager.compilePattern({
          main: "/main.tsx",
          files: [{ name: "/main.tsx", contents: source }],
        }, { space });
        const argument = runtime.getCell<{ value: number }>(
          space,
          `${name}-argument`,
        );
        const result = runtime.getCell<Record<string, unknown>>(
          space,
          `${name}-result`,
          compiled.resultSchema,
        );
        await argument.sync();
        await result.sync();
        const seed = runtime.edit();
        argument.withTx(seed).set({ value: 0 });
        expect((await seed.commit().settled).error).toBeUndefined();
        const tx = runtime.edit();
        runtime.run(tx, compiled, argument, result);
        expect((await tx.commit().settled).error).toBeUndefined();
        const cancel = result.sink(() => {});
        teardown.push(() => Promise.resolve(cancel()));
        await runtime.idle();
        await runtime.storageManager.synced();
        return { argument, result };
      };

      /** The value the server holds for `cell`'s document. */
      const stored = async (cell: Cell<unknown>) =>
        Engine.read(await server.engineForSpace(space), {
          id: cell.getAsNormalizedFullLink().id,
        })?.value;

      beforeEach(async () => {
        server = createAclServer(
          `webhooks-served-${crypto.randomUUID()}`,
          "off",
        );
        teardown.push(() => server.close());
        const storageManager = TestStorageManager.overServer(
          { as: identity },
          new LoopbackSessionFactory(server),
        );
        runtime = new Runtime({
          apiUrl: new URL("https://webhooks-handlers-test.invalid"),
          storageManager,
          experimental: { serverExecution: true },
        });
        teardown.push(() => storageManager.close(), () => runtime.dispose());
        config = runtime.getCell(space, "webhook-config");
        await config.sync();
      });

      /** Starts a serving host over the server. */
      const serve = () => {
        const host = new ExecutorHost({
          server,
          serviceIdentity: identity.did(),
          createRuntime: (servedSpace) => {
            const manager = LoopbackStorageManager.connect(server, {
              as: identity,
              servingHomeSpace: servedSpace,
            });
            const serving = new Runtime({
              apiUrl: new URL("https://webhooks-handlers-test.invalid"),
              storageManager: manager,
              servingPosture: true,
              experimental: { serverExecution: true },
            });
            return Promise.resolve({
              runtime: serving,
              dispose: async () => {
                await serving.dispose();
                await manager.close();
              },
            });
          },
          policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
          ensureSpaceRoots: false,
        });
        teardown.push(() => host.close());
      };

      it("acknowledges a delivery once the served handler has run it", async () => {
        const { argument, result } = await standUp(BUMP_PATTERN, "bump");
        inbox = result.key("bump");
        const { id, secret } = await createWebhook();
        serve();
        const res = await deliver(id, secret, JSON.stringify({ data: "x" }));
        expect(res.status).toBe(200);
        expect(await stored(argument)).toEqual({ value: 1 });
      });

      it("returns 502 for a delivery whose served handler fails", async () => {
        const { argument, result } = await standUp(THROW_PATTERN, "explode");
        inbox = result.key("explode");
        const { id, secret } = await createWebhook();
        serve();
        const res = await deliver(id, secret, JSON.stringify({ data: "x" }));
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "Failed to write payload" });
        expect(await stored(argument)).toEqual({ value: 0 });
      });
    });

    describe("refusals", () => {
      beforeEach(start);

      it("returns 401 for a wrong secret, delivering nothing", async () => {
        const { id } = await createWebhook();
        const res = await deliver(id, "whsec_wrong", '{"data":"x"}');
        expect(res.status).toBe(401);
        await runtime.scheduler.idle();
        expect(await received.pull()).toBe(null);
      });

      it("returns 401 for an unknown webhook", async () => {
        const res = await deliver("wh_unknown", "whsec_any", '{"data":"x"}');
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "Invalid request" });
      });

      it("returns 401 for a disabled webhook, even with its secret", async () => {
        const { id, secret } = await createWebhook();
        const registration = await getRegistration(runtime, id);
        await saveRegistration(runtime, { ...registration!, enabled: false });
        const res = await deliver(id, secret, '{"data":"x"}');
        expect(res.status).toBe(401);
        await runtime.scheduler.idle();
        expect(await received.pull()).toBe(null);
      });

      it("returns 400 for a body that is not JSON", async () => {
        const { id, secret } = await createWebhook();
        const res = await deliver(id, secret, "{not json");
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid JSON payload" });
      });

      it("returns 502 when the target cell link cannot be resolved", async () => {
        const secret = "whsec_test";
        const registration: WebhookRegistration = {
          id: "wh_broken",
          name: "broken",
          cellLink: "not-a-cell-link",
          secretHash: await sha256(secret),
          createdBy: space,
          createdAt: "2026-11-12T00:00:00.000Z",
          enabled: true,
        };
        await saveRegistration(runtime, registration);
        const res = await deliver("wh_broken", secret, '{"data":"x"}');
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "Failed to write payload" });
      });
    });
  });

  describe("list", () => {
    beforeEach(start);

    it("lists the space's webhooks without their secret hashes", async () => {
      const { id: first } = await createWebhook("first");
      const { id: second } = await createWebhook("second");
      const res = await app().request(`/api/webhooks?space=${space}`);
      expect(res.status).toBe(200);
      const { webhooks } = await res.json();
      expect(webhooks.map((w: { id: string }) => w.id).sort()).toEqual(
        [first, second].sort(),
      );
      expect(webhooks[0]).not.toHaveProperty("secretHash");
      expect(webhooks[0]).toMatchObject({ createdBy: space, enabled: true });
    });

    it("lists nothing for a space with no webhooks", async () => {
      await createWebhook();
      const res = await app().request(`/api/webhooks?space=${otherSpace}`);
      expect(await res.json()).toEqual({ webhooks: [] });
    });

    it("returns 400 for an empty space", async () => {
      const res = await app().request("/api/webhooks?space=");
      expect(res.status).toBe(400);
    });
  });

  describe("remove", () => {
    beforeEach(start);

    const remove = (id: string, owner: string) =>
      app().request(`/api/webhooks/${id}?space=${owner}`, {
        method: "DELETE",
      });

    it("deletes the registration and drops it from the index", async () => {
      const { id, secret } = await createWebhook();
      const { id: kept } = await createWebhook("kept");
      const res = await remove(id, space);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ deleted: true });
      expect(await getRegistration(runtime, id)).toBe(null);
      expect(await getServiceIndex(runtime, space)).toEqual([kept]);
      expect((await deliver(id, secret, '{"data":"x"}')).status).toBe(401);
    });

    it("returns 404 for an unknown webhook", async () => {
      const res = await remove("wh_unknown", space);
      expect(res.status).toBe(404);
    });

    it("returns 404 to a space other than the creator's, deleting nothing", async () => {
      const { id } = await createWebhook();
      const res = await remove(id, otherSpace);
      expect(res.status).toBe(404);
      expect(await getRegistration(runtime, id)).not.toBe(null);
    });

    it("deletes a registration whose cell link no longer parses", async () => {
      await saveRegistration(runtime, {
        id: "wh_corrupt",
        name: "corrupt",
        cellLink: "not-a-cell-link",
        secretHash: "0".repeat(64),
        createdBy: space,
        createdAt: "2026-11-12T00:00:00.000Z",
        enabled: true,
      });
      const res = await remove("wh_corrupt", space);
      expect(res.status).toBe(200);
      expect(await getRegistration(runtime, "wh_corrupt")).toBe(null);
    });

    it("returns 400 for an empty space", async () => {
      const res = await remove("wh_any", "");
      expect(res.status).toBe(400);
    });
  });

  describe("a space that refuses the toolshed's writes", () => {
    // A memory server enforcing ACLs, and a user space that grants the
    // toolshed nothing, so every write the toolshed makes there is refused
    // while its own service space stays writable.

    const secret = "whsec_refused";

    /** Starts a runtime over the enforcing server, with `serverExecution`. */
    const startRefusing = async (serverExecution: boolean) => {
      const server = createAclServer(
        `webhooks-refused-${crypto.randomUUID()}`,
        "enforce",
      );
      teardown.push(() => server.close());
      const factory = new LoopbackSessionFactory(server);
      await genesisAcl(factory, identity, { [identity.did()]: "OWNER" });
      await genesisAcl(factory, user, { [user.did()]: "OWNER" });
      const storageManager = TestStorageManager.overServer(
        { as: identity },
        factory,
      );
      runtime = new Runtime({
        apiUrl: new URL("https://webhooks-handlers-test.invalid"),
        storageManager,
        experimental: { serverExecution },
      });
      teardown.push(() => storageManager.close(), () => runtime.dispose());
      inbox = runtime.getCell(space, "webhook-inbox", STREAM_SCHEMA);
      config = runtime.getCell(space, "webhook-config");
      await saveRegistration(runtime, {
        id: "wh_refused",
        name: "refused",
        cellLink: wireOf(inbox),
        secretHash: await sha256(secret),
        createdBy: space,
        createdAt: "2026-11-12T00:00:00.000Z",
        enabled: true,
      });
    };

    it("returns 500 from create, saving no registration", async () => {
      await startRefusing(false);
      const res = await create({
        name: "github",
        cellLink: wireOf(inbox),
        confidentialCellLink: wireOf(config),
      });
      expect(res.status).toBe(500);
      expect(await getServiceIndex(runtime, space)).toEqual([]);
    });

    it("returns 502 from ingest with `serverExecution` true, whose acknowledgment waits on the append", async () => {
      await startRefusing(true);
      const res = await deliver("wh_refused", secret, '{"data":"x"}');
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "Failed to write payload" });
    });
  });

  describe("storage failure", () => {
    // Every handler reaches the runtime through `deps.runtime()`, so a
    // runtime that cannot be had fails each one at its first storage access.

    beforeEach(start);

    const broken = () =>
      createTestApp(createWebhooksRouter({
        runtime: () => {
          throw new Error("storage unavailable");
        },
      }));

    it("returns 500 from create", async () => {
      const res = await broken().request("/api/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "github",
          cellLink: wireOf(inbox),
          confidentialCellLink: wireOf(config),
        }),
      });
      expect(res.status).toBe(500);
    });

    it("returns 502 from ingest rather than 401", async () => {
      const res = await broken().request("/api/webhooks/wh_any", {
        method: "POST",
        headers: { Authorization: "Bearer whsec_any" },
        body: "{}",
      });
      expect(res.status).toBe(502);
    });

    it("returns 500 from list", async () => {
      const res = await broken().request(`/api/webhooks?space=${space}`);
      expect(res.status).toBe(500);
    });

    it("returns 500 from remove", async () => {
      const res = await broken().request(
        `/api/webhooks/wh_any?space=${space}`,
        {
          method: "DELETE",
        },
      );
      expect(res.status).toBe(500);
    });
  });

  describe("router", () => {
    beforeEach(start);

    it("returns 413 for a body over 1 MB", async () => {
      const res = await deliver("wh_any", "whsec_any", "x".repeat(1_100_000));
      expect(res.status).toBe(413);
    });

    it("returns 413 for a create body over 1 MB, saving nothing", async () => {
      const res = await create({
        name: "x".repeat(1_100_000),
        cellLink: wireOf(inbox),
        confidentialCellLink: wireOf(config),
      });

      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({
        error: "Payload too large (max 1MB)",
      });
      const listed = await app().request(`/api/webhooks?space=${space}`);
      expect(await listed.json()).toEqual({ webhooks: [] });
    });

    it("returns the CORS origin header to a cross-origin create", async () => {
      const res = await app().request("/api/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.example.com",
        },
        body: JSON.stringify({
          name: "github",
          cellLink: wireOf(inbox),
          confidentialCellLink: wireOf(config),
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
