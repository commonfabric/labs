import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PromptAttachment } from "./cf-prompt-input.ts";
import {
  hasIncompleteUpload,
  isUploadIncomplete,
  toSendAttachment,
} from "./send-attachments.ts";

const att = (over: Partial<PromptAttachment>): PromptAttachment => ({
  id: "a1",
  name: "x",
  type: "clipboard",
  ...over,
});

const ON = { uploadAttachments: true, hasContext: true };

describe("toSendAttachment", () => {
  it("drops raw data for a successfully-uploaded blob (consumer uses url)", () => {
    const blob = new Blob(["bytes"], { type: "image/png" });
    const view = toSendAttachment(
      att({
        data: blob,
        url: "https://host/space/blobs/abc.png",
        mediaType: "image/png",
        size: 5,
      }),
    );
    expect(view.url).toBe("https://host/space/blobs/abc.png");
    expect(view.mediaType).toBe("image/png");
    expect(view.size).toBe(5);
    // The non-cloneable File/Blob must not ride along — it would be dropped by
    // structured-clone into a sandboxed handler, silently losing the whole
    // attachment (and its url).
    expect("data" in view).toBe(false);
  });

  it("preserves raw File data when there is no url (upload off / no context)", () => {
    const file = new File(["bytes"], "x.png", { type: "image/png" });
    const view = toSendAttachment(att({ data: file }));
    // Backward compatible: default-off consumers still receive the bytes.
    expect(view.data).toBe(file);
    expect(view.url).toBeUndefined();
  });

  it("preserves string clipboard content (large pasted text)", () => {
    const view = toSendAttachment(att({ data: "a".repeat(2000) }));
    expect(view.data).toBe("a".repeat(2000));
  });

  it("never emits the local previewUrl", () => {
    const view = toSendAttachment(
      att({ data: new Blob(["b"]), previewUrl: "blob:local" }),
    );
    expect("previewUrl" in view).toBe(false);
  });
});

describe("isUploadIncomplete", () => {
  it("is false when upload is opted out, even with binary data and no url", () => {
    const a = att({ data: new Blob(["b"], { type: "image/png" }) });
    expect(
      isUploadIncomplete(a, { uploadAttachments: false, hasContext: true }),
    )
      .toBe(false);
  });

  it("is false without a runtime/space context (raw data is passed through)", () => {
    const a = att({ data: new Blob(["b"], { type: "image/png" }) });
    expect(
      isUploadIncomplete(a, { uploadAttachments: true, hasContext: false }),
    ).toBe(false);
  });

  it("is true for an opted-in binary attachment that never got a url (failed)", () => {
    const a = att({
      data: new File(["b"], "x.png", { type: "image/png" }),
      error: "network error",
    });
    expect(isUploadIncomplete(a, ON)).toBe(true);
  });

  it("is false once the upload produced a url", () => {
    const a = att({
      data: new File(["b"], "x.png", { type: "image/png" }),
      url: "https://host/space/blobs/abc.png",
    });
    expect(isUploadIncomplete(a, ON)).toBe(false);
  });

  it("is false for non-binary (string) data — it is passed through, not uploaded", () => {
    expect(isUploadIncomplete(att({ data: "hello" }), ON)).toBe(false);
  });
});

describe("hasIncompleteUpload", () => {
  it("is true if any attachment is a failed/incomplete upload", () => {
    const ok = att({ data: new Blob(["b"]), url: "https://h/s/blobs/a.png" });
    const bad = att({
      id: "a2",
      data: new File(["b"], "y.png"),
      error: "boom",
    });
    expect(hasIncompleteUpload([ok, bad], ON)).toBe(true);
  });

  it("is false when every upload completed (or needs no upload)", () => {
    const uploaded = att({
      data: new Blob(["b"]),
      url: "https://h/s/blobs/a.png",
    });
    const text = att({ id: "a2", data: "note" });
    expect(hasIncompleteUpload([uploaded, text], ON)).toBe(false);
  });

  it("is false for an empty attachment set", () => {
    expect(hasIncompleteUpload([], ON)).toBe(false);
  });
});
