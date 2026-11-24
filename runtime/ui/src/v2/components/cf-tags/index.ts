import { CFTags } from "./cf-tags.ts";

if (!customElements.get("cf-tags")) {
  customElements.define("cf-tags", CFTags);
}

export type { CFTags as CFTagsElement } from "./cf-tags.ts";

export * from "./cf-tags.ts";
