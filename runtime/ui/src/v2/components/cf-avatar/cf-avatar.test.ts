// First, so that the document it installs is there when Lit loads.
import { mount } from "../../test-utils/dom.ts";

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import type { CFImage } from "../cf-image/index.ts";
import {
  CFAvatar,
  initialsForName,
  isAvatarImageUrl,
  isRemoteLikeSource,
} from "./index.ts";

/** A mounted avatar with `properties` set. */
const mountAvatar = (properties: Partial<CFAvatar>): Promise<CFAvatar> =>
  mount(Object.assign(new CFAvatar(), properties));

/** What `element` shows inside its avatar box. */
const shown = (element: CFAvatar) => {
  const box = element.shadowRoot!.querySelector(".avatar")!;
  return {
    label: box.getAttribute("aria-label"),
    image: box.querySelector<CFImage>("cf-image"),
    img: box.querySelector("img"),
    glyph: box.querySelector(".glyph")?.textContent ?? null,
    initials: box.querySelector(".initials")?.textContent?.trim() ?? null,
  };
};

const DATA_URL = "data:image/png;base64,AAAA";

describe("CFAvatar", () => {
  afterEach(() => document.body.replaceChildren());

  it("registers the custom element", () => {
    expect(customElements.get("cf-avatar")).toBe(CFAvatar);
  });

  it("defaults to a medium circle", () => {
    const el = new CFAvatar();
    expect(el.size).toBe("md");
    expect(el.shape).toBe("circle");
  });

  describe("render", () => {
    const bytes = new FabricBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    it("shows bytes as an image, ahead of a glyph", async () => {
      const el = await mountAvatar({ bytes, src: "🦊", name: "Ada" });
      const { image, glyph, initials } = shown(el);
      expect(image?.bytes).toBe(bytes);
      expect(image?.getAttribute("alt")).toBe("Ada");
      expect(glyph).toBeNull();
      expect(initials).toBeNull();
    });

    it("shows the glyph, or else initials, when the bytes are empty", async () => {
      const el = await mountAvatar({
        bytes: new FabricBytes(new Uint8Array()),
        name: "Ada Lovelace",
        src: "🦊",
      });
      expect(shown(el).image).toBeNull();
      expect(shown(el).glyph).toBe("🦊");
      el.src = undefined;
      await el.updateComplete;
      expect(shown(el).image).toBeNull();
      expect(shown(el).glyph).toBeNull();
      expect(shown(el).initials).toBe("AL");
    });

    it("shows a `data:` source as an image labeled by its alt text", async () => {
      const el = await mountAvatar({
        src: ` ${DATA_URL} `,
        name: "Ada",
        alt: "Me",
      });
      const { label, img, initials } = shown(el);
      expect(img?.getAttribute("src")).toBe(DATA_URL);
      expect(img?.getAttribute("alt")).toBe("Me");
      expect(label).toBe("Me");
      expect(initials).toBeNull();
    });

    it("shows initials, and no image, for a remote source", async () => {
      const el = await mountAvatar({
        src: "https://example.com/a.png",
        name: "Ada Lovelace",
      });
      expect(shown(el)).toEqual({
        label: "Ada Lovelace",
        image: null,
        img: null,
        glyph: null,
        initials: "AL",
      });
    });

    it("labels itself `avatar` with neither a name nor alt text", async () => {
      expect(shown(await mountAvatar({})).label).toBe("avatar");
    });

    it("shows initials once its image fails to load, until its source changes", async () => {
      const el = await mountAvatar({ src: DATA_URL, name: "Ada Lovelace" });
      shown(el).img!.dispatchEvent(new Event("error"));
      await el.updateComplete;
      expect(shown(el).img).toBeNull();
      expect(shown(el).initials).toBe("AL");

      el.src = "data:image/png;base64,BBBB";
      await el.updateComplete;
      expect(shown(el).img?.getAttribute("src")).toBe(
        "data:image/png;base64,BBBB",
      );
    });
  });

  describe("size and shape", () => {
    it("reflects a valid size and shape", async () => {
      const el = await mountAvatar({ size: "xl", shape: "square" });
      expect(el.getAttribute("size")).toBe("xl");
      expect(el.getAttribute("shape")).toBe("square");
    });

    it("replaces an unknown size and shape with the defaults", async () => {
      const el = await mountAvatar({});
      el.setAttribute("size", "huge");
      el.setAttribute("shape", "hexagon");
      await el.updateComplete;
      expect(el.size).toBe("md");
      expect(el.shape).toBe("circle");
      expect(el.getAttribute("size")).toBe("md");
      expect(el.getAttribute("shape")).toBe("circle");
    });
  });

  describe("isAvatarImageUrl", () => {
    it("treats only inline data: URIs as images", () => {
      expect(isAvatarImageUrl("data:image/png;base64,AAAA")).toBe(true);
      expect(isAvatarImageUrl("data:image/svg+xml,<svg></svg>")).toBe(true);
      expect(isAvatarImageUrl("  data:image/png;base64,AAAA  ")).toBe(true);
      expect(isAvatarImageUrl("DATA:image/png;base64,AAAA")).toBe(true);
    });

    it("rejects external/remote sources (no external resources)", () => {
      // Remote URLs must NOT become an <img>; they fall back to glyph/initials.
      expect(isAvatarImageUrl("https://example.com/a.png")).toBe(false);
      expect(isAvatarImageUrl("http://example.com/a.png")).toBe(false);
      expect(isAvatarImageUrl("//example.com/a.png")).toBe(false);
      expect(isAvatarImageUrl("blob:abc")).toBe(false);
      expect(isAvatarImageUrl("/avatars/me.png")).toBe(false);
      expect(isAvatarImageUrl("./me.png")).toBe(false);
      expect(isAvatarImageUrl("ftp://example.com/a.png")).toBe(false);
    });

    it("treats glyphs / plain text / empty as non-images", () => {
      expect(isAvatarImageUrl("🦊")).toBe(false);
      expect(isAvatarImageUrl("AB")).toBe(false);
      expect(isAvatarImageUrl("ada")).toBe(false);
      expect(isAvatarImageUrl("")).toBe(false);
      expect(isAvatarImageUrl("   ")).toBe(false);
    });
  });

  describe("isRemoteLikeSource", () => {
    it("flags URL/path/scheme sources so they degrade to initials, not raw text", () => {
      expect(isRemoteLikeSource("https://example.com/a.png")).toBe(true);
      expect(isRemoteLikeSource("http://example.com/a.png")).toBe(true);
      expect(isRemoteLikeSource("//example.com/a.png")).toBe(true);
      expect(isRemoteLikeSource("/avatars/me.png")).toBe(true);
      expect(isRemoteLikeSource("blob:abc")).toBe(true);
      expect(isRemoteLikeSource("ftp://example.com/a.png")).toBe(true);
    });

    it("does not flag glyphs, initials text, or inline data URIs", () => {
      expect(isRemoteLikeSource("🦊")).toBe(false);
      expect(isRemoteLikeSource("AB")).toBe(false);
      expect(isRemoteLikeSource("ada")).toBe(false);
      expect(isRemoteLikeSource("data:image/png;base64,AAAA")).toBe(false);
      expect(isRemoteLikeSource("")).toBe(false);
    });
  });

  describe("initialsForName", () => {
    it("takes up to two uppercase initials", () => {
      expect(initialsForName("Ada Lovelace")).toBe("AL");
      expect(initialsForName("Alan Mathison Turing")).toBe("AM");
      expect(initialsForName("grace")).toBe("G");
    });

    it("falls back to ? for empty/undefined names", () => {
      expect(initialsForName(undefined)).toBe("?");
      expect(initialsForName("")).toBe("?");
      expect(initialsForName("   ")).toBe("?");
    });
  });
});
