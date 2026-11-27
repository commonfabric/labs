import { expect } from "@std/expect";
import { encodeBase64 } from "@std/encoding/base64";
import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import { PairingError, pairWithService } from "../lib/pairing.ts";

describe("pairing", () => {
  describe("pairWithService()", () => {
    let directory: string;
    let served: { pkcs8: Uint8Array; did: string };
    let sent: string[];
    let answer: () => Response | Promise<Response>;

    // Stands in for the service: records where each request went and gives
    // `answer`, which by default hands over `served`'s key.
    const fetch: typeof globalThis.fetch = (input) => {
      sent.push(String(input));
      return Promise.resolve(answer());
    };

    const pair = (keyfile: string, service = "http://127.0.0.1:9") =>
      pairWithService({ service, code: "ABCDE12345", keyfile, fetch });

    // The message of the `PairingError` `pairing` is refused with.
    const refusal = async (pairing: Promise<unknown>): Promise<string> => {
      const error = await pairing.then(() => null, (error) => error);
      if (error instanceof PairingError) return error.message;
      throw new Error(`expected a PairingError, got ${error}`);
    };

    beforeEach(async () => {
      directory = await Deno.makeTempDir({ prefix: "cf-pairing-" });
      const pkcs8 = await Identity.generatePkcs8();
      served = { pkcs8, did: (await Identity.fromPkcs8(pkcs8)).did() };
      sent = [];
      answer = () =>
        Response.json({
          pkcs8Base64: encodeBase64(served.pkcs8),
          did: served.did,
        });
    });

    afterEach(async () => {
      await Deno.remove(directory, { recursive: true });
    });

    describe("the service's address", () => {
      it("sends the code to an https: service", async () => {
        const target = `${directory}/identity.key`;

        expect(await pair(target, "https://cfs.example.ts.net/settings"))
          .toEqual({ did: served.did, wrote: true });
        expect(sent).toEqual([
          "https://cfs.example.ts.net/identity-pairing/redeem",
        ]);
      });

      it("refuses a cleartext service off this machine before sending the code", async () => {
        const target = `${directory}/new/identity.key`;

        expect(await refusal(pair(target, "http://cfs.example.ts.net")))
          .toMatch(/not an https: URL/);
        expect(sent).toEqual([]);
        await expect(Deno.lstat(`${directory}/new`)).rejects.toThrow(
          Deno.errors.NotFound,
        );
      });
    });

    describe("what the service answers", () => {
      it("keeps nothing when the service hands over bytes that are no key", async () => {
        answer = () =>
          Response.json({ pkcs8Base64: encodeBase64(new Uint8Array([1, 2])) });
        const target = `${directory}/identity.key`;

        expect(await refusal(pair(target))).toMatch(
          /without a key cf can use/,
        );
        await expect(Deno.lstat(target)).rejects.toThrow(Deno.errors.NotFound);
      });

      it("passes on, as it is, a failure that is not the service's answer", async () => {
        const failure = new Error("the stream broke");
        answer = () =>
          new Response(
            new ReadableStream({
              cancel() {
                throw failure;
              },
            }),
            { status: 307 },
          );

        const error = await pair(`${directory}/identity.key`).then(
          () => null,
          (error) => error,
        );

        expect(error).toBe(failure);
      });

      it("reports a redirect the service answers with as a pairing failure", async () => {
        answer = () => new Response(null, { status: 307 });

        expect(await refusal(pair(`${directory}/identity.key`))).toMatch(
          /redirected/,
        );
      });
    });

    describe("where the key goes", () => {
      it("makes the directories the keyfile needs", async () => {
        const target = `${directory}/a/b/identity.key`;

        expect(await pair(target)).toEqual({ did: served.did, wrote: true });
        expect(await Deno.readFile(target)).toEqual(served.pkcs8);
      });

      it("refuses a directory it cannot make, before sending the code", async () => {
        await Deno.symlink(`${directory}/nowhere`, `${directory}/gone`);

        expect(await refusal(pair(`${directory}/gone/identity.key`)))
          .toMatch(/cf cannot make .*\/gone for the key/);
        expect(sent).toEqual([]);

        await Deno.mkdir(`${directory}/nowhere`);
        expect(await pair(`${directory}/gone/identity.key`)).toEqual({
          did: served.did,
          wrote: true,
        });
        expect(await Deno.readFile(`${directory}/nowhere/identity.key`))
          .toEqual(served.pkcs8);
      });

      it("refuses a path that runs through a file, before sending the code", async () => {
        await Deno.writeTextFile(`${directory}/file`, "text");

        expect(await refusal(pair(`${directory}/file/identity.key`)))
          .toMatch(/cf cannot check .*\/file\/identity\.key/);
        expect(sent).toEqual([]);
        expect(await Deno.readTextFile(`${directory}/file`)).toBe("text");
      });

      it("refuses a link to nothing at the keyfile's path, before sending the code", async () => {
        const target = `${directory}/identity.key`;
        await Deno.symlink(`${directory}/absent`, target);

        expect(await refusal(pair(target))).toMatch(
          /is a link or a file cf cannot read as a key/,
        );
        expect(sent).toEqual([]);
        expect(await Deno.readLink(target)).toBe(`${directory}/absent`);
        await expect(Deno.lstat(`${directory}/absent`)).rejects.toThrow(
          Deno.errors.NotFound,
        );
      });

      it("follows a link to a keyfile holding the identity", async () => {
        await Deno.writeFile(`${directory}/real.key`, served.pkcs8);
        await Deno.symlink(`${directory}/real.key`, `${directory}/link.key`);

        expect(await pair(`${directory}/link.key`)).toEqual({
          did: served.did,
          wrote: false,
        });
      });

      it("refuses a keyfile it cannot read, before sending the code", async () => {
        const target = `${directory}/identity.key`;
        await Deno.mkdir(target);

        expect(await refusal(pair(target))).toMatch(
          /cf cannot read .*\/identity\.key/,
        );
        expect(sent).toEqual([]);
      });

      it("never writes over a file that holds no key, and sends no code", async () => {
        const target = `${directory}/identity.key`;
        await Deno.writeTextFile(target, "notes");

        expect(await refusal(pair(target))).toMatch(
          /exists and holds no key/,
        );
        expect(sent).toEqual([]);
        expect(await Deno.readTextFile(target)).toBe("notes");
      });

      it("keeps a keyfile that appeared while the code was spent, and says the code is spent", async () => {
        const target = `${directory}/identity.key`;
        answer = async () => {
          await Deno.writeTextFile(target, "written meanwhile");
          return Response.json({
            pkcs8Base64: encodeBase64(served.pkcs8),
            did: served.did,
          });
        };

        expect(await refusal(pair(target))).toMatch(
          /The code is spent, but .*identity\.key could not be written/,
        );
        expect(await Deno.readTextFile(target)).toBe("written meanwhile");
      });
    });
  });
});
