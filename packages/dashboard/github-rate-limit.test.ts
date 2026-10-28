import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type GitHubPrimaryRateLimit,
  GitHubRateLimitBudget,
  GitHubRateLimitBudgetError,
  type GitHubRateLimitLedgerLock,
} from "./github-rate-limit.ts";
import { dashboardCacheFile } from "./history-files.ts";
import { staticGitHubCredential } from "./github-auth.ts";
import {
  friendlyError,
  github,
  githubDownload,
  performanceGithub,
  performanceGithubDownload,
} from "./lib.ts";

const RESET = 2_000_000_000;

function primary(
  used: number,
  limit = 100,
  reset = RESET,
): GitHubPrimaryRateLimit {
  return { limit, used, remaining: limit - used, reset };
}

function rateHeaders(used: number, limit = 100, reset = RESET): HeadersInit {
  return {
    "x-ratelimit-resource": "core",
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-used": String(used),
    "x-ratelimit-remaining": String(limit - used),
    "x-ratelimit-reset": String(reset),
  };
}

function ledgerLock(overrides: Partial<GitHubRateLimitLedgerLock> = {}) {
  return {
    lock: () => Promise.resolve(),
    unlock: () => Promise.resolve(),
    close: () => {},
    ...overrides,
  };
}

function fakeLease(overrides: Record<string, unknown> = {}): Deno.FsFile {
  return {
    lock: () => Promise.resolve(),
    unlock: () => Promise.resolve(),
    tryLock: () => Promise.resolve(true),
    close: () => {},
    ...overrides,
  } as unknown as Deno.FsFile;
}

async function tokenKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

Deno.test("GitHub performance budget rejects invalid configuration", () => {
  for (const fraction of [0, 1.1, Number.NaN]) {
    assertThrows(
      () => new GitHubRateLimitBudget({ fraction }),
      RangeError,
      "fraction must be above 0 and at most 1",
    );
  }
  for (const restPointsPerMinute of [0, 1.5]) {
    assertThrows(
      () => new GitHubRateLimitBudget({ restPointsPerMinute }),
      RangeError,
      "REST points per minute must be a positive integer",
    );
  }
});

Deno.test("GitHub performance budget rejects every malformed primary field", async () => {
  const malformed: GitHubPrimaryRateLimit[] = [
    { limit: 0, used: 0, remaining: 0, reset: RESET },
    { limit: 100, used: -1, remaining: 100, reset: RESET },
    { limit: 100, used: 0, remaining: -1, reset: RESET },
    { limit: 100, used: 0, remaining: 101, reset: RESET },
    { limit: 100, used: 0, remaining: 100, reset: 0 },
  ];
  for (const [index, value] of malformed.entries()) {
    const budget = new GitHubRateLimitBudget();
    await assertRejects(
      () => budget.reserve(`invalid-${index}`, () => Promise.resolve(value)),
      GitHubRateLimitBudgetError,
      "rate limit status was invalid",
    );
  }
});

Deno.test("GitHub performance budget reports rejected in-memory probes", async () => {
  for (
    const [index, reason] of [new Error("offline"), "disconnected"].entries()
  ) {
    const budget = new GitHubRateLimitBudget();
    await assertRejects(
      () => budget.reserve(`rejected-${index}`, () => Promise.reject(reason)),
      GitHubRateLimitBudgetError,
      String(reason instanceof Error ? reason.message : reason),
    );
  }
});

Deno.test("GitHub performance budget handles incomplete and older response headers", async () => {
  const budget = new GitHubRateLimitBudget({ now: () => 1_900_000_000_000 });
  const first = await budget.reserve(
    "token",
    () => Promise.resolve(primary(0, 100, RESET + 10)),
  );
  await first.complete(new Response(null));
  await first.complete(new Response(null));

  const second = await budget.reserve(
    "token",
    () => Promise.resolve(primary(0, 100, RESET + 10)),
  );
  await second.complete(
    new Response(null, {
      headers: rateHeaders(1, 100, RESET),
    }),
  );
  const third = await budget.reserve(
    "token",
    () => Promise.resolve(primary(0, 100, RESET + 10)),
  );
  await third.complete(
    new Response(null, {
      headers: {
        "x-ratelimit-resource": "core",
        "x-ratelimit-limit": "",
      },
    }),
  );
});

Deno.test("GitHub performance budget rejects malformed stored ledgers", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const key = "a".repeat(64);
  const cases: unknown[] = [
    null,
    { version: 2, tokens: [] },
    { version: 1, tokens: {} },
    { version: 1, tokens: [null] },
    {
      version: 1,
      tokens: [{ key, primary: null, reservations: [], requestTimes: [] }],
    },
    {
      version: 1,
      tokens: [{ key, reservations: [null], requestTimes: [] }],
    },
    {
      version: 1,
      tokens: [
        { key, reservations: [], requestTimes: [] },
        { key, reservations: [], requestTimes: [] },
      ],
    },
  ];
  try {
    for (const [index, value] of cases.entries()) {
      const file = `${directory}/${index}.json`;
      await Deno.writeTextFile(file, JSON.stringify(value));
      const budget = new GitHubRateLimitBudget({ file });
      await assertRejects(
        () => budget.reserve("token", () => Promise.resolve(primary(0))),
        GitHubRateLimitBudgetError,
        "ledger was invalid",
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance budget rejects an invalid stored probe", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  try {
    const budget = new GitHubRateLimitBudget({
      file: `${directory}/ledger.json`,
    });
    await assertRejects(
      () => budget.reserve("token", () => Promise.resolve(primary(0, 0))),
      GitHubRateLimitBudgetError,
      "rate limit status was invalid",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance ledger preserves write failures during cleanup", async () => {
  for (const cleanupFails of [false, true]) {
    const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
    const file = `${directory}/ledger.json`;
    const rename = Deno.rename;
    const remove = Deno.remove;
    try {
      Deno.rename = (() =>
        Promise.reject(new Error("rename failed"))) as typeof Deno.rename;
      Deno.remove = ((path, options) =>
        cleanupFails && String(path).endsWith(".tmp")
          ? Promise.reject(new Error("remove failed"))
          : remove(path, options)) as typeof Deno.remove;
      const budget = new GitHubRateLimitBudget({ file });
      await assertRejects(
        () =>
          budget.reserve("token", () =>
            Promise.resolve(primary(0))),
        GitHubRateLimitBudgetError,
        "rename failed",
      );
    } finally {
      Deno.rename = rename;
      Deno.remove = remove;
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("GitHub performance ledger reports lock cleanup failures", async () => {
  for (const stage of ["unlock", "close"] as const) {
    const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
    try {
      const budget = new GitHubRateLimitBudget({
        file: `${directory}/ledger.json`,
        openLedgerLock: () =>
          Promise.resolve(ledgerLock({
            unlock: () =>
              stage === "unlock"
                ? Promise.reject(new Error("unlock failed"))
                : Promise.resolve(),
            close: () => {
              if (stage === "close") throw new Error("close failed");
            },
          })),
      });
      await assertRejects(
        () => budget.reserve("token", () => Promise.resolve(primary(0))),
        GitHubRateLimitBudgetError,
        `${stage} failed`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("GitHub performance ledger cleans up a reservation lease that cannot lock", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const open = Deno.open;
  try {
    Deno.open = (() =>
      Promise.resolve(fakeLease({
        lock: () => Promise.reject(new Error("lease lock failed")),
      }))) as typeof Deno.open;
    const budget = new GitHubRateLimitBudget({
      file: `${directory}/ledger.json`,
      openLedgerLock: () => Promise.resolve(ledgerLock()),
    });
    await assertRejects(
      () => budget.reserve("token", () => Promise.resolve(primary(0))),
      GitHubRateLimitBudgetError,
      "lease lock failed",
    );
  } finally {
    Deno.open = open;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance ledger reports reservation close failures", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const open = Deno.open;
  const remove = Deno.remove;
  try {
    Deno.open = (() =>
      Promise.resolve(fakeLease({
        unlock: () => Promise.reject(new Error("lease unlock failed")),
        close: () => {
          throw new Error("lease close failed");
        },
      }))) as typeof Deno.open;
    Deno.remove = ((path, options) =>
      String(path).endsWith(".reservation.lock")
        ? Promise.reject(new Error("lease remove failed"))
        : remove(path, options)) as typeof Deno.remove;
    const budget = new GitHubRateLimitBudget({
      file: `${directory}/ledger.json`,
      openLedgerLock: () =>
        Promise.resolve(ledgerLock()),
    });
    const reservation = await budget.reserve(
      "token",
      () => Promise.resolve(primary(0)),
    );
    await assertRejects(
      () => Promise.resolve(reservation.complete()),
      GitHubRateLimitBudgetError,
      "lease unlock failed",
    );
  } finally {
    Deno.open = open;
    Deno.remove = remove;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance ledger reports failed rejected-reservation cleanup", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const open = Deno.open;
  try {
    Deno.open = (() =>
      Promise.resolve(fakeLease({
        unlock: () => Promise.reject(new Error("lease unlock failed")),
      }))) as typeof Deno.open;
    const budget = new GitHubRateLimitBudget({
      file: `${directory}/ledger.json`,
      openLedgerLock: () => Promise.resolve(ledgerLock()),
    });
    await assertRejects(
      () => budget.reserve("token", () => Promise.resolve(primary(80))),
      GitHubRateLimitBudgetError,
      "lease unlock failed",
    );
  } finally {
    Deno.open = open;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance ledger reports failed abandoned-reservation cleanup", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const open = Deno.open;
  try {
    Deno.open = (() =>
      Promise.resolve(fakeLease({
        unlock: () => Promise.reject(new Error("lease unlock failed")),
        close: () => {
          throw new Error("lease close failed");
        },
      }))) as typeof Deno.open;
    const budget = new GitHubRateLimitBudget({
      file,
      openLedgerLock: () => Promise.resolve(ledgerLock()),
    });
    const reservation = await budget.reserve(
      "token",
      () => Promise.resolve(primary(0)),
    );
    await Deno.writeTextFile(file, "{invalid");
    await assertRejects(
      () => Promise.resolve(reservation.complete()),
      GitHubRateLimitBudgetError,
      "lease unlock failed",
    );
  } finally {
    Deno.open = open;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance ledger closes a lease after its write rolls back", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const rename = Deno.rename;
  let renames = 0;
  try {
    Deno.rename = ((oldpath, newpath) => {
      renames++;
      return renames === 3
        ? Promise.reject(new Error("reservation write failed"))
        : rename(oldpath, newpath);
    }) as typeof Deno.rename;
    const budget = new GitHubRateLimitBudget({ file });
    await assertRejects(
      () => budget.reserve("token", () => Promise.resolve(primary(0))),
      GitHubRateLimitBudgetError,
      "reservation write failed",
    );
    assertEquals(
      [...Deno.readDirSync(directory)].some((entry) =>
        entry.name.endsWith(".reservation.lock")
      ),
      false,
    );
  } finally {
    Deno.rename = rename;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance ledger reports reservation liveness failures", async () => {
  for (const stage of ["open", "lock"] as const) {
    const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
    const file = `${directory}/ledger.json`;
    const token = `token-${stage}`;
    const open = Deno.open;
    try {
      await Deno.writeTextFile(
        file,
        JSON.stringify({
          version: 1,
          tokens: [{
            key: await tokenKey(token),
            reservations: [{ id: "expired", resetAt: 1 }],
            requestTimes: [],
          }],
        }),
      );
      Deno.open = (() =>
        stage === "open"
          ? Promise.reject(new Error("lease open failed"))
          : Promise.resolve(fakeLease({
            tryLock: () =>
              Promise.reject(new Error("lease lock failed")),
          }))) as typeof Deno.open;
      const budget = new GitHubRateLimitBudget({
        file,
        now: () => 2,
        openLedgerLock: () => Promise.resolve(ledgerLock()),
      });
      await assertRejects(
        () => budget.reserve(token, () => Promise.resolve(primary(0))),
        GitHubRateLimitBudgetError,
        `lease ${stage} failed`,
      );
    } finally {
      Deno.open = open;
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("GitHub performance ledger treats a missing reservation lease as expired", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const token = "missing-lease";
  const open = Deno.open;
  try {
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        version: 1,
        tokens: [{
          key: await tokenKey(token),
          reservations: [{ id: "expired", resetAt: 1 }],
          requestTimes: [],
        }],
      }),
    );
    Deno.open = (() =>
      Promise.reject(new Deno.errors.NotFound())) as typeof Deno.open;
    const budget = new GitHubRateLimitBudget({
      file,
      now: () => 2,
      openLedgerLock: () => Promise.resolve(ledgerLock()),
    });
    await assertRejects(
      () => budget.reserve(token, () => Promise.resolve(primary(0))),
      GitHubRateLimitBudgetError,
    );
  } finally {
    Deno.open = open;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance ledger reports an expired-lease removal failure", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const token = "expired-removal";
  const open = Deno.open;
  const remove = Deno.remove;
  try {
    await Deno.writeTextFile(
      file,
      JSON.stringify({
        version: 1,
        tokens: [{
          key: await tokenKey(token),
          reservations: [{ id: "expired", resetAt: 1 }],
          requestTimes: [],
        }],
      }),
    );
    Deno.open = (() => Promise.resolve(fakeLease())) as typeof Deno.open;
    Deno.remove = ((path, options) =>
      String(path).endsWith(".reservation.lock")
        ? Promise.reject(new Error("lease remove failed"))
        : remove(path, options)) as typeof Deno.remove;
    const budget = new GitHubRateLimitBudget({
      file,
      now: () =>
        2,
      openLedgerLock: () => Promise.resolve(ledgerLock()),
    });
    await assertRejects(
      () => budget.reserve(token, () => Promise.resolve(primary(0))),
      GitHubRateLimitBudgetError,
      "lease remove failed",
    );
  } finally {
    Deno.open = open;
    Deno.remove = remove;
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance budget rejects a primary window that expires during its probe", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  let now = 1_900_000_000_000;
  try {
    const budget = new GitHubRateLimitBudget({
      file: `${directory}/ledger.json`,
      now: () => now,
    });
    await assertRejects(
      () =>
        budget.reserve("token", () => {
          now = RESET * 1_000;
          return Promise.resolve(primary(0));
        }),
      GitHubRateLimitBudgetError,
      "rate limit status expired before the request started",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance reservation completion is idempotent", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  try {
    const budget = new GitHubRateLimitBudget({
      file: `${directory}/ledger.json`,
    });
    const reservation = await budget.reserve(
      "token",
      () => Promise.resolve(primary(0)),
    );
    await reservation.complete();
    await reservation.complete();
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance ledger serializes concurrent reservations before taking file locks", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  let held = false;
  let overlapping = false;
  let lockCount = 0;
  const budget = new GitHubRateLimitBudget({
    file,
    now: () => 1_900_000_000_000,
    openLedgerLock: () =>
      Promise.resolve({
        async lock() {
          lockCount++;
          if (held) {
            overlapping = true;
            throw new Error("concurrent ledger lock attempt");
          }
          held = true;
          await Promise.resolve();
        },
        unlock() {
          held = false;
          return Promise.resolve();
        },
        close() {},
      }),
  });
  const probe = () => Promise.resolve(primary(0, 5_000));
  try {
    const reservations = await Promise.all(
      Array.from({ length: 48 }, () => budget.reserve("token", probe)),
    );
    await Promise.all(
      reservations.map((reservation) => reservation.complete()),
    );
    assertEquals(overlapping, false);
    assertEquals(held, false);
    assertEquals(lockCount > 48, true);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

async function readLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  try {
    while (!value.includes("\n")) {
      const next = await reader.read();
      if (next.done) {
        throw new Error("child process closed before it was ready");
      }
      value += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return value.slice(0, value.indexOf("\n"));
}

Deno.test("GitHub performance budget reserves concurrent requests below the 80% ceiling", async () => {
  const budget = new GitHubRateLimitBudget({ now: () => 1_900_000_000_000 });
  let probes = 0;
  const probe = () => {
    probes++;
    return Promise.resolve(primary(78));
  };

  const first = await budget.reserve("token", probe);
  const second = await budget.reserve("token", probe);
  const error = await assertRejects(
    () => budget.reserve("token", probe),
    GitHubRateLimitBudgetError,
  );
  assertStringIncludes(
    error.message,
    "80% performance-history safety threshold",
  );
  assertEquals(probes, 3);

  await second.complete(new Response(null, { headers: rateHeaders(80) }));
  await first.complete(new Response(null, { headers: rateHeaders(79) }));
  await assertRejects(
    () => budget.reserve("token", probe),
    GitHubRateLimitBudgetError,
  );
});

Deno.test("GitHub performance budget reads a new primary window after reset", async () => {
  let now = 1_900_000_000_000;
  const budget = new GitHubRateLimitBudget({ now: () => now });
  let probes = 0;
  const reservation = await budget.reserve("token", () => {
    probes++;
    return Promise.resolve(primary(0, 100, 1_900_000_001));
  });
  await reservation.complete(
    new Response(null, { headers: rateHeaders(1, 100, 1_900_000_001) }),
  );

  now = 1_900_000_001_000;
  const next = await budget.reserve("token", () => {
    probes++;
    return Promise.resolve(primary(0, 200, 1_900_000_100));
  });
  await next.complete(
    new Response(null, { headers: rateHeaders(1, 200, 1_900_000_100) }),
  );
  assertEquals(probes, 2);
});

Deno.test("GitHub performance budget also keeps REST request points below 80% per minute", async () => {
  const budget = new GitHubRateLimitBudget({
    now: () => 1_900_000_000_000,
    restPointsPerMinute: 5,
  });
  const probe = () => Promise.resolve(primary(0));

  for (let request = 0; request < 2; request++) {
    const reservation = await budget.reserve("token", probe);
    await reservation.complete(
      new Response(null, { headers: rateHeaders(request + 1) }),
    );
  }
  const error = await assertRejects(
    () => budget.reserve("token", probe),
    GitHubRateLimitBudgetError,
  );
  assertStringIncludes(error.message, "REST request points");
});

Deno.test("GitHub performance budget uses the most conservative primary fields", async () => {
  const budget = new GitHubRateLimitBudget({ now: () => 1_900_000_000_000 });
  await assertRejects(
    () =>
      budget.reserve("token", () =>
        Promise.resolve({
          limit: 100,
          used: 0,
          remaining: 0,
          reset: RESET,
        })),
    GitHubRateLimitBudgetError,
    "80% performance-history safety threshold",
  );
});

Deno.test("GitHub performance reservations are shared by budget instances", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const options = { now: () => 1_900_000_000_000, file };
  const firstBudget = new GitHubRateLimitBudget(options);
  const secondBudget = new GitHubRateLimitBudget(options);
  let probes = 0;
  const probe = () => {
    probes++;
    return Promise.resolve(primary(78));
  };
  try {
    const first = await firstBudget.reserve("shared-token", probe);
    const second = await secondBudget.reserve("shared-token", probe);
    await assertRejects(
      () => secondBudget.reserve("shared-token", probe),
      GitHubRateLimitBudgetError,
      "80% performance-history safety threshold",
    );
    assertEquals(probes, 3);
    assertEquals(
      (await Deno.readTextFile(file)).includes("shared-token"),
      false,
    );
    await Promise.all([
      first.complete(new Response(null, { headers: rateHeaders(79) })),
      second.complete(new Response(null, { headers: rateHeaders(80) })),
    ]);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance reservations are shared by dashboard processes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const module = new URL("./github-rate-limit.ts", import.meta.url).href;
  const token = `process-token-${crypto.randomUUID()}`;
  const now = 1_900_000_000_000;
  const childCode = `
    const { GitHubRateLimitBudget } = await import(${JSON.stringify(module)});
    const budget = new GitHubRateLimitBudget({
      file: ${JSON.stringify(file)},
      now: () => ${now},
    });
    const reservation = await budget.reserve(
      ${JSON.stringify(token)},
      () => Promise.resolve({
        limit: 100,
        used: 79,
        remaining: 21,
        reset: ${RESET},
      }),
    );
    console.log("reserved");
    await Deno.stdin.readable.getReader().read();
    await reservation.complete();
  `;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", childCode],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const childError = new Response(child.stderr).text();
  let inputError: unknown;
  let status: Deno.CommandStatus | undefined;
  let stderr = "";
  try {
    assertEquals(await readLine(child.stdout), "reserved");
    const budget = new GitHubRateLimitBudget({ file, now: () => now });
    await assertRejects(
      () => budget.reserve(token, () => Promise.resolve(primary(79))),
      GitHubRateLimitBudgetError,
      "80% performance-history safety threshold",
    );
  } finally {
    try {
      const childInput = child.stdin.getWriter();
      await childInput.write(new Uint8Array([10]));
      await childInput.close();
    } catch (error) {
      inputError = error;
    }
    [status, stderr] = await Promise.all([child.status, childError]);
    await Deno.remove(directory, { recursive: true });
  }
  if (inputError) throw inputError;
  assertEquals(status?.success, true, stderr);
});

Deno.test("GitHub performance reservations stay counted across a primary reset", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  let now = 1_900_000_000_000;
  const options = { now: () => now, file };
  const firstBudget = new GitHubRateLimitBudget(options);
  const secondBudget = new GitHubRateLimitBudget(options);
  try {
    const crossing = await firstBudget.reserve(
      "shared-token",
      () => Promise.resolve(primary(79, 100, 1_900_000_001)),
    );
    now = 1_900_000_001_000;
    await assertRejects(
      () =>
        secondBudget.reserve(
          "shared-token",
          () => Promise.resolve(primary(79, 100, 1_900_000_100)),
        ),
      GitHubRateLimitBudgetError,
      "80% performance-history safety threshold",
    );
    await crossing.complete(
      new Response(null, {
        headers: rateHeaders(80, 100, 1_900_000_100),
      }),
    );
    await assertRejects(
      () =>
        secondBudget.reserve(
          "shared-token",
          () => Promise.resolve(primary(80, 100, 1_900_000_100)),
        ),
      GitHubRateLimitBudgetError,
      "80% performance-history safety threshold",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub REST point history survives a dashboard restart", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const options = {
    now: () => 1_900_000_000_000,
    file,
    restPointsPerMinute: 5,
  };
  const probe = () => Promise.resolve(primary(0));
  try {
    const firstBudget = new GitHubRateLimitBudget(options);
    const first = await firstBudget.reserve("shared-token", probe);
    await first.complete(new Response(null, { headers: rateHeaders(1) }));

    const restarted = new GitHubRateLimitBudget(options);
    const reservation = await restarted.reserve("shared-token", probe);
    await reservation.complete(
      new Response(null, { headers: rateHeaders(2) }),
    );
    await assertRejects(
      () => restarted.reserve("shared-token", probe),
      GitHubRateLimitBudgetError,
      "REST request points",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance reservations become recoverable when completion cannot update the ledger", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  let now = 1_900_000_000_000;
  const options = { now: () => now, file };
  const budget = new GitHubRateLimitBudget(options);
  try {
    const reservation = await budget.reserve(
      "shared-token",
      () => Promise.resolve(primary(0, 100, 1_900_000_001)),
    );
    const validLedger = await Deno.readTextFile(file);
    await Deno.writeTextFile(file, "{invalid");
    await assertRejects(
      async () => await reservation.complete(),
      GitHubRateLimitBudgetError,
      "ledger could not be read",
    );
    await Deno.writeTextFile(file, validLedger);

    now = 1_900_000_001_000;
    const restarted = new GitHubRateLimitBudget(options);
    const next = await restarted.reserve(
      "shared-token",
      () => Promise.resolve(primary(0, 100, 1_900_000_100)),
    );
    await next.complete(
      new Response(null, {
        headers: rateHeaders(1, 100, 1_900_000_100),
      }),
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance requests preserve an unreadable shared ledger", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const malformed = "{not json";
  await Deno.writeTextFile(file, malformed);
  let probes = 0;
  const budget = new GitHubRateLimitBudget({ file });
  try {
    await assertRejects(
      () =>
        budget.reserve("shared-token", () => {
          probes++;
          return Promise.resolve(primary(0));
        }),
      GitHubRateLimitBudgetError,
      "ledger could not be read",
    );
    assertEquals(probes, 0);
    assertEquals(await Deno.readTextFile(file), malformed);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("GitHub performance requests fail closed when the ledger cannot be locked", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/missing/ledger.json`;
  const budget = new GitHubRateLimitBudget({ file });
  try {
    await assertRejects(
      () => budget.reserve("shared-token", () => Promise.resolve(primary(0))),
      GitHubRateLimitBudgetError,
      "ledger could not be updated",
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("a rejected performance reservation removes its unused lease", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const budget = new GitHubRateLimitBudget({
    file,
    now: () => 1_900_000_000_000,
  });
  try {
    await assertRejects(
      () => budget.reserve("shared-token", () => Promise.resolve(primary(80))),
      GitHubRateLimitBudgetError,
      "80% performance-history safety threshold",
    );
    const leases: string[] = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name.endsWith(".reservation.lock")) leases.push(entry.name);
    }
    assertEquals(leases, []);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("expired reservation leases remain until their ledger removal commits", async () => {
  const directory = await Deno.makeTempDir({ prefix: "github-rate-limit-" });
  const file = `${directory}/ledger.json`;
  const reset = 1_900_000_001;
  const firstBudget = new GitHubRateLimitBudget({
    file,
    now: () => 1_900_000_000_000,
  });
  try {
    const abandoned = await firstBudget.reserve(
      "shared-token",
      () => Promise.resolve(primary(0, 100, reset)),
    );
    const validLedger = await Deno.readTextFile(file);
    await Deno.writeTextFile(file, "{invalid");
    await assertRejects(
      async () => await abandoned.complete(),
      GitHubRateLimitBudgetError,
      "ledger could not be read",
    );
    const saturated = JSON.parse(validLedger) as {
      tokens: { requestTimes: number[] }[];
    };
    saturated.tokens[0].requestTimes = Array(4).fill(reset * 1_000);
    await Deno.writeTextFile(file, JSON.stringify(saturated));

    const restarted = new GitHubRateLimitBudget({
      file,
      now: () => reset * 1_000,
      restPointsPerMinute: 5,
    });
    await assertRejects(
      () =>
        restarted.reserve("shared-token", () => Promise.resolve(primary(0))),
      GitHubRateLimitBudgetError,
      "REST request points",
    );
    const stored = JSON.parse(await Deno.readTextFile(file)) as {
      tokens: { reservations: unknown[]; requestTimes: number[] }[];
    };
    assertEquals(stored.tokens[0].reservations.length, 1);
    assertEquals(
      [...Deno.readDirSync(directory)].filter((entry) =>
        entry.name.endsWith(".reservation.lock")
      ).length,
      1,
    );

    stored.tokens[0].requestTimes = [];
    await Deno.writeTextFile(file, JSON.stringify(stored));

    const recovered = await restarted.reserve(
      "shared-token",
      () => Promise.resolve(primary(0, 100, reset + 100)),
    );
    await recovered.complete(
      new Response(null, { headers: rateHeaders(1, 100, reset + 100) }),
    );
    assertEquals(
      [...Deno.readDirSync(directory)].filter((entry) =>
        entry.name.endsWith(".reservation.lock")
      ).length,
      0,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("ordinary dashboard GitHub requests stay outside the ledger while the next performance probe refreshes the primary total", async () => {
  const token = `ordinary-request-${crypto.randomUUID()}`;
  const ledgerFile = dashboardCacheFile(
    "fabric-wall-github-rate-limit.json",
  );
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let probes = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    if (url.pathname === "/rate_limit") {
      probes++;
      return Promise.resolve(Response.json({
        resources: { core: primary(probes === 1 ? 0 : 1) },
      }));
    }
    if (url.pathname === "/repos/o/performance-first") {
      return Promise.resolve(Response.json({ performance: true }, {
        headers: rateHeaders(1),
      }));
    }
    if (url.pathname === "/repos/o/ordinary") {
      return Promise.resolve(Response.json({ ordinary: true }, {
        headers: rateHeaders(80),
      }));
    }
    if (url.pathname === "/repos/o/performance") {
      return Promise.resolve(Response.json({ performance: true }, {
        headers: rateHeaders(2),
      }));
    }
    return Promise.resolve(Response.json({ shouldNotBeRead: true }));
  }) as typeof fetch;

  try {
    assertEquals(
      await performanceGithub<{ performance: boolean }>(
        "repos/o/performance-first",
        staticGitHubCredential(token),
      ),
      { performance: true },
    );
    const ledgerBeforeOrdinary = await Deno.readTextFile(ledgerFile);
    assertEquals(
      await github<{ ordinary: boolean }>("repos/o/ordinary", staticGitHubCredential(token)),
      { ordinary: true },
    );
    assertEquals(await Deno.readTextFile(ledgerFile), ledgerBeforeOrdinary);
    assertEquals(
      await performanceGithub<{ performance: boolean }>(
        "repos/o/performance",
        staticGitHubCredential(token),
      ),
      { performance: true },
    );
    assertEquals(calls, [
      "/rate_limit",
      "/repos/o/performance-first",
      "/repos/o/ordinary",
      "/rate_limit",
      "/repos/o/performance",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("performance GitHub requests stop after the rate probe reaches 80%", async () => {
  const token = `rate-limit-test-${crypto.randomUUID()}`;
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    if (url.pathname === "/rate_limit") {
      return Promise.resolve(Response.json({
        resources: { core: primary(80) },
      }));
    }
    return Promise.resolve(Response.json({ shouldNotBeRead: true }));
  }) as typeof fetch;

  try {
    const error = await assertRejects(
      () => performanceGithub("repos/o/r", staticGitHubCredential(token)),
      GitHubRateLimitBudgetError,
    );
    assertStringIncludes(
      error.message,
      "80% performance-history safety threshold",
    );
    assertEquals(friendlyError(error.message), "rate limit hit");
    assertEquals(calls, ["/rate_limit"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("performance GitHub requests can consume the request that reaches 80%", async () => {
  const token = `rate-limit-test-${crypto.randomUUID()}`;
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  let probes = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    if (url.pathname === "/rate_limit") {
      probes++;
      return Promise.resolve(Response.json({
        resources: { core: primary(probes === 1 ? 79 : 80) },
      }));
    }
    return Promise.resolve(Response.json({ ok: true }, {
      headers: rateHeaders(80),
    }));
  }) as typeof fetch;

  try {
    assertEquals(
      await performanceGithub<{ ok: boolean }>("repos/o/r", staticGitHubCredential(token)),
      { ok: true },
    );
    assertEquals(calls, ["/rate_limit", "/repos/o/r"]);
    await assertRejects(
      () => performanceGithub("repos/o/r", staticGitHubCredential(token)),
      GitHubRateLimitBudgetError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("performance GitHub requests report unusable rate-limit responses", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (
      const response of [
        new Response("unavailable", {
          status: 503,
          headers: {
            "x-github-request-id": "rate-probe-request",
            "x-ratelimit-remaining": "0",
            "retry-after": "60",
          },
        }),
        Response.json({ resources: {} }),
      ]
    ) {
      const token = `rate-probe-${crypto.randomUUID()}`;
      globalThis.fetch = (() =>
        Promise.resolve(response.clone())) as typeof fetch;
      const error = await assertRejects(
        () => performanceGithub("repos/o/r", staticGitHubCredential(token)),
        GitHubRateLimitBudgetError,
        "rate limit status could not be read",
      );
      if (response.status === 503) {
        assertStringIncludes(error.message, "request rate-probe-request");
        assertStringIncludes(error.message, "rate limit 0 remaining");
        assertStringIncludes(error.message, "retry after 60");
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("an unusable rate-limit response does not wait for body cleanup", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("short detail"));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    }),
    { status: 503 },
  );
  try {
    globalThis.fetch = (() => Promise.resolve(response)) as typeof fetch;
    const token = `rate-probe-cleanup-${crypto.randomUUID()}`;
    await assertRejects(
      () => performanceGithub("repos/o/r", staticGitHubCredential(token)),
      GitHubRateLimitBudgetError,
      "rate limit status could not be read",
    );
    assert(cancelled);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("GitHub download helpers return response bodies without JSON decoding", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; signal: AbortSignal | null | undefined }[] = [];
  const token = `download-${crypto.randomUUID()}`;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ path: url.pathname, signal: init?.signal });
    if (url.pathname === "/rate_limit") {
      return Promise.resolve(Response.json({
        resources: { core: primary(0, 5_000) },
      }));
    }
    return Promise.resolve(
      new Response("archive", {
        headers: rateHeaders(1, 5_000),
      }),
    );
  }) as typeof fetch;

  try {
    assertEquals(
      new TextDecoder().decode(
        (await githubDownload("repos/o/archive", staticGitHubCredential(token))).body,
      ),
      "archive",
    );
    assertEquals(
      new TextDecoder().decode(
        (await performanceGithubDownload("repos/o/archive", staticGitHubCredential(token))).body,
      ),
      "archive",
    );
    assertEquals(calls.map((call) => call.path), [
      "/repos/o/archive",
      "/rate_limit",
      "/repos/o/archive",
    ]);
    assertEquals(calls.every((call) => call.signal == null), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
