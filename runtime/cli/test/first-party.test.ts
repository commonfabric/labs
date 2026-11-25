import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { encodeBase64 } from "@std/encoding/base64";
import { Identity } from "@commonfabric/identity";
import { verifyFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { signedFetch } from "../lib/first-party.ts";
import { pairWithService } from "../lib/pairing.ts";

describe("first-party requests", () => {
  let directory: string;
  let base: string;
  let server: Deno.HttpServer<Deno.NetAddr>;
  let handle: (request: Request) => Response | Promise<Response>;
  let hits: string[];

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "cf-first-party-" });
    hits = [];
    handle = () => new Response("unset", { status: 500 });
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      (request) => {
        hits.push(new URL(request.url).pathname);
        return handle(request);
      },
    );
    base = `http://127.0.0.1:${server.addr.port}`;
  });

  afterEach(async () => {
    await server.shutdown();
    await Deno.remove(directory, { recursive: true });
  });

  const keyfile = async (name: string) => {
    const pkcs8 = await Identity.generatePkcs8();
    const path = `${directory}/${name}`;
    await Deno.writeFile(path, pkcs8);
    return { path, pkcs8, did: (await Identity.fromPkcs8(pkcs8)).did() };
  };

  describe("signedFetch", () => {
    it("signs the request, body included, as the keyfile's identity", async () => {
      const key = await keyfile("me.key");
      let seen: { did: string; body: unknown } | undefined;
      handle = async (request) => {
        const { userDid } = await verifyFirstPartyHttpRequest({ request });
        seen = { did: userDid, body: await request.json() };
        return Response.json({ ok: true });
      };

      const text = await signedFetch({
        url: `${base}/command/loom.find`,
        method: "post",
        body: JSON.stringify({ name: "Making" }),
        identity: key.path,
      });

      expect(JSON.parse(text)).toEqual({ ok: true });
      expect(seen).toEqual({ did: key.did, body: { name: "Making" } });
    });

    it("throws with the status and body on a refusal", async () => {
      const key = await keyfile("me.key");
      handle = () => Response.json({ error: "proof-missing" }, { status: 401 });

      await expect(
        signedFetch({
          url: `${base}/config`,
          method: "GET",
          identity: key.path,
        }),
      ).rejects.toThrow(/401.*proof-missing/);
    });

    it("never follows a redirect with the signature", async () => {
      const key = await keyfile("me.key");
      handle = (request) =>
        new URL(request.url).pathname === "/config"
          ? Response.redirect(`${base}/elsewhere`, 302)
          : new Response("followed");

      await expect(
        signedFetch({
          url: `${base}/config`,
          method: "GET",
          identity: key.path,
        }),
      ).rejects.toThrow(/redirect/);
      expect(hits).toEqual(["/config"]);
    });

    it("refuses plain http off this machine, sending nothing", async () => {
      const key = await keyfile("me.key");
      await expect(
        signedFetch({
          url: "http://cfs.example.ts.net/config",
          method: "GET",
          identity: key.path,
        }),
      ).rejects.toThrow(/https/);
    });
  });

  describe("pairWithService", () => {
    const answering = (pkcs8: Uint8Array, did: string) => {
      handle = async (request) => {
        const body = await request.json();
        return body.code === "ABCDE12345"
          ? Response.json({ pkcs8Base64: encodeBase64(pkcs8), did })
          : Response.json({ error: "pairing-refused" }, { status: 403 });
      };
    };

    it("redeems the code and keeps the key, readable by this user only", async () => {
      const served = await keyfile("served.key");
      answering(served.pkcs8, served.did);
      const target = `${directory}/new/identity.key`;

      const paired = await pairWithService({
        service: `${base}/some/path`,
        code: "abcde-12345\n",
        keyfile: target,
      });

      expect(paired).toEqual({ did: served.did, wrote: true });
      expect(hits).toEqual(["/identity-pairing/redeem"]);
      expect(await Deno.readFile(target)).toEqual(served.pkcs8);
      expect((await Deno.stat(target)).mode! & 0o077).toBe(0);
    });

    it("leaves a keyfile already holding the same identity as it is", async () => {
      const served = await keyfile("served.key");
      answering(served.pkcs8, served.did);

      const paired = await pairWithService({
        service: base,
        code: "ABCDE12345",
        keyfile: served.path,
      });

      expect(paired).toEqual({ did: served.did, wrote: false });
    });

    it("never replaces a keyfile holding another identity", async () => {
      const served = await keyfile("served.key");
      const mine = await keyfile("mine.key");
      answering(served.pkcs8, served.did);

      await expect(
        pairWithService({
          service: base,
          code: "ABCDE12345",
          keyfile: mine.path,
        }),
      ).rejects.toThrow(/another identity/);
      expect(await Deno.readFile(mine.path)).toEqual(mine.pkcs8);
    });

    it("keeps no key whose identity is not the one the service names", async () => {
      const served = await keyfile("served.key");
      const other = await keyfile("other.key");
      answering(served.pkcs8, other.did);
      const target = `${directory}/k`;

      await expect(
        pairWithService({ service: base, code: "ABCDE12345", keyfile: target }),
      ).rejects.toThrow(/keeps neither/);
      await expect(Deno.stat(target)).rejects.toThrow(Deno.errors.NotFound);
    });

    it("never sends the code on to where a redirect points", async () => {
      handle = (request) =>
        new URL(request.url).pathname === "/identity-pairing/redeem"
          ? Response.redirect(`${base}/elsewhere`, 307)
          : new Response("followed");

      await expect(
        pairWithService({
          service: base,
          code: "ABCDE12345",
          keyfile: `${directory}/k`,
        }),
      ).rejects.toThrow(/redirected/);
      expect(hits).toEqual(["/identity-pairing/redeem"]);
    });

    it("refuses what is not a code without spending a try", async () => {
      await expect(
        pairWithService({
          service: base,
          code: "not a code",
          keyfile: `${directory}/k`,
        }),
      ).rejects.toThrow(/not a pairing code/);
      expect(hits).toEqual([]);
    });

    it("says a refused code is wrong, expired or used, and writes nothing", async () => {
      const served = await keyfile("served.key");
      answering(served.pkcs8, served.did);
      const target = `${directory}/k`;

      await expect(
        pairWithService({ service: base, code: "ZZZZZ99999", keyfile: target }),
      ).rejects.toThrow(/wrong, expired, or\s+already used/);
      await expect(Deno.stat(target)).rejects.toThrow(Deno.errors.NotFound);
    });
  });
});
