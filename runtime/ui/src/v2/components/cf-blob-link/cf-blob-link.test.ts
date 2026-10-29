import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import type { TemplateResult } from "lit";

import { CFBlobLink } from "./index.ts";

describe("CFBlobLink", () => {
  const SPACE = "did:key:z6Mk-cf-blob-link";

  /** A runtime whose `blobUrl()` answers with `answer`, recording each call. */
  const runtimeAnswering = (answer: Promise<string>, calls: unknown[] = []) =>
    ({
      blobUrl: (options: unknown) => {
        calls.push(options);
        return answer;
      },
    }) as unknown as RuntimeClient;

  it("is registered as `cf-blob-link`", () => {
    expect(customElements.get("cf-blob-link")).toBe(CFBlobLink);
  });

  it("renders its content without a link until the blob's URL arrives", () => {
    const element = new CFBlobLink();

    const result = element.render() as TemplateResult;

    expect(result.strings.join("")).not.toContain("<a");
  });

  it("renders a link to the blob's URL that saves under its name", async () => {
    const answer = Promise.resolve("http://host/space/blobs/abc?download");
    const calls: unknown[] = [];
    const element = new CFBlobLink();
    element.runtime = runtimeAnswering(answer, calls);
    element.blob = { space: SPACE, id: "fid1:abc" };
    element.name = "report.pdf";

    element.willUpdate(new Map([["blob", undefined]]));
    await answer;

    const result = element.render() as TemplateResult;
    expect(result.strings.join("")).toContain("<a");
    expect(result.values).toEqual([
      "http://host/space/blobs/abc?download",
      "report.pdf",
    ]);
    expect(calls).toEqual([{ space: SPACE, id: "fid1:abc", download: true }]);
  });
});
