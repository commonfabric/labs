// First, so that the document it installs is there when Lit loads.
import { mount, settle, window } from "../../test-utils/dom.ts";

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { NAME, type RuntimeClient } from "@commonfabric/runtime-client";
import {
  createMockCellHandle,
  writesSent,
} from "../../test-utils/mock-cell-handle.ts";
import type { MentionableArray } from "../../core/mentionable.ts";
import { defaultTheme } from "../theme-context.ts";
import { CFPromptInput, type PromptAttachment } from "./index.ts";

type Detail = { type: string; detail: unknown };

/** A mounted prompt input with `properties`, and every event it emits. */
async function promptInputWith(properties: Partial<CFPromptInput> = {}) {
  const element = Object.assign(new CFPromptInput(), properties);
  const events: Detail[] = [];
  for (
    const type of [
      "cf-send",
      "cf-stop",
      "cf-input",
      "cf-attachment-add",
      "cf-attachment-remove",
    ]
  ) {
    element.addEventListener(type, (event) => {
      if (event instanceof CustomEvent) {
        events.push({ type, detail: event.detail });
      }
    });
  }
  await mount(element);
  return { element, textarea: textareaOf(element), events };
}

function ofType(events: Detail[], type: string): unknown[] {
  return events.filter((event) => event.type === type).map((event) =>
    event.detail
  );
}

/** The attachments carried by the `cf-attachment-add` events in `events`. */
function added(events: Detail[]): PromptAttachment[] {
  return ofType(events, "cf-attachment-add").map((detail) =>
    (detail as { attachment: PromptAttachment }).attachment
  );
}

function shadow(element: CFPromptInput): ShadowRoot {
  return element.shadowRoot!;
}

function textareaOf(element: CFPromptInput): HTMLTextAreaElement {
  return shadow(element).querySelector("textarea")!;
}

function sendButton(element: CFPromptInput): HTMLElement | null {
  return shadow(element).querySelector("#cf-prompt-input-send-button");
}

function stopButton(element: CFPromptInput): HTMLElement | null {
  return shadow(element).querySelector("#cf-prompt-input-stop-button");
}

function pills(element: CFPromptInput): HTMLElement[] {
  return [...shadow(element).querySelectorAll<HTMLElement>("cf-chip")];
}

/**
 * Types `text` into the textarea, leaving the cursor at `cursor`, or at the end
 * of the text when not given one.
 */
async function type(
  element: CFPromptInput,
  text: string,
  cursor = text.length,
): Promise<void> {
  const textarea = textareaOf(element);
  textarea.value = text;
  textarea.setSelectionRange(cursor, cursor);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  await element.updateComplete;
}

function press(
  element: CFPromptInput,
  fields: KeyboardEventInit,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...fields,
  });
  textareaOf(element).dispatchEvent(event);
  return event;
}

/**
 * The clipboard a paste carries. happy-dom's own takes only happy-dom's
 * `File`s, which the element, checking for Deno's, would not take as files.
 */
interface PastedClipboard {
  files: File[];
  items: Array<{ kind: string; getAsFile(): File | null }>;
  getData(format: string): string;
}

function clipboard(
  { files = [], items = [], data = {} }: {
    files?: File[];
    items?: PastedClipboard["items"];
    data?: Record<string, string>;
  },
): PastedClipboard {
  return { files, items, getData: (format) => data[format] ?? "" };
}

/** Pastes `clipboardData` into the textarea, returning the paste event. */
function paste(
  element: CFPromptInput,
  clipboardData: PastedClipboard | null,
): ClipboardEvent {
  const event = new ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  textareaOf(element).dispatchEvent(event);
  return event;
}

/** The space uploads go to. */
const SPACE = "did:key:z6Mk-prompt-input";

type UploadRequest = Parameters<RuntimeClient["uploadBlob"]>[0];

/** A runtime whose blob uploads `upload` answers, recording each request. */
function uploadingRuntime(
  upload: (request: UploadRequest) => ReturnType<RuntimeClient["uploadBlob"]>,
): { runtime: RuntimeClient; requests: UploadRequest[] } {
  const requests: UploadRequest[] = [];
  const runtime = {
    uploadBlob: (request: UploadRequest) => {
      requests.push(request);
      return upload(request);
    },
  } as RuntimeClient;
  return { runtime, requests };
}

/** A prompt input that uploads what is attached to it through `runtime`. */
function uploadingWith(runtime: RuntimeClient) {
  return promptInputWith({
    uploadAttachments: true,
    runtime,
    space: SPACE,
  });
}

/**
 * The attachment of the next `cf-attachment-add` the element emits, which
 * after an attachment is added is the one its upload settling emits.
 */
function nextAttachmentAdd(element: CFPromptInput): Promise<PromptAttachment> {
  return new Promise((resolve) => {
    element.addEventListener("cf-attachment-add", (event) => {
      if (event instanceof CustomEvent) resolve(event.detail.attachment);
    }, { once: true });
  });
}

/** The detail of the next `cf-send` the element emits. */
function nextSend(element: CFPromptInput): Promise<unknown> {
  return new Promise((resolve) => {
    element.addEventListener("cf-send", (event) => {
      if (event instanceof CustomEvent) resolve(event.detail);
    }, { once: true });
  });
}

function imageFile(name = "cat.png"): File {
  return new File(["picture"], name, { type: "image/png" });
}

/** A picture attached as `cat.png`. */
function image(): PromptAttachment {
  return { id: "a1", name: "cat.png", type: "file", data: imageFile() };
}

/** A mentionable list naming `names`. */
function mentionables(names: string[]) {
  const items: MentionableArray = names.map((name) => ({ [NAME]: name }));
  return createMockCellHandle(items, {
    id: "of:mentionables",
    schema: { type: "array", items: { type: "object" } },
  });
}

/** The mentions overlay the element puts in the document's body, if any. */
function overlay(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(
    "[data-cf-prompt-input-mentions-overlay]",
  );
}

function mentionItems(): HTMLElement[] {
  return [...overlay()?.querySelectorAll<HTMLElement>(".mention-item") ?? []];
}

/** Resolves once `node` has been taken out of the document's body. */
function removal(node: Node): Promise<void> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body.contains(node)) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(document.body, { childList: true });
  });
}

describe("cf-prompt-input", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers itself as `cf-prompt-input`", () => {
    expect(customElements.get("cf-prompt-input")).toBe(CFPromptInput);
  });

  describe("render()", () => {
    it("shows the placeholder, value and rows it is given", async () => {
      const { textarea } = await promptInputWith({
        placeholder: "Ask me anything",
        value: "draft",
        rows: 3,
      });

      expect(textarea.placeholder).toBe("Ask me anything");
      expect(textarea.value).toBe("draft");
      expect(textarea.getAttribute("rows")).toBe("3");
    });

    it("labels the send button `Send` unless given other text", async () => {
      const plain = await promptInputWith();
      const custom = await promptInputWith({ buttonText: "Ask" });

      expect(sendButton(plain.element)?.textContent?.trim()).toBe("Send");
      expect(sendButton(custom.element)?.textContent?.trim()).toBe("Ask");
    });

    it("sizes its buttons small or large to match, and medium otherwise", async () => {
      const sizes: unknown[] = [];
      for (const pending of [false, true]) {
        for (const size of ["sm", "lg", "xl", ""]) {
          const { element } = await promptInputWith({ size, pending });
          const button = pending ? stopButton(element) : sendButton(element);
          sizes.push(button?.getAttribute("size"));
        }
      }

      expect(sizes).toEqual(["sm", "lg", "md", "md", "sm", "lg", "md", "md"]);
    });

    it("enables the send button only once there is text to send", async () => {
      const { element } = await promptInputWith();
      expect(sendButton(element)?.hasAttribute("disabled")).toBe(true);

      await type(element, "  ");
      expect(sendButton(element)?.hasAttribute("disabled")).toBe(true);

      await type(element, "hello");
      expect(sendButton(element)?.hasAttribute("disabled")).toBe(false);

      element.disabled = true;
      await element.updateComplete;
      expect(sendButton(element)?.hasAttribute("disabled")).toBe(true);
    });

    it("shows a stop button in place of the send button while pending", async () => {
      const { element } = await promptInputWith();
      expect(sendButton(element) !== null).toBe(true);
      expect(stopButton(element) === null).toBe(true);

      element.pending = true;
      await element.updateComplete;

      expect(stopButton(element) !== null).toBe(true);
      expect(sendButton(element) === null).toBe(true);
    });

    it("shows a model picker listing each model only when given models", async () => {
      const without = await promptInputWith();
      expect(shadow(without.element).querySelector("select") === null).toBe(
        true,
      );

      const { element } = await promptInputWith({
        modelItems: [
          { label: "Fast", value: "fast" },
          undefined,
          { label: "Careful", value: "careful" },
        ],
      });
      const options = [...shadow(element).querySelectorAll("option")];

      expect(
        options.map((option) => [option.value, option.textContent?.trim()]),
      )
        .toEqual([["fast", "Fast"], ["careful", "Careful"]]);
    });

    it("disables the model picker while pending or disabled", async () => {
      const modelItems = [{ label: "Fast", value: "fast" }];
      const picker = async (properties: Partial<CFPromptInput>) => {
        const { element } = await promptInputWith({
          modelItems,
          ...properties,
        });
        return shadow(element).querySelector("select")!.disabled;
      };

      expect(await picker({})).toBe(false);
      expect(await picker({ pending: true })).toBe(true);
      expect(await picker({ disabled: true })).toBe(true);
    });

    it("shows voice input only when `voice` is set", async () => {
      const without = await promptInputWith();
      const voiced = await promptInputWith({ voice: true });

      expect(shadow(without.element).querySelector("cf-voice-input") === null)
        .toBe(true);
      expect(shadow(voiced.element).querySelector("cf-voice-input") !== null)
        .toBe(true);
    });
  });

  describe("attachments", () => {
    it("shows a pill for each attachment, accented for clipboard content", async () => {
      const { element, events } = await promptInputWith();
      const file: PromptAttachment = {
        id: "a1",
        name: "notes.txt",
        type: "file",
        data: new File(["notes"], "notes.txt", { type: "text/plain" }),
      };
      const pasted: PromptAttachment = {
        id: "a2",
        name: "Pasted content",
        type: "clipboard",
        data: "text",
      };

      element.addAttachment(file);
      element.addAttachment(pasted);
      await element.updateComplete;

      expect(added(events)).toEqual([file, pasted]);
      expect(
        pills(element).map((pill) => [
          pill.getAttribute("variant"),
          pill.textContent?.replace(/\s+/g, " ").trim(),
        ]),
      ).toEqual([
        ["default", "notes.txt 📎"],
        ["accent", "Pasted content 📋"],
      ]);
    });

    it("shows an image's own thumbnail in its pill", async () => {
      const { element } = await promptInputWith();
      const picture = image();

      element.addAttachment(picture);
      await element.updateComplete;

      expect(picture.previewUrl).toMatch(/^blob:/);
      const thumbnail = pills(element)[0].querySelector("img");
      expect(thumbnail?.getAttribute("src")).toBe(picture.previewUrl);
      expect(thumbnail?.getAttribute("alt")).toBe("cat.png");
    });

    it("shows an uploaded image by its URL, and anything else by its icon", async () => {
      const { element } = await promptInputWith();
      element.addAttachment({
        id: "a1",
        name: "photo.png",
        type: "clipboard",
        url: "https://host/space/blobs/photo.png",
        mediaType: "image/png",
      });
      element.addAttachment({
        id: "a2",
        name: "report.pdf",
        type: "file",
        url: "https://host/space/blobs/report.pdf",
        mediaType: "application/pdf",
      });
      await element.updateComplete;

      const [photo, report] = pills(element);
      expect(photo.querySelector("img")?.getAttribute("src")).toBe(
        "https://host/space/blobs/photo.png",
      );
      expect(report.querySelector("img") === null).toBe(true);
      expect(report.querySelector('[slot="icon"]')?.textContent).toBe("📎");
    });

    it("removes an attachment whose pill is dismissed, and lets go of its thumbnail", async () => {
      const { element, events } = await promptInputWith();
      const picture = image();
      element.addAttachment(picture);
      await element.updateComplete;
      const thumbnail = picture.previewUrl!;
      await (await fetch(thumbnail)).body?.cancel();

      pills(element)[0].dispatchEvent(new CustomEvent("cf-remove"));
      await element.updateComplete;

      expect(ofType(events, "cf-attachment-remove")).toEqual([{ id: "a1" }]);
      expect(pills(element).length).toBe(0);
      await expect(fetch(thumbnail)).rejects.toThrow();
    });

    it("lets go of its thumbnails when taken out of the document", async () => {
      const { element } = await promptInputWith();
      const picture = image();
      element.addAttachment(picture);
      const thumbnail = picture.previewUrl!;

      element.remove();

      await expect(fetch(thumbnail)).rejects.toThrow();
    });

    describe("uploading", () => {
      it("uploads an attached file to the space and gives the attachment its URL", async () => {
        const { runtime, requests } = uploadingRuntime(() =>
          Promise.resolve({ id: "blob-1", url: "https://host/blobs/cat.png" })
        );
        const { element } = await uploadingWith(runtime);
        const picture = image();

        element.addAttachment(picture);
        const uploaded = nextAttachmentAdd(element);
        await element.updateComplete;
        expect(pills(element)[0].textContent).toContain("⏳");
        expect(await uploaded).toBe(picture);
        await element.updateComplete;

        expect(requests).toEqual([
          expect.objectContaining({
            space: SPACE,
            contentType: "image/png",
            name: "cat.png",
          }),
        ]);
        expect(picture).toEqual(expect.objectContaining({
          url: "https://host/blobs/cat.png",
          mediaType: "image/png",
          size: 7,
          uploading: false,
          error: undefined,
        }));
        expect(pills(element)[0].textContent).not.toContain("⏳");
      });

      it("uploads a bare blob under the attachment's name", async () => {
        const { runtime, requests } = uploadingRuntime(() =>
          Promise.resolve({ id: "blob-1", url: "https://host/blobs/shot.png" })
        );
        const { element } = await uploadingWith(runtime);

        element.addAttachment({
          id: "a1",
          name: "shot.png",
          type: "clipboard",
          data: new Blob(["picture"], { type: "image/png" }),
        });
        await nextAttachmentAdd(element);

        expect(requests).toEqual([
          expect.objectContaining({
            name: "shot.png",
            contentType: "image/png",
          }),
        ]);
      });

      it("shows the failure on the pill of an upload that fails", async () => {
        const { runtime } = uploadingRuntime(() =>
          Promise.reject(new Error("blob store unreachable"))
        );
        const { element } = await uploadingWith(runtime);
        const picture = image();

        element.addAttachment(picture);
        await nextAttachmentAdd(element);
        await element.updateComplete;

        expect(picture.url).toBeUndefined();
        const warning = pills(element)[0].querySelector("span[title]");
        expect(warning?.textContent?.trim()).toBe("⚠️");
        expect(warning?.getAttribute("title")).toContain(
          "blob store unreachable",
        );
      });

      it("uploads nothing when not asked to, without a space, or for text", async () => {
        const { runtime, requests } = uploadingRuntime(() =>
          Promise.reject(new Error("unexpected upload"))
        );
        const optedOut = await promptInputWith({ runtime, space: SPACE });
        optedOut.element.addAttachment(image());
        const spaceless = await promptInputWith({
          uploadAttachments: true,
          runtime,
        });
        spaceless.element.addAttachment(image());
        const text = await uploadingWith(runtime);
        text.element.addAttachment({
          id: "a1",
          name: "Pasted content",
          type: "clipboard",
          data: "words",
        });

        for (const { element } of [optedOut, spaceless, text]) {
          await element.updateComplete;
          expect(pills(element)[0].textContent).not.toContain("⏳");
        }
        expect(requests).toEqual([]);
      });
    });

    it("opens the file picker from the upload button", async () => {
      const { element } = await promptInputWith();
      const picker = shadow(element).querySelector('input[type="file"]')!;
      let opened = 0;
      picker.addEventListener("click", () => opened++);

      shadow(element).querySelector<HTMLElement>(".upload-button")!.click();

      expect(opened).toBe(1);
    });

    describe("picking files", () => {
      // happy-dom's file input holds no files, so each case gives it the ones
      // the user picked, and records the value the element writes back.

      function pick(element: CFPromptInput, files: File[]) {
        const picker = shadow(element).querySelector<HTMLInputElement>(
          'input[type="file"]',
        )!;
        const writes: string[] = [];
        Object.defineProperty(picker, "files", { value: files });
        Object.defineProperty(picker, "value", {
          get: () => files.at(-1)?.name ?? "",
          set: (value: string) => writes.push(value),
        });
        picker.dispatchEvent(new Event("change", { bubbles: true }));
        return writes;
      }

      it("attaches each file picked, then empties the picker", async () => {
        const { element, events } = await promptInputWith();

        const writes = pick(element, [imageFile("a.png"), imageFile("b.png")]);

        expect(added(events)).toEqual([
          expect.objectContaining({ name: "a.png", type: "file" }),
          expect.objectContaining({ name: "b.png", type: "file" }),
        ]);
        expect(writes).toEqual([""]);
      });

      it("attaches nothing when the picker closes with no file", async () => {
        const { element, events } = await promptInputWith();

        const writes = pick(element, []);

        expect(events).toEqual([]);
        expect(writes).toEqual([]);
      });
    });
  });

  describe("sending", () => {
    it("emits `cf-send` with the text and attachments when the button is clicked", async () => {
      const { element, events } = await promptInputWith();
      await type(element, "look at this");
      element.addAttachment({
        id: "a1",
        name: "Pasted content",
        type: "clipboard",
        data: "words",
      });
      const sent = nextSend(element);

      sendButton(element)!.click();
      await sent;

      expect(ofType(events, "cf-send")).toEqual([{
        text: "look at this",
        message: "look at this",
        mentions: [],
        attachments: [expect.objectContaining({ id: "a1", data: "words" })],
      }]);
    });

    it("empties the textarea and the attachments before announcing the send", async () => {
      const { element, textarea } = await promptInputWith();
      await type(element, "hello");
      element.addAttachment(image());
      let textWhenSent: string | undefined;
      element.addEventListener("cf-send", () => textWhenSent = textarea.value);
      const sent = nextSend(element);

      sendButton(element)!.click();
      await sent;
      await element.updateComplete;

      expect(textWhenSent).toBe("");
      expect(textarea.value).toBe("");
      expect(element.value).toBe("");
      expect(element.hasContent).toBe(false);
      expect(pills(element).length).toBe(0);
    });

    it("sends nothing on Enter while the textarea holds only whitespace", async () => {
      const { element, events } = await promptInputWith();
      await type(element, "   ");

      press(element, { key: "Enter" });

      expect(ofType(events, "cf-send")).toEqual([]);
    });

    it("waits for an attachment's upload, and sends its URL in place of its bytes", async () => {
      const upload = Promise.withResolvers<void>();
      const { runtime } = uploadingRuntime(async () => {
        await upload.promise;
        return { id: "blob-1", url: "https://host/blobs/cat.png" };
      });
      const { element, events } = await uploadingWith(runtime);
      await type(element, "look");
      element.addAttachment(image());
      const sent = nextSend(element);

      sendButton(element)!.click();
      await element.updateComplete;
      expect(sendButton(element)!.hasAttribute("disabled")).toBe(true);
      // Enter while the first send waits sends nothing more.
      press(element, { key: "Enter" });
      expect(ofType(events, "cf-send")).toEqual([]);

      upload.resolve();
      const { attachments } = await sent as { attachments: object[] };

      expect(attachments).toEqual([
        expect.objectContaining({ url: "https://host/blobs/cat.png" }),
      ]);
      expect("data" in attachments[0]).toBe(false);
      expect("previewUrl" in attachments[0]).toBe(false);
      expect(ofType(events, "cf-send").length).toBe(1);
    });

    it("sends nothing when the text is cleared while the send waits on an upload", async () => {
      const upload = Promise.withResolvers<void>();
      const { runtime } = uploadingRuntime(async () => {
        await upload.promise;
        return { id: "blob-1", url: "https://host/blobs/cat.png" };
      });
      const { element, textarea, events } = await uploadingWith(runtime);
      await type(element, "look");
      element.addAttachment(image());

      press(element, { key: "Enter" });
      textarea.value = "  ";
      upload.resolve();
      await settle();
      await element.updateComplete;

      expect(ofType(events, "cf-send")).toEqual([]);
      expect(sendButton(element)!.hasAttribute("disabled")).toBe(false);
    });

    it("keeps the text and attachments, sending nothing, when an upload has failed", async () => {
      const { runtime } = uploadingRuntime(() =>
        Promise.reject(new Error("blob store unreachable"))
      );
      const { element, events, textarea } = await uploadingWith(runtime);
      await type(element, "look");
      element.addAttachment(image());
      await nextAttachmentAdd(element);
      await element.updateComplete;

      sendButton(element)!.click();
      await element.updateComplete;

      expect(ofType(events, "cf-send")).toEqual([]);
      expect(textarea.value).toBe("look");
      expect(pills(element).length).toBe(1);
      expect(sendButton(element)!.hasAttribute("disabled")).toBe(false);
    });

    it("does not wait for the upload of an attachment already removed", async () => {
      const upload = Promise.withResolvers<void>();
      const { runtime } = uploadingRuntime(async () => {
        await upload.promise;
        return { id: "blob-1", url: "https://host/blobs/cat.png" };
      });
      const { element, events } = await uploadingWith(runtime);
      await type(element, "never mind the picture");
      element.addAttachment(image());
      element.removeAttachment("a1");

      sendButton(element)!.click();

      expect(ofType(events, "cf-send")).toEqual([{
        text: "never mind the picture",
        message: "never mind the picture",
        mentions: [],
        attachments: [],
      }]);
      upload.resolve();
    });

    describe("from the keyboard", () => {
      it("sends on Enter, and keeps the key from adding a line", async () => {
        const { element, events } = await promptInputWith();
        await type(element, "hello");

        const enter = press(element, { key: "Enter" });

        expect(enter.defaultPrevented).toBe(true);
        expect(ofType(events, "cf-send")).toEqual([
          expect.objectContaining({ text: "hello" }),
        ]);
      });

      it("adds a line on Shift+Enter, and sends on Shift with Ctrl or Cmd", async () => {
        const { element, events } = await promptInputWith();
        await type(element, "hello");

        const shiftEnter = press(element, { key: "Enter", shiftKey: true });
        expect(shiftEnter.defaultPrevented).toBe(false);
        expect(ofType(events, "cf-send")).toEqual([]);

        const ctrl = press(element, {
          key: "Enter",
          shiftKey: true,
          ctrlKey: true,
        });
        expect(ctrl.defaultPrevented).toBe(true);
        expect(ofType(events, "cf-send").length).toBe(1);

        await type(element, "again");
        press(element, { key: "Enter", shiftKey: true, metaKey: true });
        expect(ofType(events, "cf-send").length).toBe(2);
      });

      it("sends nothing on Enter while pending, but still adds no line", async () => {
        const { element, events } = await promptInputWith();
        await type(element, "hello");
        element.pending = true;
        await element.updateComplete;

        const enter = press(element, { key: "Enter" });
        const ctrlEnter = press(element, {
          key: "Enter",
          shiftKey: true,
          ctrlKey: true,
        });

        expect(enter.defaultPrevented).toBe(true);
        expect(ctrlEnter.defaultPrevented).toBe(true);
        expect(ofType(events, "cf-send")).toEqual([]);
      });

      it("leaves every key alone while disabled, and other keys always", async () => {
        const { element, events } = await promptInputWith();
        await type(element, "hello");

        const letter = press(element, { key: "a" });
        element.disabled = true;
        const enter = press(element, { key: "Enter" });

        expect(letter.defaultPrevented).toBe(false);
        expect(enter.defaultPrevented).toBe(false);
        expect(ofType(events, "cf-send")).toEqual([]);
      });
    });
  });

  describe("stopping", () => {
    it("emits `cf-stop` when the stop button is clicked", async () => {
      const { element, events } = await promptInputWith({ pending: true });

      stopButton(element)!.click();

      expect(ofType(events, "cf-stop")).toEqual([null]);
    });
  });

  describe("typing", () => {
    it("takes its value from the textarea and emits `cf-input`", async () => {
      const { element, events } = await promptInputWith();

      await type(element, "hel");

      expect(element.value).toBe("hel");
      expect(element.hasContent).toBe(true);
      expect(ofType(events, "cf-input")).toEqual([{ value: "hel" }]);
    });

    describe("resizing the textarea", () => {
      // happy-dom lays nothing out, so each case gives the textarea the height
      // its content would need.

      function needs(textarea: HTMLTextAreaElement, height: number): void {
        Object.defineProperty(textarea, "scrollHeight", {
          configurable: true,
          value: height,
        });
      }

      it("sets the textarea's height to what its content needs, as it grows and shrinks", async () => {
        const { element, textarea } = await promptInputWith();

        needs(textarea, 500);
        await type(element, "a great many lines");
        expect(textarea.style.height).toBe("500px");

        needs(textarea, 60);
        await type(element, "a few lines");
        expect(textarea.style.height).toBe("60px");
      });

      it("leaves the textarea's height alone when not resizing", async () => {
        const { element, textarea } = await promptInputWith({
          autoResize: false,
        });
        needs(textarea, 500);

        await type(element, "a great many lines");

        expect(textarea.style.height).toBe("");
      });
    });

    describe("voice transcription", () => {
      function transcribe(element: CFPromptInput, text: string): void {
        shadow(element).querySelector("cf-voice-input")!.dispatchEvent(
          new CustomEvent("cf-transcription-complete", {
            detail: { transcription: { text } },
          }),
        );
      }

      it("appends a transcription to the text, and emits `cf-input`", async () => {
        const { element, textarea, events } = await promptInputWith({
          voice: true,
        });
        await type(element, "Hello");

        transcribe(element, "world");

        expect(element.value).toBe("Hello world");
        expect(textarea.value).toBe("Hello world");
        expect(shadow(element).activeElement?.tagName).toBe("TEXTAREA");
        expect(ofType(events, "cf-input").at(-1)).toEqual({
          value: "Hello world",
        });
      });

      it("takes a transcription as the whole text when there is none yet", async () => {
        const { element } = await promptInputWith({ voice: true });

        transcribe(element, "world");

        expect(element.value).toBe("world");
      });

      it("ignores an empty transcription", async () => {
        const { element, events } = await promptInputWith({ voice: true });

        transcribe(element, "");

        expect(element.value).toBe("");
        expect(events).toEqual([]);
      });
    });
  });

  describe("pasting", () => {
    it("attaches each pasted file once, whether it comes as a file or an item", async () => {
      const { element, events } = await promptInputWith();
      const shot = imageFile("shot.png");
      const notes = new File(["text"], "doc.txt", { type: "text/plain" });

      const event = paste(
        element,
        clipboard({
          files: [shot],
          items: [
            { kind: "file", getAsFile: () => imageFile("shot.png") },
            { kind: "file", getAsFile: () => notes },
            { kind: "file", getAsFile: () => null },
            { kind: "string", getAsFile: () => imageFile("ignored.png") },
          ],
        }),
      );

      expect(event.defaultPrevented).toBe(true);
      expect(added(events)).toEqual([
        expect.objectContaining({
          name: "shot.png",
          type: "clipboard",
          data: shot,
        }),
        expect.objectContaining({ name: "doc.txt", data: notes }),
      ]);
    });

    it("names an unnamed pasted file by whether it is an image", async () => {
      const { element, events } = await promptInputWith();

      paste(
        element,
        clipboard({
          files: [
            new File(["picture"], "", { type: "image/png" }),
            new File(["bytes"], "", { type: "application/pdf" }),
          ],
        }),
      );

      expect(added(events).map((attachment) => attachment.name)).toEqual([
        "Pasted image",
        "Pasted file",
      ]);
    });

    it("attaches long pasted text and puts a link to it at the cursor", async () => {
      const { element, textarea, events } = await promptInputWith();
      await type(element, "see  please", 4);
      const long = "x".repeat(1001);

      const event = paste(element, clipboard({ data: { text: long } }));

      expect(event.defaultPrevented).toBe(true);
      const [attachment] = added(events);
      expect(attachment).toEqual(expect.objectContaining({
        name: "Pasted content (1001 chars)",
        type: "clipboard",
        data: long,
      }));
      const link = `[Pasted content (1001 chars)](#${attachment.id})`;
      expect(element.value).toBe(`see ${link} please`);
      expect(textarea.value).toBe(element.value);
      expect(textarea.selectionStart).toBe(4 + link.length);
    });

    it("leaves short pasted text, and a paste with no clipboard, to the textarea", async () => {
      const { element, events } = await promptInputWith();

      const short = paste(
        element,
        clipboard({ data: { text: "x".repeat(1000) } }),
      );
      const empty = paste(element, null);

      expect(short.defaultPrevented).toBe(false);
      expect(empty.defaultPrevented).toBe(false);
      expect(events).toEqual([]);
    });

    describe("a web-copied image", () => {
      // A copied web image can arrive with no bytes on the clipboard, only an
      // `<img>` in its HTML flavor, and when uploading the element fetches
      // it. Each case fetches through happy-dom, whose `settle()` waits for
      // the fetch, and answers an `http` request with `answer`.

      let restore: () => void;
      let answer: (url: string) => InstanceType<typeof window.Response>;

      beforeEach(() => {
        const original = globalThis.fetch;
        Object.defineProperty(globalThis, "fetch", {
          configurable: true,
          writable: true,
          value: window.fetch.bind(window),
        });
        window.happyDOM.settings.fetch.interceptor = {
          beforeAsyncRequest: ({ request }) =>
            Promise.resolve(
              request.url.startsWith("http") ? answer(request.url) : undefined,
            ),
        };
        restore = () => {
          globalThis.fetch = original;
          window.happyDOM.settings.fetch.interceptor = null;
        };
      });

      afterEach(() => restore());

      /** A prompt input uploading through a runtime that never answers. */
      function uploader() {
        return uploadingWith(
          uploadingRuntime(() => new Promise(() => {})).runtime,
        );
      }

      function pasteImage(element: CFPromptInput, src: string, text = "") {
        return paste(
          element,
          clipboard({
            data: { "text/html": `<p><img alt="x" src="${src}"></p>`, text },
          }),
        );
      }

      it("fetches and attaches the image the HTML names", async () => {
        const { element, events } = await uploader();
        answer = () =>
          new window.Response("picture", {
            headers: { "content-type": "image/jpeg" },
          });

        const event = pasteImage(
          element,
          " https://images.example/cats/tabby.jpg ",
        );
        expect(event.defaultPrevented).toBe(true);
        await settle();

        expect(added(events)).toEqual([
          expect.objectContaining({ name: "tabby.jpg", type: "clipboard" }),
        ]);
      });

      it("names an image after its URL, or after its type when the URL has no name", async () => {
        const { element, events } = await uploader();
        answer = () =>
          new window.Response("picture", {
            headers: { "content-type": "image/svg+xml" },
          });

        pasteImage(element, "https://images.example/cats/tabby");
        await settle();
        pasteImage(element, "https://images.example/");
        await settle();
        pasteImage(element, "data:image/gif;base64,R0lGODlh");
        await settle();

        expect(added(events).map((attachment) => attachment.name)).toEqual([
          "tabby.svg",
          "pasted-image.svg",
          "pasted-image.gif",
        ]);
      });

      it("sends a message only once the image pasted into it has arrived, and sends the image with it", async () => {
        const { runtime } = uploadingRuntime(() =>
          Promise.resolve({ id: "blob-1", url: "https://host/blobs/tabby.jpg" })
        );
        const { element } = await uploadingWith(runtime);
        // Deno's own `Response`, whose `Blob` is the one the element uploads;
        // happy-dom's fetch answers with a `Blob` of its own.
        const fetched = Promise.withResolvers<Response>();
        globalThis.fetch = () => fetched.promise;
        await type(element, "look");
        const sent = nextSend(element);

        pasteImage(element, "https://images.example/tabby.jpg");
        press(element, { key: "Enter" });
        await element.updateComplete;
        expect(sendButton(element)!.hasAttribute("disabled")).toBe(true);
        fetched.resolve(
          new Response("picture", {
            headers: { "content-type": "image/jpeg" },
          }),
        );

        expect(await sent).toEqual(expect.objectContaining({
          text: "look",
          attachments: [
            expect.objectContaining({
              name: "tabby.jpg",
              url: "https://host/blobs/tabby.jpg",
            }),
          ],
        }));
      });

      it("waits too for an image pasted while the send already waits on an upload", async () => {
        const upload = Promise.withResolvers<void>();
        let uploads = 0;
        const { runtime } = uploadingRuntime(async () => {
          const n = ++uploads;
          await upload.promise;
          return { id: `blob-${n}`, url: `https://host/blobs/${n}` };
        });
        const { element } = await uploadingWith(runtime);
        const fetched = Promise.withResolvers<Response>();
        globalThis.fetch = () => fetched.promise;
        await type(element, "look");
        element.addAttachment(image());
        const sent = nextSend(element);

        press(element, { key: "Enter" });
        pasteImage(element, "https://images.example/tabby.jpg");
        upload.resolve();
        await element.updateComplete;
        fetched.resolve(
          new Response("picture", {
            headers: { "content-type": "image/jpeg" },
          }),
        );

        const { attachments } = await sent as { attachments: object[] };
        expect(attachments).toEqual([
          expect.objectContaining({ url: "https://host/blobs/1" }),
          expect.objectContaining({
            name: "tabby.jpg",
            url: "https://host/blobs/2",
          }),
        ]);
      });

      it("sends the text a failed pasted image restores, and no attachment", async () => {
        const { element } = await uploader();
        answer = () => window.Response.error();
        await type(element, "look at ");
        const sent = nextSend(element);

        pasteImage(element, "https://images.example/tabby.jpg", "a tabby");
        press(element, { key: "Enter" });
        await settle();

        expect(await sent).toEqual(expect.objectContaining({
          text: "look at a tabby",
          attachments: [],
        }));
      });

      it("puts the pasted text at the cursor when the image cannot be fetched", async () => {
        const { element, textarea, events } = await uploader();
        await type(element, "ab", 1);
        answer = () => window.Response.error();

        pasteImage(element, "https://images.example/tabby.jpg", "a tabby");
        await settle();

        expect(element.value).toBe("aa tabbyb");
        expect(textarea.value).toBe("aa tabbyb");
        expect(textarea.selectionStart).toBe(8);
        expect(added(events)).toEqual([]);
      });

      it("puts the image's URL at the cursor when there is no text to restore", async () => {
        const { element } = await uploader();
        // A missing image's placeholder, served as an image all the same.
        answer = () =>
          new window.Response("placeholder", {
            status: 404,
            headers: { "content-type": "image/png" },
          });

        pasteImage(element, "https://images.example/tabby.jpg");
        await settle();

        expect(element.value).toBe("https://images.example/tabby.jpg");
      });

      it("puts the image's URL at the cursor when what it names is no image", async () => {
        const { element } = await uploader();
        answer = () =>
          new window.Response("<html></html>", {
            headers: { "content-type": "text/html" },
          });

        pasteImage(element, "https://images.example/tabby");
        await settle();

        expect(element.value).toBe("https://images.example/tabby");
      });

      it("restores nothing for a `data:` URL that cannot be read", async () => {
        const { element, events } = await uploader();

        pasteImage(element, "data:image/png");
        await settle();

        expect(element.value).toBe("");
        expect(added(events)).toEqual([]);
      });

      it("leaves the paste to the textarea when not uploading", async () => {
        const { element, events } = await promptInputWith();

        const event = pasteImage(
          element,
          "https://images.example/tabby.jpg",
          "a tabby",
        );

        expect(event.defaultPrevented).toBe(false);
        expect(events).toEqual([]);
      });

      it("leaves the paste to the textarea when the HTML names no usable image", async () => {
        const { element, events } = await uploader();

        const local = pasteImage(element, "file:///tmp/tabby.jpg");
        const none = paste(
          element,
          clipboard({ data: { "text/html": "<p>no picture</p>" } }),
        );

        expect(local.defaultPrevented).toBe(false);
        expect(none.defaultPrevented).toBe(false);
        expect(events).toEqual([]);
      });
    });
  });

  describe("mentions", () => {
    /** A prompt input offering `names`, with `text` typed into it. */
    async function mentioning(
      names: string[],
      text: string,
      cursor = text.length,
    ) {
      const result = await promptInputWith({
        mentionable: mentionables(names),
      });
      await type(result.element, text, cursor);
      return result;
    }

    function selected(): string | undefined {
      return overlay()?.querySelector(".mention-item.selected")?.textContent
        ?.trim();
    }

    it("lists the mentionables matching what follows an `@`", async () => {
      await mentioning(["Alice", "Bob", "Alfred"], "hi @al");

      expect(mentionItems().map((item) => item.textContent?.trim())).toEqual([
        "Alice",
        "Alfred",
      ]);
    });

    it("shows no list when no mentionable matches, or once the `@` is gone", async () => {
      const { element } = await mentioning(["Alice", "Bob"], "hi @zed");
      expect(overlay() === null).toBe(true);

      await type(element, "hi @");
      expect(overlay() !== null).toBe(true);

      await type(element, "hi");
      expect(overlay() === null).toBe(true);
    });

    it("marks the mention arrowed to, or hovered, as selected", async () => {
      const { element } = await mentioning(["Alice", "Bob", "Carol"], "@");
      expect(selected()).toBe("Alice");

      const down = press(element, { key: "ArrowDown" });
      await element.updateComplete;
      expect(down.defaultPrevented).toBe(true);
      expect(selected()).toBe("Bob");

      mentionItems()[2].dispatchEvent(new MouseEvent("mouseenter"));
      await element.updateComplete;
      expect(selected()).toBe("Carol");
    });

    it("replaces the `@` text with a link to the mention clicked", async () => {
      const { element, textarea, events } = await mentioning(
        ["Alice", "Bob"],
        "ask @b now",
        "ask @b".length,
      );
      const list = overlay()!;

      mentionItems()[0].click();
      await removal(list);

      const link = "[Bob](/of:mentionables)";
      expect(element.value).toBe(`ask ${link} now`);
      expect(textarea.value).toBe(element.value);
      expect(textarea.selectionStart).toBe(`ask ${link}`.length);
      expect(shadow(element).activeElement?.tagName).toBe("TEXTAREA");
      expect(ofType(events, "cf-send")).toEqual([]);
    });

    it("takes Enter to choose a mention rather than to send", async () => {
      const { element, events } = await mentioning(["Alice"], "@");
      const list = overlay()!;

      const enter = press(element, { key: "Enter" });
      await removal(list);

      expect(enter.defaultPrevented).toBe(true);
      expect(element.value).toBe("[Alice](/of:mentionables)");
      expect(ofType(events, "cf-send")).toEqual([]);
    });

    it("inserts nothing when the cursor has moved off the `@`", async () => {
      const { element, textarea } = await mentioning(["Alice"], "@a");
      const list = overlay()!;
      textarea.setSelectionRange(0, 0);

      mentionItems()[0].click();
      await removal(list);

      expect(element.value).toBe("@a");
    });

    it("takes the list away when the element leaves the document", async () => {
      const { element } = await mentioning(["Alice"], "@");
      expect(overlay() !== null).toBe(true);

      element.remove();

      expect(overlay() === null).toBe(true);
    });

    describe("the list's place", () => {
      // happy-dom lays nothing out, so each case gives the textarea and the
      // list the boxes a browser would, and a viewport of 1000 by 800. The
      // list goes below the textarea, then moves once the frame after shows
      // where it landed.

      const box = (left: number, top: number, width: number, height: number) =>
        DOMRect.fromRect({ x: left, y: top, width, height });

      async function placed(
        anchor: DOMRect,
        width: number,
        height: number,
      ): Promise<{ top: string; left: string }> {
        document.body.replaceChildren();
        window.happyDOM.setViewport({ width: 1000, height: 800 });
        const result = await promptInputWith({
          mentionable: mentionables(["Alice"]),
        });
        textareaOf(result.element).getBoundingClientRect = () => anchor;
        await type(result.element, "@");
        const list = overlay()!.querySelector<HTMLElement>(
          ".mentions-dropdown",
        )!;
        list.getBoundingClientRect = () =>
          box(anchor.left, anchor.bottom + 2, width, height);
        await settle();
        return { top: list.style.top, left: list.style.left };
      }

      it("starts just below the textarea, before the frame that measures it", async () => {
        document.body.replaceChildren();
        const { element, textarea } = await promptInputWith({
          mentionable: mentionables(["Alice"]),
        });
        textarea.getBoundingClientRect = () => box(100.4, 300, 400, 40);

        await type(element, "@");

        const list = overlay()!.querySelector<HTMLElement>(
          ".mentions-dropdown",
        )!;
        expect([list.style.top, list.style.left]).toEqual(["342px", "100px"]);
      });

      it("sits just below the textarea when it fits there", async () => {
        expect(await placed(box(100.4, 300, 400, 40), 200, 150)).toEqual({
          top: "342px",
          left: "100px",
        });
      });

      it("moves left to keep off the right edge, but not past the left margin", async () => {
        expect((await placed(box(900, 300, 90, 40), 200, 150)).left).toBe(
          "792px",
        );
        expect((await placed(box(100, 300, 400, 40), 1200, 150)).left).toBe(
          "8px",
        );
        expect((await placed(box(-50, 300, 400, 40), 200, 150)).left).toBe(
          "8px",
        );
      });

      it("flips above the textarea when it would run off the bottom", async () => {
        expect((await placed(box(100, 700, 400, 40), 200, 150)).top).toBe(
          "548px",
        );
      });

      it("follows the textarea when the window scrolls or resizes", async () => {
        document.body.replaceChildren();
        window.happyDOM.setViewport({ width: 1000, height: 800 });
        const { element, textarea } = await promptInputWith({
          mentionable: mentionables(["Alice"]),
        });
        textarea.getBoundingClientRect = () => box(100, 300, 400, 40);
        await type(element, "@");
        const list = overlay()!.querySelector<HTMLElement>(
          ".mentions-dropdown",
        )!;
        list.getBoundingClientRect = () => box(100, 342, 200, 150);
        await settle();
        expect(list.style.top).toBe("342px");

        textarea.getBoundingClientRect = () => box(100, 200, 400, 40);
        list.getBoundingClientRect = () => box(100, 242, 200, 150);
        window.dispatchEvent(new window.Event("scroll"));
        await settle();
        expect(list.style.top).toBe("242px");

        textarea.getBoundingClientRect = () => box(150, 250, 400, 40);
        list.getBoundingClientRect = () => box(150, 292, 200, 150);
        window.dispatchEvent(new window.Event("resize"));
        await settle();
        expect([list.style.top, list.style.left]).toEqual(["292px", "150px"]);
      });

      it("puts up no list when the window scrolls while none is showing", async () => {
        document.body.replaceChildren();
        await promptInputWith({ mentionable: mentionables(["Alice"]) });

        window.dispatchEvent(new window.Event("scroll"));
        window.dispatchEvent(new window.Event("resize"));
        await settle();

        expect(overlay() === null).toBe(true);
      });

      it("holds against the bottom when there is no room above either", async () => {
        expect((await placed(box(100, 100, 400, 640), 200, 150)).top).toBe(
          "642px",
        );
        expect((await placed(box(100, 100, 400, 40), 200, 900)).top).toBe(
          "8px",
        );
      });
    });

    describe("the list's theme", () => {
      it("carries the theme around the element", async () => {
        const { element } = await mentioning(["Alice"], "@");
        element.style.setProperty("--cf-theme-font-family", "Georgia");

        document.dispatchEvent(new Event("theme-preference-changed"));

        expect(
          overlay()!.style.getPropertyValue("--cf-theme-font-family"),
        ).toBe("Georgia");
      });

      it("carries a theme given to the element directly", async () => {
        const { element } = await mentioning(["Alice"], "@");

        element.theme = { ...defaultTheme, fontFamily: "Palatino" };
        await element.updateComplete;

        expect(element.style.getPropertyValue("--cf-theme-font-family"))
          .toBe("Palatino");
        expect(
          overlay()!.style.getPropertyValue("--cf-theme-font-family"),
        ).toBe("Palatino");
      });
    });
  });

  it("watches its own size while in the document, and stops when taken out", async () => {
    // happy-dom's `ResizeObserver` never reports, so this one records what the
    // element asks of it instead.
    const observers: Array<{ observesHost: boolean; disconnected: boolean }> =
      [];
    const original = globalThis.ResizeObserver;
    let host: Element | undefined;
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: class {
        #record = { observesHost: false, disconnected: false };
        constructor() {
          observers.push(this.#record);
        }
        observe(target: Element) {
          this.#record.observesHost = target === host;
        }
        disconnect() {
          this.#record.disconnected = true;
        }
      },
    });
    try {
      const element = new CFPromptInput();
      host = element;
      await mount(element);
      expect(observers).toEqual([{ observesHost: true, disconnected: false }]);

      element.remove();
      expect(observers).toEqual([{ observesHost: true, disconnected: true }]);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  describe("choosing a model", () => {
    const modelItems = [
      { label: "Fast", value: "fast" },
      { label: "Careful", value: "careful" },
    ];

    function pickModel(element: CFPromptInput, value: string): void {
      const select = shadow(element).querySelector("select")!;
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }

    it("selects a plain model in the picker, and takes the one picked", async () => {
      const { element } = await promptInputWith({
        modelItems,
        model: "careful",
      });
      expect(shadow(element).querySelector("select")!.value).toBe("careful");

      pickModel(element, "fast");

      expect(element.model).toBe("fast");
    });

    it("selects a bound model in the picker, and writes the one picked to it", async () => {
      const model = createMockCellHandle("careful");
      const { element } = await promptInputWith({ modelItems, model });
      expect(shadow(element).querySelector("select")!.value).toBe("careful");

      pickModel(element, "fast");

      expect(element.model).toBe(model);
      expect(writesSent(model)).toEqual([
        expect.objectContaining({ type: "cell:set", value: "fast" }),
      ]);
    });

    it("selects the model in a picker that appears after the first render", async () => {
      const { element } = await promptInputWith({ model: "careful" });

      element.modelItems = modelItems;
      await element.updateComplete;

      expect(shadow(element).querySelector("select")!.value).toBe("careful");
    });
  });

  describe("public methods", () => {
    it("focuses the textarea on `focus()`", async () => {
      const { element } = await promptInputWith();

      element.focus();

      expect(shadow(element).activeElement?.tagName).toBe("TEXTAREA");
    });

    it("empties the textarea on `clear()`", async () => {
      const { element, textarea } = await promptInputWith();
      await type(element, "hello");

      element.clear();

      expect(textarea.value).toBe("");
      expect(element.value).toBe("");
    });

    it("does nothing on `focus()` or `clear()` before it renders", () => {
      const element = new CFPromptInput();
      element.value = "kept";

      element.focus();
      element.clear();

      expect(element.value).toBe("kept");
    });
  });
});
