// Drives `cf ingest` in-process through the exported cliffy command against a
// stubbed fetch, so the option validation, the space resolution and every
// rendering path are exercised without a live toolshed. The HTTP/signing layer
// underneath is covered by test/ingest-channels.test.ts.
//
// `.reset().throwErrors()` moves cliffy's internal pointer back to the root
// (the `.command()` chain leaves it on the last subcommand) and makes
// ValidationError propagate out of `.parse()` instead of printing help and
// calling `Deno.exit(1)` — the same failure, minus the process exit and the
// help spew.

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import { Identity } from "@commonfabric/identity";
import { decode } from "@commonfabric/utils/encoding";
import { ingest } from "../commands/ingest.ts";
import { resolveSpaceDid } from "../lib/ingest-channels.ts";
import { stripAnsi, withEnv } from "./utils.ts";

const API_URL = "http://ingest-command-test.invalid:9999";
const SPACE_DID = "did:key:z6MkIngestCommandTestSpaceAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_DID = "did:key:z6MkIngestCommandTestSpaceBBBBBBBBBBBBBBBBBBBBBB";

ingest.reset().throwErrors();

let tmpRoot: string;
let keyPath: string;

interface RecordedRequest {
  verb: string;
  body: Record<string, unknown>;
}

/**
 * Runs `fn` with `globalThis.fetch` answering every control-plane verb with
 * `replies[verb]`, and always puts the real fetch back.
 */
async function withStubbedFetch<T>(
  replies: Record<string, unknown>,
  fn: (calls: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: RecordedRequest[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const verb = url.pathname.split("/").at(-1)!;
    calls.push({
      verb,
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
    });
    return Promise.resolve(
      new Response(JSON.stringify(replies[verb] ?? {}), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Parse `argv`, capturing everything the command prints. `render()` writes
 * straight to stdout; @cliffy/table goes through console.log.
 */
async function run(
  argv: string[],
  replies: Record<string, unknown> = {},
): Promise<{ output: string; calls: RecordedRequest[] }> {
  const chunks: string[] = [];
  const originalWrite = Deno.stdout.writeSync;
  const originalLog = console.log;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    chunks.push(decode(data));
    return data.length;
  };
  console.log = (...args: unknown[]) => {
    chunks.push(`${args.map(String).join(" ")}\n`);
  };
  try {
    const calls = await withStubbedFetch(replies, async (calls) => {
      await ingest.parse(argv);
      return calls;
    });
    return { output: stripAnsi(chunks.join("")), calls };
  } finally {
    Deno.stdout.writeSync = originalWrite;
    console.log = originalLog;
  }
}

/** Asserts `argv` fails with a ValidationError carrying `message`. */
async function expectValidationError(
  argv: string[],
  message: string,
): Promise<void> {
  const error = await ingest.parse(argv).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as Error).message).toContain(message);
}

const minted = {
  id: "chan-1",
  url: `${API_URL}/api/ingest/chan-1`,
  space: SPACE_DID,
  causePrefix: "ingest/phone-1",
  installId: "phone-1",
  token: "tok-secret",
  expiresAt: "2026-11-02T00:00:00.000Z",
};

function channel(overrides: Record<string, unknown>) {
  return {
    id: "chan-1",
    name: "Phone",
    space: SPACE_DID,
    causePrefix: "ingest/phone-1",
    installId: "phone-1",
    sink: "journal",
    createdAt: "2026-08-01T00:00:00.000Z",
    enabled: true,
    lastSeenAt: null,
    revision: 3,
    ...overrides,
  };
}

beforeAll(async () => {
  tmpRoot = await Deno.makeTempDir({ prefix: "cli-ingest-command-" });
  keyPath = `${tmpRoot}/id.key`;
  await Deno.writeFile(keyPath, await Identity.generatePkcs8());
});

afterAll(async () => {
  await Deno.remove(tmpRoot, { recursive: true }).catch(() => {});
});

describe("cf ingest option validation", () => {
  it("rejects a missing identity", async () => {
    await withEnv("CF_IDENTITY", undefined, async () => {
      await expectValidationError(
        ["ls", "--api-url", API_URL],
        'Missing required option: "--identity", or "CF_IDENTITY".',
      );
    });
  });

  it("rejects a missing api-url", async () => {
    await withEnv("CF_API_URL", undefined, async () => {
      await expectValidationError(
        ["ls", "--identity", keyPath],
        'Missing required option: "--api-url", or "CF_API_URL".',
      );
    });
  });

  it("rejects mint without a space", async () => {
    await expectValidationError(
      [
        "mint",
        "--identity",
        keyPath,
        "--api-url",
        API_URL,
        "--install-id",
        "p",
      ],
      'Missing required option: "--space".',
    );
  });

  it("rejects mint without an install id", async () => {
    await expectValidationError(
      [
        "mint",
        "--identity",
        keyPath,
        "--api-url",
        API_URL,
        "--space",
        SPACE_DID,
      ],
      'Missing required option: "--install-id".',
    );
  });
});

describe("cf ingest mint", () => {
  it("resolves the space, sends a request id, and prints the token once", async () => {
    const { output, calls } = await run([
      "mint",
      "--identity",
      keyPath,
      "--api-url",
      API_URL,
      "--space",
      "ingest-command-space",
      "--install-id",
      "phone-1",
      "--cause-prefix",
      "ingest/phone-1",
      "--name",
      "Phone",
      "--ttl-days",
      "30",
    ], {
      mint: { ...minted, expiresAt: "2026-09-03T00:00:00.000Z" },
    });

    expect(calls.length).toBe(1);
    expect(calls[0].verb).toBe("mint");
    // A NAME on the command line reaches the server as a resolved DID.
    expect(calls[0].body.space).toBe(
      await resolveSpaceDid(keyPath, "ingest-command-space"),
    );
    expect(calls[0].body.installId).toBe("phone-1");
    expect(calls[0].body.causePrefix).toBe("ingest/phone-1");
    expect(calls[0].body.name).toBe("Phone");
    expect(calls[0].body.ttlDays).toBe(30);
    // A fresh idempotency key is minted per invocation, not left to the caller.
    expect(typeof calls[0].body.requestId).toBe("string");
    expect((calls[0].body.requestId as string).length).toBeGreaterThan(0);

    expect(output).toContain("Ingest channel minted.");
    expect(output).toContain("id:          chan-1");
    expect(output).toContain("installId:   phone-1");
    expect(output).toContain(`URL:         ${API_URL}/api/ingest/chan-1`);
    expect(output).toContain("expires:     2026-09-03T00:00:00.000Z");
    expect(output).toContain("token (shown once");
    expect(output).toContain("Authorization: Bearer <token>");
    expect(output).toContain("tok-secret");
  });

  it("forwards a did:key space verbatim and always shows an expiry", async () => {
    // Every self-serve credential is finite-lived, so the expiry line is always
    // present: the server applies a default when no --ttl-days is given.

    const { output, calls } = await run([
      "mint",
      "--identity",
      keyPath,
      "--api-url",
      API_URL,
      "--space",
      SPACE_DID,
      "--install-id",
      "phone-1",
    ], { mint: minted });

    // A did:key --space is forwarded verbatim — no derivation in the way.
    expect(calls[0].body.space).toBe(SPACE_DID);
    expect(calls[0].body.causePrefix).toBeUndefined();
    expect(output).toContain("Ingest channel minted.");
    // The VALUE, not the label: the label prints unconditionally, so asserting
    // it alone would pass just as happily against a server that dropped the
    // field entirely.
    expect(output).toContain("expires:     2026-11-02T00:00:00.000Z");
  });

  it("says so loudly when a mint response carries no expiry", async () => {
    // The server always sets an expiry, so a response without one means the two
    // sides disagree about the contract. Printing a bare blank there would hide
    // that behind something that reads like "never expires" — the opposite of
    // the truth.

    const { expiresAt: _dropped, ...noExpiry } = minted;
    const { output } = await run([
      "mint",
      "--identity",
      keyPath,
      "--api-url",
      API_URL,
      "--space",
      SPACE_DID,
      "--install-id",
      "phone-1",
    ], { mint: noExpiry });

    expect(output).toContain("unexpected");
  });
});

describe("cf ingest ls", () => {
  it("says so when there is nothing to list", async () => {
    const { output, calls } = await run(
      ["ls", "--identity", keyPath, "--api-url", API_URL],
      { list: { channels: [] } },
    );
    expect(calls[0].verb).toBe("list");
    // No --space means no filter is sent at all.
    expect(calls[0].body).toEqual({});
    expect(output).toContain("No ingest channels found.");
  });

  it("renders one row per channel with its state and last-seen time", async () => {
    const { output } = await run(
      ["ls", "--identity", keyPath, "--api-url", API_URL],
      {
        list: {
          channels: [
            channel({ id: "chan-active", lastSeenAt: "2026-08-03T09:00:00Z" }),
            channel({ id: "chan-off", enabled: false }),
            channel({
              id: "chan-gone",
              installId: "phone-2",
              space: OTHER_DID,
              revoked: { at: "2026-08-02T00:00:00Z", by: "did:key:zOwner" },
            }),
          ],
        },
      },
    );

    for (
      const header of ["ID", "INSTALL", "SPACE", "STATE", "LAST SEEN"]
    ) {
      expect(output).toContain(header);
    }
    expect(output).toContain("chan-active");
    expect(output).toContain("active");
    expect(output).toContain("chan-off");
    expect(output).toContain("disabled");
    // A revoked channel reads as revoked even though `enabled` is still true —
    // the registration is retained as an audit record, so both flags are set.
    expect(output).toContain("chan-gone");
    expect(output).toContain("revoked");
    expect(output).toContain(OTHER_DID);
    expect(output).toContain("2026-08-03T09:00:00Z");
    expect(output).toContain("never");
  });

  it("resolves a --space name into the DID it filters on", async () => {
    const { calls } = await run(
      [
        "ls",
        "--identity",
        keyPath,
        "--api-url",
        API_URL,
        "--space",
        "ingest-command-space",
      ],
      { list: { channels: [] } },
    );
    expect(calls[0].body.space).toBe(
      await resolveSpaceDid(keyPath, "ingest-command-space"),
    );
  });
});

describe("cf ingest rotate", () => {
  it("prints the new token and what a device holding the old one sees", async () => {
    const { output, calls } = await run([
      "rotate",
      "chan-1",
      "--identity",
      keyPath,
      "--api-url",
      API_URL,
      "--ttl-days",
      "7",
    ], { rotate: { ...minted, token: "tok-rotated" } });

    expect(calls[0].verb).toBe("rotate");
    expect(calls[0].body.id).toBe("chan-1");
    expect(calls[0].body.ttlDays).toBe(7);
    expect(typeof calls[0].body.requestId).toBe("string");

    expect(output).toContain("The previous token stopped working.");
    expect(output).toContain("re-pair this device");
    expect(output).toContain("Ingest channel rotated.");
    expect(output).toContain("tok-rotated");
  });
});

describe("cf ingest revoke", () => {
  it("reports the revocation time and that the record is kept", async () => {
    const { output, calls } = await run([
      "revoke",
      "chan-1",
      "--identity",
      keyPath,
      "--api-url",
      API_URL,
    ], {
      list: { channels: [channel({ revision: 7 })] },
      revoke: { id: "chan-1", revokedAt: "2026-08-04T12:00:00.000Z" },
    });

    // Read before write: revoke names the generation the caller looked at.
    expect(calls.map((c) => c.verb)).toEqual(["list", "revoke"]);
    expect(calls[1].body.id).toBe("chan-1");
    expect(calls[1].body.expectedRevision).toBe(7);
    // Plus a fresh idempotency key, spent server-side in the same transaction
    // as the write, so a revoke that WAS delivered cannot be replayed.
    expect(calls[1].body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(output).toContain("Revoked chan-1 at 2026-08-04T12:00:00.000Z.");
    expect(output).toContain("retained as an audit record");
  });

  it("looks a foreign channel up in the space when --space is given", async () => {
    // The whole point of revocation-by-current-owner is a channel minted by
    // someone whose access has since been removed. That channel has a different
    // owner, so it is NOT in the caller's own list — looking the revision up
    // there would make the one case this exists for unreachable.

    const { calls } = await run([
      "revoke",
      "chan-1",
      "--identity",
      keyPath,
      "--api-url",
      API_URL,
      "--space",
      SPACE_DID,
    ], {
      list: { channels: [channel({ owner: "did:key:zSomeoneElse" })] },
      revoke: { id: "chan-1", revokedAt: "2026-08-04T12:00:00.000Z" },
    });

    expect(calls[0].verb).toBe("list");
    expect(calls[0].body.space).toBe(SPACE_DID);
    expect(calls[1].body.expectedRevision).toBe(3);
  });

  it("says a channel was already revoked before re-issuing", async () => {
    // Revoking an already-revoked channel is a legitimate confirm, not an error
    // — and the CLI has to say which it is, or "it worked" and "it was already
    // dead" are indistinguishable.

    const { output, calls } = await run([
      "revoke",
      "chan-1",
      "--identity",
      keyPath,
      "--api-url",
      API_URL,
    ], {
      list: {
        channels: [
          channel({
            revision: 9,
            enabled: false,
            revoked: { at: "2026-08-01T09:00:00.000Z", by: "did:key:zOther" },
          }),
        ],
      },
      revoke: {
        id: "chan-1",
        revokedAt: "2026-08-01T09:00:00.000Z",
        revision: 10,
      },
    });

    expect(output).toContain("was already revoked at 2026-08-01T09:00:00.000Z");
    // It still re-issues, binding to the generation it just read.
    expect(calls[1].body.expectedRevision).toBe(9);
    expect(output).toContain("retained as an audit record");
  });

  it("refuses to revoke an id that is not among the caller's channels", async () => {
    await expect(
      run([
        "revoke",
        "chan-missing",
        "--identity",
        keyPath,
        "--api-url",
        API_URL,
      ], { list: { channels: [channel({})] } }),
    ).rejects.toThrow("No ingest channel chan-missing");
  });
});
