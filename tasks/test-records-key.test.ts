import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  agentConfigReport,
  agentRemovalReport,
  collectCommand,
  defaultDeps,
  defaultGithubToken,
  INTERRUPT_NOTICE,
  type KeyToolDeps,
  requestCommand,
  runCli,
  setupCommand,
  uninstallCommand,
} from "./test-records-key.ts";
import {
  generateIdentity,
  type KeyDeliveryIdentity,
  recipientFingerprint,
  seal,
} from "./test-records-crypto.ts";

/** A key file whose private key can actually sign, as a real one does. */
async function signingKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const base64 = btoa(String.fromCharCode(...pkcs8)).replace(
    /(.{64})/g,
    "$1\n",
  );
  return JSON.stringify({
    client_email: "test-records-gh-octocat@p.iam.gserviceaccount.com",
    private_key:
      `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`,
    token_uri: "https://oauth2.googleapis.com/token",
    cf_username: "octocat",
  });
}

const KEY_TEXT = await signingKey();
const OTHER_KEY_TEXT = await signingKey();

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

// A single-member stored zip, the shape the artifact download serves.
function storedZip(name: string, content: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const local = [
    0x50,
    0x4b,
    0x03,
    0x04,
    ...u16le(20),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(0),
    ...u32le(content.length),
    ...u32le(content.length),
    ...u16le(nameBytes.length),
    ...u16le(0),
  ];
  const centralOffset = local.length + nameBytes.length + content.length;
  const central = [
    0x50,
    0x4b,
    0x01,
    0x02,
    ...u16le(20),
    ...u16le(20),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(0),
    ...u32le(content.length),
    ...u32le(content.length),
    ...u16le(nameBytes.length),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(0),
    ...u32le(0),
  ];
  const eocd = [
    0x50,
    0x4b,
    0x05,
    0x06,
    ...u16le(0),
    ...u16le(0),
    ...u16le(1),
    ...u16le(1),
    ...u32le(central.length + nameBytes.length),
    ...u32le(centralOffset),
    ...u16le(0),
  ];
  return new Uint8Array([
    ...local,
    ...nameBytes,
    ...content,
    ...central,
    ...nameBytes,
    ...eocd,
  ]);
}

/**
 * A run as the API lists it. `named: false` is a run of a workflow
 * version whose run name does not carry the recipient, which is what the
 * delivery artifact has to identify instead.
 */
function mintRun(
  recipient: string,
  run: {
    id?: number;
    status?: string;
    conclusion?: string;
    created_at?: string;
    named?: boolean;
    actor?: string;
  } = {},
): Record<string, unknown> {
  const id = run.id ?? 42;
  return {
    id,
    status: run.status ?? "completed",
    conclusion: run.conclusion ?? "success",
    created_at: run.created_at ?? "2026-08-21T02:00:00Z",
    html_url: `https://github.com/commonfabric/labs/actions/runs/${id}`,
    display_title: run.named === false
      ? "Test Records Mint"
      : `Mint reporting key for octocat (${recipient})`,
    actor: { login: run.actor ?? "octocat" },
  };
}

interface StubOptions {
  login?: string;
  loginStatus?: number;

  /** What the token endpoint says about the installed key. */
  keyStatus?: number;

  /**
   * One page of runs per listing or run read; the last repeats. A watch
   * that pauses after the last has been served fails rather than waiting
   * on a page that cannot change.
   */
  runPages?: Record<string, unknown>[][];

  runsStatus?: number;

  /** GitHub's clock, as the runs listing reports it. */
  listDate?: string;

  artifacts?: { id: number; name: string; expired?: boolean }[];
  artifactStatus?: number;
  zip?: Uint8Array;
  zipStatus?: number;
  dispatchStatus?: number;
  dispatchDate?: string;

  /** The id of the run an accepted dispatch starts; `mintRun`'s by default. */
  dispatchedRun?: number;
}

describe("test-records-key", () => {
  let home: string;
  let deps: KeyToolDeps;
  let urls: string[];

  function withFetch(fetchImpl: typeof fetch, token = "gh-token"): void {
    deps = {
      env: (name) => name === "XDG_CONFIG_HOME" ? home : undefined,
      fetchImpl: ((input: URL | RequestInfo, init?: RequestInit) => {
        urls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return fetchImpl(input, init);
      }) as typeof fetch,
      githubToken: () => Promise.resolve(token),
      pause: () => Promise.resolve(),
    };
  }

  function withStub(options: StubOptions, token = "gh-token"): void {
    let page = 0;
    const pages = options.runPages ?? [[]];
    withFetch(
      ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: "t" }), {
              status: options.keyStatus ?? 200,
            }),
          );
        }
        if (url.endsWith("/user")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ login: options.login ?? "octocat" }),
              { status: options.loginStatus ?? 200 },
            ),
          );
        }
        if (url.endsWith("/dispatches")) {
          const headers = options.dispatchDate !== undefined
            ? { date: options.dispatchDate }
            : undefined;
          // GitHub names the run it started only when asked to.
          const details = options.dispatchStatus === undefined &&
            JSON.parse(String(init?.body)).return_run_details === true;
          const id = options.dispatchedRun ?? 42;
          return Promise.resolve(
            new Response(
              details
                ? JSON.stringify({
                  workflow_run_id: id,
                  run_url: `https://api.github.com/runs/${id}`,
                  html_url: `https://github.com/runs/${id}`,
                })
                : null,
              {
                status: options.dispatchStatus ?? (details ? 200 : 204),
                ...(headers !== undefined ? { headers } : {}),
              },
            ),
          );
        }
        const single = url.match(/\/actions\/runs\/(\d+)$/);
        if (single !== null) {
          const run = pages[Math.min(page++, pages.length - 1)]!
            .find((run) => run.id === Number(single[1]));
          return Promise.resolve(
            run === undefined
              ? new Response("not found", { status: 404 })
              : new Response(JSON.stringify(run), { status: 200 }),
          );
        }
        if (url.includes("/runs?")) {
          const runs = pages[Math.min(page++, pages.length - 1)]!;
          const headers = options.listDate !== undefined
            ? { date: options.listDate }
            : undefined;
          return Promise.resolve(
            new Response(JSON.stringify({ workflow_runs: runs }), {
              status: options.runsStatus ?? 200,
              ...(headers !== undefined ? { headers } : {}),
            }),
          );
        }
        if (url.includes("/artifacts?")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ artifacts: options.artifacts ?? [] }),
              { status: options.artifactStatus ?? 200 },
            ),
          );
        }
        if (url.endsWith("/zip")) {
          return Promise.resolve(
            new Response(
              (options.zip ?? new Uint8Array()) as unknown as BodyInit,
              { status: options.zipStatus ?? 200 },
            ),
          );
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      }) as typeof fetch,
      token,
    );
    deps.pause = () =>
      page < pages.length
        ? Promise.resolve()
        : Promise.reject(new Error("the watch outlasted the stubbed runs"));
  }

  async function storeIdentity(): Promise<KeyDeliveryIdentity> {
    const identity = await generateIdentity();
    await Deno.mkdir(join(home, "common-fabric"), { recursive: true });
    await Deno.writeTextFile(
      join(home, "common-fabric", "test-records-identity.json"),
      JSON.stringify(identity),
    );
    return identity;
  }

  /** The delivery a successful run publishes for an identity. */
  async function delivery(
    identity: KeyDeliveryIdentity,
    keyText = KEY_TEXT,
  ): Promise<{ artifacts: { id: number; name: string }[]; zip: Uint8Array }> {
    const fingerprint = await recipientFingerprint(identity.recipient);
    const sealed = await seal(
      identity.recipient,
      new TextEncoder().encode(keyText),
    );
    return {
      artifacts: [{ id: 7, name: `test-records-key-${fingerprint}` }],
      zip: storedZip(
        `${fingerprint}.sealed`,
        new TextEncoder().encode(JSON.stringify(sealed)),
      ),
    };
  }

  beforeEach(async () => {
    home = await Deno.makeTempDir({ prefix: "test-records-key-" });
    urls = [];
  });

  afterEach(async () => {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  });

  describe("requestCommand()", () => {
    it("stores an identity with owner-only permissions and dispatches", async () => {
      withStub({});

      await requestCommand(deps);

      const path = join(home, "common-fabric", "test-records-identity.json");
      const identity = JSON.parse(await Deno.readTextFile(path));
      expect(identity.recipient.startsWith("cfr1")).toBe(true);
      expect(Deno.statSync(path).mode! & 0o777).toBe(0o600);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });

    it("keeps an existing identity and prints instructions without a token", async () => {
      const identity = await storeIdentity();
      withFetch(
        (() => {
          throw new Error("no request expected");
        }) as unknown as typeof fetch,
      );
      deps.githubToken = () => Promise.resolve(undefined);

      await requestCommand(deps);

      const stored = JSON.parse(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-identity.json"),
        ),
      );
      expect(stored.recipient).toBe(identity.recipient);
      expect(urls).toEqual([]);
    });

    it("falls back to instructions when the dispatch is refused", async () => {
      await storeIdentity();
      withStub({ dispatchStatus: 403 });

      await requestCommand(deps);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });

    it("prints instructions when the token cannot name its owner", async () => {
      await storeIdentity();
      withStub({ loginStatus: 403 });

      await requestCommand(deps);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(false);
    });
  });

  describe("collectCommand()", () => {
    it("throws without a stored identity", async () => {
      withStub({});
      await expect(collectCommand(deps)).rejects.toThrow(
        "No delivery identity",
      );
    });

    it("downloads, opens, validates, and installs the delivered key", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        login: "OctoCat",
        runPages: [[mintRun(identity.recipient)]],
        ...published,
      });

      expect(await collectCommand(deps)).toBe(0);

      const installed = join(home, "common-fabric", "test-records-key.json");
      expect(await Deno.readTextFile(installed)).toBe(KEY_TEXT);
      expect(Deno.statSync(installed).mode! & 0o777).toBe(0o600);
    });

    it("asks to retry while the minting run is still going", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient, { status: "in_progress" })]],
      });

      expect(await collectCommand(deps)).toBe(1);
    });

    it("names the run that failed", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient, { conclusion: "failure" })]],
      });

      await expect(collectCommand(deps)).rejects.toThrow("finished as failure");
    });

    it("throws when no run is minting for this recipient", async () => {
      await storeIdentity();
      withStub({
        runPages: [[mintRun("cfr1someone-else", { actor: "someone-else" })]],
      });

      await expect(collectCommand(deps)).rejects.toThrow("No minting run");
    });

    it("identifies a run that does not name the recipient by its delivery", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[mintRun(identity.recipient, { named: false })]],
        ...published,
      });

      expect(await collectCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("passes over a delivery-less run someone else dispatched", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[
          mintRun("cfr1someone-else", { id: 9, actor: "someone-else" }),
          mintRun(identity.recipient, { named: false }),
        ]],
        ...published,
      });

      expect(await collectCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/runs/9/artifacts"))).toBe(
        false,
      );
    });

    it("refuses a key minted for someone else", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        login: "someone-else",
        runPages: [[mintRun(identity.recipient)]],
        ...published,
      });

      await expect(collectCommand(deps)).rejects.toThrow("minted for");
    });

    it("throws when the run published no delivery", async () => {
      const identity = await storeIdentity();
      withStub({ runPages: [[mintRun(identity.recipient)]], artifacts: [] });

      await expect(collectCommand(deps)).rejects.toThrow(
        "published no delivery",
      );
    });

    it("names the status when the artifact listing fails", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifactStatus: 500,
      });

      await expect(collectCommand(deps)).rejects.toThrow(
        "Listing the artifacts of run 42 failed: HTTP 500",
      );
    });

    it("throws when the delivery download fails", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifacts: published.artifacts,
        zipStatus: 410,
      });

      await expect(collectCommand(deps)).rejects.toThrow(
        "Downloading the delivery failed",
      );
    });

    it("throws when the delivery zip holds no sealed key", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifacts: published.artifacts,
        zip: storedZip("readme.txt", new TextEncoder().encode("hi")),
      });

      await expect(collectCommand(deps)).rejects.toThrow("holds no sealed key");
    });

    it("throws without any usable token", async () => {
      await storeIdentity();
      withStub({});
      deps.githubToken = () => Promise.resolve(undefined);
      await expect(collectCommand(deps)).rejects.toThrow(
        "A GitHub token is needed",
      );
    });

    it("reports a profile that points somewhere else", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/zsh";
        return inner(name);
      };
      await Deno.writeTextFile(
        join(home, ".zshenv"),
        'export CF_TEST_RECORDS_KEY_FILE="/somewhere/else.json"\n',
      );

      expect(await collectCommand(deps)).toBe(0);

      // The profile is a person's file: the line that disagrees stays.
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(
        'export CF_TEST_RECORDS_KEY_FILE="/somewhere/else.json"\n',
      );
    });

    it("leaves a profile that already exports the key file alone", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/zsh";
        return inner(name);
      };
      const line = `export CF_TEST_RECORDS_KEY_FILE="$HOME/common-fabric/` +
        `test-records-key.json"\n`;
      await Deno.writeTextFile(join(home, ".zshenv"), line);

      expect(await collectCommand(deps)).toBe(0);
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(line);
    });

    it("keeps the key beside the identity under a plain home", async () => {
      const identity = await generateIdentity();
      await Deno.mkdir(join(home, ".config", "common-fabric"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(home, ".config", "common-fabric", "test-records-identity.json"),
        JSON.stringify(identity),
      );
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      deps.env = (name) => name === "HOME" ? home : undefined;

      expect(await collectCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, ".config", "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("reports a profile that sets the variable without exporting it", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/zsh";
        return inner(name);
      };
      const line = `CF_TEST_RECORDS_KEY_FILE="$HOME/common-fabric/` +
        `test-records-key.json"\n`;
      await Deno.writeTextFile(join(home, ".zshenv"), line);

      expect(await collectCommand(deps)).toBe(0);
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(line);
    });

    it("reports the login profile a shell reads and does not have", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/bash";
        return inner(name);
      };
      await Deno.writeTextFile(join(home, ".bashrc"), "");

      expect(await collectCommand(deps)).toBe(0);
      expect(await Deno.readTextFile(join(home, ".bashrc"))).toContain(
        "CF_TEST_RECORDS_KEY_FILE",
      );
    });

    it("throws with nowhere to keep the identity", async () => {
      withStub({});
      deps.env = () => undefined;

      await expect(collectCommand(deps)).rejects.toThrow(
        "Neither XDG_CONFIG_HOME nor HOME is set.",
      );
    });

    /** A workstation with an agent harness, holding this settings text. */
    async function withHarness(settings?: string): Promise<string> {
      const inner = deps.env;
      deps.env = (name) => name === "HOME" ? home : inner(name);
      await Deno.mkdir(join(home, ".claude"), { recursive: true });
      const path = join(home, ".claude", "settings.json");
      if (settings !== undefined) await Deno.writeTextFile(path, settings);
      return path;
    }

    /** Where the key lands for these tests. */
    function keyPath(): string {
      return join(home, "common-fabric", "test-records-key.json");
    }

    it("passes the key file to an agent harness installed here", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const inner = deps.env;
      deps.env = (name) => name === "HOME" ? home : inner(name);
      await Deno.mkdir(join(home, ".claude"), { recursive: true });

      expect(await collectCommand(deps)).toBe(0);

      const settings = JSON.parse(
        await Deno.readTextFile(join(home, ".claude", "settings.json")),
      );
      expect(settings.env.CF_TEST_RECORDS_KEY_FILE).toBe(
        join(home, "common-fabric", "test-records-key.json"),
      );
    });

    it("says a harness already passes the key file on", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const settings = await withHarness(
        JSON.stringify({ env: { CF_TEST_RECORDS_KEY_FILE: keyPath() } }),
      );

      expect(await collectCommand(deps)).toBe(0);
      expect(JSON.parse(await Deno.readTextFile(settings))).toEqual({
        env: { CF_TEST_RECORDS_KEY_FILE: keyPath() },
      });
    });

    it("leaves a harness pointed at another key alone", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const text = JSON.stringify({
        env: { CF_TEST_RECORDS_KEY_FILE: "/elsewhere.json" },
      });
      const settings = await withHarness(text);

      expect(await collectCommand(deps)).toBe(0);
      expect(await Deno.readTextFile(settings)).toBe(text);
    });

    it("leaves a harness configuration that does not parse alone", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const settings = await withHarness("{ not json");

      expect(await collectCommand(deps)).toBe(0);
      expect(await Deno.readTextFile(settings)).toBe("{ not json");
    });

    it("throws when the token cannot read the collector's login", async () => {
      await storeIdentity();
      withStub({ loginStatus: 403 });

      await expect(collectCommand(deps)).rejects.toThrow(
        "Cannot read your GitHub login",
      );
    });

    it("names the status when the run listing fails", async () => {
      await storeIdentity();
      withStub({ runsStatus: 500 });

      await expect(collectCommand(deps)).rejects.toThrow(
        "Listing minting runs failed: HTTP 500",
      );
    });

    it("names the endpoint it could not reach", async () => {
      await storeIdentity();
      withFetch(
        (() =>
          Promise.reject(new TypeError("connection refused"))) as typeof fetch,
      );

      await expect(collectCommand(deps)).rejects.toThrow(
        "Cannot reach https://api.github.com: connection refused",
      );
    });

    it("refuses a delivery sealed to another identity", async () => {
      const identity = await storeIdentity();
      const stranger = await generateIdentity();
      const fingerprint = await recipientFingerprint(identity.recipient);
      const sealed = await seal(
        stranger.recipient,
        new TextEncoder().encode(KEY_TEXT),
      );
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifacts: [{ id: 7, name: `test-records-key-${fingerprint}` }],
        zip: storedZip(
          `${fingerprint}.sealed`,
          new TextEncoder().encode(JSON.stringify(sealed)),
        ),
      });

      await expect(collectCommand(deps)).rejects.toThrow(
        "does not open with the identity",
      );
    });

    it("refuses a delivery that is not a key file", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity, JSON.stringify({ hi: 1 }));
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      await expect(collectCommand(deps)).rejects.toThrow(
        "not a personal test-records key file",
      );
    });

    it("passes over an unnamed run of its own that delivered nothing", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [[
          mintRun(identity.recipient, { id: 9, named: false }),
          mintRun(identity.recipient, { id: 3 }),
        ]],
        ...published,
      });

      // The newest run is this person's, but it published nothing for
      // this recipient, so the delivery of the older named run is the
      // one collected.
      let artifactsFor: string | undefined;
      const inner = deps.fetchImpl;
      deps.fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/runs/9/artifacts")) {
          artifactsFor = url;
          return Promise.resolve(
            new Response(JSON.stringify({ artifacts: [] }), { status: 200 }),
          );
        }
        return inner(input, init);
      }) as typeof fetch;

      expect(await collectCommand(deps)).toBe(0);
      expect(artifactsFor).toBeDefined();
      expect(urls.some((line) => line.includes("/runs/3/artifacts"))).toBe(
        true,
      );
    });
  });

  describe("setupCommand()", () => {
    /** A workstation whose login shell is zsh, profile and all. */
    function withShell(): string {
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/zsh";
        return inner(name);
      };
      return join(home, ".zshenv");
    }

    it("dispatches, waits for the run, installs, and exports the key", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [
          [],
          [mintRun(identity.recipient, { status: "queued" })],
          [mintRun(identity.recipient, { status: "in_progress" })],
          [mintRun(identity.recipient)],
        ],
        ...published,
      });
      const profile = withShell();

      expect(await setupCommand(deps)).toBe(0);

      const installed = join(home, "common-fabric", "test-records-key.json");
      expect(await Deno.readTextFile(installed)).toBe(KEY_TEXT);
      expect(await Deno.readTextFile(profile)).toContain(
        'export CF_TEST_RECORDS_KEY_FILE="$HOME/common-fabric/' +
          'test-records-key.json"',
      );
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });

    it("follows a run that does not name the recipient to its delivery", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        runPages: [
          [mintRun(identity.recipient, {
            named: false,
            status: "in_progress",
            conclusion: undefined,
          })],
          [mintRun(identity.recipient, { named: false })],
        ],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("keeps watching when the dispatch is refused", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        dispatchStatus: 403,
        runPages: [[], [mintRun(identity.recipient)]],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("ignores a run that predates the dispatch", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      const failed = mintRun(identity.recipient, {
        id: 1,
        conclusion: "failure",
        created_at: "2026-08-21T02:00:00Z",
      });
      withStub({
        dispatchStatus: 403,
        dispatchDate: "Fri, 21 Aug 2026 03:00:00 GMT",
        runPages: [
          [failed],
          [
            mintRun(identity.recipient, {
              id: 2,
              created_at: "2026-08-21T03:00:01Z",
            }),
            failed,
          ],
        ],
        ...published,
      });

      // The failed run is the one this dispatch answers, so the watch
      // must not report it as this attempt's outcome.
      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/runs/2/artifacts"))).toBe(
        true,
      );
    });

    it("takes up a run already going instead of starting another", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      const going = mintRun(identity.recipient, {
        id: 5,
        status: "in_progress",
        conclusion: undefined,
        created_at: "2026-08-21T03:00:00Z",
      });
      withStub({
        listDate: "Fri, 21 Aug 2026 03:00:01 GMT",
        runPages: [
          [going],
          [going],
          [mintRun(identity.recipient, {
            id: 5,
            created_at: "2026-08-21T03:00:00Z",
          })],
        ],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(false);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("starts its own run rather than one it cannot identify", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      const opaque = mintRun(identity.recipient, {
        id: 4,
        named: false,
        status: "in_progress",
        conclusion: undefined,
        created_at: "2026-08-21T02:00:00Z",
      });
      withStub({
        dispatchedRun: 6,
        runPages: [
          [opaque],
          [
            mintRun(identity.recipient, {
              id: 6,
              created_at: "2026-08-21T03:00:01Z",
            }),
            opaque,
          ],
        ],
        ...published,
      });

      // A run of this person's under a name that says nothing about
      // what it is minting could be for another identity of theirs.
      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
      expect(urls.some((line) => line.includes("/runs/6/artifacts"))).toBe(
        true,
      );
    });

    it("collects a delivery an earlier run left waiting", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(false);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("raises a dispatch that failed for any other reason", async () => {
      await storeIdentity();
      withStub({ dispatchStatus: 500 });

      await expect(setupCommand(deps)).rejects.toThrow(
        "Dispatching the minting workflow failed: HTTP 500",
      );
    });

    it("raises a dispatch that does not say which run it started", async () => {
      await storeIdentity();
      withStub({});
      const inner = deps.fetchImpl;
      deps.fetchImpl =
        ((input: URL | RequestInfo, init?: RequestInit) =>
          String(input).endsWith("/dispatches")
            ? Promise.resolve(new Response("{}", { status: 200 }))
            : inner(input, init)) as typeof fetch;

      await expect(setupCommand(deps)).rejects.toThrow(
        "did not say which run it started",
      );
    });

    it("installs the key from a run created before the dispatch answered", async () => {
      // GitHub creates the run while it handles the dispatch, so the
      // run's creation time can be a second earlier than the time
      // GitHub's answers carry from then on.
      const identity = await storeIdentity();
      const published = await delivery(identity);
      const created = "2026-08-21T03:00:00Z";
      withStub({
        dispatchDate: "Fri, 21 Aug 2026 03:00:01 GMT",
        listDate: "Fri, 21 Aug 2026 03:00:01 GMT",
        runPages: [
          [],
          [mintRun(identity.recipient, {
            status: "in_progress",
            conclusion: undefined,
            created_at: created,
          })],
          [mintRun(identity.recipient, { created_at: created })],
        ],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("names the dispatched run's failure when the run does not name its recipient", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [
          [],
          [mintRun(identity.recipient, {
            named: false,
            conclusion: "failure",
          })],
        ],
      });

      await expect(setupCommand(deps)).rejects.toThrow(
        "The minting run finished as failure",
      );
    });

    it("raises a dispatched run it cannot read", async () => {
      await storeIdentity();
      withStub({ runPages: [[]] });

      await expect(setupCommand(deps)).rejects.toThrow(
        "Reading minting run 42 failed: HTTP 404",
      );
    });

    it("names the run that failed instead of waiting on it", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient, { conclusion: "failure" })]],
      });

      await expect(setupCommand(deps)).rejects.toThrow("finished as failure");
    });

    it("exports the installed key rather than minting a second one", async () => {
      await Deno.mkdir(join(home, "common-fabric"), { recursive: true });
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        KEY_TEXT,
      );
      withStub({});
      const profile = withShell();

      expect(await setupCommand(deps)).toBe(0);

      expect(await Deno.readTextFile(profile)).toContain(
        "CF_TEST_RECORDS_KEY_FILE",
      );
      // It asks what is going and whether the key still works, and
      // starts nothing.
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(false);
      expect(urls.some((line) => line.includes("oauth2.googleapis.com")))
        .toBe(true);
    });

    it("takes up a run already going even with a key installed", async () => {
      const identity = await storeIdentity();
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        KEY_TEXT,
      );
      const published = await delivery(identity, OTHER_KEY_TEXT);
      const going = mintRun(identity.recipient, {
        id: 11,
        status: "in_progress",
        conclusion: undefined,
      });
      withStub({
        runPages: [[going], [mintRun(identity.recipient, { id: 11 })]],
        ...published,
      });

      // The run was dispatched to replace this key, so standing down on
      // the installed one is how a person ends up holding a dead key.
      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(false);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(OTHER_KEY_TEXT);
    });

    it("mints a replacement for a key that is no longer accepted", async () => {
      const identity = await storeIdentity();
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        KEY_TEXT,
      );
      const published = await delivery(identity);
      withStub({
        keyStatus: 400,
        runPages: [[mintRun(identity.recipient)]],
        ...published,
      });

      // A mint that failed after revoking leaves a file naming a key
      // nothing accepts; setup must not take it for a working one.
      expect(await setupCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
      expect(urls.some((line) => line.includes("oauth2.googleapis.com"))).toBe(
        true,
      );
    });

    it("replaces a key file that cannot sign", async () => {
      const identity = await storeIdentity();
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        JSON.stringify({
          client_email: "test-records-gh-octocat@p.iam.gserviceaccount.com",
          private_key: "not a key",
          token_uri: "https://oauth2.googleapis.com/token",
          cf_username: "octocat",
        }),
      );
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      // Nothing will accept it, so there is no asking to be done.
      expect(await setupCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
      expect(urls.some((line) => line.includes("oauth2.googleapis.com")))
        .toBe(false);
    });

    it("keeps a key the endpoint could not be asked about", async () => {
      await Deno.mkdir(join(home, "common-fabric"), { recursive: true });
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        KEY_TEXT,
      );
      withStub({});
      const inner = deps.fetchImpl;
      deps.fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => {
        if (String(input).includes("oauth2.googleapis.com")) {
          return Promise.reject(new TypeError("connection refused"));
        }
        return inner(input, init);
      }) as typeof fetch;

      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(false);
    });

    it("keeps a key it could not ask about", async () => {
      await Deno.mkdir(join(home, "common-fabric"), { recursive: true });
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        KEY_TEXT,
      );
      withStub({ keyStatus: 503 });

      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(false);
    });

    it("mints a replacement when asked to rotate", async () => {
      const identity = await storeIdentity();
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        KEY_TEXT,
      );
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      expect(await setupCommand(deps, { rotate: true })).toBe(0);
      expect(urls.some((line) => line.includes("/dispatches"))).toBe(true);
    });

    it("throws without any usable token", async () => {
      withStub({});
      deps.githubToken = () => Promise.resolve(undefined);
      await expect(setupCommand(deps)).rejects.toThrow(
        "A GitHub token is needed",
      );
    });

    it("throws when the token cannot name its owner", async () => {
      withStub({ loginStatus: 403 });

      await expect(setupCommand(deps)).rejects.toThrow(
        "Cannot read your GitHub login",
      );
    });

    it("says so when the run it watched delivered nothing", async () => {
      const identity = await storeIdentity();
      withStub({
        runPages: [[mintRun(identity.recipient)]],
        artifacts: [],
      });

      await expect(setupCommand(deps)).rejects.toThrow(
        "published no delivery",
      );
    });

    it("installs over a key file that will not parse", async () => {
      const identity = await storeIdentity();
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        "not a key file",
      );
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      expect(await setupCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "test-records-key.json"),
        ),
      ).toBe(KEY_TEXT);
    });

    it("says it is waiting once, however long it waits", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({
        dispatchStatus: 403,
        runPages: [[], [], [], [mintRun(identity.recipient)]],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(urls.filter((line) => line.includes("/runs?")).length).toBe(4);
    });

    it("watches a run it can only attribute by who started it", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      const going = mintRun(identity.recipient, {
        id: 8,
        named: false,
        status: "in_progress",
        conclusion: undefined,
        created_at: "2026-08-21T03:00:01Z",
      });
      withStub({
        dispatchStatus: 403,
        dispatchDate: "Fri, 21 Aug 2026 03:00:00 GMT",
        runPages: [
          [],
          [going],
          [mintRun(identity.recipient, {
            id: 8,
            named: false,
            created_at: "2026-08-21T03:00:01Z",
          })],
        ],
        ...published,
      });

      expect(await setupCommand(deps)).toBe(0);
      expect(urls.some((line) => line.includes("/runs/8/artifacts"))).toBe(
        true,
      );
    });

    it("stops examining runs from before the watch began", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      const stale = mintRun(identity.recipient, {
        id: 1,
        named: false,
        created_at: "2026-08-21T02:00:00Z",
      });
      withStub({
        dispatchStatus: 403,
        listDate: "Fri, 21 Aug 2026 03:00:00 GMT",
        runPages: [
          [stale],
          [
            mintRun(identity.recipient, {
              id: 2,
              created_at: "2026-08-21T03:00:01Z",
            }),
            stale,
          ],
        ],
        artifacts: [],
        zip: published.zip,
      });
      const inner = deps.fetchImpl;
      deps.fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/runs/2/artifacts")) {
          return Promise.resolve(
            new Response(JSON.stringify({ artifacts: published.artifacts }), {
              status: 200,
            }),
          );
        }
        return inner(input, init);
      }) as typeof fetch;

      expect(await setupCommand(deps)).toBe(0);
      // The stale run is examined on the first round, which is what
      // fixes the clock, and left alone on every round after it.
      expect(
        urls.filter((line) => line.includes("/runs/1/artifacts")).length,
      ).toBe(1);
    });
  });

  describe("defaultGithubToken()", () => {
    const noCommand = () => {
      throw new Error("no command expected");
    };

    it("returns the token the environment carries", async () => {
      expect(
        await defaultGithubToken(
          (name) => name === "GH_TOKEN" ? "from-gh-token" : undefined,
          noCommand,
        ),
      ).toBe("from-gh-token");
      expect(
        await defaultGithubToken(
          (name) => name === "GITHUB_TOKEN" ? "from-github-token" : undefined,
          noCommand,
        ),
      ).toBe("from-github-token");
    });

    it("returns what the signed-in command line holds", async () => {
      expect(
        await defaultGithubToken(
          () => undefined,
          (command, args) => {
            expect(command).toBe("gh");
            expect(args).toEqual(["auth", "token"]);
            return Promise.resolve({
              code: 0,
              stdout: new TextEncoder().encode("from-gh\n"),
            });
          },
        ),
      ).toBe("from-gh");
    });

    it("returns undefined when no source holds one", async () => {
      const empty = () => undefined;
      expect(
        await defaultGithubToken(
          empty,
          () => Promise.resolve({ code: 1, stdout: new Uint8Array() }),
        ),
      ).toBeUndefined();
      expect(
        await defaultGithubToken(
          empty,
          () =>
            Promise.resolve({ code: 0, stdout: new TextEncoder().encode(" ") }),
        ),
      ).toBeUndefined();
      expect(
        await defaultGithubToken(empty, () => Promise.reject(new Error("no"))),
      ).toBeUndefined();
      expect(
        await defaultGithubToken(
          (name) => name === "GH_TOKEN" ? "" : undefined,
          () => Promise.resolve({ code: 1, stdout: new Uint8Array() }),
        ),
      ).toBeUndefined();
    });
  });

  describe("defaultDeps()", () => {
    it("returns the wiring the command line runs against", () => {
      const wiring = defaultDeps();
      expect(wiring.env).toBe(Deno.env.get);
      expect(wiring.fetchImpl).toBe(fetch);
      expect(typeof wiring.githubToken).toBe("function");
      expect(typeof wiring.pause).toBe("function");
    });
  });

  describe("INTERRUPT_NOTICE", () => {
    it("says how to pick the key up again", () => {
      expect(INTERRUPT_NOTICE).toContain("deno task test-records-key setup");
    });
  });

  describe("uninstallCommand()", () => {
    /** A workstation that setup has been through. */
    async function installed(): Promise<string> {
      const identity = await storeIdentity();
      await Deno.writeTextFile(
        join(home, "common-fabric", "test-records-key.json"),
        KEY_TEXT,
      );
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/zsh";
        return inner(name);
      };
      await Deno.writeTextFile(join(home, ".zshenv"), "alias l=ls\n");
      await collectCommand(deps);
      return join(home, ".zshenv");
    }

    it("removes the key, the identity, and the export", async () => {
      const profile = await installed();

      expect(await uninstallCommand(deps)).toBe(0);

      await expect(
        Deno.stat(join(home, "common-fabric", "test-records-key.json")),
      ).rejects.toThrow();
      await expect(
        Deno.stat(join(home, "common-fabric", "test-records-identity.json")),
      ).rejects.toThrow();
      expect(await Deno.readTextFile(profile)).toBe("alias l=ls\n");
    });

    it("stops an agent harness passing the key file on", async () => {
      await installed();
      const inner = deps.env;
      deps.env = (name) => name === "HOME" ? home : inner(name);
      await Deno.mkdir(join(home, ".claude"), { recursive: true });
      await Deno.writeTextFile(
        join(home, ".claude", "settings.json"),
        JSON.stringify({
          theme: "auto",
          env: {
            CF_TEST_RECORDS_KEY_FILE: join(
              home,
              "common-fabric",
              "test-records-key.json",
            ),
          },
        }),
      );

      expect(await uninstallCommand(deps)).toBe(0);

      expect(
        JSON.parse(
          await Deno.readTextFile(join(home, ".claude", "settings.json")),
        ),
      ).toEqual({ theme: "auto" });
    });

    it("keeps a harness pointed at a key this tool did not install", async () => {
      await installed();
      const inner = deps.env;
      deps.env = (name) => name === "HOME" ? home : inner(name);
      await Deno.mkdir(join(home, ".claude"), { recursive: true });
      const text = JSON.stringify({
        env: { CF_TEST_RECORDS_KEY_FILE: "/elsewhere.json" },
      });
      await Deno.writeTextFile(join(home, ".claude", "settings.json"), text);

      expect(await uninstallCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(join(home, ".claude", "settings.json")),
      ).toBe(text);
    });

    it("reports a harness configuration it cannot read", async () => {
      await installed();
      const inner = deps.env;
      deps.env = (name) => name === "HOME" ? home : inner(name);
      await Deno.mkdir(join(home, ".claude"), { recursive: true });
      await Deno.writeTextFile(
        join(home, ".claude", "settings.json"),
        "{ not json",
      );

      expect(await uninstallCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(join(home, ".claude", "settings.json")),
      ).toBe("{ not json");
    });

    it("leaves the directory when something else is in it", async () => {
      await installed();
      await Deno.writeTextFile(
        join(home, "common-fabric", "something-else.json"),
        "{}",
      );

      expect(await uninstallCommand(deps)).toBe(0);
      expect(
        await Deno.readTextFile(
          join(home, "common-fabric", "something-else.json"),
        ),
      ).toBe("{}");
    });

    it("keeps the key when the profile cannot be taken apart", async () => {
      await installed();
      const inner = deps.env;
      deps.env = (name) => name === "HOME" ? home : inner(name);
      // A profile that cannot be replaced: the removal fails, and the
      // key it names must still be there afterwards.
      await Deno.remove(join(home, ".zshenv"));
      await Deno.mkdir(join(home, ".zshenv", "inside"), { recursive: true });

      await expect(uninstallCommand(deps)).rejects.toThrow();

      expect(
        (await Deno.stat(join(home, "common-fabric", "test-records-key.json")))
          .isFile,
      ).toBe(true);
    });

    it("says which file it could not remove", async () => {
      withStub({});
      // A directory where the key file goes is not something a delete
      // of the key file can take away.
      await Deno.mkdir(
        join(home, "common-fabric", "test-records-key.json", "inside"),
        { recursive: true },
      );

      await expect(uninstallCommand(deps)).rejects.toThrow("Cannot remove");
    });

    it("says so when there was nothing to remove", async () => {
      withStub({});
      expect(await uninstallCommand(deps)).toBe(0);
    });

    it("does not claim recording stopped when a line was kept", async () => {
      await installed();
      const inner = deps.env;
      deps.env = (name) => name === "HOME" ? home : inner(name);
      await Deno.writeTextFile(
        join(home, ".zshenv"),
        `export CF_TEST_RECORDS_KEY_FILE="/elsewhere.json"\n`,
      );
      const said: string[] = [];
      const log = console.log;
      console.log = (line: string) => said.push(line);
      try {
        expect(await uninstallCommand(deps)).toBe(0);
      } finally {
        console.log = log;
      }

      const report = said.join("\n");
      expect(report).toContain("What this tool could take back is gone.");
      expect(report).not.toContain("Every new shell records nothing.");
    });

    it("keeps an export the tool did not write", async () => {
      withStub({});
      const inner = deps.env;
      deps.env = (name) => {
        if (name === "HOME") return home;
        if (name === "SHELL") return "/bin/zsh";
        return inner(name);
      };
      const line = `export CF_TEST_RECORDS_KEY_FILE="/elsewhere.json"\n`;
      await Deno.writeTextFile(join(home, ".zshenv"), line);

      expect(await uninstallCommand(deps)).toBe(0);
      expect(await Deno.readTextFile(join(home, ".zshenv"))).toBe(line);
    });

    it("leaves spools of records that were never shipped", async () => {
      await installed();
      const spools = join(home, "spools");
      await Deno.mkdir(join(spools, "run-1"), { recursive: true });
      const inner = deps.env;
      deps.env = (name) =>
        name === "CF_TEST_RECORDS_SPOOL_ROOT" ? spools : inner(name);

      expect(await uninstallCommand(deps)).toBe(0);
      expect((await Deno.stat(join(spools, "run-1"))).isDirectory).toBe(true);
    });
  });

  describe("agentConfigReport()", () => {
    const update = (
      outcome: "added" | "present" | "conflict" | "changed" | "unreadable",
      existing?: string,
    ) => ({
      harness: "Claude Code",
      path: "/h/.claude/settings.json",
      outcome,
      ...(existing !== undefined ? { existing } : {}),
    });

    it("says the harness carries the key file", () => {
      expect(agentConfigReport(update("added"), "/k.json")).toContain(
        "Claude Code passes CF_TEST_RECORDS_KEY_FILE",
      );
      expect(agentConfigReport(update("present"), "/k.json")).toContain(
        "already passes the key file on",
      );
    });

    it("quotes back a value it would not write over", () => {
      const report = agentConfigReport(update("conflict", "/other"), "/k.json");
      expect(report).toContain("/other");
      expect(report).toContain("Left alone.");
    });

    it("says nothing was written when the file moved under it", () => {
      expect(agentConfigReport(update("changed"), "/k.json")).toContain(
        "changed while this was writing",
      );
    });

    it("hands back the line to add when the file does not parse", () => {
      expect(agentConfigReport(update("unreadable"), "/k.json")).toContain(
        '"CF_TEST_RECORDS_KEY_FILE": "/k.json"',
      );
    });
  });

  describe("agentRemovalReport()", () => {
    const removal = (
      outcome: "removed" | "kept" | "changed" | "unreadable",
      existing?: string,
    ) => ({
      harness: "Claude Code",
      path: "/h/.claude/settings.json",
      outcome,
      ...(existing !== undefined ? { existing } : {}),
    });

    it("says the harness has stopped carrying the key file", () => {
      expect(agentRemovalReport(removal("removed"))).toContain(
        "no longer passes CF_TEST_RECORDS_KEY_FILE on",
      );
    });

    it("says why a value stayed", () => {
      const report = agentRemovalReport(removal("kept", "/other"));
      expect(report).toContain("/other");
      expect(report).toContain("not the key this tool installed");
    });

    it("says nothing was written when the file moved under it", () => {
      expect(agentRemovalReport(removal("changed"))).toContain(
        "changed while this was writing",
      );
    });

    it("says what to do by hand when the file does not parse", () => {
      expect(agentRemovalReport(removal("unreadable"))).toContain(
        'out of its "env" by hand',
      );
    });
  });

  describe("runCli()", () => {
    it("returns 2 and prints usage for a command it does not have", async () => {
      withStub({});
      expect(await runCli(["wat"], deps)).toBe(2);
      expect(await runCli([], deps)).toBe(2);
    });

    it("returns 2 for an argument the command does not take", async () => {
      withStub({});
      expect(await runCli(["setup", "--wat"], deps)).toBe(2);
      expect(await runCli(["request", "--wat"], deps)).toBe(2);
      expect(await runCli(["collect", "--wat"], deps)).toBe(2);
      expect(await runCli(["uninstall", "--wat"], deps)).toBe(2);
    });

    it("runs uninstall", async () => {
      withStub({});
      expect(await runCli(["uninstall"], deps)).toBe(0);
    });

    it("returns 1 and reports a failure a person can hit", async () => {
      withStub({});
      expect(await runCli(["collect"], deps)).toBe(1);
    });

    it("returns what the command it ran returned", async () => {
      const identity = await storeIdentity();
      const published = await delivery(identity);
      withStub({ runPages: [[mintRun(identity.recipient)]], ...published });

      expect(await runCli(["setup"], deps)).toBe(0);
      expect(await runCli(["request"], deps)).toBe(0);
    });

    it("lets a fault in the tool keep its stack", async () => {
      await storeIdentity();
      withStub({});
      deps.githubToken = () => Promise.reject(new RangeError("bug"));

      await expect(runCli(["collect"], deps)).rejects.toThrow(RangeError);
    });
  });
});
