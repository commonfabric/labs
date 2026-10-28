import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  accountIdFor,
  displayNameFor,
  ensurePersonFolder,
  ensureServiceAccount,
  isAccountNotVisible,
  isGitHubUsername,
  mintKey,
  parseMintArgs,
  runMint,
  usernameOfDisplayName,
} from "./test-records-mint.ts";
import { generateIdentity, open } from "./test-records-crypto.ts";
import { parsePersonalKeyFile } from "./test-records-config.ts";

function sequenceFetch(
  responses: { status: number; json?: unknown }[],
  log: { method: string; url: string; body?: string }[],
): typeof fetch {
  let index = 0;
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    const entry: { method: string; url: string; body?: string } = {
      method: init?.method ?? "GET",
      url: String(input),
    };
    if (typeof init?.body === "string") entry.body = init.body;
    log.push(entry);
    const response = responses[index++] ?? { status: 500 };
    return Promise.resolve(
      new Response(JSON.stringify(response.json ?? {}), {
        status: response.status,
      }),
    );
  }) as typeof fetch;
}

describe("test-records-mint", () => {
  describe("isGitHubUsername()", () => {
    it("returns true for ordinary logins", () => {
      expect(isGitHubUsername("octocat")).toBe(true);
      expect(isGitHubUsername("a")).toBe(true);
      expect(isGitHubUsername("hyphen-ated-9")).toBe(true);
    });

    it("returns false for malformed logins", () => {
      expect(isGitHubUsername("")).toBe(false);
      expect(isGitHubUsername("-leading")).toBe(false);
      expect(isGitHubUsername("trailing-")).toBe(false);
      expect(isGitHubUsername("dou--ble")).toBe(false);
      expect(isGitHubUsername("a".repeat(40))).toBe(false);
      expect(isGitHubUsername("has space")).toBe(false);
    });
  });

  describe("accountIdFor()", () => {
    it("returns the plain lowercased id when it fits", async () => {
      expect(await accountIdFor("Octocat")).toBe("test-records-gh-octocat");
    });

    it("returns a digest-suffixed id for long usernames", async () => {
      const id = await accountIdFor("a-very-long-github-username-indeed");
      expect(id.length).toBeLessThanOrEqual(30);
      expect(id.startsWith("test-records-gh-")).toBe(true);
      expect(id).toMatch(/-[0-9a-f]{6}$/);
    });

    it("returns distinct ids for long usernames sharing a prefix", async () => {
      const a = await accountIdFor("a-very-long-github-username-one");
      const b = await accountIdFor("a-very-long-github-username-two");
      expect(a).not.toBe(b);
    });

    it("returns the same id for the same username", async () => {
      expect(await accountIdFor("a-very-long-github-username-one"))
        .toBe(await accountIdFor("a-very-long-github-username-one"));
    });
  });

  describe("usernameOfDisplayName()", () => {
    it("round-trips through displayNameFor()", () => {
      expect(usernameOfDisplayName(displayNameFor("Octocat"))).toBe("Octocat");
    });

    it("returns undefined for other display names", () => {
      expect(usernameOfDisplayName("Dashboard reader")).toBeUndefined();
    });
  });

  describe("ensureServiceAccount()", () => {
    it("creates the account when it does not exist", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      const email = await ensureServiceAccount({
        token: "t",
        fetchImpl: sequenceFetch(
          [{ status: 404 }, { status: 200, json: {} }],
          log,
        ),
      }, "octocat");
      expect(email).toBe(
        "test-records-gh-octocat@commontools-core.iam.gserviceaccount.com",
      );
      expect(log.length).toBe(2);
      expect(log[1]?.method).toBe("POST");
      expect(log[1]?.body).toContain('"accountId":"test-records-gh-octocat"');
      expect(log[1]?.body).toContain("Test records key holder: octocat");
    });

    it("re-enables a disabled account", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      await ensureServiceAccount({
        token: "t",
        fetchImpl: sequenceFetch(
          [{ status: 200, json: { disabled: true } }, {
            status: 200,
            json: {},
          }],
          log,
        ),
      }, "octocat");
      expect(log[1]?.url).toContain(":enable");
    });

    it("leaves an enabled account untouched", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      await ensureServiceAccount({
        token: "t",
        fetchImpl: sequenceFetch([{ status: 200, json: {} }], log),
      }, "octocat");
      expect(log.length).toBe(1);
    });
  });

  describe("ensurePersonFolder()", () => {
    it("creates the folder and adds the create-only grant", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      await ensurePersonFolder(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200, json: {} },
            { status: 200, json: { bindings: [], etag: "e1" } },
            { status: 200, json: {} },
          ], log),
        },
        "cf-ci-metadata",
        "labs/test-records",
        "octocat",
        "sa@example.iam.gserviceaccount.com",
      );
      expect(log[0]?.body).toContain(
        '"name":"labs/test-records/submissions/local/octocat/"',
      );
      expect(log[2]?.method).toBe("PUT");
      expect(log[2]?.body).toContain("roles/storage.objectCreator");
      expect(log[2]?.body).toContain(
        "serviceAccount:sa@example.iam.gserviceaccount.com",
      );
    });

    it("treats an existing folder and grant as done", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      await ensurePersonFolder(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 409 },
            {
              status: 200,
              json: {
                bindings: [{
                  role: "roles/storage.objectCreator",
                  members: ["serviceAccount:sa@x"],
                }],
                etag: "e1",
              },
            },
          ], log),
        },
        "cf-ci-metadata",
        "labs/test-records",
        "octocat",
        "sa@x",
      );
      expect(log.length).toBe(2);
    });

    it("grants once the account has reached Cloud Storage", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      let waits = 0;
      await ensurePersonFolder(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200, json: {} },
            { status: 200, json: { bindings: [], etag: "e1" } },
            {
              status: 400,
              json: {
                error: {
                  code: 400,
                  message: "Service account sa@x does not exist.",
                },
              },
            },
            { status: 200, json: {} },
          ], log),
          awaitVisibility: () => {
            waits++;
            return Promise.resolve();
          },
        },
        "cf-ci-metadata",
        "labs/test-records",
        "octocat",
        "sa@x",
      );
      expect(waits).toBe(1);
      expect(log.length).toBe(4);
      expect(log[3]?.method).toBe("PUT");
    });

    it("throws for a grant refused on any other ground", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      await expect(ensurePersonFolder(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200, json: {} },
            { status: 200, json: { bindings: [], etag: "e1" } },
            { status: 403, json: { error: { message: "forbidden" } } },
          ], log),
          awaitVisibility: () => {
            throw new Error("no wait expected");
          },
        },
        "cf-ci-metadata",
        "labs/test-records",
        "octocat",
        "sa@x",
      )).rejects.toThrow("granting roles/storage.objectCreator");
    });
  });

  describe("isAccountNotVisible()", () => {
    it("returns true for a create the service has not seen yet", () => {
      expect(isAccountNotVisible(
        400,
        { error: { message: "Service account sa@x does not exist." } },
        "sa@x",
      )).toBe(true);
      expect(isAccountNotVisible(404, "sa@x does not exist", "sa@x"))
        .toBe(true);
    });

    it("returns false for any other refusal", () => {
      expect(isAccountNotVisible(403, { error: { message: "no" } }, "sa@x"))
        .toBe(false);
      expect(isAccountNotVisible(
        400,
        { error: { message: "Service account other@x does not exist." } },
        "sa@x",
      )).toBe(false);
      expect(isAccountNotVisible(
        400,
        { error: { message: "Role roles/storage.objectCreator is not valid" } },
        "sa@x",
      )).toBe(false);
    });
  });

  describe("mintKey()", () => {
    const keyData = btoa(JSON.stringify({
      client_email: "sa@x",
      private_key: "pem",
      token_uri: "https://oauth2.googleapis.com/token",
    }));

    it("returns the key file with the username added", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      const keyFile = await mintKey(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200, json: { keys: [] } },
            { status: 200, json: { privateKeyData: keyData } },
          ], log),
        },
        "sa@x",
        "octocat",
      );
      expect(JSON.parse(keyFile).cf_username).toBe("octocat");
      expect(log[0]?.url).toContain("keyTypes=USER_MANAGED");
    });

    it("revokes every key the account held before minting one", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      await mintKey(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            {
              status: 200,
              json: {
                keys: [
                  { name: "projects/p/serviceAccounts/sa@x/keys/old1" },
                  { name: "projects/p/serviceAccounts/sa@x/keys/old2" },
                ],
              },
            },
            { status: 200, json: {} },
            { status: 200, json: {} },
            { status: 200, json: { privateKeyData: keyData } },
          ], log),
        },
        "sa@x",
        "octocat",
      );
      const deletes = log.filter((entry) => entry.method === "DELETE");
      expect(deletes.length).toBe(2);
      expect(deletes[0]?.url).toContain("/keys/old1");
      expect(deletes[1]?.url).toContain("/keys/old2");
      // The account never holds two live keys, so the new one is created
      // only once the old ones are gone.
      expect(log.map((entry) => entry.method)).toEqual([
        "GET",
        "DELETE",
        "DELETE",
        "POST",
      ]);
    });

    it("throws before minting when a key cannot be revoked", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      await expect(mintKey(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            {
              status: 200,
              json: {
                keys: [{ name: "projects/p/serviceAccounts/sa@x/keys/old" }],
              },
            },
            { status: 500 },
          ], log),
        },
        "sa@x",
        "octocat",
      )).rejects.toThrow("revoking");
      // Nothing was created, so no key is left that nobody holds.
      expect(log.some((entry) => entry.method === "POST")).toBe(false);
    });

    it("names the permission a refused revocation needs", async () => {
      await expect(mintKey(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            {
              status: 200,
              json: {
                keys: [{ name: "projects/p/serviceAccounts/sa@x/keys/old" }],
              },
            },
            { status: 403 },
          ], []),
        },
        "sa@x",
        "octocat",
      )).rejects.toThrow("iam.serviceAccountKeys.delete");
    });

    it("returns the key once the account has reached key creation", async () => {
      const log: { method: string; url: string; body?: string }[] = [];
      let waits = 0;
      const keyFile = await mintKey(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200, json: { keys: [] } },
            {
              status: 404,
              json: {
                error: {
                  code: 404,
                  message:
                    "Service account projects/p/serviceAccounts/sa@x does not exist.",
                  status: "NOT_FOUND",
                },
              },
            },
            { status: 200, json: { privateKeyData: keyData } },
          ], log),
          awaitVisibility: () => {
            waits++;
            return Promise.resolve();
          },
        },
        "sa@x",
        "octocat",
      );
      expect(JSON.parse(keyFile).cf_username).toBe("octocat");
      expect(waits).toBe(1);
      expect(log.map((entry) => entry.method)).toEqual(["GET", "POST", "POST"]);
    });

    it("throws for a mint refused on any other ground", async () => {
      await expect(mintKey(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200, json: { keys: [] } },
            {
              status: 404,
              json: { error: { message: "Project p does not exist." } },
            },
          ], []),
          awaitVisibility: () => {
            throw new Error("no wait expected");
          },
        },
        "sa@x",
        "octocat",
      )).rejects.toThrow("minting a key");
    });
  });

  describe("runMint()", () => {
    let out: string;

    beforeEach(async () => {
      out = await Deno.makeTempDir({ prefix: "test-records-mint-" });
    });

    afterEach(async () => {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    });

    // A whole-run GCP stub: fresh account, fresh folder, no previous keys.
    function mintFetch(log: string[]): typeof fetch {
      const keyData = btoa(JSON.stringify({
        client_email: "test-records-gh-octocat@p.iam.gserviceaccount.com",
        private_key: "pem",
        token_uri: "https://oauth2.googleapis.com/token",
      }));
      return ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        log.push(`${method} ${decodeURIComponent(url)}`);
        if (url.includes("/keys?keyTypes=USER_MANAGED")) {
          return Promise.resolve(
            new Response(JSON.stringify({ keys: [] }), { status: 200 }),
          );
        }
        if (url.endsWith("/keys") && method === "POST") {
          return Promise.resolve(
            new Response(JSON.stringify({ privateKeyData: keyData }), {
              status: 200,
            }),
          );
        }
        if (url.includes("/serviceAccounts/") && method === "GET") {
          return Promise.resolve(new Response("{}", { status: 404 }));
        }
        if (url.includes("/managedFolders/") && url.endsWith("/iam")) {
          return Promise.resolve(
            new Response(
              JSON.stringify(method === "GET" ? { bindings: [] } : {}),
              { status: 200 },
            ),
          );
        }
        return Promise.resolve(new Response("{}", { status: 200 }));
      }) as typeof fetch;
    }

    it("provisions, mints, and seals a delivery the recipient can open", async () => {
      const identity = await generateIdentity();
      const log: string[] = [];
      const githubOutput = join(out, "github-output.txt");
      const path = await runMint({
        recipient: identity.recipient,
        username: "OctoCat",
        out: join(out, "delivery"),
        client: { token: "t", fetchImpl: mintFetch(log) },
        githubOutput,
      });

      const box = JSON.parse(await Deno.readTextFile(path));
      const keyText = new TextDecoder().decode(await open(identity, box));
      const key = parsePersonalKeyFile(keyText);
      expect(key?.cf_username).toBe("octocat");
      expect(path).toContain("test-records-key-");
      expect(await Deno.readTextFile(githubOutput)).toMatch(
        /^fingerprint=[0-9a-f]{32}\n$/,
      );
      // The provisioning canonicalized the login before naming anything.
      expect(log.some((line) => line.includes("local/octocat/"))).toBe(true);
      expect(log.some((line) => line.includes("OctoCat"))).toBe(false);
    });

    it("refuses a malformed recipient before touching anything", async () => {
      const log: string[] = [];
      await expect(runMint({
        recipient: "age1notours",
        username: "octocat",
        out,
        client: { token: "t", fetchImpl: mintFetch(log) },
      })).rejects.toThrow("not a cfr1 delivery recipient");
      expect(log).toEqual([]);
    });

    it("refuses a malformed username before touching anything", async () => {
      const log: string[] = [];
      const identity = await generateIdentity();
      await expect(runMint({
        recipient: identity.recipient,
        username: "-bad-",
        out,
        client: { token: "t", fetchImpl: mintFetch(log) },
      })).rejects.toThrow("not a GitHub username");
      expect(log).toEqual([]);
    });
  });

  describe("parseMintArgs()", () => {
    it("returns the trimmed inputs of a full command line", () => {
      expect(parseMintArgs([
        "--recipient",
        " cfr1abc ",
        "--username",
        " octocat ",
        "--out",
        "delivery",
      ])).toEqual({
        recipient: "cfr1abc",
        username: "octocat",
        out: "delivery",
      });
    });

    it("returns undefined for malformed command lines", () => {
      expect(parseMintArgs([])).toBeUndefined();
      expect(parseMintArgs(["--recipient"])).toBeUndefined();
      expect(parseMintArgs(["--mystery", "x"])).toBeUndefined();
      expect(parseMintArgs(["--recipient", "r", "--out", "o"]))
        .toBeUndefined();
    });
  });

  describe("error paths", () => {
    it("throws when reading the account fails outright", async () => {
      await expect(ensureServiceAccount(
        { token: "t", fetchImpl: sequenceFetch([{ status: 500 }], []) },
        "octocat",
      )).rejects.toThrow("reading");
    });

    it("throws when creating the account fails", async () => {
      await expect(ensureServiceAccount(
        {
          token: "t",
          fetchImpl: sequenceFetch([{ status: 404 }, { status: 403 }], []),
        },
        "octocat",
      )).rejects.toThrow("creating");
    });

    it("throws when re-enabling the account fails", async () => {
      await expect(ensureServiceAccount(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200, json: { disabled: true } },
            { status: 500 },
          ], []),
        },
        "octocat",
      )).rejects.toThrow("enabling");
    });

    it("throws when the folder cannot be created", async () => {
      await expect(ensurePersonFolder(
        { token: "t", fetchImpl: sequenceFetch([{ status: 403 }], []) },
        "b",
        "p",
        "octocat",
        "sa@x",
      )).rejects.toThrow("creating folder");
    });

    it("throws when the folder policy cannot be read or written", async () => {
      await expect(ensurePersonFolder(
        {
          token: "t",
          fetchImpl: sequenceFetch([{ status: 200 }, { status: 500 }], []),
        },
        "b",
        "p",
        "octocat",
        "sa@x",
      )).rejects.toThrow("reading IAM");
      await expect(ensurePersonFolder(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200 },
            { status: 200, json: { bindings: [], etag: "e" } },
            { status: 409 },
          ], []),
        },
        "b",
        "p",
        "octocat",
        "sa@x",
      )).rejects.toThrow("granting");
    });

    it("throws when the key listing or the mint itself fails", async () => {
      await expect(mintKey(
        { token: "t", fetchImpl: sequenceFetch([{ status: 500 }], []) },
        "sa@x",
        "octocat",
      )).rejects.toThrow("listing the keys");
      await expect(mintKey(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200, json: { keys: [] } },
            { status: 429 },
          ], []),
        },
        "sa@x",
        "octocat",
      )).rejects.toThrow("minting a key");
      await expect(mintKey(
        {
          token: "t",
          fetchImpl: sequenceFetch([
            { status: 200, json: { keys: [] } },
            { status: 200, json: {} },
          ], []),
        },
        "sa@x",
        "octocat",
      )).rejects.toThrow("no privateKeyData");
    });
  });
});
