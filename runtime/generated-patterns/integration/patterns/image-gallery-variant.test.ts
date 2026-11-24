import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

type VariantInput = {
  mode?: string;
  src?: string;
  alt?: string;
};

type ImageGalleryVariantArgs = {
  modes?: string[];
  variants?: VariantInput[];
  activeMode?: string;
};

export const imageGalleryVariantScenario: PatternIntegrationScenario<
  ImageGalleryVariantArgs
> = {
  name: "image gallery variants track active device selection",
  module: new URL(
    "./image-gallery-variant.pattern.ts",
    import.meta.url,
  ),
  exportName: "imageGalleryVariant",
  argument: {
    modes: ["Desktop", "Mobile", " Tablet"],
    variants: [
      { mode: "mobile", src: "mobile-initial.jpg", alt: "mobile hero" },
      { mode: "desktop", src: "Desktop-HD.png" },
    ],
    activeMode: "mobile",
  },
  steps: [
    {
      expect: [
        { path: "availableModes", value: ["desktop", "mobile", "tablet"] },
        {
          path: "variantList",
          value: [
            {
              mode: "desktop",
              src: "Desktop-HD.png",
              alt: "Image for desktop",
            },
            {
              mode: "mobile",
              src: "mobile-initial.jpg",
              alt: "mobile hero",
            },
            {
              mode: "tablet",
              src: "tablet-placeholder.png",
              alt: "Image for tablet",
            },
          ],
        },
        { path: "activeMode", value: "mobile" },
        {
          path: "currentVariant",
          value: {
            mode: "mobile",
            src: "mobile-initial.jpg",
            alt: "mobile hero",
          },
        },
        { path: "currentSource", value: "mobile-initial.jpg" },
        { path: "currentAlt", value: "mobile hero" },
        { path: "variantSummary", value: "mobile:mobile-initial.jpg" },
        {
          path: "label",
          value: "Mode mobile uses mobile-initial.jpg",
        },
        { path: "history", value: [] },
      ],
    },
    {
      events: [{
        stream: "updateVariant",
        payload: {
          mode: "tablet",
          src: " tablet-hd.png ",
          alt: " Tablet preview ",
        },
      }],
      expect: [
        {
          path: "variantList",
          value: [
            {
              mode: "desktop",
              src: "Desktop-HD.png",
              alt: "Image for desktop",
            },
            {
              mode: "mobile",
              src: "mobile-initial.jpg",
              alt: "mobile hero",
            },
            {
              mode: "tablet",
              src: "tablet-hd.png",
              alt: "Tablet preview",
            },
          ],
        },
        { path: "activeMode", value: "mobile" },
        { path: "currentSource", value: "mobile-initial.jpg" },
        {
          path: "variantSummary",
          value: "mobile:mobile-initial.jpg",
        },
        { path: "history", value: [] },
      ],
    },
    {
      events: [{ stream: "selectMode", payload: { mode: "tablet" } }],
      expect: [
        { path: "activeMode", value: "tablet" },
        {
          path: "currentVariant",
          value: {
            mode: "tablet",
            src: "tablet-hd.png",
            alt: "Tablet preview",
          },
        },
        { path: "currentSource", value: "tablet-hd.png" },
        { path: "currentAlt", value: "Tablet preview" },
        { path: "variantSummary", value: "tablet:tablet-hd.png" },
        { path: "history", value: ["tablet"] },
        {
          path: "label",
          value: "Mode tablet uses tablet-hd.png",
        },
      ],
    },
    {
      events: [{
        stream: "updateVariant",
        payload: { mode: "tablet", src: "tablet-final.png" },
      }],
      expect: [
        {
          path: "currentVariant",
          value: {
            mode: "tablet",
            src: "tablet-final.png",
            alt: "Tablet preview",
          },
        },
        { path: "currentSource", value: "tablet-final.png" },
        { path: "variantSummary", value: "tablet:tablet-final.png" },
        {
          path: "label",
          value: "Mode tablet uses tablet-final.png",
        },
        { path: "history", value: ["tablet"] },
      ],
    },
    {
      events: [{ stream: "selectMode", payload: { mode: "desktop" } }],
      expect: [
        { path: "activeMode", value: "desktop" },
        {
          path: "currentVariant",
          value: {
            mode: "desktop",
            src: "Desktop-HD.png",
            alt: "Image for desktop",
          },
        },
        { path: "currentAlt", value: "Image for desktop" },
        { path: "variantSummary", value: "desktop:Desktop-HD.png" },
        {
          path: "history",
          value: ["tablet", "desktop"],
        },
        {
          path: "label",
          value: "Mode desktop uses Desktop-HD.png",
        },
      ],
    },
    {
      events: [{ stream: "selectMode", payload: { mode: "unknown" } }],
      expect: [
        { path: "activeMode", value: "desktop" },
        {
          path: "history",
          value: ["tablet", "desktop", "desktop"],
        },
        {
          path: "label",
          value: "Mode desktop uses Desktop-HD.png",
        },
      ],
    },
  ],
};

export const scenarios = [imageGalleryVariantScenario];

describe("image-gallery-variant", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
