import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from "@panva/jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  fetchGmailMailbox,
  getMailboxChannels,
  type GmailPushDeps,
  isPlausibleAddress,
  MailboxBindingFullError,
  mailboxKey,
  mailboxListUpdate,
  MAX_CHANNELS_PER_MAILBOX,
  processGmailPush,
  verifyGmailIdToken,
} from "./gmail-push.utils.ts";
import {
  channelId,
  getLastSeen,
  getRegistration,
  type IngestRegistration,
  latestCell,
  saveRegistration,
} from "@/routes/ingest/ingest.utils.ts";

const AUDIENCE = "https://toolshed.test/gmail-push";
const PUSH_ACCOUNT = "gmail-push@loom-internal.iam.gserviceaccount.com";
const MAILBOX = "alice@example.com";
const PUBLISH_TIME = "2026-09-30T12:34:56.789Z";
const NOW = Date.parse("2026-10-01T08:00:00.000Z");

describe("gmail-push.utils", () => {
  let signingKey: CryptoKey;
  let strangerKey: CryptoKey;
  let keys: JWTVerifyGetKey;

  let signer: Identity;
  let space: ReturnType<Identity["did"]>;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let deps: GmailPushDeps;

  beforeAll(async () => {
    const google = await generateKeyPair("RS256");
    const stranger = await generateKeyPair("RS256");
    signingKey = google.privateKey;
    strangerKey = stranger.privateKey;
    const jwk = await exportJWK(google.publicKey);
    keys = createLocalJWKSet({
      keys: [{ ...jwk, kid: "google-1", alg: "RS256", use: "sig" }],
    });
  });

  beforeEach(async () => {
    signer = await Identity.fromPassphrase("gmail-push-test");
    space = signer.did();
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://gmail-push-test.invalid"),
      storageManager,
    });
    deps = {
      runtime,
      serviceSpace: space,
      keys,
      audience: AUDIENCE,
      serviceAccounts: [PUSH_ACCOUNT],
    };
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Signs a push token the way a Pub/Sub push subscription does. */
  const pushToken = (
    over: {
      claims?: Record<string, unknown>;
      audience?: string;
      issuer?: string;
      expiresAt?: number;
      key?: CryptoKey;
    } = {},
  ): Promise<string> =>
    new SignJWT({
      email: PUSH_ACCOUNT,
      email_verified: true,
      ...over.claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "google-1" })
      .setIssuer(over.issuer ?? "https://accounts.google.com")
      .setAudience(over.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(over.expiresAt ?? "1h")
      .sign(over.key ?? signingKey);

  const bearer = async (over?: Parameters<typeof pushToken>[0]) =>
    `Bearer ${await pushToken(over)}`;

  /** Wraps a Gmail notification in a Pub/Sub push envelope. */
  const envelope = (
    notification: unknown,
    message: Record<string, unknown> = {},
  ): string =>
    JSON.stringify({
      message: {
        data: btoa(JSON.stringify(notification)),
        messageId: "m-1",
        publishTime: PUBLISH_TIME,
        ...message,
      },
      subscription: "projects/loom-internal/subscriptions/gmail-push",
    });

  const notification = (over: Record<string, unknown> = {}) => ({
    emailAddress: MAILBOX,
    historyId: 4242,
    ...over,
  });

  /** Saves a live gmail channel writing its own cell, and returns it. */
  const channel = async (
    installId: string,
    over: Partial<IngestRegistration> = {},
  ): Promise<IngestRegistration> => {
    const registration: IngestRegistration = {
      id: channelId(space, installId),
      name: installId,
      space,
      target: {
        space,
        id: runtime.getCell(space, `gmail-push-${installId}`)
          .getAsNormalizedFullLink().id,
        path: [],
      },
      installId,
      kind: "gmail",
      secretHash: "unused",
      createdBy: space,
      createdAt: "2026-09-01T00:00:00.000Z",
      enabled: true,
      ...over,
    };
    await saveRegistration(runtime, space, registration);
    return registration;
  };

  /**
   * Binds `registration` to the mailbox at `address` the way a mint does:
   * the registration gains the mailbox's key, and the channel joins the
   * mailbox's list, in one write. Returns the registration as stored.
   */
  const bind = async (
    registration: IngestRegistration,
    address: string,
  ): Promise<IngestRegistration> => {
    const key = mailboxKey(address);
    const bound = { ...registration, mailboxKey: key };
    await saveRegistration(
      runtime,
      space,
      bound,
      undefined,
      undefined,
      undefined,
      mailboxListUpdate(runtime, space, registration.id, {
        next: key,
        previous: registration.mailboxKey,
      }, NOW),
    );
    return bound;
  };

  /** What a channel's cell holds. */
  const latest = async (
    registration: IngestRegistration,
  ): Promise<unknown> => {
    const cell = latestCell(runtime, registration);
    await cell.sync();
    await runtime.storageManager.synced();
    return cell.get();
  };

  const push = async (rawBody: string, authorization?: string) =>
    processGmailPush(
      deps,
      authorization ?? await bearer(),
      rawBody,
      NOW,
    );

  describe("processGmailPush()", () => {
    describe("push token", () => {
      it("returns 401 when there is no `Authorization` header", async () => {
        const result = await processGmailPush(
          deps,
          undefined,
          envelope(notification()),
          NOW,
        );
        expect(result.status).toBe(401);
      });

      it("returns 401 for a token signed by a key Google does not publish", async () => {
        const result = await push(
          envelope(notification()),
          await bearer({ key: strangerKey }),
        );
        expect(result.status).toBe(401);
      });

      it("returns 401 for a token minted for another audience", async () => {
        const result = await push(
          envelope(notification()),
          await bearer({ audience: "https://elsewhere.test/push" }),
        );
        expect(result.status).toBe(401);
      });

      it("returns 401 for a token from an issuer other than Google", async () => {
        const result = await push(
          envelope(notification()),
          await bearer({ issuer: "https://issuer.test" }),
        );
        expect(result.status).toBe(401);
      });

      it("returns 401 for a token signed for a service account not accepted", async () => {
        const result = await push(
          envelope(notification()),
          await bearer({
            claims: { email: "other@project.iam.gserviceaccount.com" },
          }),
        );
        expect(result.status).toBe(401);
      });

      it("returns 401 for a token whose email is not verified", async () => {
        const result = await push(
          envelope(notification()),
          await bearer({ claims: { email_verified: false } }),
        );
        expect(result.status).toBe(401);
      });

      it("returns 401 for an expired token", async () => {
        const result = await push(
          envelope(notification()),
          await bearer({ expiresAt: Math.floor(Date.now() / 1000) - 600 }),
        );
        expect(result.status).toBe(401);
      });

      describe("when Google's keys cannot be read", () => {
        const failingWith = async (error: Error) =>
          processGmailPush(
            {
              ...deps,
              keys: () => {
                throw error;
              },
            },
            await bearer(),
            envelope(notification()),
            NOW,
          );

        it("returns 502 when the request fails", async () => {
          const result = await failingWith(
            new TypeError("network unreachable"),
          );
          expect(result.status).toBe(502);
        });

        it("returns 502 when the request times out", async () => {
          expect((await failingWith(new errors.JWKSTimeout())).status).toBe(
            502,
          );
        });

        it("returns 502 when the endpoint answers with an error", async () => {
          const result = await failingWith(
            new errors.JOSEError(
              "Expected 200 OK from the JSON Web Key Set HTTP response",
            ),
          );
          expect(result.status).toBe(502);
        });

        it("returns 401 when no published key matches the token", async () => {
          const result = await failingWith(new errors.JWKSNoMatchingKey());
          expect(result.status).toBe(401);
        });
      });
    });

    describe("decoding", () => {
      it("acknowledges a body that is not JSON, delivering nothing", async () => {
        await bind(await channel("a"), MAILBOX);
        expect(await push("not json")).toEqual({
          status: 200,
          body: { delivered: 0 },
        });
      });

      it("acknowledges a message whose data is not base64 JSON", async () => {
        await bind(await channel("a"), MAILBOX);
        const body = JSON.stringify({
          message: { data: "!!!", messageId: "m-1", publishTime: PUBLISH_TIME },
        });
        expect(await push(body)).toEqual({
          status: 200,
          body: { delivered: 0 },
        });
      });

      it("acknowledges a notification whose history id is not an integer", async () => {
        await bind(await channel("a"), MAILBOX);
        const result = await push(
          envelope(notification({ historyId: "12ab" })),
        );
        expect(result).toEqual({ status: 200, body: { delivered: 0 } });
      });

      it("acknowledges a notification without an email address", async () => {
        await bind(await channel("a"), MAILBOX);
        const result = await push(
          envelope(notification({ emailAddress: "no-at-sign" })),
        );
        expect(result).toEqual({ status: 200, body: { delivered: 0 } });
      });
    });

    describe("delivery", () => {
      it("acknowledges a notification for a mailbox nobody has bound", async () => {
        expect(await push(envelope(notification()))).toEqual({
          status: 200,
          body: { delivered: 0 },
        });
      });

      it("writes the notification to the bound channel's cell", async () => {
        const a = await bind(await channel("a"), MAILBOX);

        const result = await push(envelope(notification()));

        expect(result).toEqual({ status: 200, body: { delivered: 1 } });
        expect(await latest(a)).toEqual({
          type: "gmail.push",
          emailAddress: MAILBOX,
          historyId: "4242",
          publishTime: PUBLISH_TIME,
        });
      });

      it("records a history id given as a decimal string unchanged", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        const big = "18446744073709551615";

        await push(envelope(notification({ historyId: big })));

        expect(await latest(a)).toMatchObject({ historyId: big });
      });

      it("replaces the record when a newer history id arrives", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        await push(envelope(notification({ historyId: 4242 })));

        await push(envelope(notification({ historyId: 5000 })));

        expect(await latest(a)).toMatchObject({ historyId: "5000" });
      });

      it("keeps the record when an older history id arrives after it", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        await push(envelope(notification({ historyId: 4242 })));

        const result = await push(envelope(notification({ historyId: 4000 })));

        expect(result).toEqual({ status: 200, body: { delivered: 1 } });
        expect(await latest(a)).toMatchObject({ historyId: "4242" });
      });

      it("compares history ids as integers, not as strings", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        await push(envelope(notification({ historyId: "900" })));

        await push(envelope(notification({ historyId: "1000" })));

        expect(await latest(a)).toMatchObject({ historyId: "1000" });
      });

      it("takes the new mailbox's first notification after a rebind, whatever its history id", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        await push(envelope(notification({ historyId: 9000 })));
        await bind(a, "bob@example.com");

        const result = await push(envelope(
          notification({ emailAddress: "bob@example.com", historyId: 100 }),
        ));

        expect(result).toEqual({ status: 200, body: { delivered: 1 } });
        expect(await latest(a)).toMatchObject({
          emailAddress: "bob@example.com",
          historyId: "100",
        });
      });

      it("leaves the cell as it is when the same history id is delivered again", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        await push(envelope(notification(), { publishTime: PUBLISH_TIME }));

        await push(
          envelope(notification(), { publishTime: "2026-09-30T12:35:00.000Z" }),
        );

        expect(await latest(a)).toMatchObject({ publishTime: PUBLISH_TIME });
      });

      it("matches the mailbox regardless of case", async () => {
        await bind(await channel("a"), "Alice@Example.com");

        const result = await push(envelope(notification()));

        expect(result).toEqual({ status: 200, body: { delivered: 1 } });
      });

      it("delivers to every live channel bound to the mailbox", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        const b = await bind(await channel("b"), MAILBOX);

        const result = await push(envelope(notification()));

        expect(result).toEqual({ status: 200, body: { delivered: 2 } });
        expect(await latest(a)).toMatchObject({ historyId: "4242" });
        expect(await latest(b)).toMatchObject({ historyId: "4242" });
      });

      it("skips a bound device channel", async () => {
        await bind(
          await channel("j", {
            kind: "device",
            causePrefix: "gmail-push-j",
            target: undefined,
          }),
          MAILBOX,
        );

        expect(await push(envelope(notification()))).toEqual({
          status: 200,
          body: { delivered: 0 },
        });
      });

      it("skips a bound channel that has since been revoked", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        await saveRegistration(runtime, space, {
          ...a,
          enabled: false,
          revoked: { at: "2026-09-20T00:00:00.000Z", by: space },
        });

        const result = await push(envelope(notification()));

        expect(result).toEqual({ status: 200, body: { delivered: 0 } });
        expect(await latest(a)).toBeUndefined();
      });

      it("skips a bound channel that has expired", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        await saveRegistration(runtime, space, {
          ...a,
          expiresAt: "2026-09-30T00:00:00.000Z",
        });

        const result = await push(envelope(notification()));

        expect(result).toEqual({ status: 200, body: { delivered: 0 } });
      });

      it("stamps the channel's last-seen time", async () => {
        const a = await bind(await channel("a"), MAILBOX);
        expect(await getLastSeen(runtime, space, a.id)).toBeNull();

        await push(envelope(notification()));

        expect(await getLastSeen(runtime, space, a.id)).not.toBeNull();
      });
    });
  });

  describe("mailboxListUpdate()", () => {
    it("moves a rebound channel off the mailbox it was bound to", async () => {
      const a = await bind(await channel("a"), MAILBOX);

      await bind(a, "bob@example.com");

      expect(await getMailboxChannels(runtime, space, MAILBOX)).toEqual([]);
      expect(await getMailboxChannels(runtime, space, "bob@example.com"))
        .toEqual([a.id]);
      expect((await getRegistration(runtime, space, a.id))?.mailboxKey)
        .toBe(mailboxKey("bob@example.com"));
    });

    it("lists a channel bound twice to one mailbox once", async () => {
      const a = await bind(await channel("a"), MAILBOX);
      await bind(a, MAILBOX);

      expect(await getMailboxChannels(runtime, space, MAILBOX)).toEqual([a.id]);
    });

    it("throws `MailboxBindingFullError` past the per-mailbox limit, writing nothing", async () => {
      for (let i = 0; i < MAX_CHANNELS_PER_MAILBOX; i++) {
        await bind(await channel(`c${i}`), MAILBOX);
      }
      const extra = await channel("extra");

      await expect(bind(extra, MAILBOX)).rejects
        .toBeInstanceOf(MailboxBindingFullError);
      expect((await getRegistration(runtime, space, extra.id))?.mailboxKey)
        .toBeUndefined();
      expect(await getMailboxChannels(runtime, space, MAILBOX)).not
        .toContain(extra.id);
    });

    it("takes a channel out of its mailbox's list when given no next mailbox", async () => {
      const a = await bind(await channel("a"), MAILBOX);
      const b = await bind(await channel("b"), MAILBOX);

      await saveRegistration(
        runtime,
        space,
        { ...a, enabled: false },
        undefined,
        undefined,
        undefined,
        mailboxListUpdate(runtime, space, a.id, { previous: a.mailboxKey }),
      );

      expect(await getMailboxChannels(runtime, space, MAILBOX)).toEqual([b.id]);
    });

    it("frees the place of a retired channel for a new one", async () => {
      const bound: IngestRegistration[] = [];
      for (let i = 0; i < MAX_CHANNELS_PER_MAILBOX; i++) {
        bound.push(await bind(await channel(`c${i}`), MAILBOX));
      }
      // Retired without leaving the list, as an expiry or an operator
      // retirement leaves a channel.
      await saveRegistration(runtime, space, { ...bound[0], enabled: false });
      const extra = await channel("extra");

      await bind(extra, MAILBOX);

      const ids = await getMailboxChannels(runtime, space, MAILBOX);
      expect(ids).toContain(extra.id);
      expect(ids).not.toContain(bound[0].id);
    });
  });

  describe("verifyGmailIdToken()", () => {
    const CLIENT_ID = "123.apps.googleusercontent.com";
    // A Gmail address, which Google is the authority on without an `hd` claim.
    const GMAIL_MAILBOX = "alice@gmail.com";
    const idToken = (
      over: { claims?: Record<string, unknown>; audience?: string } = {},
    ): Promise<string> =>
      new SignJWT({
        email: GMAIL_MAILBOX,
        email_verified: true,
        ...over.claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "google-1" })
        .setIssuer("https://accounts.google.com")
        .setAudience(over.audience ?? CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(signingKey);
    const verify = (token: string, clientIds = [CLIENT_ID]) =>
      verifyGmailIdToken(keys, clientIds, token);

    it("returns the mailbox a token Google signed for an accepted client names", async () => {
      expect(await verify(await idToken())).toEqual({
        ok: true,
        emailAddress: GMAIL_MAILBOX,
      });
    });

    it("returns `rejected` for a token minted for another client", async () => {
      expect(await verify(await idToken({ audience: "other-client" })))
        .toEqual({ ok: false, reason: "rejected" });
    });

    it("returns the mailbox for a Workspace address whose domain the `hd` claim vouches for", async () => {
      expect(
        await verify(
          await idToken({
            claims: { email: "alice@example.com", hd: "example.com" },
          }),
        ),
      ).toEqual({ ok: true, emailAddress: "alice@example.com" });
    });

    it("returns `rejected` for a verified address outside Gmail that no `hd` claim vouches for", async () => {
      expect(
        await verify(
          await idToken({
            claims: { email: "alice@example.com" },
          }),
        ),
      ).toEqual({ ok: false, reason: "rejected" });
      expect(
        await verify(
          await idToken({
            claims: { email: "alice@example.com", hd: "other.example" },
          }),
        ),
      ).toEqual({ ok: false, reason: "rejected" });
    });

    it("returns `rejected` for a token whose address is not verified", async () => {
      expect(await verify(await idToken({ claims: { email_verified: false } })))
        .toEqual({ ok: false, reason: "rejected" });
    });

    it("returns `rejected` for a token that is not a token at all", async () => {
      expect(await verify("not-a-jwt")).toEqual({
        ok: false,
        reason: "rejected",
      });
    });

    it("returns `unsupported` when no client id is configured", async () => {
      expect(await verify(await idToken(), [])).toEqual({
        ok: false,
        reason: "unsupported",
      });
    });
  });

  describe("mailboxKey()", () => {
    it("returns the same key regardless of case and surrounding whitespace", () => {
      expect(mailboxKey(" Alice@Example.COM ")).toBe(mailboxKey(MAILBOX));
    });

    it("returns different keys for different addresses", () => {
      expect(mailboxKey("bob@example.com")).not.toBe(mailboxKey(MAILBOX));
    });

    it("returns a key that does not contain the address", () => {
      expect(mailboxKey(MAILBOX)).not.toContain("alice");
    });
  });

  describe("isPlausibleAddress()", () => {
    it("returns `true` for an address with a local part and a domain", () => {
      expect(isPlausibleAddress(MAILBOX)).toBe(true);
    });

    it("returns `false` without an `@` between two nonempty parts", () => {
      expect(isPlausibleAddress("alice")).toBe(false);
      expect(isPlausibleAddress("@example.com")).toBe(false);
      expect(isPlausibleAddress("alice@")).toBe(false);
    });

    it("returns `false` for an address longer than 320 characters", () => {
      expect(isPlausibleAddress(`${"a".repeat(320)}@example.com`)).toBe(false);
    });
  });

  describe("fetchGmailMailbox()", () => {
    const originalFetch = globalThis.fetch;
    let requested: Request | undefined;

    const respond = (response: () => Response) => {
      globalThis.fetch = (input, init) => {
        requested = new Request(input, init);
        return Promise.resolve(response());
      };
    };

    afterEach(() => {
      globalThis.fetch = originalFetch;
      requested = undefined;
    });

    it("returns the mailbox Gmail names for the token", async () => {
      respond(() => Response.json({ emailAddress: MAILBOX, historyId: "1" }));

      expect(await fetchGmailMailbox("token-1")).toEqual({
        ok: true,
        emailAddress: MAILBOX,
      });
      expect(requested?.headers.get("Authorization")).toBe("Bearer token-1");
    });

    it("returns `rejected` when Gmail refuses the token", async () => {
      respond(() => new Response("{}", { status: 401 }));
      expect(await fetchGmailMailbox("bad")).toEqual({
        ok: false,
        reason: "rejected",
      });
    });

    it("returns `unavailable` when Gmail fails", async () => {
      respond(() => new Response("{}", { status: 503 }));
      expect(await fetchGmailMailbox("token-1")).toEqual({
        ok: false,
        reason: "unavailable",
      });
    });

    it("returns `unavailable` when the request itself fails", async () => {
      globalThis.fetch = () => Promise.reject(new TypeError("offline"));
      expect(await fetchGmailMailbox("token-1")).toEqual({
        ok: false,
        reason: "unavailable",
      });
    });

    it("returns `unavailable` when the profile names no address", async () => {
      respond(() => Response.json({ historyId: "1" }));
      expect(await fetchGmailMailbox("token-1")).toEqual({
        ok: false,
        reason: "unavailable",
      });
    });
  });
});
