import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { validateBashCurlCommand } from "../src/tools/bash-curl-policy.ts";

const expectAllowed = (command: string) =>
  expect(validateBashCurlCommand(command)).toEqual({ allowed: true });

const expectDenied = (command: string) =>
  expect(validateBashCurlCommand(command).allowed).toBe(false);

const reasonFor = (command: string) => validateBashCurlCommand(command).reason;

describe("validateBashCurlCommand()", () => {
  it("allows loopback curl targets", () => {
    expectAllowed("curl http://localhost:8000/projects");
    expectAllowed("curl -fsS http://127.0.0.1:8000/context");
    expectAllowed("curl --url=http://localhost:8000/capture-progress");
    expectAllowed("curl --url http://127.0.0.1:8000/projects");
    expectAllowed("curl localhost:8000/projects");
    expectAllowed("curl http://host.docker.internal:8000/projects");
    expectAllowed("curl --version");
  });

  it("allows non-curl bash commands", () => {
    expectAllowed("find . -maxdepth 2 -type f");
    expectAllowed("grep -R capture .");
    expectAllowed("grep curl README.md");
  });

  it("denies external curl targets", () => {
    expectDenied("curl https://example.com");
    expectDenied("curl example.com");
    expectDenied("curl --url=https://example.com");
    expectDenied("curl -fsS https://commontools.org | head");
    expectDenied("curl -fsS");
    expectDenied("curl --request GET");
  });

  it("denies curl routing overrides", () => {
    expectDenied("curl --proxy http://localhost:8888 http://localhost:8000");
    expectDenied(
      "curl --resolve example.com:443:127.0.0.1 https://example.com",
    );
    expectDenied(
      "curl --connect-to example.com:443:localhost:8443 https://example.com",
    );
    expect(reasonFor("curl -x http://localhost:8888 http://localhost:8000"))
      .toBe("curl flag -x is not allowed from cf-harness bash");
  });

  it("denies dynamic curl targets", () => {
    expectDenied('curl "$URL"');
    expectDenied("curl http://localhost:8000/items[1-3]");
    expectDenied("command curl https://example.com");
    expectDenied("env curl https://example.com");
    expectDenied("bash -lc 'curl https://example.com'");
  });

  it("returns a reason for a remote host that states the loopback rule and names no host to try instead", () => {
    expect(reasonFor("curl -fsS https://example.com/status")).toBe(
      "curl host example.com is not allowed from cf-harness bash: curl may name only localhost, a 127.x or ::1 address, or host.docker.internal, and a service that does not answer at one of those is out of this sandbox's reach",
    );
  });

  it("allows the IPv6 loopback address, in any of its spellings", () => {
    expectAllowed("curl http://[::1]:8000/projects");
    expectAllowed("curl -fsS [::1]:8000/context");
    expectAllowed("curl --url=http://[0:0:0:0:0:0:0:1]/projects");
  });

  it("denies a bracketed IPv6 host other than the loopback address", () => {
    // An IPv4 address written as IPv6 is not the `::1` the rule names; the
    // model can name 127.0.0.1 itself.
    for (const host of ["[::2]", "[::ffff:7f00:1]"]) {
      expect(
        reasonFor(`curl http://${host}:8000/`)?.startsWith(
          `curl host ${host} is not allowed`,
        ),
      ).toBe(true);
    }
    expectDenied("curl http://[::ffff:127.0.0.1]:8000/");
    expectDenied("curl http://[::1]:8000/items[1-3]");
    expectDenied("curl http://localhost:8000/items[12]");
    expectDenied("curl http://[fe80::1%25en0]:8000/");
  });

  it("returns an unterminated-quote reason for a curl command with an open quote", () => {
    expect(reasonFor("curl 'http://localhost:8000")).toBe(
      "unterminated quote in curl command",
    );
    expectAllowed("curl 'http://localhost:8000'");
  });

  it("checks every command in a sequence, pipeline, or conditional chain", () => {
    // Each operator starts a new command, so the curl after it is judged as a
    // command of its own rather than as an argument.
    expectAllowed("cd /tmp; curl http://localhost:8000/");
    expectAllowed("true && curl http://localhost:8000/ || echo failed");
    expectAllowed("curl http://localhost:8000/ >> log.txt");
    expect(reasonFor("cd /tmp; curl https://example.com/")).toMatch(
      /^curl host example\.com is not allowed/,
    );
    expect(reasonFor("false || curl https://example.com/")).toMatch(
      /^curl host example\.com is not allowed/,
    );
  });

  it("judges a curl command that follows environment assignments", () => {
    expectAllowed("NO_PROXY=* curl http://localhost:8000/");
    expect(reasonFor("NO_PROXY=* curl https://example.com/")).toMatch(
      /^curl host example\.com is not allowed/,
    );
  });

  it("treats every argument after `--` as a target, even one that starts with a dash", () => {
    expectAllowed("curl -fsS -- http://localhost:8000/");
    expect(reasonFor("curl -- -x")).toMatch(/^curl host -x is not allowed/);
  });

  it("returns a reason naming the flag when --url has no value", () => {
    expect(reasonFor("curl --url")).toBe(
      "curl flag --url requires a localhost URL",
    );
  });

  it("skips the value of a flag that takes one rather than reading it as a target", () => {
    expectAllowed("curl -H example.com http://localhost:8000/");
    expectAllowed("curl --header=example.com http://localhost:8000/");
    expectDenied("curl -fsS example.com http://localhost:8000/");
  });

  it("returns a reason naming the protocol for a non-http URL", () => {
    expect(reasonFor("curl ftp://localhost/file")).toBe(
      "curl protocol ftp: is not allowed from cf-harness bash",
    );
    expect(reasonFor("curl file://localhost/etc/passwd")).toBe(
      "curl protocol file: is not allowed from cf-harness bash",
    );
  });

  it("returns a reason naming a target that does not parse as a URL", () => {
    expect(reasonFor("curl http://")).toBe(
      "curl target http:// must be an http(s) localhost URL",
    );
  });
});
