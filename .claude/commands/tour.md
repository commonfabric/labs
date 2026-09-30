# Platform Tour

Interactively tour the Common Fabric platform as a user, exercising core workflows through browser automation. You are LARPing as a curious user exploring the platform. Narrate what you see as you go — the user is watching.

## Usage

```
/tour <base-url>
```

If no URL is provided, default to `http://localhost:8000`. Examples:
- `/tour` — local dev server
- `/tour https://toolshed.saga-castor.ts.net` — production

## Setup

1. **Determine the base URL.** Use `$ARGUMENTS` if provided, otherwise `http://localhost:8000`. Trim any trailing slash.

2. **Compute the space slug.** Use today's date in `YYYY-MM-DD` format plus `-claude` (e.g. `2026-02-16-claude`).

3. **Create a screenshot directory.** Create `./tour-screenshots/YYYY-MM-DD/` for this run. All screenshots go here with numbered prefixes and descriptive names (`01-space-home.png`, `02-new-note.png`, etc.).

4. **Detect browser automation tool.** Run `which agent-browser` to check availability.

   **If `agent-browser` is available:** Use it throughout. Open with `agent-browser --headed open {url}` so the user can watch. Use `agent-browser snapshot -i` to discover interactive elements, interact via `@ref`s, and `agent-browser screenshot {path}` to capture.

   **If `agent-browser` is NOT available:** Fall back to the Playwright MCP tools. Use `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and `browser_take_screenshot` instead. The same principles apply — snapshot before interacting, use refs from snapshots, re-snapshot after DOM changes.

5. **Navigate to the space.** Open `{base-url}/{space-slug}`. Take an initial snapshot and screenshot. Describe what you see.

## Shadow DOM Helpers

These reusable JS eval snippets help navigate shadow DOM. To avoid shell quoting issues with `agent-browser eval`, write JS to a temp file first, then run `agent-browser eval "$(cat /tmp/tour-helper.js)"`.

### Find Details Disclosures

```js
(() => {
  function findInShadow(node, depth) {
    if (depth > 10) return [];
    const results = [];
    if (node.shadowRoot) {
      const details = node.shadowRoot.querySelectorAll('details');
      details.forEach((d) => {
        const s = d.querySelector('summary');
        if (s) {
          const rect = s.getBoundingClientRect();
          results.push({
            text: s.textContent.trim().substring(0, 50),
            open: d.open,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
          });
        }
      });
      node.shadowRoot.querySelectorAll('*').forEach((child) => {
        results.push(...findInShadow(child, depth + 1));
      });
    }
    return results;
  }
  const all = [];
  document.querySelectorAll('*').forEach((el) => {
    all.push(...findInShadow(el, 0));
  });
  return all;
})()
```

### Find Cell Link Chips

```js
(() => {
  function findCellLinks(node, depth) {
    if (depth > 10) return [];
    const results = [];
    if (node.shadowRoot) {
      const links = node.shadowRoot.querySelectorAll("cf-cell-link");
      links.forEach((l) => {
        const rect = l.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const inner = l.shadowRoot ? l.shadowRoot.textContent.trim().substring(0, 60) : l.textContent.trim().substring(0, 60);
          results.push({ text: inner, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        }
      });
      node.shadowRoot.querySelectorAll("*").forEach((child) => {
        results.push(...findCellLinks(child, depth + 1));
      });
    }
    return results;
  }
  const all = [];
  document.querySelectorAll("*").forEach((el) => { all.push(...findCellLinks(el, 0)); });
  return all;
})()
```

### Find Shadow DOM Buttons

Replace `BUTTON_TEXT` with the target text (e.g. "+").

```js
(() => {
  function findButtons(node, depth) {
    if (depth > 12) return [];
    const results = [];
    if (node.shadowRoot) {
      node.shadowRoot.querySelectorAll("button").forEach((b) => {
        if (b.textContent.trim() === "BUTTON_TEXT") {
          const rect = b.getBoundingClientRect();
          if (rect.width > 0 && rect.y > 0 && rect.y < 800)
            results.push({ text: b.textContent.trim(), x: rect.x + rect.width/2, y: rect.y + rect.height/2 });
        }
      });
      node.shadowRoot.querySelectorAll("*").forEach((child) => { results.push(...findButtons(child, depth + 1)); });
    }
    return results;
  }
  const all = [];
  document.querySelectorAll("*").forEach((el) => { all.push(...findButtons(el, 0)); });
  return all;
})()
```

### Scroll Content Area

```js
(() => {
  function findScrollable(node, depth) {
    if (depth > 8) return [];
    const results = [];
    if (node.shadowRoot) {
      for (const el of node.shadowRoot.querySelectorAll('*')) {
        if (el.scrollHeight > el.clientHeight + 50) {
          el.scrollBy(0, 400);
          results.push({ tag: el.tagName, scrollH: el.scrollHeight, clientH: el.clientHeight });
        }
        results.push(...findScrollable(el, depth + 1));
      }
    }
    return results;
  }
  const all = [];
  document.querySelectorAll('*').forEach(el => all.push(...findScrollable(el, 0)));
  return all.filter(r => r.scrollH > r.clientH + 50);
})()
```

### Scroll Content Area Up

Same as above but use `el.scrollBy(0, -400)` instead of `el.scrollBy(0, 400)`.

## The Tour

Work through these steps in order. At each step:
- Take a snapshot to discover interactive elements
- Interact using refs from the snapshot — never hardcode selectors
- After each major action, re-snapshot (refs are invalidated by DOM changes)
- Take a screenshot and save it to the screenshot directory
- **Narrate what you see** — describe the UI, what changed, anything surprising
- If a step fails, note the failure, take a screenshot of the error state, and continue to the next step

### Step 0: Register / Login

Fresh spaces require authentication. You will see "Register" and "Login" buttons on the landing page.

- Click **Register** to create a new identity
- Click **Generate Passphrase** on the next screen
- Click **I've Saved It - Continue** to complete registration

If the space is already authenticated (you see the Patterns view with a header toolbar), skip this step.

### Step 1: Explore the Space Home

You should now be on the authenticated space page. Describe the layout: the header breadcrumb, the "Patterns" heading, the "Notes" dropdown, any toolbar buttons, and the FAB (floating action button) in the bottom-right. Take a screenshot.

### Step 2: Create a New Note

Find the **"Notes ▾"** dropdown button in the content toolbar area. Click it to reveal a menu with options like "New Note", "New Notebook", "All Notes". Click **"New Note"**. After the note view loads, take a screenshot.

### Step 3: Edit the Note

The note has two parts to edit:

**Title:** The title is inside nested shadow DOM: `x-root-view > shadowRoot > x-app-view > shadowRoot > x-body-view > shadowRoot > cf-render > shadowRoot > div > cf-screen > cf-vstack`. It will NOT appear in accessibility snapshots.

1. Write a JS eval to find the title span:
```js
(() => {
  const rv = document.querySelector("x-root-view");
  const av = rv.shadowRoot.querySelector("x-app-view");
  const bv = av.shadowRoot.querySelector("x-body-view");
  const cr = bv.shadowRoot.querySelector("cf-render");
  const spans = cr.shadowRoot.querySelectorAll("span");
  for (const span of spans) {
    if (span.textContent.trim() === "New Note") {
      const rect = span.getBoundingClientRect();
      return { x: rect.x + rect.width/2, y: rect.y + rect.height/2, text: span.textContent };
    }
  }
  return "title span not found";
})()
```
2. Click at the returned coordinates to activate edit mode
3. A `cf-input` appears. Find the input inside it:
```js
(() => {
  const rv = document.querySelector("x-root-view");
  const av = rv.shadowRoot.querySelector("x-app-view");
  const bv = av.shadowRoot.querySelector("x-body-view");
  const cr = bv.shadowRoot.querySelector("cf-render");
  const cfInput = cr.shadowRoot.querySelector("cf-input");
  const input = cfInput.shadowRoot.querySelector("input");
  input.focus();
  input.value = "YOUR TITLE HERE";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return "set title: " + input.value;
})()
```
4. Press Enter to confirm

**Body:** The body textbox (code editor) IS accessible via snapshot. Use `agent-browser snapshot -i` to find it, then `agent-browser type @ref "your text"`. If the ref is ambiguous (matches multiple), use the textbox that doesn't have `"Note title..."` as placeholder.

Take a screenshot showing the edited note with the updated title in the breadcrumb.

### Step 4: Create a Second Note via Omnibox and Link It

Open the Omnibot (click the FAB in the bottom-right). Ask it to create a new note and then append a link to it from the first note. For example:

> Create a new note called "Related Thoughts" with some placeholder content. Then append a link to it inside my "YOUR FIRST NOTE TITLE" note.

(Replace "YOUR FIRST NOTE TITLE" with whatever you titled the note in Step 3.)

Wait for the LLM to use `createNote` and then `appendLink` (or edit the first note's content). Once done, navigate to the first note and verify a `[[📝 Related Thoughts (...)]]` wiki-link appears at the bottom of its content. Click the wiki-link to confirm it navigates to the second note. Take screenshots of both notes showing the link.

### Step 5: Return to Space Home

Click the space name link in the breadcrumb (e.g. "2026-02-16-claude") to navigate back to the space home. Verify the notes you created appear in the Patterns list with their titles. The breadcrumb should show an updated item count. Take a screenshot.

### Step 6: Open the Chat

Find the **"Open" button** (the FAB) in the bottom-right corner of the page and click it. A chat panel will appear in the bottom-right with:
- An input field: "Ask the LLM a question..."
- A "Send" button
- A model selector (defaults may vary — typically Claude Sonnet 4.5 or Opus 4.1)
- "Tools" button showing available tool count
- An "Expand" button to make the panel larger

Click Expand for better visibility. Take a screenshot.

### Step 7: Reference the Note in Chat

1. Click into the chat input textbox
2. Type `@` to trigger the mention autocomplete — a dropdown list will appear
3. Find and click your note (e.g. "📝 2026-02-16") in the dropdown
4. The mention will be inserted as a markdown link in the input
5. Type after the mention: " What does this note say?"
6. Click Send and wait ~15 seconds for the LLM to respond

The LLM should use the `read` tool and quote the note's content back. Take a screenshot of the response.

### Step 8: Ask for the Pattern Index

In the chat, type: "Can you list the available patterns from the pattern index?" and send. Wait ~20 seconds. The LLM should use the `listPatternIndex` tool and return categorized lists of available patterns. Take a screenshot.

### Step 9: Launch a Counter Pattern

In the chat, type: "Please launch the counter pattern with an initial value of 5" and send. Wait ~25 seconds. The LLM should:
1. Use `fetchAndRunPattern` to compile and run the counter
2. Use `navigateTo` to navigate to the new pattern

The counter view shows: a heading "Simple Counter", a large number (5), text like "Counter is the 5th number", and "- Decrement" / "+ Increment" buttons. Take a screenshot. Note: the counter pattern may not appear in `listPatternIndex`, but the LLM can still launch it via `fetchAndRunPattern` using the path `counter/counter.tsx`.

**Testing interactivity:** The `cf-button` component wraps a native `<button>` inside its shadow root. Use this approach:
```js
(() => {
  const rv = document.querySelector("x-root-view");
  const av = rv.shadowRoot.querySelector("x-app-view");
  const bv = av.shadowRoot.querySelector("x-body-view");
  const cr = bv.shadowRoot.querySelector("cf-render");
  const buttons = cr.shadowRoot.querySelectorAll("cf-button");
  return Array.from(buttons).map(b => {
    const rect = b.getBoundingClientRect();
    return { x: rect.x + rect.width/2, y: rect.y + rect.height/2, w: rect.width };
  });
})()
```
The first button is Decrement, the second is Increment. Click at the coordinates and verify the counter value updates.

Take a screenshot showing the changed value.

### Step 10: Add To-Do Items via Omnibot

Navigate back to the space home by clicking the space name in the breadcrumb. The space home has a two-column layout: the **Do List** on the left and **Recent / Pieces** on the right.

Open the Omnibot (click the FAB in the bottom-right). Send a message asking it to add four tasks to the do-list. Something like:

> Please add these items to my to-do list:
> 1. Plan a weekend camping trip
> 2. Research the best noise-canceling headphones under $200
> 3. Budget for a home office upgrade — $500 to spend
> 4. Clone the https://github.com/commonfabric/labs repo and summarize the readme in a note

Wait ~15-25 seconds for the LLM to use the `addDoItem` or `addDoItems` tools. The items appear in the do-list as soon as the tool executes — you don't need to wait for the LLM to finish its text summary. Once you see items in the list, click anywhere on the page to dismiss the omnibox and move on. Note: dismissing the omnibox eats the first click — it does NOT also interact with whatever is underneath. You'll need a second click to interact with elements like AI Suggestions disclosures.

Verify the items appear in the do-list on the left side of the space home. Take a screenshot.

### Step 11: Watch AI Suggestions Generate

Each do-list item has a collapsible **"AI Suggestions"** section (a `<details>` disclosure element). These elements are inside nested shadow DOM and will NOT appear in accessibility snapshots. Use the **Find Details Disclosures** helper from the Shadow DOM Helpers section. This returns an array of `{text, open, x, y}` objects — one per `<details>` element. Use coordinate-based clicking (`mouse move {x} {y}` + `mouse down left` + `mouse up left`) to toggle them open/closed. Re-run the JS eval after expanding to get updated positions, since expanding one item shifts the others down.

Click the disclosure summary on one of the items (e.g. "Plan a weekend camping trip") to expand it.

A Suggestion pattern will activate and begin generating. Watch for:
- **`cf-message-beads`** — colored dots representing the LLM conversation. A spinning gray dot means the LLM is working. Blue = user, green = assistant text, amber = assistant tool calls, purple = tool results.
- The LLM (Claude Sonnet) will call tools like `listPatternIndex`, `fetchAndRunPattern`, or `bash` to find/create a relevant result.
- When done, a **`cf-cell-link`** chip (pill) appears showing the resulting piece.

Narrate the bead activity as it happens — describe what tools are being called and what's appearing. Wait for the suggestion to complete. Take a screenshot.

Expand the AI Suggestions on a second item too (e.g. "Research the best noise-canceling headphones under $200") and watch that one generate as well.

### Step 12: Click Suggestions and Explore Results

Use the **Find Cell Link Chips** helper to locate `cf-cell-link` chips. The `text` field from the helper shows the chip's display name. Click the `cf-cell-link` chip on a completed suggestion to navigate to the resulting piece. Describe what the piece looks like — it could be a note with content, a web search result, a pattern output, etc.

Navigate back to the space home (breadcrumb). Check the **Recent** section in the right column — the piece you just visited should now appear there at the top of the list. Take a screenshot showing the recent list with the new piece.

### Step 13: View the Grid View

On the space home, use the **Find Cell Link Chips** helper to locate the chip next to the **"Recent"** heading. The `text` field from the helper shows the chip's display name. Click it to navigate to the **PieceGrid** — a thumbnail grid view.

The grid shows a 3-column layout where each piece is rendered as a live scaled-down preview (40% scale) with a clickable name chip below. Describe what you see — the thumbnails should show miniature versions of each piece's actual UI. Take a screenshot.

Navigate back to the space home.

### Step 14: Suggestion Refinement / Follow-up

Back on the space home, find a do-list item with a completed suggestion (expand it if collapsed). The **"Refine suggestion..."** input is hidden by default. To reveal it, click the **"+"** button on the `cf-message-beads` widget (the row of colored dots at the bottom of the suggestion). Use the **Find Shadow DOM Buttons** helper (searching for '+') to locate the button coordinates. This toggles the `cf-prompt-input` visible, which allows you to continue the conversation with the suggestion LLM.

The refinement input and Send button appear in the accessibility snapshot after clicking '+'. Use refs to interact with them.

For the **budget item**, type a refinement like:
> Actually I need to include a standing desk — reallocate the budget to fit one in under $500

Or for the **camping trip checklist**, refine with:
> Add items for cooking — I want to bring a camp stove and make coffee

Watch the beads update as the LLM continues working. It may call more tools, update the result, or create a new piece. Wait for completion, then click the result to see what was generated. Take a screenshot of the refined result.

Try refinement on another suggestion too. For example, on the **repo summary item**, refine with:
> Also list the top 5 most interesting packages and what they do

Take a screenshot of each refined result.

### Step 15: Rearrange the Do-List via Omnibot

Navigate back to the space home. Open the Omnibot (FAB). Ask it to rearrange the do-list by making one item a subtask of another. For example:

> Make "Research the best noise-canceling headphones under $200" a subtask of "Budget for a home office upgrade"

Wait for the LLM to use the `updateDoItem` tool (setting `indent`). The do-list supports indentation levels: 0 = root task, 1 = subtask, 2 = sub-subtask. Complex operations (remove + re-add with indent) can take 30-60 seconds. If the LLM times out, the partial results (e.g. marking done, removing item) will still be visible. Try simpler operations first: 'Mark the camping trip as done' before attempting subtask nesting. Verify the item now appears indented under its parent in the do-list. Take a screenshot.

Try another rearrangement — ask Omnibot to mark one item as done, or to add a new subtask under an existing item.

### Step 16: Create a Note and @mention in Omnibot

Use the **"Notes ▾"** dropdown to create a new note (same as Step 2). Edit the title to something descriptive like "Tour Observations" using the shadow DOM coordinate technique from Step 3. Add body content summarizing interesting things you've seen during the tour so far.

Navigate back to the space home and verify the note appears in the Pieces list.

Open the Omnibot, type `@` to trigger mention autocomplete. Find and select the new note (e.g. "📝 Tour Observations") from the dropdown. Type a question after the mention, like "Summarize this note and suggest what else I should add." Send and wait for the response. Take a screenshot.

### Step 17: Free Exploration

Spend 2-3 minutes freely exploring the platform. This is intentionally unstructured — follow your curiosity. Some ideas:

- Click on various pieces in the Recent list to see what they look like
- Try the grid view for **all pieces** (click the chip next to "Pieces" heading, not just "Recent")
- Open more AI Suggestions on do-list items you haven't expanded yet
- Send more refinement messages on existing suggestions
- Ask Omnibot to do other things with the do-list: mark items done, remove items, add new ones
- Navigate between pieces using breadcrumbs and `cf-cell-link` chips
- Check if any suggestion results have their own interactive elements
- Try creating another note or pattern from the Omnibot
- Hover over the message beads in suggestions to see conversation details

Screenshot anything interesting you find.

## Wrap Up

1. **Check for errors.** If using `agent-browser`, run `agent-browser console` and `agent-browser errors` to capture any console errors or warnings. If using Playwright MCP, check the browser console via `browser_console_messages`.

2. **Take a final screenshot** of the current state.

3. **Print the tour report:**

```
## Tour Report - {date}

### Environment
- URL: {base-url}
- Space: /{space-slug}
- Browser tool: agent-browser | playwright MCP

### Steps Completed
For each step, mark pass/fail with a one-line observation:
- [x] Step 0: Registration — how the auth flow went
- [x] Step 1: Space Home — description of what loaded
- [x] Step 2: Create Note — how it went
- [x] Step 3: Edit Note — title and body editing
- [x] Step 4: Link Notes via Omnibox — created second note and appended link
- [x] Step 5: Return Home — notes appeared in list
- [x] Step 6: Open Chat — FAB and chat panel
- [x] Step 7: @mention Note — LLM read the note
- [x] Step 8: Pattern Index — listing of available patterns
- [x] Step 9: Counter Pattern — launch and interact
- [x] Step 10: Add To-Do Items — Omnibot added items to do-list
- [x] Step 11: AI Suggestions — watched suggestions generate
- [x] Step 12: Explore Suggestions — clicked results, checked recent list
- [x] Step 13: Grid View — viewed thumbnail grid
- [x] Step 14: Suggestion Refinement — sent follow-up messages
- [x] Step 15: Rearrange Do-List — Omnibot restructured tasks
- [x] Step 16: Note + @mention — created note, mentioned in Omnibot
- [x] Step 17: Free Exploration — what you discovered
- [ ] Some Step — FAILED: reason
...etc

### Screenshots
List all saved screenshots with paths.

### Console Errors
Any errors or warnings found in the browser console.

### Issues Found
Describe any bugs, unexpected behavior, or UX friction encountered.

### Free Exploration Highlights
Notable discoveries, surprising behavior, or interesting interactions from Step 16.
```

4. **Ask the user if they want to keep exploring.** Use AskUserQuestion to offer:
   - **Explore more patterns** — keep the browser open and let the user pick patterns from the index to launch and try
   - **Done** — close the browser and end the tour

If the user chooses to explore more patterns, list the patterns from the index (from Step 7's response) and ask which one to launch. Keep iterating — launch the pattern, narrate what it does, take screenshots, then ask again. Close the browser only when the user says they're done.

## Known Gotchas

These are persistent platform/tooling quirks that affect multiple steps. Step-specific advice belongs in the steps themselves.

1. **Font warnings in console.** JetBrainsMono font OTS parsing warnings are cosmetic — not errors. Ignore them when reviewing console output.

2. **Newlines in `agent-browser type` trigger Enter/submit.** Never include newlines in typed text — the chat input interprets them as send. Write everything on one line.

3. **Shell quoting with `agent-browser eval`.** Inline JS with quotes gets mangled by the shell. Always write JS to a temp file first: `cat > /tmp/tour-helper.js <<'EOF' ... EOF` then run `agent-browser eval "$(cat /tmp/tour-helper.js)"`. See the Shadow DOM Helpers section.

4. **Do NOT use Playwright MCP alongside `agent-browser`.** They operate on separate page contexts. Playwright MCP's page will be `about:blank` while `agent-browser` has the actual page. Pick one and stick with it.

## Rules

- **Prefer `agent-browser`, fall back to Playwright MCP.** Check availability at startup and adapt.
- **Always snapshot before interacting.** Never assume element refs from a previous snapshot are still valid.
- **Use `snapshot -i` for interactive refs.** The `-i` flag returns only interactive elements with unique refs, avoiding the duplicate-ref problem that occurs with full snapshots.
- **Use coordinate-based clicks for ALL shadow DOM custom elements.** This includes `cf-button`, `cf-cell-link`, `cf-input`, `<details>` summaries, and `cf-message-beads`. Ref-based clicks may hang or fail on these.
- **Write JS eval snippets to temp files.** See Known Gotchas for details.
- **Be descriptive.** The user is watching — narrate what you see, what you're clicking, and what happened.
- **Don't block on failures.** If a step fails, document it and move on. The tour is about coverage, not perfection.
- **No hardcoded selectors.** Discover elements from snapshots. The UI may change — the Known Gotchas describe interaction patterns, not specific refs.
- **Show the browser.** Use headed/visible mode so the user can watch the tour happen in real time.
- **This is exploratory, not a snapshot test.** The descriptions are high-level guides. You are free to explore beyond the prescribed steps and adapt to what you find.

## Self-Improvement

This tour is designed to improve itself. When something goes wrong during a run:

1. **Fix the source, not the footnotes.** Don't just add a new Known Gotcha — go back and rewrite the step that was wrong. The tour should always read as correct, up-to-date instructions, not a document with errata appended.
   - If a step says to click element X but it's now element Y, **rewrite the step**.
   - If timing assumptions are wrong, **update the numbers in the step**.
   - If a UI flow has changed, **rewrite the flow description**.
   - If a JS eval snippet no longer works, **fix the snippet**.

2. **Known Gotchas are for structural workarounds, not corrections.** A gotcha belongs in the list only when it describes a persistent platform quirk that can't be fixed by rewriting a step (e.g., "shadow DOM elements don't appear in accessibility snapshots"). If a gotcha was added as a correction to a bad step, fold the fix into the step and remove the gotcha.

3. **Keep the file from growing.** When updating:
   - Remove gotchas that are now redundant because the step was fixed.
   - Remove gotchas for bugs that have been fixed in the platform.
   - Consolidate duplicate or overlapping gotchas.
   - The file should get *better*, not *longer*.

4. **Only document what you've actually hit.** Don't add speculative advice. Every change should come from a real failure in a real tour run.

5. **Extract reusable helpers.** If a step requires JS eval for shadow DOM navigation, consider whether the snippet should be a helper in the Shadow DOM Helpers section. Parameterize where possible (e.g. 'find button by text' instead of 'find + button').
