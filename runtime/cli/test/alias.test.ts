import { expect } from "@std/expect";
import { argv, cf, checkStderr, stripAnsi } from "./utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("CLI naming", () => {
  it("shows cf in top-level help", async () => {
    const { code, stdout, stderr } = await cf(argv`--help`);
    const help = stripAnsi(stdout.join("\n"));

    expect(code).toBe(0);
    checkStderr(stderr);
    expect(help).toContain("cf check ./pattern.tsx");
    expect(help).toContain(
      "Run 'cf <command> --help' for command-specific help.",
    );
  });

  it("shows cf in exec help examples", async () => {
    const { code, stdout, stderr } = await cf(argv`help exec`);
    const help = stripAnsi(stdout.join("\n"));

    expect(code).toBe(0);
    checkStderr(stderr);
    expect(help).toContain(
      "cf exec /tmp/cf/home/pieces/notes/result/add.handler invoke --query milk",
    );
    expect(help).toContain(
      "cf exec /tmp/cf/home/pieces/notes/result/search.tool --query milk",
    );
  });
});
