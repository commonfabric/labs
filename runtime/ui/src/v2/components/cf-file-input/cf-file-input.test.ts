// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { RuntimeClient } from "@commonfabric/runtime-client";
import { defaultTheme } from "../theme-context.ts";
import type { StoredFile } from "../../utils/file-cell-storage.ts";
import { CFFileInput } from "./index.ts";

/** One upload the stand-in runtime received. */
interface Upload {
  space: string;
  name?: string;
  contentType: string;
  body: Uint8Array;
}

/**
 * A runtime that stores each uploaded blob under a numbered id, recording the
 * upload. An upload waits for `hold` when one is set.
 */
function fakeRuntime() {
  const uploads: Upload[] = [];
  const fake = {
    uploads,
    hold: undefined as Promise<void> | undefined,
    runtime: {
      uploadBlob: async (options) => {
        await fake.hold;
        uploads.push({
          space: options.space,
          name: options.name,
          contentType: options.contentType,
          body: options.body instanceof Uint8Array
            ? options.body.slice()
            : new Uint8Array(options.body),
        });
        return {
          id: `blob-${uploads.length}`,
          url: `blobs/${options.name}`,
        };
      },
    } as Pick<RuntimeClient, "uploadBlob"> as RuntimeClient,
  };
  return fake;
}

/**
 * A `CFFileInput` that keeps the work each change of its file input starts,
 * so that a test can wait for it to finish.
 */
class WatchedFileInput extends CFFileInput {
  readonly changes: Promise<void>[] = [];

  protected override _handleFileChange(event: Event): Promise<void> {
    const change = super._handleFileChange(event);
    this.changes.push(change);
    return change;
  }
}
customElements.define("watched-file-input", WatchedFileInput);

describe("CFFileInput", () => {
  afterEach(() => document.body.replaceChildren());

  function mountInput(
    properties: Partial<
      Pick<
        CFFileInput,
        | "runtime"
        | "space"
        | "multiple"
        | "maxFiles"
        | "includeData"
        | "maxSizeBytes"
        | "showPreview"
        | "removable"
        | "previewSize"
        | "disabled"
        | "theme"
      >
    > = {},
  ): Promise<WatchedFileInput> {
    return mount(
      Object.assign(new WatchedFileInput(), {
        space: "did:key:z6Mk-file-input-test",
        ...properties,
      }),
    );
  }

  function fileInput(element: CFFileInput): HTMLInputElement {
    return element.shadowRoot!.querySelector('input[type="file"]')!;
  }

  /**
   * Picks `files` in the element's file input, as the file picker does, and
   * resolves once the element has handled them. The files are Deno's, which
   * the component's own `File` is, so the list is filled by index rather than
   * through happy-dom's `DataTransfer`.
   */
  function pick(element: WatchedFileInput, files: File[]): Promise<void> {
    const input = fileInput(element);
    const before = element.changes.length;
    input.files = Object.assign(new FileList(), files);
    input.dispatchEvent(new Event("change"));
    expect(element.changes).toHaveLength(before + 1);
    return element.changes[before];
  }

  /** The details of every `type` event the element dispatches from now on. */
  function record<T>(element: CFFileInput, type: string): T[] {
    const details: T[] = [];
    element.addEventListener(
      type,
      (event) => details.push((event as CustomEvent<T>).detail),
    );
    return details;
  }

  type Change = { files: StoredFile[]; allFiles: StoredFile[] };
  type Failure = { error: Error; message: string };

  /** The name and size each rendered preview shows. */
  function previews(element: CFFileInput): string[] {
    return [...element.shadowRoot!.querySelectorAll(".file-info")].map((
      info,
    ) => info.textContent!.trim().replace(/\s+/g, " "));
  }

  describe("picking files", () => {
    it("uploads the picked file and dispatches `cf-change` with its descriptor", async () => {
      const fake = fakeRuntime();
      const element = await mountInput({ runtime: fake.runtime });
      const changes = record<Change>(element, "cf-change");

      await pick(element, [
        new File(["hello"], "a.txt", { type: "text/plain" }),
      ]);

      expect(fake.uploads).toEqual([{
        space: "did:key:z6Mk-file-input-test",
        name: "a.txt",
        contentType: "text/plain",
        body: new TextEncoder().encode("hello"),
      }]);
      expect(changes).toHaveLength(1);
      const { files, allFiles } = changes[0];
      expect(files).toMatchObject([{
        id: "blob-1",
        name: "a.txt",
        type: "text/plain",
        size: 5,
        url: "blobs/a.txt",
      }]);
      expect(files[0].data).toBeUndefined();
      expect(allFiles).toEqual(files);
      // Cleared, so that picking the same file again is a change.
      expect(fileInput(element).files).toHaveLength(0);
    });

    it("includes a data URL in the descriptor when `includeData` is set", async () => {
      const element = await mountInput({
        runtime: fakeRuntime().runtime,
        includeData: true,
      });
      const changes = record<Change>(element, "cf-change");

      await pick(element, [new File(["hi"], "a.txt", { type: "text/plain" })]);

      expect(changes[0].files[0].data).toBe("data:text/plain;base64,aGk=");
    });

    it("does nothing when the pick is empty", async () => {
      const fake = fakeRuntime();
      const element = await mountInput({ runtime: fake.runtime });
      const changes = record(element, "cf-change");
      const failures = record(element, "cf-error");

      await pick(element, []);
      await element.updateComplete;

      expect(fake.uploads).toEqual([]);
      expect(changes).toEqual([]);
      expect(failures).toEqual([]);
      expect(element.shadowRoot!.querySelector(".loading")).toBeNull();
    });

    it("replaces the earlier file when `multiple` is not set", async () => {
      const element = await mountInput({ runtime: fakeRuntime().runtime });
      const changes = record<Change>(element, "cf-change");

      await pick(element, [new File(["1"], "one.txt")]);
      await pick(element, [new File(["22"], "two.txt")]);

      expect(changes[1].allFiles.map((file) => file.name)).toEqual([
        "two.txt",
      ]);
      await element.updateComplete;
      expect(previews(element)).toEqual(["two.txt (2 B)"]);
    });

    it("appends to the earlier files when `multiple` is set", async () => {
      const element = await mountInput({
        runtime: fakeRuntime().runtime,
        multiple: true,
      });
      const changes = record<Change>(element, "cf-change");

      await pick(element, [new File(["1"], "one.txt")]);
      await pick(element, [new File(["22"], "two.txt")]);

      const { files, allFiles } = changes[1];
      expect(files.map((file) => file.name)).toEqual(["two.txt"]);
      expect(allFiles.map((file) => file.name)).toEqual([
        "one.txt",
        "two.txt",
      ]);
    });

    it("dispatches `cf-error` and uploads nothing when a pick would pass `maxFiles`", async () => {
      const fake = fakeRuntime();
      const element = await mountInput({
        runtime: fake.runtime,
        multiple: true,
        maxFiles: 1,
      });
      const failures = record<Failure>(element, "cf-error");

      await pick(element, [
        new File(["1"], "one.txt"),
        new File(["2"], "two.txt"),
      ]);

      expect(failures.map(({ error, message }) => [error.message, message]))
        .toEqual([["Max files exceeded", "Maximum 1 files allowed"]]);
      expect(fake.uploads).toEqual([]);
    });

    it("uploads a pick within `maxFiles`", async () => {
      const element = await mountInput({
        runtime: fakeRuntime().runtime,
        multiple: true,
        maxFiles: 2,
      });
      const changes = record<Change>(element, "cf-change");
      const failures = record(element, "cf-error");

      await pick(element, [
        new File(["1"], "one.txt"),
        new File(["2"], "two.txt"),
      ]);

      expect(failures).toEqual([]);
      expect(changes[0].files).toHaveLength(2);
    });

    it("warns, and uploads anyway, when a file is over `maxSizeBytes`", async () => {
      using warn = stub(console, "warn");
      const fake = fakeRuntime();
      const element = await mountInput({
        runtime: fake.runtime,
        multiple: true,
        maxSizeBytes: 4,
      });

      await pick(element, [
        new File(["1234"], "fits.txt"),
        new File(["12345"], "big.txt"),
      ]);

      expect(fake.uploads.map((upload) => upload.name)).toEqual([
        "fits.txt",
        "big.txt",
      ]);
      expect(warn.calls.map((call) => call.args[0])).toEqual([
        "File big.txt (5 B) exceeds maxSizeBytes (4 B) even after compression",
      ]);
    });

    it("dispatches `cf-error` for each file when there is no runtime", async () => {
      const element = await mountInput();
      const changes = record(element, "cf-change");
      const failures = record<Failure>(element, "cf-error");

      await pick(element, [new File(["1"], "one.txt")]);

      expect(failures.map(({ error, message }) => [error.message, message]))
        .toEqual([[
          "Runtime is not available for file storage",
          "Failed to process one.txt",
        ]]);
      expect(changes).toEqual([]);
      await element.updateComplete;
      expect(element.shadowRoot!.querySelector(".loading")).toBeNull();
      expect(fileInput(element).files).toHaveLength(0);
    });

    it("dispatches `cf-error` when there is no space", async () => {
      const element = await mountInput({
        runtime: fakeRuntime().runtime,
        space: undefined,
      });
      const failures = record<Failure>(element, "cf-error");

      await pick(element, [new File(["1"], "one.txt")]);

      expect(failures.map(({ error }) => error.message)).toEqual([
        "Space is not available for file storage",
      ]);
    });

    it("keeps the files that upload when another fails", async () => {
      const fake = fakeRuntime();
      const element = await mountInput({
        runtime: fake.runtime,
        multiple: true,
      });
      const upload = fake.runtime.uploadBlob;
      fake.runtime.uploadBlob = (options) =>
        options.name === "bad.txt"
          ? Promise.reject(new Error("offline"))
          : upload(options);
      const changes = record<Change>(element, "cf-change");
      const failures = record<Failure>(element, "cf-error");

      await pick(element, [
        new File(["1"], "bad.txt"),
        new File(["2"], "good.txt"),
      ]);

      expect(failures.map(({ message }) => message)).toEqual([
        "Failed to process bad.txt",
      ]);
      expect(changes[0].files.map((file) => file.name)).toEqual([
        "good.txt",
      ]);
    });

    it("renders the loading state while files upload", async () => {
      const fake = fakeRuntime();
      const element = await mountInput({ runtime: fake.runtime });
      const upload = Promise.withResolvers<void>();
      fake.hold = upload.promise;

      const picked = pick(element, [new File(["1"], "one.txt")]);
      await element.updateComplete;

      const button = element.shadowRoot!.querySelector("cf-button")!;
      expect(element.shadowRoot!.querySelector(".loading")!.textContent)
        .toBe("Processing files...");
      expect(button.textContent!.trim()).toBe("Loading...");
      expect(button.hasAttribute("disabled")).toBe(true);

      upload.resolve();
      await picked;
      await element.updateComplete;
      expect(element.shadowRoot!.querySelector(".loading")).toBeNull();
      expect(button.textContent!.trim()).toBe("📎 Add File");
      expect(button.hasAttribute("disabled")).toBe(false);
    });
  });

  describe("previews", () => {
    async function mountWith(
      files: File[],
      properties: Parameters<typeof mountInput>[0] = {},
    ): Promise<WatchedFileInput> {
      const element = await mountInput({
        runtime: fakeRuntime().runtime,
        multiple: true,
        ...properties,
      });
      await pick(element, files);
      await element.updateComplete;
      return element;
    }

    it("renders each file's name and size", async () => {
      const element = await mountWith([
        new File(["x".repeat(2048)], "two-k.txt"),
        new File(["x"], "one.txt"),
      ]);

      expect(previews(element)).toEqual([
        "two-k.txt (2.0 KB)",
        "one.txt (1 B)",
      ]);
    });

    it("renders an image as an `<img>` of its URL", async () => {
      const element = await mountWith([
        new File(["x"], "cat.png", { type: "image/png" }),
      ]);

      const img = element.shadowRoot!.querySelector(".preview-item img")!;
      expect(img.getAttribute("src")).toBe("blobs/cat.png");
      expect(img.getAttribute("alt")).toBe("cat.png");
      expect(element.shadowRoot!.querySelector(".file-icon")).toBeNull();
    });

    it("renders an icon chosen by the file's type for anything else", async () => {
      const types = {
        "application/pdf": "📄",
        "video/mp4": "🎬",
        "audio/mpeg": "🎵",
        "text/csv": "📝",
        "application/msword": "📝",
        "application/vnd.ms-excel": "📊",
        "application/vnd.ms-powerpoint": "📽️",
        "application/zip": "📎",
      };
      const element = await mountWith(
        Object.keys(types).map((type) => new File(["x"], type, { type })),
      );

      const shown = Object.fromEntries(
        [...element.shadowRoot!.querySelectorAll(".file-preview")].map((
          preview,
        ) => [
          preview.querySelector(".file-name")!.textContent,
          preview.querySelector(".file-icon")!.textContent,
        ]),
      );
      expect(shown).toEqual(types);
    });

    it("renders the preview size as a class", async () => {
      const element = await mountWith([new File(["x"], "a.txt")], {
        previewSize: "lg",
      });

      expect(
        element.shadowRoot!.querySelector(".preview-item")!.classList
          .contains("size-lg"),
      ).toBe(true);
    });

    it("renders no previews when `showPreview` is not set", async () => {
      const element = await mountWith([new File(["x"], "a.txt")], {
        showPreview: false,
      });

      expect(element.shadowRoot!.querySelector(".previews")).toBeNull();
    });

    it("renders no remove buttons when `removable` is not set", async () => {
      const element = await mountWith([new File(["x"], "a.txt")], {
        removable: false,
      });

      expect(previews(element)).toEqual(["a.txt (1 B)"]);
      expect(element.shadowRoot!.querySelector(".remove-button")).toBeNull();
    });

    it("removes a file when its remove button is clicked", async () => {
      const element = await mountWith([
        new File(["1"], "one.txt"),
        new File(["2"], "two.txt"),
      ]);
      const removals = record<
        { id: string; files: StoredFile[]; allFiles: StoredFile[] }
      >(element, "cf-remove");
      const changes = record<Change>(element, "cf-change");

      element.shadowRoot!.querySelector<HTMLElement>(".remove-button")!
        .click();

      expect(removals).toHaveLength(1);
      expect(removals[0].id).toBe("blob-1");
      expect(removals[0].files.map((file) => file.name)).toEqual(["two.txt"]);
      expect(changes.map((change) => change.allFiles)).toEqual([
        removals[0].files,
      ]);
      await element.updateComplete;
      expect(previews(element)).toEqual(["two.txt (1 B)"]);
    });
  });

  describe("the button", () => {
    it("dispatches `cf-click` and opens the file input's picker", async () => {
      const element = await mountInput();
      let picked = 0;
      fileInput(element).addEventListener("click", () => picked++);
      const clicks = record(element, "cf-click");

      element.shadowRoot!.querySelector<HTMLElement>("cf-button")!.click();

      expect(clicks).toHaveLength(1);
      expect(picked).toBe(1);
    });

    it("renders the input's `accept`, `multiple` and `disabled` from the element", async () => {
      const element = await mountInput({ multiple: true, disabled: true });
      element.accept = ".pdf";
      await element.updateComplete;

      const input = fileInput(element);
      expect(input.getAttribute("accept")).toBe(".pdf");
      expect(input.multiple).toBe(true);
      expect(input.disabled).toBe(true);
      expect(
        element.shadowRoot!.querySelector("cf-button")!.hasAttribute(
          "disabled",
        ),
      ).toBe(true);
    });
  });

  describe("theme", () => {
    it("writes a theme given to it onto its own style", async () => {
      const element = await mountInput();
      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "",
      );

      element.theme = { ...defaultTheme, fontFamily: "Donut Sans" };
      await element.updateComplete;

      expect(element.style.getPropertyValue("--cf-theme-font-family")).toBe(
        "Donut Sans",
      );
    });
  });
});
