# Advanced Component Patterns

This document explores advanced patterns revealed by complex components like
`cf-theme`, `cf-code-editor`, and historical outliner implementations.

## Architectural Principles

### 1. Context Provision Pattern (`cf-theme`)

**Philosophy:** Components should receive configuration from their environment,
not just properties. Theme is ambient context that flows down the tree.

**Key Insight:** Use `display: contents` to be invisible in layout while
providing context.

```typescript
import { ContextConsumer, provide } from "@lit/context";

export class CFThemeProvider extends BaseElement {
  static override styles = css`
    :host {
      display: contents; /* Do not add extra layout */
    }
  `;

  @property({ attribute: false })
  theme: any = {};

  @provide({ context: cfThemeContext })
  @property({ attribute: false })
  _computedTheme: CFTheme = defaultTheme;

  /** The enclosing cf-theme's theme, or undefined for an outermost one. */
  #enclosing: CFTheme | undefined;

  constructor() {
    super();
    // A provider ignores requests from its own host, so this is answered by
    // the enclosing cf-theme, if there is one.
    new ContextConsumer(this, {
      context: cfThemeContext,
      subscribe: true,
      callback: (theme) => {
        this.#enclosing = theme;
        if (this.hasUpdated) this._recomputeAndApply();
      },
    });
  }

  private _recomputeAndApply() {
    // Merge the partial theme over the enclosing cf-theme's, or the defaults
    this._computedTheme = mergeWithDefaultTheme(this.theme, this.#enclosing);
    // Apply to self for CSS variable cascade: only what differs from the
    // enclosing theme, which the rest inherit
    applyThemeToElement(this, this._computedTheme, this.#enclosing);
    // Subscribe to Cell properties for reactive theme updates
    this.#setupSubscriptions();
  }

  #setupSubscriptions() {
    // Clean up previous subscriptions
    for (const off of this.#unsubs) off();
    this.#unsubs = [];

    // Subscribe to Cell properties in theme object
    for (const key of Object.keys(this.theme)) {
      const val = this.theme[key];
      if (isCell(val)) {
        const off = val.sink(() => this._recomputeAndApply());
        this.#unsubs.push(off);
      }
    }
  }
}
```

**Pattern Lessons:**

1. **Context providers are invisible:** Use `display: contents` to not affect
   layout
2. **Merge partial over the enclosing theme:** Support both full and
   pattern-style partial themes; a nested provider tints the one around it, and
   only an outermost one starts from the defaults
3. **Subscribe to Cell properties:** Theme values can be reactive Cells
4. **Apply to self:** Set CSS variables on the provider element so they cascade,
   and set only those that differ from what already cascades in
5. **Clean up subscriptions:** Always unsubscribe in `disconnectedCallback()`

**When to use:** Any time you need to provide ambient configuration (theme,
locale, services) to a subtree.

---

### 2. Third-Party Integration Pattern (`cf-code-editor`)

**Philosophy:** Complex third-party libraries (CodeMirror, Monaco, etc.) require
careful lifecycle management and bidirectional synchronization with Lit
properties.

**Key Insights:**

- Initialize in `firstUpdated()`, not `connectedCallback()` or constructor
- Use Compartments for reconfigurable extensions
- Synchronize bidirectionally: Lit props → library AND library → Lit/Cells
- Clean up library instances in `disconnectedCallback()`

```typescript
export class CFCodeEditor extends BaseElement {
  private _editorView: EditorView | undefined;
  private _lang = new Compartment();
  private _readonly = new Compartment();
  private _cleanupFns: Array<() => void> = [];

  // Cell controller manages Cell <-> value synchronization
  private _cellController = createStringCellController(this, {
    timing: { strategy: "debounce", delay: 500 },
    onChange: (newValue, oldValue) => {
      this.emit("cf-change", { value: newValue, oldValue });
    },
  });

  protected override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    this._initializeEditor();
    this._cellController.bind(this.value);
    this._setupCellSyncHandler();
  }

  private _initializeEditor(): void {
    const editorElement = this.shadowRoot?.querySelector(".code-editor");
    if (!editorElement) return;

    const extensions: Extension[] = [
      basicSetup,
      // Use Compartments for reconfigurable extensions
      this._lang.of(getLangExtFromMimeType(this.language)),
      this._readonly.of(EditorState.readOnly.of(this.readonly)),

      // Sync editor changes → Cell/value
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !this.readonly) {
          this.setValue(update.state.doc.toString());
        }
      }),
    ];

    this._editorView = new EditorView({
      state: EditorState.create({
        doc: this.getValue(),
        extensions,
      }),
      parent: editorElement,
    });
  }

  override updated(changedProperties: Map<string, any>) {
    super.updated(changedProperties);

    // Sync value changes (different Cell) → controller → editor
    if (changedProperties.has("value")) {
      this._cellController.bind(this.value);
      this._updateEditorFromCellValue();
    }

    // Reconfigure extensions using Compartments
    if (changedProperties.has("language") && this._editorView) {
      this._editorView.dispatch({
        effects: this._lang.reconfigure(getLangExtFromMimeType(this.language)),
      });
    }

    if (changedProperties.has("readonly") && this._editorView) {
      this._editorView.dispatch({
        effects: this._readonly.reconfigure(
          EditorState.readOnly.of(this.readonly),
        ),
      });
    }
  }

  private _updateEditorFromCellValue(): void {
    if (this._editorView) {
      const newValue = this.getValue();
      const currentValue = this._editorView.state.doc.toString();
      if (newValue !== currentValue) {
        this._editorView.dispatch({
          changes: {
            from: 0,
            to: this._editorView.state.doc.length,
            insert: newValue,
          },
        });
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupFns.forEach((fn) => fn());
    this._cleanupFns = [];
    if (this._editorView) {
      this._editorView.destroy();
      this._editorView = undefined;
    }
  }
}
```

**Pattern Lessons:**

1. **Deferred initialization:** Wait for `firstUpdated()` to ensure DOM is ready
2. **Compartments for reconfiguration:** Use library-specific patterns for
   dynamic updates
3. **Bidirectional sync:** Editor changes flow to Cells, Cell changes flow to
   editor
4. **Prevent circular updates:** Check if values actually changed before
   updating
5. **Controller abstraction:** Use reactive controllers for common patterns
   (CellController, InputTimingController)
6. **Explicit cleanup:** Destroy library instances and clear subscriptions

**When to use:** Integrating any third-party library (Monaco, Quill,
ProseMirror, D3, etc.) that manages its own DOM and state.

---

### 3. Reactive Controller Pattern

**Philosophy:** Extract reusable component behaviors into reactive controllers
rather than mixins or base classes.

**Common Controllers in Common UI:**

#### InputTimingController

Manages input debouncing/throttling/blur strategies:

```typescript
private inputTiming = new InputTimingController(this, {
  strategy: this.timingStrategy,
  delay: this.timingDelay,
});

private handleInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  this.inputTiming.schedule(() => {
    this.emit("cf-change", { value });
  });
}
```

#### CellController (String/Array)

Manages Cell<T> ↔ value synchronization with timing:

```typescript
private _cellController = createStringCellController(this, {
  timing: { strategy: "debounce", delay: 500 },
  onChange: (newValue, oldValue) => {
    this.emit("cf-change", { value: newValue, oldValue });
  },
});

// Bind to Cell or plain value
this._cellController.bind(this.value);

// Get current value (works with Cell or plain value)
const currentValue = this._cellController.getValue();

// Set value (syncs to Cell if bound)
this._cellController.setValue(newValue);
```

#### MentionController

Manages @-mention autocomplete with Cell<MentionableArray>:

```typescript
private mentionController = new MentionController(this);

// In firstUpdated
this.mentionController.setup({
  mentionableCell: this.mentionable,
  onMentionSelect: (piece) => {
    // Handle mention selection
  },
});
```

**Pattern Lessons:**

1. **Controllers own cleanup:** Implement `hostDisconnected()` for cleanup
2. **Controllers don't render:** They manage state and side effects only
3. **Configuration over inheritance:** Prefer configuring controllers over
   extending base classes
4. **Share controllers across component types:** Same timing logic for
   input/textarea/editor

**When to create a controller:**

- Behavior is reused across multiple components
- Behavior has complex lifecycle management (subscriptions, timers, external
  resources)
- Behavior is independent of rendering

---

### 4. Path-Based Operations Pattern (legacy outliner)

**Philosophy:** For tree structures, use paths (arrays of indices) instead of
direct references to enable operations that work with both immutable state and
Cells.

**Key Insight:** Paths are stable references that survive tree mutations.

```typescript
// Path is array of indices: [0, 2, 1] means root -> first child -> third child -> second child
type NodePath = number[];

// Get node by path
function getNodeByPath(tree: Tree, path: NodePath): Node | null {
  let current: Node = tree.root;
  for (const index of path) {
    if (!current.children || index >= current.children.length) {
      return null;
    }
    current = current.children[index];
  }
  return current;
}

// Get node Cell by path (for mutations)
function getNodeCellByPath(treeCell: Cell<Tree>, path: NodePath): Cell<Node> {
  let current = treeCell.key("root");
  for (const index of path) {
    current = current.key("children").key(index);
  }
  return current;
}

// Operations use paths for stability
class TreeOperations {
  insertChild(treeCell: Cell<Tree>, parentPath: NodePath, index: number): void {
    const parentCell = getNodeCellByPath(treeCell, parentPath);
    const childrenCell = parentCell.key("children");

    mutateCell(childrenCell, (cell) => {
      const children = cell.get() || [];
      children.splice(index, 0, { body: "", children: [] });
      cell.set(children);
    });
  }

  deleteNode(treeCell: Cell<Tree>, path: NodePath): void {
    const parentPath = path.slice(0, -1);
    const index = path[path.length - 1];
    const parentCell = getNodeCellByPath(treeCell, parentPath);

    mutateCell(parentCell.key("children"), (cell) => {
      const children = cell.get() || [];
      children.splice(index, 1);
      cell.set(children);
    });
  }
}
```

**Pattern Lessons:**

1. **Paths over references:** Paths remain valid after mutations, references
   don't
2. **Separate read and write paths:** `getNodeByPath` for reads,
   `getNodeCellByPath` for mutations
3. **Path utilities:** Create helper functions for common path operations
   (parent, siblings, depth)
4. **Diff-based updates:** Calculate diffs between tree versions to minimize DOM
   updates
5. **Event context includes paths:** Keyboard events include current node path
   for operations

**When to use:** Any hierarchical structure (trees, outlines, nested lists) that
supports editing.

---

### 5. Diff-Based Rendering Pattern (legacy outliner)

**Philosophy:** For complex nested structures, calculate minimal diffs to update
only what changed rather than re-rendering everything.

```typescript
class TreeDiffCalculator {
  diff(oldTree: Tree, newTree: Tree): TreeDiff {
    // Calculate minimal set of operations to transform oldTree → newTree
    const operations: Operation[] = [];
    this._diffNodes(oldTree.root, newTree.root, [], operations);
    return { operations };
  }

  private _diffNodes(
    oldNode: Node,
    newNode: Node,
    path: NodePath,
    operations: Operation[],
  ): void {
    // Check if node body changed
    if (oldNode.body !== newNode.body) {
      operations.push({ type: "update", path, body: newNode.body });
    }

    // Diff children arrays
    this._diffChildren(
      oldNode.children || [],
      newNode.children || [],
      path,
      operations,
    );
  }
}

class PathDiffApplier {
  apply(treeCell: Cell<Tree>, diff: TreeDiff): void {
    // Apply minimal operations to Cell tree
    for (const op of diff.operations) {
      switch (op.type) {
        case "update":
          this._updateNode(treeCell, op.path, op.body);
          break;
        case "insert":
          this._insertNode(treeCell, op.path, op.node);
          break;
        case "delete":
          this._deleteNode(treeCell, op.path);
          break;
      }
    }
  }
}
```

**Pattern Lessons:**

1. **Two-phase updates:** Calculate diff, then apply operations
2. **Path-based operations:** All operations reference paths for stability
3. **Minimal updates:** Only touch changed nodes, not entire tree
4. **Preserve focus:** Diff application preserves user focus/selection
5. **Transaction boundaries:** Apply entire diff in single transaction

**When to use:**

- Large nested structures where full re-render is expensive
- Preserving DOM state (focus, selection, scroll position) is important
- Structure changes frequently in response to user input

---

### 6. Progressive Enhancement Pattern

**Philosophy:** Components should work with plain values but enhance when given
Cells for reactivity.

```typescript
@property({ attribute: false })
value: Cell<string> | string;

// Support both Cell and plain value
private getValue(): string {
  return isCell(this.value) ? this.value.get() : this.value;
}

private setValue(newValue: string): void {
  if (isCell(this.value)) {
    mutateCell(this.value, (cell) => cell.set(newValue));
  } else {
    this.value = newValue;
    this.requestUpdate();
  }
}

// Set up subscription only if Cell
override updated(changedProperties: Map<string, any>) {
  if (changedProperties.has("value")) {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }

    if (isCell(this.value)) {
      this._unsubscribe = this.value.sink(() => {
        this.requestUpdate();
      });
    }
  }
}
```

**Pattern Lessons:**

1. **Type unions:** `value: Cell<T> | T` for flexibility
2. **Runtime checks:** Use `isCell()` to determine behavior
3. **Unified interface:** Provide `getValue()`/`setValue()` that work with both
4. **Conditional subscriptions:** Only subscribe to Cells, not plain values
5. **Graceful fallback:** Component works without Cells, just not reactively

---

## Component Complexity Spectrum

Components fall on a spectrum of integration depth:

1. **Pure presentation:** Layout, visual components (no runtime integration)
2. **Themed inputs:** Consume theme, emit events (shallow integration)
3. **Cell-aware:** Support Cell properties, manage subscriptions (medium
   integration)
4. **Runtime-integrated:** Deep Cell manipulation, pattern execution, backlink
   resolution (deep integration)

Choose the simplest pattern that meets requirements. Don't add Cell support just
because you can.
