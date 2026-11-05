import { assertEquals } from "@std/assert";
import { validateBashCurlCommand } from "../src/tools/bash-curl-policy.ts";

const assertAllowed = (command: string) =>
  assertEquals(validateBashCurlCommand(command), { allowed: true });

const assertDenied = (command: string) =>
  assertEquals(validateBashCurlCommand(command).allowed, false);

Deno.test("validateBashCurlCommand allows loopback curl targets", () => {
  assertAllowed("curl http://localhost:8000/projects");
  assertAllowed("curl -fsS http://127.0.0.1:8000/context");
  assertAllowed("curl --url=http://localhost:8000/capture-progress");
  assertAllowed("curl --url http://127.0.0.1:8000/projects");
  assertAllowed("curl localhost:8000/projects");
  assertAllowed("curl http://host.docker.internal:8000/projects");
  assertAllowed("curl --version");
});

Deno.test("validateBashCurlCommand allows non-curl bash commands", () => {
  assertAllowed("find . -maxdepth 2 -type f");
  assertAllowed("grep -R capture .");
  assertAllowed("grep curl README.md");
});

Deno.test("validateBashCurlCommand denies external curl targets", () => {
  assertDenied("curl https://example.com");
  assertDenied("curl example.com");
  assertDenied("curl --url=https://example.com");
  assertDenied("curl -fsS https://commontools.org | head");
  assertDenied("curl -fsS");
  assertDenied("curl --request GET");
});

Deno.test("validateBashCurlCommand denies curl routing overrides", () => {
  assertDenied("curl --proxy http://localhost:8888 http://localhost:8000");
  assertDenied("curl --resolve example.com:443:127.0.0.1 https://example.com");
  assertDenied(
    "curl --connect-to example.com:443:localhost:8443 https://example.com",
  );
});

Deno.test("validateBashCurlCommand denies dynamic curl targets", () => {
  assertDenied('curl "$URL"');
  assertDenied("curl http://localhost:8000/items[1-3]");
  assertDenied("command curl https://example.com");
  assertDenied("env curl https://example.com");
  assertDenied("bash -lc 'curl https://example.com'");
});

Deno.test("validateBashCurlCommand returns a reason for a remote host that states the loopback rule and names no host to try instead", () => {
  assertEquals(
    validateBashCurlCommand("curl -fsS https://example.com/status").reason,
    "curl host example.com is not allowed from cf-harness bash: curl may name only localhost, a 127.x or ::1 address, or host.docker.internal, and a service that does not answer at one of those is out of this sandbox's reach",
  );
});

Deno.test("validateBashCurlCommand allows the IPv6 loopback address, in any of its spellings", () => {
  assertAllowed("curl http://[::1]:8000/projects");
  assertAllowed("curl -fsS [::1]:8000/context");
  assertAllowed("curl --url=http://[0:0:0:0:0:0:0:1]/projects");
});

Deno.test("validateBashCurlCommand denies a bracketed IPv6 host other than the loopback address", () => {
  // An IPv4 address written as IPv6 is not the `::1` the rule names; the
  // model can name 127.0.0.1 itself.
  for (const host of ["[::2]", "[::ffff:7f00:1]"]) {
    assertEquals(
      validateBashCurlCommand(`curl http://${host}:8000/`).reason?.startsWith(
        `curl host ${host} is not allowed`,
      ),
      true,
    );
  }
  assertDenied("curl http://[::ffff:127.0.0.1]:8000/");
  assertDenied("curl http://[::1]:8000/items[1-3]");
  assertDenied("curl http://localhost:8000/items[12]");
  assertDenied("curl http://[fe80::1%25en0]:8000/");
});
