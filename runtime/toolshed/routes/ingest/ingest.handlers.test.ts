import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTestApp } from "@/lib/create-app.ts";
import { createIngestRouter } from "./ingest.handlers.ts";
import {
  generateIngestSecret,
  type IngestRegistration,
  journalCell,
  saveRegistration,
} from "./ingest.utils.ts";

const signer = await Identity.fromPassphrase("ingest handlers test");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase("ingest handlers other"))
  .did();

describe("ingest.handlers", () => {
  // The auth and validation contract is `processIngest`'s, tested in
  // ingest.utils.test.ts. These pin what the handlers add: where the token
  // and the addressed space come from, and how the result reaches the wire.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let registration: IngestRegistration;
  let secret: string;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://ingest-handlers-test.invalid"),
      storageManager,
    });
    const minted = generateIngestSecret();
    secret = minted.secret;
    registration = {
      id: "ing_handlers",
      name: "handlers",
      space,
      causePrefix: "location",
      installId: "install-1",
      kind: "device",
      secretHash: minted.secretHash,
      createdBy: space,
      createdAt: "2026-11-12T00:00:00.000Z",
      enabled: true,
    };
    await saveRegistration(runtime, space, registration);
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const app = () =>
    createTestApp(
      createIngestRouter({ runtime: () => runtime, serviceSpace: space }),
    );

  const post = (path: string, token: string | undefined) =>
    app().request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        partition: "2026-11-12",
        records: [{ point_id: "a" }],
      }),
    });

  /** The records the channel's journal holds for the test's partition. */
  const journal = async () => {
    const cell = journalCell(runtime, registration, "2026-11-12");
    await cell.sync();
    return cell.get();
  };

  describe("addressed through the channel's space", () => {
    it("appends the records and returns the counts", async () => {
      const res = await post(
        `/api/spaces/${space}/ingest/ing_handlers`,
        secret,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: 1, appended: 1 });
      expect(await journal()).toEqual([{ point_id: "a" }]);
    });

    it("returns 401 for a space other than the channel's, writing nothing", async () => {
      const res = await post(
        `/api/spaces/${otherSpace}/ingest/ing_handlers`,
        secret,
      );
      expect(res.status).toBe(401);
      expect(await journal()).toBeUndefined();
    });

    it("returns 401 for a request without a bearer token", async () => {
      const res = await post(
        `/api/spaces/${space}/ingest/ing_handlers`,
        undefined,
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid request" });
    });
  });

  describe("addressed by channel id alone", () => {
    it("appends the records and returns the counts", async () => {
      const res = await post("/api/ingest/ing_handlers", secret);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ received: 1, appended: 1 });
      expect(await journal()).toEqual([{ point_id: "a" }]);
    });

    it("returns the refusal `processIngest` makes for a wrong token", async () => {
      const res = await post("/api/ingest/ing_handlers", "ingsec_wrong");
      expect(res.status).toBe(401);
      expect(await journal()).toBeUndefined();
    });

    it("returns 401 for a request without a bearer token", async () => {
      const res = await post("/api/ingest/ing_handlers", undefined);
      expect(res.status).toBe(401);
    });
  });
});
