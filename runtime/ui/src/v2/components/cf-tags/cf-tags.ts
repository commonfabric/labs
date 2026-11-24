import { css, html, unsafeCSS } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { BaseElement } from "../../core/base-element.ts";
import { pillGeometryCSS } from "../../styles/variables.ts";

/**
 * CFTags - A tags component that renders tags as pills with add/remove functionality
 *
 * @element cf-tags
 *
 * @attr {Array<string>} tags - Array of tag strings
 * @attr {boolean} readonly - Whether the tags are read-only
 *
 * @fires cf-change - Fired when tags change with detail: { tags }
 *
 * @example
 * <cf-tags .tags="${['tag1', 'tag2']}" @cf-change="${handleTagsChange}"></cf-tags>
 */
export class CFTags extends BaseElement {
  static override properties = {
    tags: { type: Array },
    readonly: { type: Boolean },
    editingIndex: { type: Number, state: true },
    originalTagValue: { type: String, state: true },
    newTagValue: { type: String, state: true },
    showingNewInput: { type: Boolean, state: true },
  };

  declare tags: string[];
  declare readonly: boolean;
  declare editingIndex: number | null;
  declare originalTagValue: string;
  declare newTagValue: string;
  declare showingNewInput: boolean;

  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        ${unsafeCSS(pillGeometryCSS)};
        display: block;
        width: 100%;

        --cf-tags-gap: var(--cf-pill-sm-gap, var(--cf-size-sm-spacing, 4px));
        --cf-tag-min-height: var(
          --cf-pill-sm-min-height,
          var(--cf-size-sm-height, 24px)
        );
        --cf-tag-padding-h: var(--cf-pill-sm-padding-h, 10px);
        --cf-tag-padding-v: var(--cf-pill-sm-padding-v, 2px);
        --cf-tag-border-radius: var(
          --cf-pill-border-radius,
          var(--cf-border-radius-full, 9999px)
        );
        --cf-tag-font-size: var(
          --cf-pill-sm-font-size,
          var(--cf-size-sm-font-size, 11px)
        );
        --cf-tag-line-height: var(
          --cf-pill-sm-line-height,
          var(--cf-size-sm-line-height, 16px)
        );
        --cf-tag-background: var(
          --cf-theme-color-surface,
          var(--cf-colors-gray-100, #f2f3f6)
        );
        --cf-tag-border-color: var(
          --cf-theme-color-border,
          var(--cf-colors-gray-300, #d5d7dd)
        );
        --cf-tag-color: var(
          --cf-theme-color-text,
          var(--cf-colors-gray-900, #16181d)
        );
        --cf-tag-hover-background: color-mix(
          in srgb,
          var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa)) 12%,
          var(--cf-tag-background)
        );
        --cf-tag-hover-border-color: color-mix(
          in srgb,
          var(--cf-theme-color-primary, var(--cf-colors-primary-500, #4979fa)) 28%,
          var(--cf-tag-border-color)
        );
        --cf-tag-add-color: var(
          --cf-theme-color-text-muted,
          var(--cf-colors-gray-500, #94979e)
        );
        --cf-tag-ring: var(
          --cf-theme-color-primary,
          var(--cf-colors-primary-500, #4979fa)
        );
      }

      .tags-container {
        display: flex;
        flex-wrap: wrap;
        gap: var(--cf-tags-gap);
        align-items: center;
        min-height: var(--cf-tag-min-height);
      }

      .tag {
        display: inline-flex;
        align-items: center;
        gap: var(--cf-tags-gap);
        min-height: var(--cf-tag-min-height);
        padding: var(--cf-tag-padding-v) var(--cf-tag-padding-h);
        background: var(--cf-tag-background);
        border: 1px solid var(--cf-tag-border-color);
        border-radius: var(--cf-tag-border-radius);
        font-size: var(--cf-tag-font-size);
        line-height: var(--cf-tag-line-height);
        color: var(--cf-tag-color);
        transition:
          background-color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease),
          border-color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease);
        user-select: none;
      }

      .tag:hover {
        background-color: var(--cf-tag-hover-background);
        border-color: var(--cf-tag-hover-border-color);
      }

      .tag.editing {
        background-color: var(--cf-theme-color-background, #ffffff);
        border-color: var(--cf-tag-ring);
        outline: 2px solid var(--cf-tag-ring);
        outline-offset: -2px;
      }

      .tag-text {
        flex: 1;
        min-width: 0;
      }

      .tag-edit {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        min-width: 0;
        color: inherit;
        font: inherit;
        line-height: inherit;
        cursor: pointer;
      }

      .tag:has(.tag-edit:focus-visible) {
        outline: 2px solid var(--cf-tag-ring);
        outline-offset: 2px;
      }

      .tag-input {
        background: transparent;
        border: none;
        outline: none;
        font: inherit;
        color: inherit;
        min-width: 3rem;
        width: 100%;
      }

      .tag-remove {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--cf-size-sm-icon-sm, 10px);
        height: var(--cf-size-sm-icon-sm, 10px);
        border-radius: var(--cf-border-radius-full, 9999px);
        color: currentColor;
        cursor: pointer;
        line-height: 1;
        opacity: 0.58;
        transition:
          opacity var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease),
          background-color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease);
      }

      .tag-remove:hover {
        opacity: 1;
        background-color: color-mix(in srgb, currentColor 12%, transparent);
      }

      .tag-remove:focus-visible {
        outline: 2px solid var(--cf-tag-ring);
        outline-offset: 2px;
      }

      .add-tag {
        display: inline-flex;
        align-items: center;
        gap: var(--cf-tags-gap);
        min-height: var(--cf-tag-min-height);
        padding: var(--cf-tag-padding-v) var(--cf-tag-padding-h);
        background-color: transparent;
        border: 1px dashed var(--cf-tag-border-color);
        border-radius: var(--cf-tag-border-radius);
        font-size: var(--cf-tag-font-size);
        font-family: inherit;
        line-height: var(--cf-tag-line-height);
        color: var(--cf-tag-add-color);
        cursor: pointer;
        transition:
          background-color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease),
          border-color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease),
          color var(--cf-transition-duration-fast, 150ms)
          var(--cf-transition-timing-ease, ease);
        min-width: 4rem;
      }

      .add-tag:hover {
        border-color: var(--cf-tag-ring);
        color: var(--cf-tag-ring);
        background-color: var(--cf-tag-hover-background);
      }

      .add-tag:focus-visible {
        outline: 2px solid var(--cf-tag-ring);
        outline-offset: 2px;
      }

      .add-tag.active {
        border-color: var(--cf-tag-ring);
        background-color: var(--cf-theme-color-background, #ffffff);
        outline: 2px solid var(--cf-tag-ring);
        outline-offset: -2px;
      }

      .add-tag-input {
        background: transparent;
        border: none;
        outline: none;
        font: inherit;
        color: var(--cf-tag-color);
        min-width: 3rem;
        flex: 1;
      }

      .add-tag-input::placeholder {
        color: var(--cf-tag-add-color);
      }

      .placeholder {
        color: var(--cf-tag-add-color);
        font-style: italic;
        padding: var(--cf-tag-padding-v) var(--cf-tag-padding-h);
      }
    `,
  ];

  constructor() {
    super();
    this.tags = [];
    this.readonly = false;
    this.editingIndex = null;
    this.originalTagValue = "";
    this.newTagValue = "";
    this.showingNewInput = false;
  }

  private handleTagClick(index: number, event: MouseEvent) {
    if (this.readonly) return;

    event.preventDefault();
    this.editingIndex = index;
    this.originalTagValue = this.tags[index]; // Store original value
    this.requestUpdate();

    // Focus the input after render
    setTimeout(() => {
      const input = this.shadowRoot?.querySelector(
        `#tag-input-${index}`,
      ) as HTMLInputElement;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }

  private handleTagRemove(index: number, event: MouseEvent) {
    if (this.readonly) return;

    event.stopPropagation();
    const newTags = [...this.tags];
    newTags.splice(index, 1);
    this.tags = newTags;
    this.emit("cf-change", { tags: this.tags });
  }

  private handleTagInput(index: number, event: Event) {
    // Update the tag value as user types
    const input = event.target as HTMLInputElement;
    const newTags = [...this.tags];
    newTags[index] = input.value;
    this.tags = newTags;
  }

  private handleTagKeyDown(index: number, event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.finishEditingTag(index);
    } else if (event.key === "Escape") {
      event.preventDefault();
      // Restore original value
      const newTags = [...this.tags];
      newTags[index] = this.originalTagValue;
      this.tags = newTags;
      this.editingIndex = null;
      this.requestUpdate();
    } else if (event.key === "Backspace") {
      // Check if the input is empty
      const input = event.target as HTMLInputElement;
      if (input.value === "") {
        event.preventDefault();
        this.handleTagRemove(index, new MouseEvent("click"));
      }
    }
  }

  private handleTagBlur(index: number) {
    this.finishEditingTag(index);
  }

  private finishEditingTag(index: number) {
    const tag = this.tags[index]?.trim();
    if (!tag) {
      // Remove empty tag
      this.handleTagRemove(index, new MouseEvent("click"));
    } else {
      // Update tag and emit change
      const newTags = [...this.tags];
      newTags[index] = tag;
      this.tags = newTags;
      this.emit("cf-change", { tags: this.tags });
    }

    this.editingIndex = null;
    this.requestUpdate();
  }

  private handleAddTagClick() {
    if (this.readonly) return;

    this.showingNewInput = true;
    this.newTagValue = "";
    this.requestUpdate();

    setTimeout(() => {
      const input = this.shadowRoot?.querySelector(
        "#new-tag-input",
      ) as HTMLInputElement;
      if (input) {
        input.focus();
      }
    }, 0);
  }

  private handleNewTagInput(event: Event) {
    this.newTagValue = (event.target as HTMLInputElement).value;
  }

  private handleNewTagKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      this.addNewTag();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.cancelNewTag();
    }
  }

  private handleNewTagBlur() {
    if (this.newTagValue.trim()) {
      this.addNewTag();
    } else {
      this.cancelNewTag();
    }
  }

  private addNewTag() {
    const tag = this.newTagValue.trim();
    if (tag && !this.tags.includes(tag)) {
      this.tags = [...this.tags, tag];
      this.emit("cf-change", { tags: this.tags });
    }
    this.cancelNewTag();
  }

  private cancelNewTag() {
    this.showingNewInput = false;
    this.newTagValue = "";
    this.requestUpdate();
  }

  override render() {
    return html`
      <div class="tags-container">
        ${(!Array.isArray(this.tags) || this.tags.length === 0) &&
            !this.showingNewInput
          ? html`
            <span class="placeholder">No tags</span>
          `
          : ""} ${repeat(
            this.tags ?? [],
            (_, index) => index,
            (tag, index) => this.renderTag(tag, index),
          )} ${!this.readonly ? this.renderAddTag() : ""}
      </div>
    `;
  }

  private renderTag(tag: string, index: number) {
    const isEditing = this.editingIndex === index;

    return html`
      <div class="tag ${isEditing ? "editing" : ""}">
        ${isEditing
          ? html`
            <input
              id="tag-input-${index}"
              class="tag-input"
              .value="${tag}"
              @input="${(e: Event) => this.handleTagInput(index, e)}"
              @keydown="${(e: KeyboardEvent) =>
                this.handleTagKeyDown(index, e)}"
              @blur="${() => this.handleTagBlur(index)}"
            />
          `
          : html`
            ${this.readonly
              ? html`
                <span class="tag-text">${tag}</span>
              `
              : html`
                <button
                  type="button"
                  class="tag-edit"
                  aria-label="Edit ${tag}"
                  @click="${(e: MouseEvent) => this.handleTagClick(index, e)}"
                >
                  <span class="tag-text">${tag}</span>
                </button>
              `} ${!this.readonly
              ? html`
                <button
                  type="button"
                  class="tag-remove"
                  @click="${(e: MouseEvent) => this.handleTagRemove(index, e)}"
                  title="Remove tag"
                  aria-label="Remove ${tag}"
                >
                  ×
                </button>
              `
              : ""}
          `}
      </div>
    `;
  }

  private renderAddTag() {
    return this.showingNewInput
      ? html`
        <div class="add-tag active">
          <input
            id="new-tag-input"
            class="add-tag-input"
            placeholder="New tag"
            .value="${this.newTagValue}"
            @input="${this.handleNewTagInput}"
            @keydown="${this.handleNewTagKeyDown}"
            @blur="${this.handleNewTagBlur}"
          />
        </div>
      `
      : html`
        <button
          type="button"
          class="add-tag"
          @click="${this.handleAddTagClick}"
        >
          + Add tag
        </button>
      `;
  }
}
