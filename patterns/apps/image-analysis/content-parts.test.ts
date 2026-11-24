import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { ImageData } from "commonfabric";
import { contentParts } from "./content-parts.ts";

const image = (fields: Partial<ImageData>): ImageData => ({
  id: "img",
  name: "img.png",
  url: "",
  data: "",
  timestamp: 0,
  size: 0,
  type: "image/png",
  ...fields,
});

describe("content-parts", () => {
  it("returns no parts for no question and no images", () => {
    expect(contentParts("", [])).toEqual([]);
  });

  it("returns the question as a text part", () => {
    expect(contentParts("What is this?", [])).toEqual([
      { type: "text", text: "What is this?" },
    ]);
  });

  it("follows the question with each image, by data before URL", () => {
    expect(
      contentParts("Compare these", [
        image({ data: "data:image/png;base64,AAAA", url: "https://x.test/a" }),
        image({ url: "https://x.test/b" }),
      ]),
    ).toEqual([
      { type: "text", text: "Compare these" },
      { type: "image", image: "data:image/png;base64,AAAA" },
      { type: "image", image: "https://x.test/b" },
    ]);
  });

  it("leaves out an image with neither data nor a URL", () => {
    expect(contentParts("", [image({}), image({ url: "https://x.test/c" })]))
      .toEqual([{ type: "image", image: "https://x.test/c" }]);
  });
});
