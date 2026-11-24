import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { layoutSpacingUtilityStyles } from "../../styles/layout-spacing.ts";

/**
 * CFVGroup - Vertical group component with automatic gap management
 *
 * @element cf-vgroup
 *
 * @attr {string} gap - Gap between items using the shared spacing scale
 * @attr {string} align - Align items (start, center, end, stretch)
 * @attr {string} justify - Justify content (start, center, end, between, around, evenly)
 *
 * @slot - Content to be grouped vertically
 *
 * @example
 * <cf-vgroup gap="1">
 *   <cf-label>Name</cf-label>
 *   <cf-input placeholder="Enter your name" />
 * </cf-vgroup>
 */
export class CFVGroup extends BaseElement {
  static override styles = [
    layoutSpacingUtilityStyles,
    css`
      :host {
        display: block;
      }

      .group {
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
      }

      /* Alignment */
      .align-start {
        align-items: flex-start;
      }
      .align-center {
        align-items: center;
      }
      .align-end {
        align-items: flex-end;
      }
      .align-stretch {
        align-items: stretch;
      }

      /* Justification */
      .justify-start {
        justify-content: flex-start;
      }
      .justify-center {
        justify-content: center;
      }
      .justify-end {
        justify-content: flex-end;
      }
      .justify-between {
        justify-content: space-between;
      }
      .justify-around {
        justify-content: space-around;
      }
      .justify-evenly {
        justify-content: space-evenly;
      }

      /* Direct children - preserve sizing */
      ::slotted(*) {
        flex-shrink: 0;
      }
    `,
  ];

  static override properties = {
    gap: { type: String },
    align: { type: String },
    justify: { type: String },
  };

  declare gap: string;
  declare align: string;
  declare justify: string;

  constructor() {
    super();
    this.gap = "md";
    this.align = "stretch";
    this.justify = "start";
  }

  override render() {
    const classes = {
      group: true,
      [`gap-${this.gap}`]: true,
      [`align-${this.align}`]: true,
      [`justify-${this.justify}`]: true,
    };

    return html`
      <div class="${classMap(classes)}" part="group">
        <slot></slot>
      </div>
    `;
  }
}
