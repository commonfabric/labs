import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import { Identity } from "@commonfabric/identity";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { fetchAction, fetchCommand } from "../commands/fetch.ts";
import { FirstPartyError } from "../lib/first-party.ts";

interface Seen {
  method: string;
  path: string;
  did: string;
  body: string;
}

describe("cf fetch", () => {
  let directory: string;
  let keyPath: string;
  let did: string;
  let seen: Seen[];
  let answer: Response;
  let printed: string;
  let server: Deno.HttpServer<Deno.NetAddr>;
  let base: string;

  const stdout: Pick<typeof Deno.stdout, "write"> = {
    write(bytes) {
      printed += new TextDecoder().decode(bytes);
      return Promise.resolve(bytes.length);
    },
  };

  const stdinOf = (text: string) =>
    ReadableStream.from([new TextEncoder().encode(text)]);

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "cf-fetch-" });
    const pkcs8 = await Identity.generatePkcs8();
    keyPath = `${directory}/me.key`;
    await Deno.writeFile(keyPath, pkcs8);
    did = (await Identity.fromPkcs8(pkcs8)).did();
    seen = [];
    answer = new Response("");
    printed = "";
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const { userDid } = await verifyFirstPartyHttpRequest({ request });
        seen.push({
          method: request.method,
          path: new URL(request.url).pathname,
          did: userDid,
          body: await request.text(),
        });
        return answer;
      },
    );
    base = `http://127.0.0.1:${server.addr.port}`;
  });

  afterEach(async () => {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  });

  for (const method of ["GET", "HEAD"]) {
    it(`sends a ${method} with no body and leaves stdin unread`, async () => {
      answer = new Response('{"ok":true}');
      const stdin = stdinOf("not a body");

      await fetchAction(
        { identity: keyPath, method },
        `${base}/config`,
        { stdin, stdout },
      );

      expect(seen).toEqual([{ method, path: "/config", did, body: "" }]);
      expect(stdin.locked).toBe(false);
      // A HEAD answer carries no body, which prints as an empty line.
      expect(printed).toBe(method === "GET" ? '{"ok":true}\n' : "\n");
    });
  }

  it("sends stdin as the body of any other method, signed", async () => {
    answer = new Response('{"id":"loom-1"}\n');

    await fetchAction(
      { identity: keyPath, method: "post" },
      `${base}/command/loom.find`,
      { stdin: stdinOf('{"name":"Making"}'), stdout },
    );

    expect(seen).toEqual([{
      method: "POST",
      path: "/command/loom.find",
      did,
      body: '{"name":"Making"}',
    }]);
    // An answer that already ends in a newline is printed as it is.
    expect(printed).toBe('{"id":"loom-1"}\n');
  });

  it("refuses without an identity, before reading or sending", async () => {
    const stdin = stdinOf("{}");

    await expect(
      fetchAction(
        { method: "POST" },
        `${base}/command/loom.find`,
        { stdin, stdout },
      ),
    ).rejects.toThrow(ValidationError);

    expect(stdin.locked).toBe(false);
    expect(seen).toEqual([]);
    expect(printed).toBe("");
  });

  it("parses --identity and sends a GET by default", async () => {
    answer = new Response("not the owner", { status: 403 });

    // A refusal ends the command before it prints anything.
    await expect(
      fetchCommand.parse(["--identity", keyPath, `${base}/config`]),
    ).rejects.toThrow(new FirstPartyError("403 Forbidden: not the owner"));

    expect(seen).toEqual([{ method: "GET", path: "/config", did, body: "" }]);
  });
});
