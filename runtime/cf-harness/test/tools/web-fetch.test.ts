import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";

import { createHarnessCfcInvocationContext } from "../../src/contracts/cfc-invocation-context.ts";
import { createToolOutputId } from "../../src/contracts/tool-result.ts";
import type { SandboxRuntime } from "../../src/sandbox/types.ts";
import {
  createWebFetchTool,
  type CreateWebFetchToolOptions,
  defaultWebFetchNetwork,
  isWebFetchToolErrorOutput,
  isWebFetchToolSuccessOutput,
  toModelFacingWebFetchOutput,
  type WebFetchConnection,
  type WebFetchNetwork,
  type WebFetchTlsOptions,
  type WebFetchToolErrorOutput,
  type WebFetchToolInput,
  type WebFetchToolOutput,
  type WebFetchToolSuccessOutput,
} from "../../src/tools/web-fetch.ts";
import type { HarnessToolContext } from "../../src/tools/types.ts";
import { parseIpAddress } from "../../src/network-address.ts";
import {
  loopbackNetwork,
  offlineNetwork,
  type RawHttpHandler,
  type RawHttpServer,
  respondWith,
  serveRawHttp,
  serveRawHttps,
  TEST_TLS_AUTHORITY,
  TEST_TLS_COMMON_NAME_ONLY,
  TEST_TLS_SERVER,
} from "../support/web-fetch-network.ts";

const FETCHED_AT = "2026-05-01T17:54:00.000Z";

// The address every test host resolves to: on the open internet, and on none
// of the (empty) interface networks the tests give the tool, so web_fetch
// accepts it. The loopback network then carries the connection to a local
// server instead.
const PUBLIC_ADDRESS = "93.184.216.34";

const unusedSandbox: SandboxRuntime = {
  describe: () => ({
    kind: "runsc-cfc",
    defaultWorkingDirectory: "/workspace",
  }),
  resolvePath: (path) => path,
  isPathWithinWorkspace: () => true,
  isPathWithinAllowedRoots: () => true,
  defaultWorkingDirectory: () => "/workspace",
  run: () => Promise.reject(new Error("web_fetch runs no sandbox command")),
  runShell: () => Promise.reject(new Error("web_fetch runs no sandbox shell")),
};

const createContext = (): HarnessToolContext => {
  let sequence = 0;
  return {
    runId: "run-1",
    cfcEnforcementMode: "observe",
    workspaceHostPath: "/tmp/cf-harness-workspace",
    skillScriptExecutionTarget: "sandbox",
    currentDir: "/workspace",
    sandbox: unusedSandbox,
    hostProcessRunner: {
      run: () => Promise.reject(new Error("web_fetch runs no host process")),
    },
    resolvePath: (path) => path,
    resolveHostPath: (path) => path,
    resolveHostRootPath: (path) => path,
    isHostPathWithinWorkspace: () => Promise.resolve(false),
    isHostPathWithinArtifactRoot: () => Promise.resolve(false),
    setCurrentDir: () => {},
    nextOutputId(toolId) {
      sequence += 1;
      return createToolOutputId("run-1", toolId, sequence);
    },
    now: () => FETCHED_AT,
    recordSkillResourceRead: () => Promise.resolve(),
    recordSkillScriptExecution: () => Promise.resolve(),
    createCfcInvocationContext: (invocation) =>
      Promise.resolve(createHarnessCfcInvocationContext({
        sequence: 1,
        runId: "run-1",
        createdAt: FETCHED_AT,
        cfcEnforcementMode: "observe",
        runManifest: { present: false },
        ...invocation,
      })),
  };
};

const invoke = <Conn extends WebFetchConnection>(
  options: CreateWebFetchToolOptions<Conn>,
  input: WebFetchToolInput,
): Promise<WebFetchToolOutput> =>
  createWebFetchTool<Conn>({
    localNetworks: () => [],
    network: offlineNetwork,
    ...options,
  }).invoke(
    createContext(),
    input,
  );

const expectSuccess = (
  output: WebFetchToolOutput,
): WebFetchToolSuccessOutput => {
  if (!isWebFetchToolSuccessOutput(output)) {
    throw new Error(`expected a web_fetch result: ${JSON.stringify(output)}`);
  }
  return output;
};

const expectError = (output: WebFetchToolOutput): WebFetchToolErrorOutput => {
  if (!isWebFetchToolErrorOutput(output)) {
    throw new Error(`expected a web_fetch error: ${JSON.stringify(output)}`);
  }
  return output;
};

type ResolveDns = WebFetchNetwork<WebFetchConnection>["resolveDns"];

/**
 * A `resolveDns` that answers each A lookup with the IPv4 addresses in
 * `answer(name)`, and the AAAA lookup web_fetch makes beside it with the IPv6
 * ones, so `answer` runs once each time web_fetch resolves a name.
 */
const dnsAnswering = (
  answer: (name: string) => readonly string[],
): ResolveDns => {
  let addresses: readonly string[] = [];
  return (query, recordType) => {
    if (recordType === "A") {
      addresses = answer(query);
    }
    return Promise.resolve(
      addresses.filter((address) =>
        address.includes(":") === (recordType === "AAAA")
      ),
    );
  };
};

const resolvingTo = (
  addresses: readonly string[],
): ResolveDns => dnsAnswering(() => addresses);

/**
 * A loopback network on which every name resolves to {@link PUBLIC_ADDRESS}
 * and every connection reaches `port` on `127.0.0.1`.
 */
const servedNetwork = (
  port: number,
  options: Parameters<typeof loopbackNetwork>[1] = {},
) =>
  loopbackNetwork(port, {
    resolveDns: resolvingTo([PUBLIC_ADDRESS]),
    ...options,
  });

/**
 * A network on which every name resolves to {@link PUBLIC_ADDRESS}, and whose
 * every connection gives web_fetch one of `reads` for each read and then
 * ends, so that a test decides where reads split a response.
 */
const scriptedNetwork = (
  reads: readonly string[],
): WebFetchNetwork<WebFetchConnection> => ({
  ...offlineNetwork,
  resolveDns: resolvingTo([PUBLIC_ADDRESS]),
  connect: () =>
    Promise.resolve({
      readable: ReadableStream.from(
        reads.map((text) => new TextEncoder().encode(text)),
      ),
      writable: new WritableStream(),
      close: () => {},
    }),
});

/** A connection that carries nothing and counts how often it is closed. */
const countingConnection = () => {
  const connection = {
    closes: 0,
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    close() {
      connection.closes += 1;
    },
  };
  return connection;
};

const localNetwork = (text: string, prefixLength: number) => {
  const address = parseIpAddress(text);
  if (address === undefined) {
    throw new Error(`${text} did not parse`);
  }
  return { address, prefixLength };
};

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return `sha256:${
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
};

/**
 * Reads `conn` until the client closes or resets it: a test that awaits this
 * hangs, and so fails, if the client never closes its socket.
 */
const readUntilClosed = async (conn: Deno.Conn): Promise<void> => {
  const buffer = new Uint8Array(4096);
  try {
    while (await conn.read(buffer) !== null) {
      // Discard what the client sent before closing.
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.ConnectionReset)) {
      throw error;
    }
  }
};

const head = (lines: readonly string[]): string =>
  `${lines.join("\r\n")}\r\n\r\n`;

const PLAIN_HEAD = head([
  "HTTP/1.1 200 OK",
  "Content-Type: text/plain",
]);

const CHUNKED_HEAD = head([
  "HTTP/1.1 200 OK",
  "Content-Type: text/plain",
  "Transfer-Encoding: gzip, chunked",
]);

describe("web-fetch", () => {
  //
  // Most of these cases fetch through web_fetch's own HTTP/1.1 client: the
  // host resolves to a public address, and the network the tool is given
  // carries the connection to a server on `127.0.0.1` that writes exactly the
  // bytes a case needs. Nothing reaches beyond this machine.
  //

  let server: RawHttpServer | undefined;

  const startServer = (handler: RawHttpHandler): RawHttpServer => {
    server = serveRawHttp(handler);
    return server;
  };

  /**
   * web_fetch's output for `url` when every connection reaches `handler`, on
   * a server that replaces any the case started before.
   */
  const fetchFromServer = async (
    handler: RawHttpHandler,
    url = "http://public.example/page",
    input: Omit<WebFetchToolInput, "url"> = {},
  ) => {
    await server?.close();
    const { port } = startServer(handler);
    const network = servedNetwork(port);
    const output = await invoke({ network }, { url, ...input });
    return { output, network };
  };

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  describe("input", () => {
    it("throws for a byte cap, text cap or timeout outside its range", async () => {
      for (
        const input of [
          { maxBytes: 0 },
          { maxBytes: 1_000_001 },
          { maxTextChars: 1.5 },
          { timeoutMs: 60_001 },
        ]
      ) {
        await expect(invoke({}, { url: "https://public.example/", ...input }))
          .rejects.toThrow("must be an integer from 1 to");
      }
    });

    it("returns `invalid_url` for text that is not a URL", async () => {
      expect(expectError(await invoke({}, { url: "not a url" }))).toEqual({
        type: "cf-harness.web-fetch-error",
        outputId: "run-1:web_fetch:1",
        url: "not a url",
        code: "invalid_url",
        message: "web_fetch url is not valid: not a url",
        fetchedAt: FETCHED_AT,
      });
    });

    it("returns `invalid_url` for a scheme other than HTTP and HTTPS", async () => {
      const output = expectError(
        await invoke({}, { url: "ftp://public.example/file" }),
      );

      expect(output.code).toBe("invalid_url");
      expect(output.message).toBe("web_fetch protocol ftp: is not supported");
    });

    it("returns `blocked_url` for a URL carrying credentials", async () => {
      const output = expectError(
        await invoke({}, { url: "https://user:secret@public.example/" }),
      );

      expect(output.code).toBe("blocked_url");
      expect(output.message).toBe(
        "web_fetch URLs may not include credentials",
      );
    });

    it("returns `blocked_url` for host names that name this machine or its network, without fetching", async () => {
      const network = servedNetwork(0);

      for (
        const host of [
          "localhost:8000",
          "host.docker.internal",
          "printer.local",
          "app.localhost",
        ]
      ) {
        const output = expectError(
          await invoke({ network }, { url: `http://${host}/private` }),
        );

        expect(output).toEqual({
          type: "cf-harness.web-fetch-error",
          outputId: "run-1:web_fetch:1",
          url: `http://${host}/private`,
          code: "blocked_url",
          message: `web_fetch host ${
            host.split(":")[0]
          } is local and is not allowed`,
          fetchedAt: FETCHED_AT,
        });
      }
      expect(network.connects).toEqual([]);
    });
  });

  describe("address checks", () => {
    it("returns `blocked_url` for a host that resolves to a private address, without fetching", async () => {
      const network = servedNetwork(0, {
        resolveDns: resolvingTo(["10.0.0.7"]),
      });

      const output = expectError(
        await invoke({ network }, { url: "https://public.example/private" }),
      );

      expect(network.connects).toEqual([]);
      expect(output).toEqual({
        type: "cf-harness.web-fetch-error",
        outputId: "run-1:web_fetch:1",
        url: "https://public.example/private",
        code: "blocked_url",
        message:
          "web_fetch host public.example resolved to 10.0.0.7, which is not on the open internet, and is not allowed",
        fetchedAt: FETCHED_AT,
      });
    });

    it("returns `blocked_url` for a host that resolves to something it cannot read as an address", async () => {
      const network = servedNetwork(0, {
        resolveDns: resolvingTo(["0x7f.0.0.1"]),
      });

      const output = expectError(
        await invoke({ network }, { url: "https://odd.example/" }),
      );

      expect(network.connects).toEqual([]);
      expect(output.message).toBe(
        "web_fetch host odd.example resolved to 0x7f.0.0.1, which is not an IP address",
      );
    });

    it("returns `blocked_url` when the host resolves to a private address again at connect time", async () => {
      const resolutions = [[PUBLIC_ADDRESS], ["10.0.0.7"]];
      const network = loopbackNetwork(0, {
        resolveDns: dnsAnswering(() => resolutions.shift()!),
      });

      const output = expectError(
        await invoke({ network }, { url: "https://rebind.example/private" }),
      );

      expect(resolutions).toEqual([]);
      expect(network.connects).toEqual([]);
      expect(output).toEqual({
        type: "cf-harness.web-fetch-error",
        outputId: "run-1:web_fetch:1",
        url: "https://rebind.example/private",
        code: "blocked_url",
        message:
          "web_fetch host rebind.example resolved to 10.0.0.7, which is not on the open internet, and is not allowed",
        finalUrl: "https://rebind.example/private",
        fetchedAt: FETCHED_AT,
      });
    });

    it("returns `blocked_url` for IP literal hosts outside the open internet, without fetching", async () => {
      const network = loopbackNetwork(0);

      for (
        const url of [
          "http://100.64.0.1/",
          "http://192.0.2.1/",
          "http://198.18.0.1/",
          "http://224.0.0.1/",
          "http://240.0.0.1/",
          "http://[::ffff:7f00:1]/",
          "http://[2001:db8::1]/",
          "http://[64:ff9b::a00:1]/",
        ]
      ) {
        const output = expectError(await invoke({ network }, { url }));

        expect(output.code).toBe("blocked_url");
        expect(output.message).toBe(
          `web_fetch host ${
            new URL(url).hostname
          } is not on the open internet and is not allowed`,
        );
      }
      expect(network.connects).toEqual([]);
    });

    describe("this device's interface networks", () => {
      const LOCAL_NETWORKS = [
        localNetwork("2a02:8071:1234:5600::1", 64),
        localNetwork("81.2.69.142", 24),
        localNetwork("81.2.70.5", 0),
      ];

      /**
       * What web_fetch makes of `url` when its host resolves to `resolved`
       * and this device's interfaces are on `LOCAL_NETWORKS`: the addresses
       * it connected to, and its output.
       */
      const fetchOnLocalNetworks = async (url: string, resolved: string) => {
        server ??= serveRawHttps(respondWith(`${PLAIN_HEAD}fetched`));
        const network = loopbackNetwork(server.port, {
          resolveDns: resolvingTo([resolved]),
        });
        const output = await invoke({
          network,
          localNetworks: () => LOCAL_NETWORKS,
        }, { url });
        return { connects: network.connects, output };
      };

      it("returns `blocked_url` for public addresses on those networks", async () => {
        for (
          const address of [
            "2a02:8071:1234:5600::99",
            "81.2.69.160",
            "::ffff:81.2.69.160",
            "81.2.70.5",
          ]
        ) {
          const { connects, output } = await fetchOnLocalNetworks(
            "https://host.example/",
            address,
          );

          expect(connects).toEqual([]);
          expect(expectError(output).message).toBe(
            `web_fetch host host.example resolved to ${address}, which is not on the open internet, and is not allowed`,
          );
        }
        for (
          const url of [
            "https://[2a02:8071:1234:5600::99]/",
            "https://81.2.69.160/",
            "https://[::ffff:81.2.69.160]/",
          ]
        ) {
          const host = new URL(url).hostname;
          const { connects, output } = await fetchOnLocalNetworks(url, host);

          expect(connects).toEqual([]);
          expect(expectError(output).message).toBe(
            `web_fetch host ${host} is not on the open internet and is not allowed`,
          );
        }
      });

      it("fetches public addresses outside those networks", async () => {
        for (
          const address of [
            "2a02:8071:1234:5601::99",
            "81.2.70.160",
            "::ffff:81.2.70.160",
            "81.2.70.6",
          ]
        ) {
          const { connects, output } = await fetchOnLocalNetworks(
            "https://host.example/",
            address,
          );

          expect(connects.map(({ hostname }) => hostname)).toEqual([address]);
          expect(expectSuccess(output).text).toBe("fetched");
        }
        for (
          const url of [
            "https://[2a02:8071:1234:5601::99]/",
            "https://81.2.70.160/",
          ]
        ) {
          const { connects, output } = await fetchOnLocalNetworks(
            url,
            new URL(url).hostname,
          );

          expect(connects).toHaveLength(1);
          expect(expectSuccess(output).text).toBe("fetched");
        }
      });

      it("returns `blocked_url` when the device joins a network between the URL check and the connection", async () => {
        const networkLists = [[], LOCAL_NETWORKS];
        const network = loopbackNetwork(0, {
          resolveDns: resolvingTo(["81.2.69.160"]),
        });

        const output = expectError(
          await invoke({
            network,
            localNetworks: () => networkLists.shift()!,
          }, { url: "https://joined.example/" }),
        );

        expect(networkLists).toEqual([]);
        expect(network.connects).toEqual([]);
        expect(output).toEqual({
          type: "cf-harness.web-fetch-error",
          outputId: "run-1:web_fetch:1",
          url: "https://joined.example/",
          code: "blocked_url",
          message:
            "web_fetch host joined.example resolved to 81.2.69.160, which is not on the open internet, and is not allowed",
          finalUrl: "https://joined.example/",
          fetchedAt: FETCHED_AT,
        });
      });
    });
  });

  describe("DNS", () => {
    it("connects to an address the A lookup returns when the AAAA lookup fails", async () => {
      const queries: string[] = [];
      const { port } = startServer(respondWith(`${PLAIN_HEAD}resolved`));
      const network = loopbackNetwork(port, {
        resolveDns: (query, recordType) => {
          queries.push(`${recordType} ${query}`);
          return recordType === "A"
            ? Promise.resolve([PUBLIC_ADDRESS])
            : Promise.reject(new Error("no AAAA records"));
        },
      });

      const output = expectSuccess(
        await invoke({ network }, { url: "http://public.example/" }),
      );

      expect(output.text).toBe("resolved");
      // Once to validate the URL, and again when connecting, so a rebinding
      // between the two is caught.
      expect(queries).toEqual([
        "A public.example",
        "AAAA public.example",
        "A public.example",
        "AAAA public.example",
      ]);
      expect(network.connects).toEqual([{
        hostname: PUBLIC_ADDRESS,
        port: 80,
      }]);
    });

    it("returns `blocked_url` naming the lookup failure when both lookups fail", async () => {
      const network = loopbackNetwork(0, {
        resolveDns: (_query, recordType) =>
          Promise.reject(new Error(`no ${recordType} records`)),
      });

      const output = expectError(
        await invoke({ network }, { url: "http://missing.example/" }),
      );

      expect(output.code).toBe("blocked_url");
      expect(output.message).toBe(
        "web_fetch host missing.example could not be resolved to a public address: no A records",
      );
      expect(network.connects).toEqual([]);
    });

    it("returns `blocked_url` when both lookups find no address", async () => {
      const network = loopbackNetwork(0, {
        resolveDns: () => Promise.resolve([]),
      });

      const output = expectError(
        await invoke({ network }, { url: "http://empty.example/" }),
      );

      expect(output.code).toBe("blocked_url");
      expect(output.message).toBe(
        "web_fetch host empty.example could not be resolved to a public address",
      );
    });

    it("connects to an IP literal host without a lookup", async () => {
      const { port } = startServer(respondWith(`${PLAIN_HEAD}literal`));
      const network = loopbackNetwork(port);

      const output = expectSuccess(
        await invoke({ network }, { url: "http://81.2.70.160:8080/x" }),
      );

      expect(output.text).toBe("literal");
      expect(network.connects).toEqual([{
        hostname: "81.2.70.160",
        port: 8080,
      }]);
    });
  });

  describe("connection", () => {
    it("sends one GET naming the host, closing the connection and refusing compression", async () => {
      const { output, network } = await fetchFromServer(
        respondWith(`${PLAIN_HEAD}hello`),
        "http://public.example:8080/path?q=1",
      );

      expect(expectSuccess(output).text).toBe("hello");
      expect(network.connects).toEqual([{
        hostname: PUBLIC_ADDRESS,
        port: 8080,
      }]);
      const lines = server!.requests[0]!.split("\r\n");
      expect(lines.slice(0, 4)).toEqual([
        "GET /path?q=1 HTTP/1.1",
        "Host: public.example:8080",
        "Connection: close",
        "Accept-Encoding: identity",
      ]);
      expect(lines).toContain("User-Agent: cf-harness-web-fetch/1.0");
      expect(lines.filter((line) => /^host:/i.test(line))).toHaveLength(1);
    });

    it("connects to port 80 for HTTP and 443 for HTTPS when the URL names none", async () => {
      const http = await fetchFromServer(
        respondWith(`${PLAIN_HEAD}http`),
        "http://public.example/",
      );
      await server!.close();
      server = serveRawHttps(respondWith(`${PLAIN_HEAD}https`));
      const httpsNetwork = servedNetwork(server.port);
      const https = await invoke({ network: httpsNetwork }, {
        url: "https://public.example/",
      });

      expect(http.network.connects[0]?.port).toBe(80);
      expect(expectSuccess(https).text).toBe("https");
      expect(httpsNetwork.connects[0]?.port).toBe(443);
    });

    it("verifies TLS against the URL's host name rather than the address", async () => {
      server = serveRawHttps(respondWith(`${PLAIN_HEAD}secure`));
      const network = servedNetwork(server.port);

      const output = expectSuccess(
        await invoke({ network }, { url: "https://Public.Example./secure" }),
      );

      expect(output.text).toBe("secure");
      expect(output.finalUrl).toBe("https://public.example./secure");
      expect(network.tlsHostnames).toEqual(["public.example"]);
    });

    it("returns `fetch_failed` when the TLS handshake fails", async () => {
      // A server that answers a TLS client hello with plain HTTP, then waits
      // for the client to close its socket.
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const clientClosed = (async () => {
        const conn = await listener.accept();
        try {
          await conn.write(new TextEncoder().encode(PLAIN_HEAD));
          await readUntilClosed(conn);
        } finally {
          conn.close();
        }
      })();
      const network = servedNetwork(listener.addr.port);

      try {
        const output = expectError(
          await invoke({ network }, { url: "https://public.example/" }),
        );

        expect(output.code).toBe("fetch_failed");
        expect(output.message).toContain(
          "web_fetch could not connect to public host public.example",
        );
        await clientClosed;
      } finally {
        listener.close();
      }
    });

    it("returns `fetch_failed`, leaving the connection to a `startTls` that failed", async () => {
      const tcp = countingConnection();
      const tlsHostnames: string[] = [];

      const output = expectError(
        await invoke({
          network: {
            ...offlineNetwork,
            resolveDns: resolvingTo([PUBLIC_ADDRESS]),
            connect: () => Promise.resolve(tcp),
            startTls: (conn: WebFetchConnection, { hostname }) => {
              expect(conn).toBe(tcp);
              tlsHostnames.push(hostname);
              return Promise.reject(new Error("handshake failed"));
            },
          },
        }, { url: "https://public.example/" }),
      );

      expect(output.code).toBe("fetch_failed");
      expect(output.message).toContain("handshake failed");
      expect(tlsHostnames).toEqual(["public.example"]);
      // `startTls` owns the connection it was handed, failing or not.
      expect(tcp.closes).toBe(0);
    });

    it("tries the next resolved address when one refuses the connection", async () => {
      const { port } = startServer(respondWith(`${PLAIN_HEAD}second`));
      const network = loopbackNetwork(port, {
        resolveDns: resolvingTo([PUBLIC_ADDRESS, "81.2.70.160"]),
        unreachable: [PUBLIC_ADDRESS],
      });

      const output = expectSuccess(
        await invoke({ network }, { url: "http://public.example/" }),
      );

      expect(output.text).toBe("second");
      expect(network.connects.map(({ hostname }) => hostname)).toEqual([
        PUBLIC_ADDRESS,
        "81.2.70.160",
      ]);
    });

    it("returns `fetch_failed` naming every address when none accepts", async () => {
      const network = loopbackNetwork(0, {
        resolveDns: resolvingTo([PUBLIC_ADDRESS, "81.2.70.160"]),
        unreachable: [PUBLIC_ADDRESS, "81.2.70.160"],
      });

      const output = expectError(
        await invoke({ network }, { url: "http://public.example/" }),
      );

      expect(output.code).toBe("fetch_failed");
      expect(output.message).toBe(
        "web_fetch could not connect to public host public.example: " +
          `connection refused: ${PUBLIC_ADDRESS}; ` +
          "connection refused: 81.2.70.160",
      );
    });

    it("returns `fetch_failed` for port 0 without connecting", async () => {
      const network = servedNetwork(0);

      const output = expectError(
        await invoke({ network }, { url: "http://public.example:0/" }),
      );

      expect(output.code).toBe("fetch_failed");
      expect(output.message).toContain("web_fetch URL port is not valid: 0");
      expect(network.connects).toEqual([]);
    });
  });

  describe("defaultWebFetchNetwork.startTls()", () => {
    //
    // These cases run the TLS handshake web_fetch uses in production against
    // a server on `127.0.0.1`.
    //

    /** web_fetch's TLS over a new TCP connection to the case's server. */
    const startTls = async (options: WebFetchTlsOptions) =>
      defaultWebFetchNetwork.startTls(
        await Deno.connect({ hostname: "127.0.0.1", port: server!.port }),
        options,
      );

    const trustingTestAuthority = (hostname: string): WebFetchTlsOptions => ({
      hostname,
      caCerts: [TEST_TLS_AUTHORITY],
    });

    it("exchanges bytes with a server whose certificate names the host and comes from a trusted authority", async () => {
      server = serveRawHttps(respondWith(`${PLAIN_HEAD}secure`));

      for (
        const hostname of [
          "public.example",
          "81.2.70.160",
          "2a02:8071:1234:5601::99",
          "2A02:8071:1234:5601:0:0:0:99",
        ]
      ) {
        const conn = await startTls(trustingTestAuthority(hostname));
        const writer = conn.writable.getWriter();
        await writer.write(new TextEncoder().encode(head(["GET / HTTP/1.1"])));
        writer.releaseLock();
        const response = await new Response(conn.readable).text();

        expect(response).toBe(`${PLAIN_HEAD}secure`);
      }
    });

    it("refuses a certificate that does not name the host", async () => {
      server = serveRawHttps(respondWith(PLAIN_HEAD));

      // The certificate names 81.2.70.160, which is neither the IPv4-mapped
      // IPv6 address of the same host nor an IPv6 address starting with the
      // same four bytes.
      for (
        const hostname of [
          "other.example",
          "81.2.70.161",
          "::ffff:81.2.70.160",
          "5102:46a0::",
          "2a02:8071:1234:5601::98",
        ]
      ) {
        await expect(startTls(trustingTestAuthority(hostname))).rejects
          .toThrow(`certificate not valid for name "${hostname}"`);
      }
    });

    it("refuses a certificate from an authority it does not trust", async () => {
      server = serveRawHttps(respondWith(PLAIN_HEAD));

      await expect(startTls({ hostname: "public.example" })).rejects.toThrow(
        "invalid peer certificate: UnknownIssuer",
      );
    });

    it("refuses a certificate naming the host only as its common name", async () => {
      server = serveRawHttps(
        respondWith(PLAIN_HEAD),
        TEST_TLS_COMMON_NAME_ONLY,
      );

      await expect(startTls(trustingTestAuthority("public.example"))).rejects
        .toThrow('certificate not valid for name "public.example"');
    });

    it("passes on only the host name and authorities, so verification stays on", async () => {
      server = serveRawHttps(respondWith(PLAIN_HEAD));
      // Wider than WebFetchTlsOptions, as any object with its properties may
      // be.
      const options = {
        ...trustingTestAuthority("other.example"),
        unsafelyDisableHostnameVerification: true,
      };

      // A connection that verification let through is closed, so that the
      // server stops waiting for a request.
      const outcome = await startTls(options).then(
        (conn) => {
          conn.close();
          return "connected";
        },
        (error) => String(error),
      );

      expect(outcome).toContain(
        'certificate not valid for name "other.example"',
      );
    });

    it("offers HTTP/1.1 by ALPN", async () => {
      const listener = Deno.listenTls({
        hostname: "127.0.0.1",
        port: 0,
        alpnProtocols: ["h2", "http/1.1"],
        ...TEST_TLS_SERVER,
      });
      try {
        const [accepted, conn] = await Promise.all([
          listener.accept(),
          Deno.connect({ hostname: "127.0.0.1", port: listener.addr.port })
            .then((tcp) =>
              defaultWebFetchNetwork.startTls(
                tcp,
                trustingTestAuthority("public.example"),
              )
            ),
        ]);
        const { alpnProtocol } = await accepted.handshake();
        accepted.close();
        conn.close();

        expect(alpnProtocol).toBe("http/1.1");
      } finally {
        listener.close();
      }
    });

    it("closes the connection it was handed when TLS cannot start", async () => {
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      try {
        const [accepted, tcp] = await Promise.all([
          listener.accept(),
          Deno.connect({ hostname: "127.0.0.1", port: listener.addr.port }),
        ]);

        await expect(
          defaultWebFetchNetwork.startTls(tcp, { hostname: "not a name" }),
        ).rejects.toThrow("Invalid hostname: 'not a name'");
        expect(() => tcp.close()).toThrow(Deno.errors.BadResource);
        // Only the client closing its socket ends this read.
        expect(await accepted.read(new Uint8Array(1))).toBeNull();
        accepted.close();
      } finally {
        listener.close();
      }
    });
  });

  describe("response head", () => {
    it("returns `fetch_failed` for a status line that is not HTTP", async () => {
      const { output } = await fetchFromServer(
        respondWith("SPDY/9 200 OK\r\n\r\nbody"),
      );

      expect(expectError(output).message).toContain(
        "web_fetch received an invalid HTTP status line",
      );
    });

    it("returns `fetch_failed` when the connection ends inside the headers", async () => {
      const { output } = await fetchFromServer(
        respondWith("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n"),
      );

      expect(expectError(output).message).toContain(
        "web_fetch response headers were incomplete or too large",
      );
    });

    it("returns `fetch_failed` for headers longer than 64 KiB", async () => {
      const { output } = await fetchFromServer(
        respondWith(
          `HTTP/1.1 200 OK\r\nX-Long: ${"a".repeat(70 * 1024)}\r\n\r\n`,
        ),
      );

      expect(expectError(output).message).toContain(
        "web_fetch response headers were incomplete or too large",
      );
    });

    it("returns the final response after skipping interim 1xx heads", async () => {
      const { output } = await fetchFromServer(
        respondWith(
          head([
            "HTTP/1.1 103 Early Hints",
            "Link: </style.css>; rel=preload",
          ]) +
            head(["HTTP/1.1 100 Continue"]) +
            PLAIN_HEAD + "final",
        ),
      );

      const success = expectSuccess(output);
      expect(success.status).toBe(200);
      expect(success.contentType).toBe("text/plain");
      expect(success.text).toBe("final");
    });

    it("returns `fetch_failed` for a 101 Switching Protocols it did not ask for", async () => {
      const { output } = await fetchFromServer(
        respondWith(
          head(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket"]) +
            PLAIN_HEAD + "after the switch",
        ),
      );

      const error = expectError(output);
      expect(error.code).toBe("fetch_failed");
      expect(error.message).toContain(
        "web_fetch received 101 Switching Protocols, which it did not ask for",
      );
    });

    it("returns `fetch_failed` when interim heads together pass 64 KiB", async () => {
      const interim = head([
        "HTTP/1.1 103 Early Hints",
        `Link: <${"a".repeat(1024)}>; rel=preload`,
      ]);
      const { output } = await fetchFromServer(
        respondWith(interim.repeat(70) + PLAIN_HEAD + "final"),
      );

      expect(expectError(output).message).toContain(
        "web_fetch response headers were incomplete or too large",
      );
    });

    it("joins a folded header line onto the header above it and skips lines without a name", async () => {
      const { output } = await fetchFromServer(
        respondWith(
          "HTTP/1.0 200\r\n" +
            "no separator here\r\n" +
            ": nameless\r\n" +
            "Content-Type: text/plain;\r\n" +
            "\tcharset=utf-8\r\n" +
            "\r\n" +
            "folded",
        ),
      );

      const success = expectSuccess(output);
      expect(success.contentType).toBe("text/plain; charset=utf-8");
      expect(success.status).toBe(200);
      expect(success.text).toBe("folded");
    });
  });

  describe("response body", () => {
    it("stops reading at the declared content length", async () => {
      const { output } = await fetchFromServer(
        respondWith(
          head([
            "HTTP/1.1 200 OK",
            "Content-Type: text/plain",
            "Content-Length: 5",
          ]) + "hello and more",
        ),
      );

      expect(expectSuccess(output).rawContent).toBe("hello");
    });

    // A body larger than one 16 KiB read, so that most of it arrives after
    // the read that found the end of the head.
    const LARGE_BODY = "0123456789abcdef".repeat(4096);

    it("reads a content-length body across many reads", async () => {
      const { output } = await fetchFromServer(
        respondWith(
          head([
            "HTTP/1.1 200 OK",
            "Content-Type: text/plain",
            `Content-Length: ${LARGE_BODY.length}`,
          ]) + LARGE_BODY,
        ),
        "http://public.example/large",
        { maxBytes: 1_000_000 },
      );

      const success = expectSuccess(output);
      expect(success.rawContent).toBe(LARGE_BODY);
      expect(success.rawContentTruncated).toBe(false);
    });

    it("reads a body without a length across many reads until the connection closes", async () => {
      const { output } = await fetchFromServer(
        respondWith(PLAIN_HEAD + LARGE_BODY),
        "http://public.example/large",
        { maxBytes: 1_000_000 },
      );

      expect(expectSuccess(output).rawContent).toBe(LARGE_BODY);
    });

    it("ignores a content length that is not a whole number", async () => {
      const { output } = await fetchFromServer(
        respondWith(
          head([
            "HTTP/1.1 200 OK",
            "Content-Type: text/plain",
            "Content-Length: -3",
          ]) + "whole body",
        ),
      );

      expect(expectSuccess(output).rawContent).toBe("whole body");
    });

    it("decodes a chunked body with extensions and trailers", async () => {
      const { output } = await fetchFromServer(
        respondWith(
          CHUNKED_HEAD +
            "5;name=value\r\nhello\r\n" +
            "7\r\n, world\r\n" +
            "0\r\n" +
            "X-Checksum: abc\r\n" +
            "\r\n",
        ),
      );

      const success = expectSuccess(output);
      expect(success.rawContent).toBe("hello, world");
      expect(success.bytes).toBe(12);
    });

    it("decodes a chunk whose bytes arrive in several reads", async () => {
      const network = scriptedNetwork([
        CHUNKED_HEAD,
        "a",
        "\r\n01234",
        "56789\r",
        "\n0\r\n\r\n",
      ]);

      const output = await invoke({ network }, {
        url: "http://public.example/",
      });

      expect(expectSuccess(output).rawContent).toBe("0123456789");
    });

    for (
      const { description, body, message } of [
        {
          description: "a chunk size that is not hexadecimal",
          body: "zz\r\n",
          message: "web_fetch received an invalid chunked response",
        },
        {
          description: "a chunk size too large to represent",
          body: `${"f".repeat(20)}\r\n`,
          message: "web_fetch received an invalid chunked response",
        },
        {
          description: "chunk data not followed by a line break",
          body: "3\r\nabcXY",
          message: "web_fetch received an invalid chunked response",
        },
        {
          description: "a connection that ends inside a chunk",
          body: "a\r\nabc",
          message: "web_fetch response ended unexpectedly",
        },
        {
          description: "a chunk size line longer than 4 KiB",
          body: `${"0".repeat(5000)}\r\n`,
          message: "web_fetch chunked line exceeded size limit",
        },
        {
          description: "a chunk size line that passes 4 KiB without ending",
          body: "1".repeat(5000),
          message: "web_fetch chunked line exceeded size limit",
        },
        {
          description: "trailers longer than 16 KiB",
          body: `1\r\na\r\n0\r\n${
            `X-Trailer: ${"a".repeat(200)}\r\n`.repeat(90)
          }\r\n`,
          message: "web_fetch chunked trailers exceeded size limit",
        },
        {
          description: "more than 100 trailer lines",
          body: `0\r\n${"X-T: 1\r\n".repeat(101)}\r\n`,
          message: "web_fetch chunked trailers exceeded line limit",
        },
      ]
    ) {
      it(`returns \`fetch_failed\` for ${description}`, async () => {
        const { output } = await fetchFromServer(
          respondWith(CHUNKED_HEAD + body),
        );

        const error = expectError(output);
        expect(error.code).toBe("fetch_failed");
        expect(error.message).toContain(message);
      });
    }

    it("stops reading at the byte cap, reports the body truncated and closes the connection", async () => {
      const { promise: clientClosed, resolve: signalClientClosed } = Promise
        .withResolvers<void>();
      const { output } = await fetchFromServer(
        async (conn) => {
          await conn.write(
            new TextEncoder().encode(`${PLAIN_HEAD}${"x".repeat(1000)}`),
          );
          // Held open: only the client closing it ends this read.
          await conn.read(new Uint8Array(1));
          signalClientClosed();
        },
        "http://public.example/",
        { maxBytes: 10 },
      );
      await clientClosed;

      const success = expectSuccess(output);
      expect(success.rawContent).toBe("x".repeat(10));
      expect(success.rawContentTruncated).toBe(true);
    });

    it("caps the raw bytes and the model's text independently", async () => {
      const { output } = await fetchFromServer(
        respondWith(`${PLAIN_HEAD}abcdef`),
        "http://public.example/large.txt",
        { maxBytes: 3, maxTextChars: 2 },
      );

      const success = expectSuccess(output);
      expect(success.bytes).toBe(3);
      expect(success.rawContent).toBe("abc");
      expect(success.rawContentTruncated).toBe(true);
      expect(success.text).toBe("ab");
      expect(success.textTruncated).toBe(true);
    });

    it("returns `unsupported_content_type` for a type that is not text, closing the connection unread", async () => {
      // The body's chunked framing is invalid, so reading any of it would
      // fail the fetch.
      const { promise: clientClosed, resolve: signalClientClosed } = Promise
        .withResolvers<void>();
      const { output } = await fetchFromServer(
        async (conn) => {
          await conn.write(
            new TextEncoder().encode(
              head([
                "HTTP/1.1 200 OK",
                "Content-Type: image/png",
                "Transfer-Encoding: chunked",
              ]) + "png\r\n",
            ),
          );
          // Held open: only the client closing it ends this read.
          await conn.read(new Uint8Array(1));
          signalClientClosed();
        },
        "http://public.example/image.png",
      );
      await clientClosed;

      expect(output).toEqual({
        type: "cf-harness.web-fetch-error",
        outputId: "run-1:web_fetch:1",
        url: "http://public.example/image.png",
        code: "unsupported_content_type",
        message: "web_fetch content-type image/png is not supported",
        finalUrl: "http://public.example/image.png",
        status: 200,
        contentType: "image/png",
        fetchedAt: FETCHED_AT,
      });
    });

    it("returns `unsupported_content_type` for a response without a content type", async () => {
      const { output } = await fetchFromServer(
        respondWith("HTTP/1.1 200 OK\r\n\r\nheaderless text"),
        "http://public.example/headerless",
      );

      expect(output).toEqual({
        type: "cf-harness.web-fetch-error",
        outputId: "run-1:web_fetch:1",
        url: "http://public.example/headerless",
        code: "unsupported_content_type",
        message:
          "web_fetch response did not include a supported text content-type",
        finalUrl: "http://public.example/headerless",
        status: 200,
        fetchedAt: FETCHED_AT,
      });
    });

    it("returns `fetch_failed` for a body that ends before its Content-Length", async () => {
      const truncatedHead = head([
        "HTTP/1.1 200 OK",
        "Content-Type: text/plain",
        "Content-Length: 100",
      ]);

      const truncated = expectError(
        await invoke({ network: scriptedNetwork([truncatedHead, "partial"]) }, {
          url: "http://public.example/",
        }),
      );
      const complete = expectSuccess(
        await invoke({
          network: scriptedNetwork([
            head([
              "HTTP/1.1 200 OK",
              "Content-Type: text/plain",
              "Content-Length: 7",
            ]),
            "partial",
          ]),
        }, { url: "http://public.example/" }),
      );

      expect(truncated.code).toBe("fetch_failed");
      expect(truncated.message).toContain(
        "web_fetch response ended before its Content-Length",
      );
      expect(complete.rawContent).toBe("partial");
    });

    it("returns `fetch_failed` when reading the body fails", async () => {
      const network: WebFetchNetwork<WebFetchConnection> = {
        ...scriptedNetwork([]),
        connect: () =>
          Promise.resolve({
            readable: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    head([
                      "HTTP/1.1 200 OK",
                      "Content-Type: text/plain",
                      "Content-Length: 100",
                    ]) + "partial",
                  ),
                );
              },
              pull(controller) {
                controller.error(new Error("Connection reset by peer"));
              },
            }),
            writable: new WritableStream(),
            close: () => {},
          }),
      };

      const output = expectError(
        await invoke({ network }, { url: "http://public.example/reset" }),
      );

      expect(output.code).toBe("fetch_failed");
      expect(output.message).toContain("Connection reset by peer");
    });

    it("returns an empty body for a status that cannot carry one", async () => {
      for (const status of [204, 205]) {
        const { output } = await fetchFromServer(
          respondWith(
            head([`HTTP/1.1 ${status} No Content`, "Content-Type: text/plain"]),
          ),
        );

        const success = expectSuccess(output);
        expect(success.status).toBe(status);
        expect(success.ok).toBe(true);
        expect(success.bytes).toBe(0);
        expect(success.rawContent).toBe("");
      }
    });
  });

  describe("timeouts", () => {
    //
    // The tool's timer is the only clock these cases need, so a fake one
    // fires it once the server has seen the request, rather than a real one
    // racing the network.
    //

    let time: FakeTime | undefined;

    afterEach(() => {
      time?.restore();
      time = undefined;
    });

    /**
     * Starts fetching from a server that runs `beforeHang` and then holds the
     * connection open until the client closes it, fires the timeout once the
     * server has the request, and returns the output.
     */
    const timeOutDuringResponse = async (
      beforeHang: (conn: Deno.Conn) => Promise<void>,
      url = "http://public.example/slow",
    ) => {
      const { promise: requested, resolve: signalRequested } = Promise
        .withResolvers<void>();
      const serve = url.startsWith("https:") ? serveRawHttps : serveRawHttp;
      server = serve(async (conn) => {
        await beforeHang(conn);
        signalRequested();
        // Held until the client gives up and closes.
        await conn.read(new Uint8Array(1));
      });
      time = new FakeTime();
      const pending = invoke({ network: servedNetwork(server.port) }, {
        url,
        timeoutMs: 1000,
      });
      // A fetch that fails before its request is read settles first, and
      // then fails the test rather than leaving it waiting.
      await Promise.race([requested, pending]);
      await time.tickAsync(1000);
      return await pending;
    };

    it("returns `timeout` while waiting for the response head", async () => {
      const output = await timeOutDuringResponse(() => Promise.resolve());

      expect(expectError(output)).toEqual({
        type: "cf-harness.web-fetch-error",
        outputId: "run-1:web_fetch:1",
        url: "http://public.example/slow",
        code: "timeout",
        message: "web_fetch timed out",
        fetchedAt: FETCHED_AT,
      });
    });

    it("returns `timeout` while waiting for the response head over TLS", async () => {
      const output = await timeOutDuringResponse(
        () => Promise.resolve(),
        "https://public.example/slow",
      );

      expect(expectError(output).code).toBe("timeout");
    });

    it("returns `timeout` while resolving the host", async () => {
      const { promise: resolving, resolve: signalResolving } = Promise
        .withResolvers<{ signal: AbortSignal }>();
      time = new FakeTime();

      const pending = invoke({
        network: {
          ...offlineNetwork,
          resolveDns: (_query, _recordType, options) => {
            signalResolving(options);
            return new Promise(() => {});
          },
        },
      }, { url: "https://slow.example/resolve", timeoutMs: 1000 });
      const { signal } = await resolving;
      await time.tickAsync(1000);

      // The lookup was handed the signal, so it stops when web_fetch does.
      expect(signal.aborted).toBe(true);
      expect(expectError(await pending)).toEqual({
        type: "cf-harness.web-fetch-error",
        outputId: "run-1:web_fetch:1",
        url: "https://slow.example/resolve",
        code: "timeout",
        message: "web_fetch timed out",
        fetchedAt: FETCHED_AT,
      });
    });

    it("returns `timeout` while resolving a redirect's target", async () => {
      const { promise: resolving, resolve: signalResolving } = Promise
        .withResolvers<void>();
      const { port } = startServer(respondWith(head([
        "HTTP/1.1 302 Found",
        "Location: http://slow.example/",
      ])));
      const publicDns = resolvingTo([PUBLIC_ADDRESS]);
      time = new FakeTime();

      const pending = invoke({
        network: loopbackNetwork(port, {
          resolveDns: (query, recordType, options) => {
            if (query !== "slow.example") {
              return publicDns(query, recordType, options);
            }
            signalResolving();
            return new Promise(() => {});
          },
        }),
      }, { url: "http://public.example/start", timeoutMs: 1000 });
      await resolving;
      await time.tickAsync(1000);

      const output = expectError(await pending);
      expect(output.code).toBe("timeout");
      expect(output.url).toBe("http://public.example/start");
      expect(server!.requests).toHaveLength(1);
    });

    it("returns `timeout` while connecting, having handed the connection its signal", async () => {
      const { promise: connecting, resolve: signalConnecting } = Promise
        .withResolvers<Deno.ConnectOptions>();
      const network = {
        ...offlineNetwork,
        resolveDns: resolvingTo([PUBLIC_ADDRESS]),
        connect: (options: Deno.ConnectOptions) => {
          signalConnecting(options);
          return new Promise<never>(() => {});
        },
      };
      time = new FakeTime();

      const pending = invoke({ network }, {
        url: "http://public.example/connect",
        timeoutMs: 1000,
      });
      const { signal } = await connecting;
      await time.tickAsync(1000);

      expect(expectError(await pending).code).toBe("timeout");
      expect(signal?.aborted).toBe(true);
    });

    it("returns `timeout` while waiting for more of the body", async () => {
      const output = await timeOutDuringResponse(async (conn) => {
        await conn.write(new TextEncoder().encode(`${PLAIN_HEAD}partial`));
      });

      expect(expectError(output).code).toBe("timeout");
    });

    it("returns `timeout`, leaving no rejection unhandled, when the handshake fails after the timeout", async () => {
      time = new FakeTime();

      const output = await invoke({
        network: {
          ...offlineNetwork,
          resolveDns: resolvingTo([PUBLIC_ADDRESS]),
          connect: () =>
            Promise.resolve({
              readable: new ReadableStream(),
              writable: new WritableStream(),
              close: () => {},
            }),
          startTls: () => {
            // The timeout fires before web_fetch waits on the handshake.
            time!.tick(1000);
            return Promise.reject(new Error("handshake failed"));
          },
        },
      }, { url: "https://public.example/", timeoutMs: 1000 });

      expect(expectError(output).code).toBe("timeout");
    });

    it("returns `timeout` and closes a connection that opens after the timeout", async () => {
      const late = countingConnection();
      time = new FakeTime();

      const output = await invoke({
        network: {
          ...offlineNetwork,
          resolveDns: resolvingTo([PUBLIC_ADDRESS]),
          connect: () => {
            // The timeout fires before the connection opens.
            time!.tick(1000);
            return Promise.resolve(late);
          },
        },
      }, { url: "http://public.example/", timeoutMs: 1000 });

      expect(expectError(output).code).toBe("timeout");
      expect(late.closes).toBe(1);
    });

    it("returns `timeout` and closes a TLS connection whose handshake completes after the timeout", async () => {
      const tcp = countingConnection();
      const tls = countingConnection();
      time = new FakeTime();

      const output = await invoke({
        network: {
          ...offlineNetwork,
          resolveDns: resolvingTo([PUBLIC_ADDRESS]),
          connect: () => Promise.resolve(tcp),
          startTls: () => {
            // The timeout fires before the handshake completes.
            time!.tick(1000);
            return Promise.resolve(tls);
          },
        },
      }, { url: "https://public.example/", timeoutMs: 1000 });

      expect(expectError(output).code).toBe("timeout");
      expect(tls.closes).toBe(1);
      // The TCP connection belongs to `startTls`, which `tls` closes it with.
      expect(tcp.closes).toBe(0);
    });

    it("returns `timeout` while waiting for the TLS handshake", async () => {
      // A server that reads the client hello and never answers it.
      // Deno.startTls leaves the socket open until the peer closes, so once
      // web_fetch has returned, the server closes its side and waits for the
      // client to close too.
      const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const { promise: helloRead, resolve: signalHelloRead } = Promise
        .withResolvers<void>();
      const { promise: returned, resolve: signalReturned } = Promise
        .withResolvers<void>();
      const served = (async () => {
        const conn = await listener.accept();
        try {
          await conn.read(new Uint8Array(4096));
          signalHelloRead();
          await returned;
          await conn.closeWrite();
          await readUntilClosed(conn);
        } finally {
          conn.close();
        }
      })();
      time = new FakeTime();

      try {
        const pending = invoke(
          { network: servedNetwork(listener.addr.port) },
          { url: "https://public.example/slow", timeoutMs: 1000 },
        );
        await helloRead;
        await time.tickAsync(1000);
        const output = await pending;
        signalReturned();
        await served;

        expect(expectError(output).code).toBe("timeout");
      } finally {
        listener.close();
      }
    });
  });

  describe("redirects", () => {
    /** A response head redirecting to `location` with `status`. */
    const redirectTo = (location: string, status = 302): string =>
      head([`HTTP/1.1 ${status} Redirect`, `Location: ${location}`]);

    /** The request line of each request the server received. */
    const requestLines = (): string[] =>
      server!.requests.map((request) => request.split("\r\n", 1)[0]!);

    it("follows a relative redirect and reports each hop", async () => {
      const { output } = await fetchFromServer(
        (conn, requestHead) =>
          respondWith(
            requestHead.startsWith("GET /start ")
              ? redirectTo("/moved", 301)
              : `${PLAIN_HEAD}arrived`,
          )(conn, requestHead),
        "http://public.example/start",
      );

      const success = expectSuccess(output);
      expect(requestLines()).toEqual([
        "GET /start HTTP/1.1",
        "GET /moved HTTP/1.1",
      ]);
      expect(success.text).toBe("arrived");
      expect(success.finalUrl).toBe("http://public.example/moved");
      expect(success.redirects).toEqual([{
        status: 301,
        url: "http://public.example/start",
        location: "http://public.example/moved",
      }]);
    });

    it("returns `too_many_redirects` after five redirects", async () => {
      let hop = 0;

      const { output } = await fetchFromServer(
        (conn, requestHead) => {
          hop += 1;
          return respondWith(redirectTo(`/hop-${hop}`))(conn, requestHead);
        },
        "http://public.example/start",
      );

      const error = expectError(output);
      expect(server!.requests).toHaveLength(6);
      expect(error.code).toBe("too_many_redirects");
      expect(error.message).toBe("web_fetch exceeded 5 redirects");
      expect(error.finalUrl).toBe("http://public.example/hop-5");
    });

    it("returns `blocked_url` for a redirect to a scheme other than HTTP", async () => {
      const { output } = await fetchFromServer(
        respondWith(redirectTo("file:///etc/passwd")),
        "http://public.example/start",
      );

      const error = expectError(output);
      expect(error.code).toBe("blocked_url");
      expect(error.message).toBe(
        "web_fetch redirect target denied: web_fetch protocol file: is not supported",
      );
      expect(server!.requests).toHaveLength(1);
    });

    it("returns `blocked_url` for a redirect to this machine, its network or a private address, fetching only the first URL", async () => {
      for (
        const { location, reason } of [
          {
            location: "http://127.0.0.1/admin",
            reason:
              "web_fetch host 127.0.0.1 is not on the open internet and is not allowed",
          },
          {
            location: "http://localhost/admin",
            reason: "web_fetch host localhost is local and is not allowed",
          },
          {
            location: "http://169.254.169.254/latest/meta-data/",
            reason:
              "web_fetch host 169.254.169.254 is not on the open internet and is not allowed",
          },
          {
            location: "http://internal.example/admin",
            reason:
              "web_fetch host internal.example resolved to 10.0.0.7, which is not on the open internet, and is not allowed",
          },
        ]
      ) {
        server = serveRawHttp(respondWith(redirectTo(location)));
        // Every name but internal.example is public, localhost included, so
        // only the redirect check itself can refuse these targets.
        const network = loopbackNetwork(server.port, {
          resolveDns: dnsAnswering((name) =>
            name === "internal.example" ? ["10.0.0.7"] : [PUBLIC_ADDRESS]
          ),
        });

        const output = await invoke({ network }, {
          url: "http://public.example/start",
        });
        const requests = requestLines();
        await server.close();
        server = undefined;

        expect(output).toEqual({
          type: "cf-harness.web-fetch-error",
          outputId: "run-1:web_fetch:1",
          url: "http://public.example/start",
          code: "blocked_url",
          message: `web_fetch redirect target denied: ${reason}`,
          finalUrl: "http://public.example/start",
          fetchedAt: FETCHED_AT,
        });
        expect(requests).toEqual(["GET /start HTTP/1.1"]);
        expect(network.connects).toEqual([{
          hostname: PUBLIC_ADDRESS,
          port: 80,
        }]);
      }
    });

    it("returns `fetch_failed` for a redirect location it cannot parse, closing the connection", async () => {
      const { port } = startServer(async (conn) => {
        await conn.write(
          new TextEncoder().encode(`${redirectTo("http://[bad/")}body`),
        );
        // Held open: only the client closing it ends this read.
        await conn.read(new Uint8Array(1));
      });
      const served = servedNetwork(port);
      let closes = 0;

      const output = await invoke({
        network: {
          ...offlineNetwork,
          resolveDns: served.resolveDns,
          connect: async (options: Deno.ConnectOptions) => {
            const conn = await served.connect(options);
            return {
              readable: conn.readable,
              writable: conn.writable,
              close() {
                closes += 1;
                conn.close();
              },
            };
          },
        },
      }, { url: "http://public.example/start" });

      const error = expectError(output);
      expect(error.code).toBe("fetch_failed");
      expect(error.message).toContain("Invalid URL");
      expect(server!.requests).toHaveLength(1);
      // Closed by the time web_fetch returned.
      expect(closes).toBe(1);
    });

    it("returns a redirect status without a location as the response", async () => {
      const { output } = await fetchFromServer(
        respondWith(
          head(["HTTP/1.1 304 Not Modified", "Content-Type: text/plain"]),
        ),
        "http://public.example/cached",
      );

      const success = expectSuccess(output);
      expect(success.status).toBe(304);
      expect(success.ok).toBe(false);
      expect(success.bytes).toBe(0);
      expect(success.redirects).toBeUndefined();
    });
  });

  describe("text extraction", () => {
    const fetchBody = async (
      body: string,
      contentType = "text/html",
    ): Promise<WebFetchToolSuccessOutput> => {
      const { output } = await fetchFromServer(
        respondWith(
          head(["HTTP/1.1 200 OK", `Content-Type: ${contentType}`]) + body,
        ),
        "http://public.example/dir/page",
      );
      return expectSuccess(output);
    };

    it("returns an HTML page's title, text and links, and keeps its raw content from the model", async () => {
      const html = [
        "<!doctype html>",
        "<title>Example &amp; Test</title>",
        "<style>.hidden{display:none}</style>",
        "<script>ignoreMe()</script>",
        "<h1>Hello <em>world</em></h1>",
        '<p>Read <a href="/next">next page</a>.</p>',
      ].join("");

      const output = await fetchBody(html, "text/html; charset=utf-8");

      expect(output.outputId).toBe("run-1:web_fetch:1");
      expect(output.finalUrl).toBe("http://public.example/dir/page");
      expect(output.title).toBe("Example & Test");
      expect(output.text).toBe("Example & Test Hello world\nRead next page .");
      expect(output.links).toEqual([{
        text: "next page",
        href: "http://public.example/next",
      }]);
      expect(output.rawContent).toBe(html);
      expect(output.rawContentDigest).toBe(await sha256(html));
      expect("rawContent" in toModelFacingWebFetchOutput(output)).toBe(false);
    });

    it("drops comments, scripts, styles, templates and drawings from the text", async () => {
      const output = await fetchBody(
        "<!-- note --><noscript>enable js</noscript>" +
          "<template><p>hidden</p></template><svg><text>chart</text></svg>" +
          "<div>first</div>second<br/>third",
      );

      expect(output.text).toBe("first\nsecond\nthird");
    });

    it("decodes named, decimal and hexadecimal entities, keeping ones it cannot read", async () => {
      const output = await fetchBody(
        "<p>&lt;a&gt; &quot;b&quot; &apos;c&apos; &#65;&#x42; &unknown; &#x110000; &#9999999;</p>",
      );

      expect(output.text).toBe(
        `<a> "b" 'c' AB &unknown; &#x110000; &#9999999;`,
      );
    });

    it("omits a title that holds only whitespace", async () => {
      const output = await fetchBody("<title>  </title><p>body</p>");

      expect(output.title).toBeUndefined();
      expect(output.text).toBe("body");
    });

    it("resolves quoted and unquoted links and skips ones it cannot follow", async () => {
      const output = await fetchBody(
        "<a href='one'>One</a>" +
          "<a class=x href=/two>Two &amp; more</a>" +
          '<a href="javascript:alert(1)">script</a>' +
          '<a href="http://[bad">broken</a>' +
          "<a name=anchor>no href</a>",
      );

      expect(output.links).toEqual([
        { text: "One", href: "http://public.example/dir/one" },
        { text: "Two & more", href: "http://public.example/two" },
      ]);
    });

    it("keeps at most 50 links", async () => {
      const output = await fetchBody(
        Array.from({ length: 60 }, (_, index) => `<a href="/l${index}">l</a>`)
          .join(""),
      );

      expect(output.links).toHaveLength(50);
      expect(output.links?.at(-1)?.href).toBe("http://public.example/l49");
    });

    it("returns JSON as it arrived, with no links or title", async () => {
      const body = '{"html":"<a href=\\"/x\\">x</a>"}';

      for (const contentType of ["application/json", "application/ld+json"]) {
        const output = await fetchBody(body, contentType);

        expect(output.text).toBe(body);
        expect(output.links).toBeUndefined();
        expect(output.title).toBeUndefined();
      }
    });
  });

  describe("isWebFetchToolSuccessOutput()", () => {
    it("returns `true` only for a web_fetch result", () => {
      expect(isWebFetchToolSuccessOutput({
        type: "cf-harness.web-fetch-result",
        outputId: "run-1:web_fetch:1",
      })).toBe(true);
      expect(isWebFetchToolSuccessOutput({
        type: "cf-harness.web-fetch-error",
        outputId: "run-1:web_fetch:1",
      })).toBe(false);
      expect(isWebFetchToolSuccessOutput({
        type: "cf-harness.web-fetch-result",
      })).toBe(false);
      expect(isWebFetchToolSuccessOutput("cf-harness.web-fetch-result")).toBe(
        false,
      );
    });
  });

  describe("isWebFetchToolErrorOutput()", () => {
    it("returns `true` only for a web_fetch error", () => {
      expect(isWebFetchToolErrorOutput({
        type: "cf-harness.web-fetch-error",
        outputId: "run-1:web_fetch:1",
      })).toBe(true);
      expect(isWebFetchToolErrorOutput({
        type: "cf-harness.web-fetch-result",
        outputId: "run-1:web_fetch:1",
      })).toBe(false);
      expect(isWebFetchToolErrorOutput({
        type: "cf-harness.web-fetch-error",
        outputId: 1,
      })).toBe(false);
      expect(isWebFetchToolErrorOutput(null)).toBe(false);
    });
  });

  describe("toModelFacingWebFetchOutput()", () => {
    it("returns an error output unchanged", async () => {
      const error = expectError(await invoke({}, { url: "not a url" }));

      expect(toModelFacingWebFetchOutput(error)).toBe(error);
    });
  });
});
