import { beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { encodeBase64 } from "@std/encoding/base64";
import { Identity } from "@commonfabric/identity";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";

import { createSandboxExecRouter } from "./exec.index.ts";
import { createTestApp } from "@/lib/create-app.ts";

const SANDBOX_URL = "http://sandbox.test";
const TOOLSHED_URL = "http://toolshed.test";
const signer = await Identity.fromPassphrase("toolshed sandbox exec test");

interface SandboxCall {
  method: string;
  path: string;
  body?: unknown;
}

describe("exec.handlers", () => {
  let calls: SandboxCall[];
  let respond: (call: SandboxCall) => Response;

  /** Answers the calls in order, one response factory per call. */
  function sequence(...responses: (() => Response)[]) {
    respond = () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected sandbox call");
      return next();
    };
  }

  async function exec(payload: Record<string, unknown>) {
    const app = createTestApp(createSandboxExecRouter({
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const text = await request.text();
        const call = {
          method: request.method,
          path: `${url.origin}${url.pathname}`,
          ...(text ? { body: JSON.parse(text) } : {}),
        };
        calls.push(call);
        return respond(call);
      },
      sandboxUrl: SANDBOX_URL,
      toolshedUrl: TOOLSHED_URL,
    }));
    const body = JSON.stringify(payload);
    const headers = await signFirstPartyHttpRequest({
      url: new URL("/api/sandbox/exec", "http://localhost"),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signer,
    });
    return app.request("/api/sandbox/exec", { method: "POST", headers, body });
  }

  beforeEach(() => {
    calls = [];
    sequence();
  });

  it("runs the command in an existing sandbox and returns its decoded output", async () => {
    sequence(
      () => new Response("{}"),
      () =>
        Response.json({
          stdout: encodeBase64("héllo wörld\n"),
          stderr: encodeBase64("warning ✓\n"),
          exitCode: 3,
        }),
    );
    const response = await exec({
      sandboxId: "box-1",
      command: "echo hello",
      workingDirectory: "/work",
      environment: { FOO: "bar" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      stdout: "héllo wörld\n",
      stderr: "warning ✓\n",
      exitCode: 3,
    });
    expect(calls).toEqual([
      { method: "GET", path: `${SANDBOX_URL}/v1/sandboxes/box-1` },
      {
        method: "POST",
        path: `${SANDBOX_URL}/v1/sandboxes/box-1/exec`,
        body: {
          cmd: ["bash", "-c", "echo hello"],
          cwd: "/work",
          env: [`CF_API_URL=${TOOLSHED_URL}`, "FOO=bar"],
        },
      },
    ]);
  });

  it("returns empty output and exit code 0 when the service omits them", async () => {
    sequence(() => new Response("{}"), () => Response.json({}));
    const response = await exec({ sandboxId: "box-1", command: "true" });

    expect(await response.json()).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(calls[1].body).toEqual({
      cmd: ["bash", "-c", "true"],
      env: [`CF_API_URL=${TOOLSHED_URL}`],
    });
  });

  it("lets the request's environment override `CF_API_URL`", async () => {
    sequence(() => new Response("{}"), () => Response.json({}));
    const response = await exec({
      sandboxId: "box-1",
      command: "true",
      environment: { CF_API_URL: "http://elsewhere.test" },
    });
    await response.json();

    expect(calls[1].body).toEqual({
      cmd: ["bash", "-c", "true"],
      env: ["CF_API_URL=http://elsewhere.test"],
    });
  });

  it("encodes the sandbox id as one path segment of the service's addresses", async () => {
    sequence(
      () => new Response("{}"),
      () => Response.json({ exitCode: 0 }),
    );

    const response = await exec({ sandboxId: "../admin", command: "ls" });

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.path)).toEqual([
      `${SANDBOX_URL}/v1/sandboxes/..%2Fadmin`,
      `${SANDBOX_URL}/v1/sandboxes/..%2Fadmin/exec`,
    ]);
  });

  it("aborts the service call when the request's timeout passes, and not before", async () => {
    using time = new FakeTime();
    let aborted = false;
    const app = createTestApp(createSandboxExecRouter({
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
      sandboxUrl: SANDBOX_URL,
      toolshedUrl: TOOLSHED_URL,
    }));
    const body = JSON.stringify({
      sandboxId: "box-slow",
      command: "sleep 60",
      timeout: 5000,
    });
    const headers = await signFirstPartyHttpRequest({
      url: new URL("/api/sandbox/exec", "http://localhost"),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signer,
    });

    const pending = app.request("/api/sandbox/exec", {
      method: "POST",
      headers,
      body,
    });
    await time.tickAsync(4999);
    expect(aborted).toBe(false);
    await time.tickAsync(1);
    const response = await pending;

    expect(aborted).toBe(true);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Exec failed: Sandbox exec timed out",
    });
  });

  describe("sandbox creation", () => {
    it("creates a missing sandbox from the devbox image before running", async () => {
      sequence(
        () => new Response("no such sandbox", { status: 404 }),
        () => new Response("{}", { status: 201 }),
        () => Response.json({ stdout: encodeBase64("ok") }),
      );
      const response = await exec({ sandboxId: "box-2", command: "ls" });

      expect(response.status).toBe(200);
      expect((await response.json()).stdout).toBe("ok");
      expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET ${SANDBOX_URL}/v1/sandboxes/box-2`,
        `POST ${SANDBOX_URL}/v1/sandboxes`,
        `POST ${SANDBOX_URL}/v1/sandboxes/box-2/exec`,
      ]);
      expect(calls[1].body).toEqual({ id: "box-2", baseImage: "devbox" });
    });

    it("runs the command when creation reports the sandbox already exists", async () => {
      sequence(
        () => new Response("", { status: 404 }),
        () => new Response("sandbox already exists", { status: 409 }),
        () => Response.json({ stdout: encodeBase64("ok") }),
      );
      const response = await exec({ sandboxId: "box-2", command: "ls" });

      expect(response.status).toBe(200);
      expect((await response.json()).stdout).toBe("ok");
    });

    it("returns 500 without running the command when creation fails", async () => {
      sequence(
        () => new Response("", { status: 404 }),
        () => new Response("out of capacity", { status: 503 }),
      );
      const response = await exec({ sandboxId: "box-2", command: "ls" });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Exec failed: Failed to create sandbox: 503 out of capacity",
      });
      expect(calls.length).toBe(2);
    });

    it("returns 500 without running the command when the sandbox check fails", async () => {
      sequence(() => new Response("broken", { status: 502 }));
      const response = await exec({ sandboxId: "box-2", command: "ls" });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Exec failed: Failed to check sandbox: 502 broken",
      });
      expect(calls.length).toBe(1);
    });
  });

  describe("reaped sandbox", () => {
    it("recreates the sandbox and runs the command again once", async () => {
      sequence(
        () => new Response("{}"),
        () => new Response("gone", { status: 404 }),
        () => new Response("", { status: 404 }),
        () => new Response("{}", { status: 201 }),
        () => Response.json({ stdout: encodeBase64("second try") }),
      );
      const response = await exec({ sandboxId: "box-3", command: "ls" });

      expect(response.status).toBe(200);
      expect((await response.json()).stdout).toBe("second try");
      expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET ${SANDBOX_URL}/v1/sandboxes/box-3`,
        `POST ${SANDBOX_URL}/v1/sandboxes/box-3/exec`,
        `GET ${SANDBOX_URL}/v1/sandboxes/box-3`,
        `POST ${SANDBOX_URL}/v1/sandboxes`,
        `POST ${SANDBOX_URL}/v1/sandboxes/box-3/exec`,
      ]);
    });

    it("returns 500 when the sandbox is missing again after recreation", async () => {
      sequence(
        () => new Response("{}"),
        () => new Response("gone", { status: 404 }),
        () => new Response("{}"),
        () => new Response("gone again", { status: 404 }),
      );
      const response = await exec({ sandboxId: "box-3", command: "ls" });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Exec failed: Sandbox not found: gone again",
      });
      expect(calls.length).toBe(4);
    });
  });

  describe("failures", () => {
    it("returns 500 without retrying when the exec call fails with another status", async () => {
      sequence(
        () => new Response("{}"),
        () => new Response("bad command", { status: 400 }),
      );
      const response = await exec({ sandboxId: "box-4", command: "ls" });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Exec failed: Exec failed: 400 bad command",
      });
      expect(calls.length).toBe(2);
    });

    it("returns 500 when the exec response is not JSON", async () => {
      sequence(() => new Response("{}"), () => new Response("<html>"));
      const response = await exec({ sandboxId: "box-4", command: "ls" });

      expect(response.status).toBe(500);
      expect((await response.json()).error).toMatch(/^Exec failed: /);
    });

    it("returns 500 when the sandbox service cannot be reached", async () => {
      respond = () => {
        throw "connection refused";
      };
      const response = await exec({ sandboxId: "box-4", command: "ls" });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Exec failed: connection refused",
      });
    });

    it("returns 422 without calling the service for an empty command or a timeout under a second", async () => {
      for (
        const payload of [
          { sandboxId: "box-4", command: "" },
          { sandboxId: "", command: "ls" },
          { sandboxId: "box-4", command: "ls", timeout: 999 },
        ]
      ) {
        const response = await exec(payload);
        await response.json();
        expect(response.status).toBe(422);
      }
      expect(calls).toEqual([]);
    });
  });
});
