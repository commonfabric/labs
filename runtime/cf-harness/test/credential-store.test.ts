import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  FileHarnessCredentialStore,
  type HarnessCredentialStore,
  InMemoryHarnessCredentialStore,
} from "../src/auth/credential-store.ts";
import type { OpenAICodexOAuthCredential } from "../src/auth/types.ts";

const credential = (
  owner: string,
  refreshToken = `refresh-${owner}`,
): OpenAICodexOAuthCredential => ({
  type: "oauth",
  providerId: "openai-codex",
  accessToken: `access-${owner}`,
  refreshToken,
  expiresAt: 4_000_000_000_000,
  accountId: `account-${owner}`,
});

/** Every `size`-character slice of `text`, for "quotes none of this" checks. */
function* windows(text: string, size: number): Generator<string> {
  for (let index = 0; index + size <= text.length; index += 1) {
    yield text.slice(index, index + size);
  }
}

const assertQueuedUpdateCanAbort = async (
  store: HarnessCredentialStore,
): Promise<void> => {
  await store.set("local", "openai-codex", credential("local"));
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const first = store.update("local", "openai-codex", async (current) => {
    markFirstStarted();
    await holdFirst;
    return current;
  });
  await firstStarted;

  let secondUpdaterRan = false;
  const controller = new AbortController();
  const second = store.update(
    "local",
    "openai-codex",
    (current) => {
      secondUpdaterRan = true;
      return current;
    },
    controller.signal,
  );
  controller.abort(new DOMException("queued update canceled", "AbortError"));
  await assertRejects(
    () => second,
    DOMException,
    "queued update canceled",
  );
  assertEquals(secondUpdaterRan, false);

  releaseFirst();
  await first;
  await store.update("local", "openai-codex", (current) => current);
};

Deno.test("in-memory credential store cancels queued mutations", async () => {
  await assertQueuedUpdateCanAbort(new InMemoryHarnessCredentialStore());
});

Deno.test("file credential store cancels queued local lock waits", async () => {
  const root = await Deno.makeTempDir();
  await assertQueuedUpdateCanAbort(
    new FileHarnessCredentialStore({ path: join(root, "auth.json") }),
  );
});

Deno.test("file credential store cancels a cross-process advisory-lock wait", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const lockPath = `${path}.lock`;
  const holder = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "--quiet",
      `const file = await Deno.open(Deno.args[0], { create: true, read: true, write: true, mode: 0o600 });
await file.lock(true);
console.log("locked");
await Deno.stdin.read(new Uint8Array(1));
await file.unlock();
file.close();`,
      lockPath,
    ],
    cwd: root,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const stdout = holder.stdout.getReader();
  let holderOutput = "";
  while (!holderOutput.includes("locked")) {
    const { value, done } = await stdout.read();
    if (done) throw new Error("lock holder exited before acquiring the lock");
    holderOutput += new TextDecoder().decode(value);
  }
  stdout.releaseLock();

  let markLockStarted!: () => void;
  const lockStarted = new Promise<void>((resolve) => {
    markLockStarted = resolve;
  });
  const store = new FileHarnessCredentialStore({
    path,
    onLockAcquisitionStarted: markLockStarted,
  });
  const controller = new AbortController();
  const pending = store.update(
    "local",
    "openai-codex",
    () => credential("local"),
    controller.signal,
  );
  await lockStarted;
  const reason = new DOMException("cross-process wait canceled", "AbortError");
  controller.abort(reason);

  await assertRejects(
    () => pending,
    DOMException,
    "cross-process wait canceled",
  );

  const stdin = holder.stdin.getWriter();
  await stdin.write(new Uint8Array([1]));
  await stdin.close();
  assertEquals((await holder.status).success, true);
  await store.set("local", "openai-codex", credential("after-cancel"));
  assertEquals(
    (await store.get("local", "openai-codex"))?.accountId,
    "account-after-cancel",
  );
});

Deno.test("file credential store is owner-isolated, atomic, and private", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "harness-home", "auth.json");
  const store = new FileHarnessCredentialStore({ path });

  await Promise.all([
    store.set("loom:user-a", "openai-codex", credential("a")),
    store.set("loom:user-b", "openai-codex", credential("b")),
  ]);

  assertEquals(
    (await store.get("loom:user-a", "openai-codex"))?.accountId,
    "account-a",
  );
  assertEquals(
    (await store.get("loom:user-b", "openai-codex"))?.accountId,
    "account-b",
  );
  assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  assertEquals(
    (await Deno.stat(join(root, "harness-home"))).mode! & 0o777,
    0o700,
  );
  const names = [...Deno.readDirSync(join(root, "harness-home"))].map((e) =>
    e.name
  );
  assertEquals(names.sort(), ["auth.json", "auth.json.lock"]);
});

Deno.test("file credential store serializes mutations across store instances", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const first = new FileHarnessCredentialStore({ path });
  const second = new FileHarnessCredentialStore({ path });

  await Promise.all([
    first.set("loom:user-a", "openai-codex", credential("a")),
    second.set("loom:user-b", "openai-codex", credential("b")),
  ]);

  assertEquals(
    (await first.get("loom:user-a", "openai-codex"))?.accountId,
    "account-a",
  );
  assertEquals(
    (await first.get("loom:user-b", "openai-codex"))?.accountId,
    "account-b",
  );
});

Deno.test("file credential store preserves prototype-shaped owner keys", async () => {
  const root = await Deno.makeTempDir();
  const store = new FileHarnessCredentialStore({
    path: join(root, "auth.json"),
  });

  await store.set("__proto__", "openai-codex", credential("prototype"));

  assertEquals(
    (await store.get("__proto__", "openai-codex"))?.accountId,
    "account-prototype",
  );
});

Deno.test("file credential store rejects non-private and symlinked homes", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  const publicHome = join(root, "public-home");
  await Deno.mkdir(publicHome, { mode: 0o755 });
  await assertRejects(
    () =>
      new FileHarnessCredentialStore({ path: join(publicHome, "auth.json") })
        .get("local", "openai-codex"),
    Error,
    "private permissions",
  );

  const realHome = join(root, "real-home");
  const linkedHome = join(root, "linked-home");
  await Deno.mkdir(realHome, { mode: 0o700 });
  await Deno.symlink(realHome, linkedHome);
  await assertRejects(
    () =>
      new FileHarnessCredentialStore({ path: join(linkedHome, "auth.json") })
        .get("local", "openai-codex"),
    Error,
    "must not be a symlink",
  );

  const privateHome = join(root, "private-home");
  await Deno.mkdir(privateHome, { mode: 0o700 });
  const publicAuthFile = join(privateHome, "auth.json");
  await Deno.writeTextFile(
    publicAuthFile,
    JSON.stringify({ version: 1, owners: {} }),
    { mode: 0o644 },
  );
  await assertRejects(
    () =>
      new FileHarnessCredentialStore({ path: publicAuthFile })
        .get("local", "openai-codex"),
    Error,
    "file must have private permissions",
  );

  await Deno.remove(publicAuthFile);
  const lockTarget = join(root, "lock-target");
  await Deno.writeTextFile(lockTarget, "");
  await Deno.symlink(lockTarget, `${publicAuthFile}.lock`);
  await assertRejects(
    () =>
      new FileHarnessCredentialStore({ path: publicAuthFile })
        .set("local", "openai-codex", credential("local")),
    Error,
    "lock file must be a regular file",
  );
});

Deno.test("file credential store surfaces malformed storage without overwriting it", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const store = new FileHarnessCredentialStore({ path });
  await store.set("local", "openai-codex", credential("local"));
  const lastValid = store.lastValidSnapshot();
  await Deno.writeTextFile(path, "{malformed");

  await assertRejects(
    () => store.set("local", "openai-codex", credential("new")),
    Error,
    "failed to read credential store",
  );
  assertEquals(await Deno.readTextFile(path), "{malformed");
  assertEquals(store.lastValidSnapshot(), lastValid);
});

Deno.test("file credential store keeps stored bytes out of its read failure", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const refreshToken = "rt-EXTREMELY-SECRET-REFRESH-VALUE";
  const store = new FileHarnessCredentialStore({ path });
  await store.set("local", "openai-codex", credential("local", refreshToken));
  // Unquoting the token is what an external truncation looks like to the
  // parser: it fails on the token itself, so the token is what it quotes back.
  const corrupted = (await Deno.readTextFile(path)).replace(
    `"${refreshToken}"`,
    refreshToken,
  );
  await Deno.writeTextFile(path, corrupted);

  const error = await assertRejects(
    () => store.get("local", "openai-codex"),
    Error,
    "failed to read credential store",
  );
  assertEquals(error.message.includes(refreshToken), false, error.message);
  const echoed = [...windows(corrupted, 8)].filter((window) =>
    error.message.includes(window)
  );
  assertEquals(echoed, [], `error echoed stored bytes: ${error.message}`);
});

Deno.test("file credential store rejects malformed owners and expiries fail-closed", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const malformedDocuments = [
    '{"version":1,"owners":[]}',
    '{"version":2,"owners":{},"health":[]}',
    '{"version":2,"owners":{},"health":{"local":[]}}',
    '{"version":2,"owners":{"local":{"openai-codex":{"type":"oauth","providerId":"openai-codex","accessToken":"access","refreshToken":"refresh","expiresAt":1,"accountId":"account"}}},"health":{"local":{"openai-codex":[]}}}',
    '{"version":1,"owners":{"local":{"openai-codex":{"type":"oauth","providerId":"openai-codex","accessToken":"access","refreshToken":"refresh","expiresAt":1e999,"accountId":"account"}}}}',
    '{"version":2,"owners":{},"health":{"local":{"openai-codex":{"status":"reconnect-required","reason":"revoked"}}}}',
  ];
  for (const malformed of malformedDocuments) {
    await Deno.writeTextFile(path, malformed, { mode: 0o600 });
    const store = new FileHarnessCredentialStore({ path });
    await assertRejects(
      () => store.set("local", "openai-codex", credential("replacement")),
      Error,
      "failed to read credential store",
    );
    assertEquals(await Deno.readTextFile(path), malformed);
  }
});

Deno.test("logout deletes only the selected owner/provider entry", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("loom:user-a", "openai-codex", credential("a"));
  await store.set("loom:user-b", "openai-codex", credential("b"));

  await store.delete("loom:user-a", "openai-codex");

  assertEquals(await store.get("loom:user-a", "openai-codex"), undefined);
  assertEquals(
    (await store.get("loom:user-b", "openai-codex"))?.accountId,
    "account-b",
  );
});

Deno.test("version-1 credential documents migrate on mutation without losing owners", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const original = {
    version: 1,
    owners: {
      local: { "openai-codex": credential("local") },
      other: { "openai-codex": credential("other") },
    },
  };
  const originalText = `${JSON.stringify(original, null, 2)}\n`;
  await Deno.writeTextFile(path, originalText, { mode: 0o600 });
  const store = new FileHarnessCredentialStore({ path });

  assertEquals(
    (await store.get("local", "openai-codex"))?.accountId,
    "account-local",
  );
  assertEquals(await Deno.readTextFile(path), originalText);
  await store.set("local", "openai-codex", credential("updated"));

  const migrated = JSON.parse(await Deno.readTextFile(path));
  assertEquals(migrated.version, 2);
  assertEquals(migrated.health, {});
  assertEquals(
    migrated.owners.other["openai-codex"].accountId,
    "account-other",
  );
  assertEquals(
    migrated.owners.local["openai-codex"].accountId,
    "account-updated",
  );
});

Deno.test("credential store never overwrites unknown future documents", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const future = '{"version":3,"owners":{},"health":{},"future":true}';
  await Deno.writeTextFile(path, future, { mode: 0o600 });
  const store = new FileHarnessCredentialStore({ path });

  await assertRejects(
    () => store.set("local", "openai-codex", credential("replacement")),
    Error,
    "unsupported credential store format",
  );
  assertEquals(await Deno.readTextFile(path), future);
});

Deno.test("credential health is atomic with credentials and logout removes both", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.updateRecord("local", "openai-codex", () => ({
    credential: credential("local"),
    health: { status: "reconnect-required", reason: "revoked" },
  }));

  assertEquals(await store.getHealth("local", "openai-codex"), {
    status: "reconnect-required",
    reason: "revoked",
  });
  await store.delete("local", "openai-codex");
  assertEquals(await store.get("local", "openai-codex"), undefined);
  assertEquals(await store.getHealth("local", "openai-codex"), undefined);
});

Deno.test("file credential health lookup and logout survive reopen", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const store = new FileHarnessCredentialStore({ path });
  await store.updateRecord("local", "openai-codex", () => ({
    credential: credential("local"),
    health: { status: "reconnect-required", reason: "revoked" },
  }));
  const reopened = new FileHarnessCredentialStore({ path });
  assertEquals(await reopened.getHealth("local", "openai-codex"), {
    status: "reconnect-required",
    reason: "revoked",
  });
  await reopened.delete("local", "openai-codex");
  assertEquals(await reopened.getRecord("local", "openai-codex"), {});
});

for (
  const [name, createStore] of [
    [
      "in-memory",
      () => ({
        store: new InMemoryHarnessCredentialStore() as HarnessCredentialStore,
        readBytes: undefined,
      }),
    ],
    [
      "file",
      async () => {
        const root = await Deno.makeTempDir();
        const path = join(root, "auth.json");
        return {
          store: new FileHarnessCredentialStore({
            path,
          }) as HarnessCredentialStore,
          readBytes: () => Deno.readTextFile(path),
        };
      },
    ],
  ] as const
) {
  Deno.test(`${name} credential store rejects orphan health atomically`, async () => {
    const { store, readBytes } = await createStore();
    await store.set("local", "openai-codex", credential("original"));
    const originalBytes = await readBytes?.();

    await assertRejects(
      () =>
        store.updateRecord("local", "openai-codex", () => ({
          health: { status: "reconnect-required", reason: "revoked" },
        })),
      Error,
      "credential health requires a credential",
    );
    assertEquals(
      (await store.get("local", "openai-codex"))?.accountId,
      "account-original",
    );
    if (readBytes !== undefined) {
      assertEquals(await readBytes(), originalBytes);
    }

    await store.updateRecord("local", "openai-codex", () => ({
      credential: credential("unhealthy"),
      health: { status: "reconnect-required", reason: "revoked" },
    }));
    await store.update("local", "openai-codex", () => undefined);
    assertEquals(await store.getRecord("local", "openai-codex"), {});
  });
}

Deno.test("file credential store finishes an atomic commit after its updater starts", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const store = new FileHarnessCredentialStore({ path });
  await store.set("local", "openai-codex", credential("original"));
  const controller = new AbortController();

  await store.updateRecord("local", "openai-codex", () => {
    controller.abort(new Error("late cancellation"));
    return { credential: credential("replacement") };
  }, controller.signal);
  assertEquals(
    (await new FileHarnessCredentialStore({ path }).get(
      "local",
      "openai-codex",
    ))?.accountId,
    "account-replacement",
  );
});
