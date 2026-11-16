import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from "@panva/jose";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createTestApp } from "@/lib/create-app.ts";
import {
  channelId,
  type IngestRegistration,
  latestCell,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";
import { mailboxKey, mailboxListUpdate } from "./gmail-push.utils.ts";
import { createIngestPushRouter } from "./ingest-push.handlers.ts";
import { BASE } from "./ingest-push.routes.ts";

const AUDIENCE = "https://toolshed.test/gmail-push";
const PUSH_ACCOUNT = "gmail-push@toolshed-test.iam.gserviceaccount.com";
const MAILBOX = "alice@example.com";

const signer = await Identity.fromPassphrase("ingest-push handlers test");
const space = signer.did();
const otherSpace = (await Identity.fromPassphrase("ingest-push other")).did();

const google = await generateKeyPair("RS256");
const keys: JWTVerifyGetKey = createLocalJWKSet({
  keys: [{
    ...await exportJWK(google.publicKey),
    kid: "google-1",
    alg: "RS256",
    use: "sig",
  }],
});

/** A push token as a Pub/Sub push subscription signs one. */
const pushToken = (): Promise<string> =>
  new SignJWT({ email: PUSH_ACCOUNT, email_verified: true })
    .setProtectedHeader({ alg: "RS256", kid: "google-1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(google.privateKey);

const envelope = JSON.stringify({
  message: {
    data: btoa(JSON.stringify({ emailAddress: MAILBOX, historyId: 4242 })),
    messageId: "m-1",
    publishTime: "2026-11-12T00:00:00.000Z",
  },
  subscription: "projects/toolshed-test/subscriptions/gmail-push",
});

describe("ingest-push.handlers", () => {
  // The verification and delivery rules are `processGmailPush`'s, tested in
  // gmail-push.utils.test.ts. These pin what the handler adds: the registry
  // check on the path and how the result reaches the wire.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://ingest-push-handlers-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const push = async (to: string, enabled = true) =>
    await createTestApp(createIngestPushRouter({
      runtime: () => runtime,
      serviceSpace: space,
      keys,
      audience: AUDIENCE,
      serviceAccounts: [PUSH_ACCOUNT],
      enabled,
    })).request(`${BASE.replace(":space", to)}/gmail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await pushToken()}` },
      body: envelope,
    });

  /** Saves a live gmail channel bound to `MAILBOX`, and returns it. */
  const boundChannel = async (): Promise<IngestRegistration> => {
    const registration: IngestRegistration = {
      id: channelId(space, "inbox"),
      name: "inbox",
      space,
      target: {
        space,
        id: runtime.getCell(space, "gmail-push-inbox").getAsNormalizedFullLink()
          .id,
        path: [],
      },
      installId: "inbox",
      kind: "gmail",
      createdBy: space,
      createdAt: "2026-11-01T00:00:00.000Z",
      enabled: true,
      mailboxKey: mailboxKey(MAILBOX),
    };
    await saveRegistration(
      runtime,
      space,
      registration,
      undefined,
      undefined,
      undefined,
      mailboxListUpdate(runtime, space, registration.id, {
        next: mailboxKey(MAILBOX),
        previous: undefined,
      }, Date.now()),
    );
    return registration;
  };

  it("delivers a notification to the mailbox's channel and returns the count", async () => {
    const registration = await boundChannel();
    const res = await push(space);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ delivered: 1 });
    const cell = latestCell(runtime, registration);
    await cell.sync();
    expect(cell.get()).toMatchObject({
      type: "gmail.push",
      emailAddress: MAILBOX,
      historyId: "4242",
    });
  });

  it("returns 404 for a push addressed to another registry, delivering nothing", async () => {
    const registration = await boundChannel();
    const res = await push(otherSpace);
    expect(res.status).toBe(404);
    const cell = latestCell(runtime, registration);
    await cell.sync();
    expect(cell.get()).toBeUndefined();
  });

  it("returns 404 for every push where Gmail push is off", async () => {
    const res = await push(space, false);
    expect(res.status).toBe(404);
  });
});
