import { join } from "@std/path";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  type CreateRequest,
  GitHubRefusal,
  type MergeRequest,
} from "../lib/view/github.ts";
import {
  type BeginStep,
  plainText,
  type StepKind,
  type TaskText,
} from "../lib/view/tasklog.ts";
import {
  clientDataHash,
  connectPinned,
  describeFidoFailure,
  encodeRequest,
  runTool,
  type ToolResult,
  type ToolRunner,
  touchGate,
} from "../lib/view/touchgate.ts";

const fixtures = new URL("./fixtures/touch-gate/", import.meta.url);
const SERVER_PEM = Deno.readTextFileSync(new URL("server.crt", fixtures));
const SERVER_KEY = Deno.readTextFileSync(new URL("server.key", fixtures));
const OTHER_PEM = Deno.readTextFileSync(new URL("other.crt", fixtures));

/** The DER encoding of the certificate in `pem`. */
function der(pem: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.fromBase64(pem.replace(/-----[A-Z ]+-----|\s/g, ""));
}

/** The bytes that `hex` spells, ignoring whitespace. */
function hex(text: string): Uint8Array {
  return Uint8Array.fromHex(text.replace(/\s/g, ""));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

const SECRET = new Uint8Array(32).fill(7);
const CREDENTIAL = new Uint8Array([1, 2, 3]);
const CHALLENGE = new Uint8Array(32).map((_, i) => 0xa0 + i % 16);
const AUTHENTICATOR_DATA = new Uint8Array(37).fill(5);
const SIGNATURE = new Uint8Array(70).fill(9);

/** The assertion the fake security key makes, as the client sends it. */
const ASSERTION = concat(
  u32(AUTHENTICATOR_DATA.length),
  AUTHENTICATOR_DATA,
  u32(SIGNATURE.length),
  SIGNATURE,
);

const CREATE: CreateRequest = {
  repository: "octo/repo",
  head: "fork:feature",
  base: "main",
  title: "Fix the frobnicator",
  body: "It was broken.\nNow it is not.",
};

const MERGE: MergeRequest = {
  repository: "octo/repo",
  number: 12,
  method: "squash",
  sha: "c0ffee",
};

/** Reads exactly `length` bytes from `conn`, or fewer when it ends or fails
 * first. */
async function readExact(conn: Deno.Conn, length: number) {
  const out = new Uint8Array(length);
  let at = 0;
  while (at < length) {
    const n = await conn.read(out.subarray(at)).catch(() => null);
    if (n === null) return out.slice(0, at);
    at += n;
  }
  return out;
}

/**
 * A fake touch-gate server on a free port, presenting the fixture
 * certificate, which runs `script` with the first connection and then
 * closes it. `done` settles once it has.
 */
function fakeServer(script: (conn: Deno.TlsConn) => Promise<void>) {
  const listener = Deno.listenTls({
    hostname: "127.0.0.1",
    port: 0,
    cert: SERVER_PEM,
    key: SERVER_KEY,
  });
  const done = (async () => {
    const conn = await listener.accept();
    try {
      await script(conn);
    } finally {
      conn.close();
      listener.close();
    }
  })();
  return { port: listener.addr.port, done };
}

/** The server's side of an exchange that reaches the challenge: what it
 * read, and the assertion it read in answer. */
function challengingServer(requestLength: number, reply: Uint8Array) {
  const seen = { request: new Uint8Array(0), assertion: new Uint8Array(0) };
  const server = fakeServer(async (conn) => {
    seen.request = await readExact(conn, SECRET.length + requestLength);
    await conn.write(concat(u32(0), CHALLENGE));
    seen.assertion = await readExact(conn, ASSERTION.length);
    await conn.write(reply);
  });
  return { ...server, seen };
}

/** A reply with `status` and `message`, and `rest` after it. */
function reply(
  status: number,
  message: string,
  rest: Uint8Array = new Uint8Array(0),
) {
  return concat(u32(status), new TextEncoder().encode(`${message}\0`), rest);
}

/**
 * A configuration directory for a server at `port` whose certificate is
 * `pem`. `files` replaces or, with null, removes its files.
 */
function configDirectory(
  port: number,
  pem = SERVER_PEM,
  files: Readonly<Record<string, string | Uint8Array | null>> = {},
) {
  const directory = Deno.makeTempDirSync();
  Deno.mkdirSync(join(directory, "keys"));
  const all = {
    server: `127.0.0.1:${port}\n`,
    "server.der": der(pem),
    secret: SECRET,
    "keys/laptop.credential": CREDENTIAL,
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    if (content === null) continue;
    if (typeof content === "string") {
      Deno.writeTextFileSync(join(directory, name), content);
    } else Deno.writeFileSync(join(directory, name), content);
  }
  return directory;
}

const ok = (stdout: string): ToolResult => ({
  success: true,
  stdout,
  stderr: "",
});
const failed = (stderr: string): ToolResult => ({
  success: false,
  stdout: "",
  stderr,
});

/**
 * libfido2's tools for security keys `dev0` and `dev1`, of which only
 * `holder` holds the credential, and each call made to them. `answer`
 * replaces the answer to a call it returns one for.
 */
function fakeTools(
  holder = "dev0",
  answer: (args: readonly string[]) => ToolResult | undefined = () => undefined,
) {
  const calls: Array<{ program: string; args: string[]; input: string }> = [];
  const tool: ToolRunner = (program, args, input) => {
    calls.push({ program, args: [...args], input });
    const answered = answer(args);
    if (answered) return Promise.resolve(answered);
    if (program === "fido2-token") {
      return Promise.resolve(ok("dev0: one key\ndev1: another key\n"));
    }
    if (args.includes("up=false")) {
      return Promise.resolve(
        args.at(-1) === holder ? ok("") : failed("FIDO_ERR_NO_CREDENTIALS\n"),
      );
    }
    // libfido2 wraps the authenticator data in a CBOR byte string.
    const wrapped = concat(new Uint8Array([0x58, 37]), AUTHENTICATOR_DATA);
    return Promise.resolve(ok(
      `${input.split("\n")[0]}\ntouch-gate\n${wrapped.toBase64()}\n` +
        `${SIGNATURE.toBase64()}\n`,
    ));
  };
  return { tool, calls };
}

/** Runs `send` with the service for `directory` and `tool`, returning the
 * steps it showed, a line as each began, ending in an ellipsis, and a line
 * as each was done, ending in a check mark, the kind each step was begun
 * with, and how it settled. */
async function attempt(
  directory: string,
  tool: ToolRunner,
  send: (
    service: ReturnType<typeof touchGate>,
    step: BeginStep,
  ) => Promise<unknown>,
  token = "work",
) {
  let written = "";
  const kinds: Array<StepKind | undefined> = [];
  const service = touchGate(token, {
    directory,
    tool,
    connect: connectPinned,
  });
  const step: BeginStep = (text, kind) => {
    kinds.push(kind);
    written += `${plainText(text)}…\n`;
    return () => written += `${plainText(text)} ✓\n`;
  };
  try {
    const result = await send(service, step);
    return { written, kinds, result };
  } catch (error) {
    return { written, kinds, error: String(error) };
  } finally {
    Deno.removeSync(directory, { recursive: true });
  }
}

describe("touchgate", () => {
  describe("encodeRequest()", () => {
    it("encodes the merge request of the protocol's example as its 42 bytes", () => {
      expect(
        encodeRequest(2, "laptop", ["work", "octo/repo", 12, "squash", ""]),
      ).toEqual(hex(`
        02 00 00 00
        6c 61 70 74 6f 70 00
        77 6f 72 6b 00
        6f 63 74 6f 2f 72 65 70 6f 00
        0c 00 00 00 00 00 00 00
        73 71 75 61 73 68 00
        00
      `));
    });

    it("throws for a string holding U+0000 or a lone surrogate, which it cannot send", () => {
      expect(() => encodeRequest(1, "laptop", ["a\0b"])).toThrow(
        "touch-gate cannot send",
      );
      expect(() => encodeRequest(1, "laptop", ["\ud800"])).toThrow(
        "touch-gate cannot send",
      );
    });
  });

  describe("clientDataHash()", () => {
    it("returns the hash of the protocol's example", async () => {
      const request = encodeRequest(2, "laptop", [
        "work",
        "octo/repo",
        12,
        "squash",
        "",
      ]);

      expect(
        await clientDataHash(
          new Uint8Array(32).map((_, i) => i),
          hex(`f1 33 8f 1d ab a5 7a 8a 5f 1d dd 16 11 7b e4 98
            aa b4 39 ea f4 5e d3 e8 e5 ca 70 2d 71 f6 29 08`),
          request,
        ),
      ).toEqual(hex(`52 d2 04 3d 94 99 1e 07 f2 38 d0 23 cd c3 3e 42
        09 43 7a 97 c0 e2 9a 62 07 2a de 2c 4d 3f 00 5c`));
    });
  });

  describe("describeFidoFailure()", () => {
    it("says what the last error libfido2's tool names means, naming the tool and the error", () => {
      expect(
        describeFidoFailure(
          "fido2-assert",
          "fido2-assert: fido_dev_get_assert: FIDO_ERR_RX\n",
        ),
      ).toBe(
        "the security key stopped answering. It may have stopped waiting " +
          "for a touch, been unplugged, or been in use by another program " +
          "(fido2-assert: FIDO_ERR_RX)",
      );
      expect(
        describeFidoFailure(
          "fido2-assert",
          "FIDO_ERR_RX then FIDO_ERR_USER_ACTION_TIMEOUT",
        ),
      ).toBe(
        "the security key was not touched in time " +
          "(fido2-assert: FIDO_ERR_USER_ACTION_TIMEOUT)",
      );
    });

    it("returns what the tool printed when it names no error whose meaning is known", () => {
      expect(describeFidoFailure("fido2-token", "no access\n")).toBe(
        "fido2-token failed: no access",
      );
      expect(
        describeFidoFailure(
          "fido2-assert",
          "fido2-assert: fido_dev_get_assert: FIDO_ERR_INTERNAL\n",
        ),
      ).toBe(
        "fido2-assert failed: fido2-assert: fido_dev_get_assert: " +
          "FIDO_ERR_INTERNAL",
      );
    });
  });

  describe("touchGate()", () => {
    it("creates a pull request once the key signs the challenge, asking for the touch by the key's name, and resolves with its address", async () => {
      const request = encodeRequest(1, "laptop", [
        "work",
        "octo/repo",
        "fork:feature",
        "main",
        "Fix the frobnicator",
        "It was broken.\nNow it is not.",
      ]);
      const url = "https://github.com/octo/repo/pull/12";
      const server = challengingServer(
        request.length,
        reply(0, url, hex("0c 00 00 00 00 00 00 00")),
      );
      const { tool, calls } = fakeTools("dev1");

      const { written, result } = await attempt(
        configDirectory(server.port),
        tool,
        (service, step) =>
          service.create(CREATE, step, new AbortController().signal),
      );
      await server.done;

      expect(result).toBe(url);
      expect(server.seen.request).toEqual(concat(SECRET, request));
      expect(server.seen.assertion).toEqual(ASSERTION);
      const hash = await sha256(
        concat(CHALLENGE, await sha256(der(SERVER_PEM)), request),
      );
      const signing = calls.at(-1)!;
      expect(signing.args).toEqual(["-G", "-p", "dev1"]);
      expect(signing.input).toBe(
        `${hash.toBase64()}\ntouch-gate\n${CREDENTIAL.toBase64()}\n`,
      );
      expect(written).toBe(
        "Touch the “laptop” security key to create a PR.…\n" +
          "Touch the “laptop” security key to create a PR. ✓\n" +
          "Sending the approval to touch-gate…\n" +
          "Sending the approval to touch-gate ✓\n",
      );
    });

    it("resolves with the address of the pull request the server numbers, whatever its message, or with its message when it gives no number", async () => {
      const request = encodeRequest(1, "laptop", [
        "work",
        "octo/repo",
        "fork:feature",
        "main",
        "Fix the frobnicator",
        "It was broken.\nNow it is not.",
      ]);
      const numbered = hex("22 00 00 00 00 00 00 00");
      for (
        const [rest, expected] of [
          [numbered, "https://github.com/octo/repo/pull/34"],
          [new Uint8Array(0), "a pull request was created"],
        ] as const
      ) {
        const server = challengingServer(
          request.length,
          reply(0, "a pull request was created", rest),
        );

        const { result } = await attempt(
          configDirectory(server.port),
          fakeTools().tool,
          (service, step) =>
            service.create(CREATE, step, new AbortController().signal),
        );
        await server.done;

        expect(result).toBe(expected);
      }
    });

    it("rejects when the server ends the connection partway through the pull request's number", async () => {
      const request = encodeRequest(1, "laptop", [
        "work",
        "octo/repo",
        "fork:feature",
        "main",
        "Fix the frobnicator",
        "It was broken.\nNow it is not.",
      ]);
      const server = challengingServer(
        request.length,
        reply(0, "created", new Uint8Array(3)),
      );

      const { error } = await attempt(
        configDirectory(server.port),
        fakeTools().tool,
        (service, step) =>
          service.create(CREATE, step, new AbortController().signal),
      );
      await server.done;

      expect(error).toContain("closed the connection");
    });

    it("rejects with the abort when its signal aborts while it waits to learn whether the server numbers the pull request", async () => {
      const request = encodeRequest(1, "laptop", [
        "work",
        "octo/repo",
        "fork:feature",
        "main",
        "Fix the frobnicator",
        "It was broken.\nNow it is not.",
      ]);
      const controller = new AbortController();
      let after: Uint8Array | undefined;
      const server = fakeServer(async (conn) => {
        await readExact(conn, SECRET.length + request.length);
        await conn.write(concat(u32(0), CHALLENGE));
        await readExact(conn, ASSERTION.length);
        await conn.write(reply(0, "created"));
        after = await readExact(conn, 1);
      });
      const directory = configDirectory(server.port);
      const service = touchGate("work", {
        directory,
        tool: fakeTools().tool,
        connect: async (...args) => {
          const connection = await connectPinned(...args);
          return {
            ...connection,
            ended: () => {
              controller.abort();
              return connection.ended();
            },
          };
        },
      });

      try {
        await expect(service.create(CREATE, () => () => {}, controller.signal))
          .rejects.toThrow("the request was aborted");
      } finally {
        Deno.removeSync(directory, { recursive: true });
      }
      await server.done;

      expect(after).toEqual(new Uint8Array(0));
    });

    it("merges a pull request, asking for the touch by the key's name", async () => {
      const request = encodeRequest(2, "laptop", [
        "work",
        "octo/repo",
        12,
        "squash",
        "c0ffee",
      ]);
      const server = challengingServer(request.length, reply(0, "merged"));
      const { tool } = fakeTools();

      const { written, result } = await attempt(
        configDirectory(server.port),
        tool,
        (service, step) =>
          service.merge(MERGE, step, new AbortController().signal),
      );
      await server.done;

      expect(result).toBeUndefined();
      expect(server.seen.request).toEqual(concat(SECRET, request));
      expect(written).toBe(
        "Touch the “laptop” security key to merge the PR.…\n" +
          "Touch the “laptop” security key to merge the PR. ✓\n" +
          "Sending the approval to touch-gate…\n" +
          "Sending the approval to touch-gate ✓\n",
      );
    });

    it("begins the step asking for the touch as one that waits for a person, and the step sending the approval with the default kind", async () => {
      const request = encodeRequest(2, "laptop", [
        "work",
        "octo/repo",
        12,
        "squash",
        "c0ffee",
      ]);
      const server = challengingServer(request.length, reply(0, "merged"));
      const { tool } = fakeTools();

      const { kinds } = await attempt(
        configDirectory(server.port),
        tool,
        (service, step) =>
          service.merge(MERGE, step, new AbortController().signal),
      );
      await server.done;

      expect(kinds).toEqual(["person", undefined]);
    });

    it("says the security key was touched before it sends the server the approval", async () => {
      const request = encodeRequest(2, "laptop", [
        "work",
        "octo/repo",
        12,
        "squash",
        "c0ffee",
      ]);
      const log: string[] = [];
      let saidBeforeSending: string | undefined;
      let saidBeforeTouch: string | undefined;
      let touchText: TaskText = [];
      const server = fakeServer(async (conn) => {
        await readExact(conn, SECRET.length + request.length);
        await conn.write(concat(u32(0), CHALLENGE));
        await readExact(conn, ASSERTION.length);
        saidBeforeSending = log.join("");
        await conn.write(reply(0, "merged"));
      });
      const { tool } = fakeTools("dev0");
      const signing: ToolRunner = (program, args, input, signal) => {
        if (args.includes("-p")) saidBeforeTouch = log.join("");
        return tool(program, args, input, signal);
      };

      const { result } = await attempt(
        configDirectory(server.port),
        signing,
        (service, step) =>
          service.merge(MERGE, (text) => {
            if (log.length === 0) touchText = text;
            log.push(`${plainText(text)}…`);
            const done = step(text);
            return () => {
              log.push(`${plainText(text)} ✓`);
              done();
            };
          }, new AbortController().signal),
      );
      await server.done;

      expect(result).toBeUndefined();
      expect(saidBeforeTouch).toBe(
        "Touch the “laptop” security key to merge the PR.…",
      );
      expect(saidBeforeSending).toBe(
        "Touch the “laptop” security key to merge the PR.…" +
          "Touch the “laptop” security key to merge the PR. ✓" +
          "Sending the approval to touch-gate…",
      );
      expect(log.at(-1)).toBe("Sending the approval to touch-gate ✓");
      expect(touchText.filter((span) => span.tone !== "text")).toEqual([
        { text: "laptop", tone: "name" },
      ]);
    });

    it("rejects with the server's message when it refuses before the challenge, asking for no touch", async () => {
      const server = fakeServer(async (conn) => {
        await readExact(conn, SECRET.length);
        await conn.write(reply(1, "the key is already waiting for a touch"));
      });
      const { tool, calls } = fakeTools();

      const { written, error } = await attempt(
        configDirectory(server.port),
        tool,
        (service, step) =>
          service.merge(MERGE, step, new AbortController().signal),
      );
      await server.done;

      expect(error).toBe(
        "Error: touch-gate refused: the key is already waiting for a touch",
      );
      expect(written).toBe("");
      expect(calls.some((call) => call.args.includes("-p"))).toBe(false);
    });

    it("rejects with the server's message when it refuses after the touch", async () => {
      const request = encodeRequest(2, "laptop", [
        "work",
        "octo/repo",
        12,
        "squash",
        "c0ffee",
      ]);
      const server = challengingServer(
        request.length,
        reply(1, "GitHub said: Head branch was modified"),
      );

      const { error } = await attempt(
        configDirectory(server.port),
        fakeTools().tool,
        (service, step) =>
          service.merge(MERGE, step, new AbortController().signal),
      );
      await server.done;

      expect(error).toBe(
        "Error: touch-gate refused: GitHub said: Head branch was modified",
      );
    });

    it("rejects with GitHub's status and message when the server passes on GitHub's refusal", async () => {
      const request = encodeRequest(2, "laptop", [
        "work",
        "octo/repo",
        12,
        "squash",
        "c0ffee",
      ]);
      const server = challengingServer(
        request.length,
        reply(
          1,
          'GitHub replied with status 405: {"message":"Merge already in ' +
            'progress","documentation_url":"https://docs.github.com/rest/' +
            'pulls/pulls#merge-a-pull-request","status":"405"}',
        ),
      );

      let thrown: unknown;
      const { error } = await attempt(
        configDirectory(server.port),
        fakeTools().tool,
        (service, step) =>
          service.merge(MERGE, step, new AbortController().signal).catch(
            (failure) => {
              thrown = failure;
              throw failure;
            },
          ),
      );
      await server.done;

      expect(error).toBe(
        "Error: GitHub answered 405: Merge already in progress",
      );
      expect(thrown).toBeInstanceOf(GitHubRefusal);
      expect(thrown instanceof GitHubRefusal && thrown.retryable).toBe(false);
    });

    it("rejects when the server closes the connection before its message ends, or sends one that is not UTF-8", async () => {
      for (
        const [bytes, message] of [
          [concat(u32(1), new TextEncoder().encode("cut sho")), "closed"],
          [concat(u32(1), new Uint8Array([0xff, 0])), "not UTF-8"],
        ] as const
      ) {
        const server = fakeServer(async (conn) => {
          await readExact(conn, SECRET.length);
          await conn.write(bytes);
        });

        const { error } = await attempt(
          configDirectory(server.port),
          fakeTools().tool,
          (service, step) =>
            service.merge(MERGE, step, new AbortController().signal),
        );
        await server.done;

        expect(error).toContain(message);
      }
    });

    it("sends nothing to a server whose certificate is not the expected one", async () => {
      let received: Uint8Array | undefined;
      const server = fakeServer(async (conn) => {
        received = await readExact(conn, 1);
      });

      const { error } = await attempt(
        configDirectory(server.port, OTHER_PEM),
        fakeTools().tool,
        (service, step) =>
          service.merge(MERGE, step, new AbortController().signal),
      );
      await server.done;

      expect(error).toBe(
        "Error: the touch-gate server's certificate is not the expected one",
      );
      expect(received).toEqual(new Uint8Array(0));
    });

    it("rejects, closing the connection, when its signal aborts while the key waits for a touch", async () => {
      const request = encodeRequest(2, "laptop", [
        "work",
        "octo/repo",
        12,
        "squash",
        "c0ffee",
      ]);
      const controller = new AbortController();
      let after: Uint8Array | undefined;
      const server = fakeServer(async (conn) => {
        await readExact(conn, SECRET.length + request.length);
        await conn.write(concat(u32(0), CHALLENGE));
        after = await readExact(conn, 1);
      });
      const { tool } = fakeTools("dev0", (args) => {
        if (!args.includes("-p")) return undefined;
        controller.abort();
        return failed("fido2-assert: interrupted");
      });

      const { error } = await attempt(
        configDirectory(server.port),
        tool,
        (service, step) => service.merge(MERGE, step, controller.signal),
      );
      await server.done;

      expect(error).toContain("fido2-assert failed");
      expect(after).toEqual(new Uint8Array(0));
    });

    it("rejects, saying what libfido2's error means, when the security key stops answering while it waits for a touch", async () => {
      const request = encodeRequest(2, "laptop", [
        "work",
        "octo/repo",
        12,
        "squash",
        "c0ffee",
      ]);
      const server = fakeServer(async (conn) => {
        await readExact(conn, SECRET.length + request.length);
        await conn.write(concat(u32(0), CHALLENGE));
        await readExact(conn, 1);
      });
      const { tool } = fakeTools(
        "dev0",
        (args) =>
          args.includes("-p")
            ? failed("fido2-assert: fido_dev_get_assert: FIDO_ERR_RX\n")
            : undefined,
      );

      const { error, written } = await attempt(
        configDirectory(server.port),
        tool,
        (service, step) =>
          service.merge(MERGE, step, new AbortController().signal),
      );
      await server.done;

      expect(written).toContain("Touch the “laptop” security key");
      expect(error).toBe(
        "Error: the security key stopped answering. It may have stopped " +
          "waiting for a touch, been unplugged, or been in use by another " +
          "program (fido2-assert: FIDO_ERR_RX)",
      );
    });

    it("rejects with the abort, asking no other security key, when its signal aborts while a key is asked about its credential", async () => {
      const controller = new AbortController();
      const { tool, calls } = fakeTools("dev1", (args) => {
        if (!args.includes("up=false")) return undefined;
        controller.abort(new Error("stopped by the user"));
        return failed("fido2-assert: interrupted");
      });

      const { error } = await attempt(
        configDirectory(1),
        tool,
        (service, step) => service.merge(MERGE, step, controller.signal),
      );

      expect(error).toBe("Error: stopped by the user");
      expect(calls.filter((call) => call.args.includes("up=false")).length)
        .toBe(1);
    });

    it("rejects without connecting when its signal has already aborted", async () => {
      const directory = configDirectory(1);

      const { error } = await attempt(
        directory,
        fakeTools().tool,
        (service, step) => service.merge(MERGE, step, AbortSignal.abort()),
      );

      expect(error).toContain("aborted");
    });

    it("rejects without asking anything when no token is set, or the token cannot be a name", async () => {
      for (
        const [token, message] of [
          ["", "no touch-gate token is set in the settings"],
          ["a b", "“a b” cannot name a touch-gate token"],
          ["..", "“..” cannot name a touch-gate token"],
        ]
      ) {
        const { tool, calls } = fakeTools();

        const { error } = await attempt(
          configDirectory(1),
          tool,
          (service, step) =>
            service.create(CREATE, step, new AbortController().signal),
          token,
        );

        expect(error).toBe(`Error: ${message}`);
        expect(calls).toEqual([]);
      }
    });

    it("rejects, saying what is wrong, for a configuration it cannot use", async () => {
      for (
        const [files, message] of [
          [{ secret: null }, "cannot read"],
          [{ secret: new Uint8Array(31) }, "is not 32 bytes long"],
          [{ server: "gate.example.test\n" }, "is not host:port"],
          [{ "keys/laptop.key": "x" }, "is not named NAME.credential"],
          [{ "keys/laptop.credential": null }, "no security key is registered"],
        ] as const
      ) {
        const { error } = await attempt(
          configDirectory(1, SERVER_PEM, files),
          fakeTools().tool,
          (service, step) =>
            service.merge(MERGE, step, new AbortController().signal),
        );

        expect(error).toContain(message);
      }
    });

    it("rejects with the reason when the keys directory cannot be read", async () => {
      const directory = configDirectory(1);
      Deno.removeSync(join(directory, "keys"), { recursive: true });
      Deno.writeTextFileSync(join(directory, "keys"), "not a directory");

      const { error } = await attempt(
        directory,
        fakeTools().tool,
        (service, step) =>
          service.merge(MERGE, step, new AbortController().signal),
      );

      expect(error).toContain("NotADirectory");
    });

    it("rejects when the server's message is longer than a client accepts", async () => {
      const request = encodeRequest(2, "laptop", [
        "work",
        "octo/repo",
        12,
        "squash",
        "c0ffee",
      ]);
      const server = fakeServer(async (conn) => {
        await readExact(conn, SECRET.length + request.length);
        await conn.write(u32(1));
        const chunk = new Uint8Array(1 << 16).fill(0x61);
        for (let sent = 0; sent <= 1 << 20; sent += chunk.length) {
          await conn.write(chunk).catch(() => {});
        }
      });

      const { error } = await attempt(
        configDirectory(server.port),
        fakeTools().tool,
        (service, step) =>
          service.merge(MERGE, step, new AbortController().signal),
      );
      await server.done;

      expect(error).toBe(
        "Error: the touch-gate server sent a message too long",
      );
    });

    it("passes over a security key that cannot answer for one that holds the credential, and counts a request for a touch as holding it", async () => {
      const asked = (stderr: string) => (args: readonly string[]) =>
        args.at(-1) === "dev0" && args.includes("up=false")
          ? failed(stderr)
          : undefined;
      for (
        const [answer, signer] of [
          [asked("FIDO_ERR_RX\n"), "dev1"],
          [asked("FIDO_ERR_USER_PRESENCE_REQUIRED\n"), "dev0"],
        ] as const
      ) {
        const request = encodeRequest(2, "laptop", [
          "work",
          "octo/repo",
          12,
          "squash",
          "c0ffee",
        ]);
        const server = challengingServer(request.length, reply(0, "merged"));
        const { tool, calls } = fakeTools("dev1", answer);

        const { result } = await attempt(
          configDirectory(server.port),
          tool,
          (service, step) =>
            service.merge(MERGE, step, new AbortController().signal),
        );
        await server.done;

        expect(result).toBeUndefined();
        expect(calls.at(-1)!.args).toEqual(["-G", "-p", signer]);
      }
    });

    it("rejects when no connected security key holds the credential, with the failure of one that cannot answer if there was one", async () => {
      const cases = [
        [fakeTools("none").tool, "no connected security key holds"],
        [
          fakeTools(
            "none",
            (args) =>
              args.includes("up=false") && args.at(-1) === "dev1"
                ? failed("FIDO_ERR_RX\n")
                : undefined,
          ).tool,
          "cannot ask the security key dev1: the security key stopped " +
          "answering.",
        ],
        [
          fakeTools(
            "dev0",
            (args) => args.includes("-L") ? failed("no access\n") : undefined,
          ).tool,
          "fido2-token failed: no access",
        ],
      ] as const;
      for (const [tool, message] of cases) {
        const { error } = await attempt(
          configDirectory(1),
          tool,
          (service, step) =>
            service.merge(MERGE, step, new AbortController().signal),
        );

        expect(error).toContain(message);
      }
    });

    it("rejects when the key's tool prints authenticator data or a signature it cannot read", async () => {
      for (
        const [stdout, message] of [
          ["h\nr\n!!!\nAAAA\n", "not base64"],
          ["h\nr\nQUJD\nAAAA\n", "not a CBOR byte string"],
        ]
      ) {
        const request = encodeRequest(2, "laptop", [
          "work",
          "octo/repo",
          12,
          "squash",
          "c0ffee",
        ]);
        const server = fakeServer(async (conn) => {
          await readExact(conn, SECRET.length + request.length);
          await conn.write(concat(u32(0), CHALLENGE));
          await readExact(conn, 1);
        });

        const { error } = await attempt(
          configDirectory(server.port),
          fakeTools(
            "dev0",
            (args) => args.includes("-p") ? ok(stdout) : undefined,
          ).tool,
          (service, step) =>
            service.merge(MERGE, step, new AbortController().signal),
        );
        await server.done;

        expect(error).toContain(message);
      }
    });
  });

  describe("runTool()", () => {
    it("rejects without starting the program when its signal has already aborted", async () => {
      const root = Deno.makeTempDirSync();
      try {
        const ran = join(root, "ran");

        await expect(
          runTool("sh", ["-c", `touch '${ran}'`], "", AbortSignal.abort()),
        ).rejects.toThrow();

        expect(() => Deno.statSync(ran)).toThrow(Deno.errors.NotFound);
      } finally {
        Deno.removeSync(root, { recursive: true });
      }
    });

    it("runs a program with the input on its standard input, and returns what it printed and whether it succeeded", async () => {
      const signal = new AbortController().signal;

      expect(await runTool("cat", [], "hello\n", signal)).toEqual(
        ok("hello\n"),
      );
      expect(
        await runTool("sh", ["-c", "cat >&2; exit 3"], "oops", signal),
      ).toEqual(failed("oops"));
    });
  });
});
