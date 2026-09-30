import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  createTestSpace,
  env,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";

const { FRONTEND_URL } = env;

describe("shell blob upload", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("uploads an image and displays it through an absolute blobs URL", async () => {
    const identity = await Identity.generate({ implementation: "noble" });
    const spaceDid = await createTestSpace(identity);
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceDid },
      identity,
    });
    await waitForCondition(shell.page(), () =>
      Boolean(
        (globalThis as unknown as {
          commonfabric?: { rt?: unknown };
        }).commonfabric?.rt,
      ));
    await waitForCondition(shell.page(), () => {
      const rootView = document.querySelector("x-root-view");
      const appView = rootView?.shadowRoot?.querySelector("x-app-view") as
        | { _spaceRootPattern?: { value?: unknown } }
        | null;
      return Boolean(appView?._spaceRootPattern?.value);
    });

    const result = await shell.page().evaluate(async () => {
      const g = globalThis as unknown as {
        commonfabric?: {
          rt?: {
            uploadBlob(options: {
              space: string;
              contentType: string;
              body: Uint8Array;
              suffix?: string;
            }): Promise<{ id: string; url: string }>;
          };
        };
      };
      const rt = g.commonfabric?.rt;
      if (!rt) {
        throw new Error("Runtime client was not exposed");
      }
      // Blob authorization is deferred, but direct writes under ACL
      // enforcement still need an existing space. The space was created
      // before the page opened it, and its root has loaded.
      const space = (document.querySelector("x-root-view") as
        | { space?: string }
        | null)?.space;
      if (!space) throw new Error("The shell opened no space");

      const upload = await rt.uploadBlob({
        space,
        contentType: "image/gif",
        suffix: "gif",
        body: new Uint8Array([
          0x47,
          0x49,
          0x46,
          0x38,
          0x39,
          0x61,
          0x01,
          0x00,
          0x01,
          0x00,
          0x80,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0xff,
          0xff,
          0xff,
          0x2c,
          0x00,
          0x00,
          0x00,
          0x00,
          0x01,
          0x00,
          0x01,
          0x00,
          0x00,
          0x02,
          0x02,
          0x44,
          0x01,
          0x00,
          0x3b,
        ]),
      });

      const image = document.createElement("img");
      image.setAttribute("data-blob-upload-test", "true");
      image.alt = "Uploaded blob test image";
      image.style.width = "16px";
      image.style.height = "16px";
      image.style.imageRendering = "pixelated";
      image.src = upload.url;
      document.body.append(image);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Timed out loading uploaded image")),
          5000,
        );
        image.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        image.onerror = () => {
          clearTimeout(timeout);
          reject(new Error(`Failed to load ${image.currentSrc}`));
        };
      });

      return {
        uploadUrl: upload.url,
        currentSrc: image.currentSrc,
        hasSpaceBase: Boolean(
          document.head.querySelector("[data-commonfabric-space-base='true']"),
        ),
      };
    });

    const image = await shell.page().waitForSelector(
      "[data-blob-upload-test='true']",
    );

    await waitForCondition(shell.page(), () => {
      const image = document.querySelector<HTMLImageElement>(
        "[data-blob-upload-test='true']",
      );
      if (!image) return false;
      const rect = image.getBoundingClientRect();
      return image.complete &&
        image.naturalWidth === 1 &&
        image.naturalHeight === 1 &&
        rect.width === 16 &&
        rect.height === 16;
    });
    const box = await image.boundingBox();

    const rendered = await shell.page().evaluate(() => {
      const image = document.querySelector<HTMLImageElement>(
        "[data-blob-upload-test='true']",
      );
      if (!image) {
        throw new Error("Uploaded image was not added to the document");
      }

      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Could not read uploaded image pixels");
      }
      context.drawImage(image, 0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      const rect = image.getBoundingClientRect();

      return {
        complete: image.complete,
        currentSrc: image.currentSrc,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        renderedWidth: rect.width,
        renderedHeight: rect.height,
        pixel: { red, green, blue, alpha },
      };
    });

    expect(result.uploadUrl.startsWith("http")).toBe(true);
    expect(result.currentSrc).toContain("/did:key:");
    expect(result.currentSrc).toContain("/blobs/");
    expect(result.hasSpaceBase).toBe(false);
    expect(Boolean(box)).toBe(true);
    expect(box?.width).toBe(16);
    expect(box?.height).toBe(16);
    expect(rendered.complete).toBe(true);
    expect(rendered.currentSrc).toBe(result.currentSrc);
    expect(rendered.naturalWidth).toBe(1);
    expect(rendered.naturalHeight).toBe(1);
    expect(rendered.renderedWidth).toBe(16);
    expect(rendered.renderedHeight).toBe(16);
    expect(rendered.pixel.alpha).toBe(255);
  });
});
