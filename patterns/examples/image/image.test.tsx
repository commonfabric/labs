/**
 * Test Pattern: Image
 *
 * An image with a caption is named after it and shows it beneath the image;
 * one without falls back to "Image" and shows no caption.
 *
 * Run: deno task cf test patterns/examples/image/image.test.tsx
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findNodeByText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Image from "./image.tsx";

const URL = "https://example.com/harbor.jpg";

export default pattern(() => {
  const captioned = Image({ url: URL, caption: "Harbor at dawn" });
  const bare = Image({ url: URL, caption: "" });

  const assert_captioned = assert(() =>
    captioned[NAME] === "Harbor at dawn" &&
    captioned.url === URL && captioned.caption === "Harbor at dawn" &&
    propValue(findElement(captioned[UI], "img"), "src") === URL &&
    propValue(findElement(captioned[UI], "img"), "alt") === "Harbor at dawn" &&
    findElement(findNodeByText(captioned[UI], "Harbor at dawn"), "div") !==
      undefined
  );

  const assert_bare = assert(() =>
    bare[NAME] === "Image" &&
    propValue(findElement(bare[UI], "img"), "src") === URL &&
    propValue(findElement(bare[UI], "img"), "alt") === "Image" &&
    findElement(findElement(bare[UI], "cf-vstack"), "div") === undefined
  );

  return {
    [TESTS]: [
      { assertion: assert_captioned },
      { assertion: assert_bare },
    ],
    captioned,
    bare,
  };
});
