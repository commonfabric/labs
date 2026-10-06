import { assertEquals } from "@std/assert";

import { REMOTE_LOAD_PROPS } from "../src/worker/reconciler.ts";

// The reconciler decides a remote load by a hand-kept table of the props that
// load one (`REMOTE_LOAD_PROPS`). A component that loads what a prop names, or
// renders markup or a nested view that can, and is missing from it would let a
// value carrying a material-risk caveat load a URL as it renders (SC-56). So
// every component whose source shows a way to load is held to the table, or to
// a reason here that it loads nothing a value chooses.

const COMPONENTS_DIR = new URL("../../ui/src/v2/components/", import.meta.url);

/** Signs in a component's source that it can load a remote resource. */
const LOADS =
  /<img|fetch\(|cf-markdown|cf-chat-message|<cf-render|<cf-chat\b|<cf-fab\b|unsafeHTML|innerHTML|\.src\s*=|background-image|srcset/;

/** Components that show a sign of loading but load nothing a value chooses. */
const LOADS_NOTHING_A_VALUE_CHOOSES: Readonly<Record<string, string>> = {
  "cf-avatar":
    "renders only `data:` URIs; anything else falls back to initials",
  "cf-button": "its stylesheet's background-image is `none`",
  "cf-file-input": "previews files the user chose, from its own state",
  "cf-image": "renders an object URL it makes from bytes",
  "cf-image-input": "previews files the user chose, from its own state",
  "cf-piece-menu": "its stylesheet's background-images are gradients",
  "cf-plaid-link": "loads a fixed script and posts to fixed endpoints",
  "cf-progress": "its stylesheet's background-image is a gradient",
  "cf-prompt-input": "fetches a pasted image, on the user's paste",
  "cf-select": "its stylesheet's background-image is an inline `data:` SVG",
  "cf-voice-input": "posts to a fixed transcription endpoint",
  "cf-webhook": "posts to fixed endpoints",
};

async function componentSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  for await (const entry of Deno.readDir(COMPONENTS_DIR)) {
    if (!entry.isDirectory || !entry.name.startsWith("cf-")) continue;
    const dir = new URL(`${entry.name}/`, COMPONENTS_DIR);
    let text = "";
    for await (const file of Deno.readDir(dir)) {
      if (
        !file.isFile || !file.name.endsWith(".ts") ||
        file.name.includes("test") || file.name.includes("stories")
      ) continue;
      text += await Deno.readTextFile(new URL(file.name, dir));
    }
    sources.set(entry.name, text);
  }
  return sources;
}

Deno.test("every component that can load is in the remote-load table or says why not", async () => {
  const sources = await componentSources();
  const unclassified = [...sources]
    .filter(([tag, text]) =>
      LOADS.test(text) && !REMOTE_LOAD_PROPS.has(tag) &&
      !(tag in LOADS_NOTHING_A_VALUE_CHOOSES)
    )
    .map(([tag]) => tag)
    .sort();
  assertEquals(unclassified, []);
});

Deno.test("the table and the reasons name components that exist, once", async () => {
  const sources = await componentSources();
  const tableTags = [...REMOTE_LOAD_PROPS.keys()].filter((tag) =>
    tag.startsWith("cf-")
  );
  assertEquals(tableTags.filter((tag) => !sources.has(tag)), []);
  assertEquals(
    Object.keys(LOADS_NOTHING_A_VALUE_CHOOSES).filter((tag) =>
      !sources.has(tag)
    ),
    [],
  );
  assertEquals(
    tableTags.filter((tag) => tag in LOADS_NOTHING_A_VALUE_CHOOSES),
    [],
  );
});
