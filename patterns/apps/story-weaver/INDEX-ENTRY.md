## `apps/story-weaver/story-weaver.tsx`

Grow a story with AI, one level at a time. Commit a synopsis (or ask for ideas
with Inspire me), and each spindle on the next level asks the model for four
Markdown options built on its parent; pin one and its children appear on the
level below, ready to generate. Levels (Characters & Themes, Chapters, ...)
are editable, and each has a branch factor for how many sibling spindles a
pinned parent gets. Respin asks for fresh options, a spindle can carry its own
extra instruction, and pins built on text that has since changed are flagged
stale. The board is a tree of paths derived from what was pinned
(`story-logic.ts`), and the pinned story projects to `[FS]` Markdown.

**Keywords:** llm, generateObject, writing, story, brainstorm, tree, branching

### Input Schema

```ts
interface Level {
  title: string;
  prompt: string; // instruction each spindle at this level sends
  branch: number; // siblings per pinned parent, 1..6
}

interface Spindle {
  path: string; // sibling indices per level, e.g. "0.2"
  pinned: number; // option index, or -1
  pinnedText: string;
  parentHash: string; // hash of the parent text when pinned (stale check)
  extraPrompt: string;
  respins: number;
  requested: boolean; // levels below the first wait for Generate options
}

interface StoryWeaverInput {
  title?: PerSpace<Writable<string | Default<"My Story Weaver">>>;
  synopsis?: PerSpace<Writable<string | Default<"">>>;
  synopsisDraft?: PerSpace<Writable<string | Default<"">>>;
  levels?: PerSpace<Writable<Level[] | Default<typeof DEFAULT_LEVELS>>>;
  spindles?: PerSpace<Writable<Spindle[] | Default<[]>>>;
}
```

### Output Schema

```ts
interface StoryWeaverOutput {
  title: string;
  synopsis: string;
  synopsisDraft: string;
  levels: Level[];
  spindles: Spindle[];
  board: string[][]; // paths on the board, level by level
  startStory: Stream<void>;
  pin: Stream<{ path: string; option: number; text: string }>;
  respin: Stream<{ path: string }>;
  generate: Stream<{ path: string }>;
  setExtraPrompt: Stream<{ path: string; text: string }>;
  setBranch: Stream<{ level: number; branch: number }>;
  addLevel: Stream<{ title: string; prompt: string }>;
  updateLevel: Stream<{ level: number; title: string; prompt: string }>;
  removeLastLevel: Stream<void>;
}
```

<!-- demo-list: `apps/story-weaver/` (brainstorm a story level by level with AI) -->
