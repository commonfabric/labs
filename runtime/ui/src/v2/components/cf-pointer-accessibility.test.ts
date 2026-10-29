import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CFChip } from "./cf-chip/index.ts";
import { CFMessageBeads } from "./cf-message-beads/index.ts";
import { CFTags } from "./cf-tags/index.ts";
import { CFTile } from "./cf-tile/index.ts";

type TemplateValue = {
  strings?: readonly string[];
  values?: readonly unknown[];
};

function renderedMarkup(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderedMarkup).join("");
  if (!value || typeof value !== "object") {
    return typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";
  }

  const template = value as TemplateValue;
  if (!template.strings || !template.values) return "";

  return template.strings.map((part, index) =>
    part + renderedMarkup(template.values?.[index])
  ).join("");
}

Deno.test("cf-chip unit paths keep primary and remove actions separate", () => {
  const chip = new CFChip();
  chip.label = "Roadmap";
  const internals = chip as unknown as {
    _handleClick(): void;
    _handleRemove(event: Event): void;
  };

  let chipClicks = 0;
  let removals = 0;
  chip.addEventListener("cf-click", () => chipClicks++);
  chip.addEventListener("cf-remove", () => removals++);

  internals._handleClick();
  assertEquals(chipClicks, 0);
  assertStringIncludes(renderedMarkup(chip.render()), "chip-content");

  chip.interactive = true;
  chip.removable = true;
  internals._handleClick();
  let propagationStopped = false;
  internals._handleRemove({
    stopPropagation: () => {
      propagationStopped = true;
    },
  } as unknown as Event);
  assertEquals(chipClicks, 1);
  assertEquals(removals, 1);
  assert(propagationStopped);

  const markup = renderedMarkup(chip.render());
  assertStringIncludes(markup, "chip-action");
  assertStringIncludes(markup, "chip-remove");
  assertStringIncludes(markup, "Remove");
});

Deno.test("cf-tile unit paths preserve nested details", () => {
  const tile = new CFTile();
  const internals = tile as unknown as { handleClick(): void };
  assertStringIncludes(renderedMarkup(tile.render()), "No item data");

  tile.item = { title: "Project notes" };
  tile.summary = "Three pages";
  let clicks = 0;
  tile.addEventListener("cf-click", () => clicks++);
  internals.handleClick();
  assertEquals(clicks, 1);

  let markup = renderedMarkup(tile.render());
  assertStringIncludes(markup, "tile-action");
  assertStringIncludes(markup, "summary-details");

  tile.clickable = false;
  internals.handleClick();
  assertEquals(clicks, 1);
  markup = renderedMarkup(tile.render());
  assertEquals(markup.includes("tile-action"), false);
  assertStringIncludes(markup, "Project notes");
});

Deno.test("cf-tags unit paths render semantic edit, remove, and add states", () => {
  const tags = new CFTags();
  tags.tags = ["alpha"];
  const internals = tags as unknown as {
    renderAddTag(): unknown;
    renderTag(tag: string, index: number): unknown;
  };

  assertStringIncludes(renderedMarkup(tags.render()), "tags-container");
  let markup = renderedMarkup(internals.renderTag("alpha", 0));
  assertStringIncludes(markup, "tag-edit");
  assertStringIncludes(markup, "Edit alpha");
  assertStringIncludes(markup, "Remove alpha");
  assertStringIncludes(renderedMarkup(internals.renderAddTag()), "+ Add tag");

  tags.editingIndex = 0;
  markup = renderedMarkup(internals.renderTag("alpha", 0));
  assertStringIncludes(markup, "tag-input-0");

  tags.editingIndex = null;
  tags.showingNewInput = true;
  markup = renderedMarkup(internals.renderAddTag());
  assertStringIncludes(markup, "new-tag-input");

  tags.showingNewInput = false;
  tags.readonly = true;
  markup = renderedMarkup(internals.renderTag("alpha", 0));
  assertEquals(markup.includes("tag-edit"), false);
  assertEquals(markup.includes("tag-remove"), false);
  assertStringIncludes(markup, "tag-text");
});

Deno.test("cf-message-beads unit paths render a named list and refine control", () => {
  const beads = new CFMessageBeads();
  const internals = beads as unknown as {
    _onRefineClick(): void;
    willUpdate(changedProperties: Map<PropertyKey, unknown>): void;
  };

  beads.pending = false;
  assertStringIncludes(renderedMarkup(beads.render()), "placeholder");
  beads.pending = true;
  assertStringIncludes(renderedMarkup(beads.render()), "spinner");

  beads.pending = false;
  beads.label = "History";
  beads.messages = [
    { role: "tool", content: "Tool output" },
    { role: "user", content: "Hello from the thread" },
    { role: "assistant", content: "A direct answer" },
    {
      role: "assistant",
      content: [{ type: "tool-call", toolName: "search" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool-result", toolName: "search" }],
    },
    { role: "assistant", content: [{ type: "image" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "A structured answer" }],
    },
    { role: "assistant", content: [] },
  ] as never;
  internals.willUpdate(new Map([["messages", undefined]]));

  const markup = renderedMarkup(beads.render());
  assertStringIncludes(markup, "History");
  assertStringIncludes(markup, "<ul");
  assertStringIncludes(markup, "<li");
  assertStringIncludes(markup, 'role="list"');
  assertStringIncludes(markup, 'role="listitem"');
  assertEquals(/<button[^>]*class="bead/.test(markup), false);
  assertStringIncludes(markup, "user: Hello from the thread");
  assertStringIncludes(markup, "→ search");
  assertStringIncludes(markup, "← search");
  assertStringIncludes(markup, "assistant: [image]");
  assertStringIncludes(markup, "Refine messages");

  let refinements = 0;
  beads.addEventListener("cf-refine", () => refinements++);
  internals._onRefineClick();
  assertEquals(refinements, 1);
});
