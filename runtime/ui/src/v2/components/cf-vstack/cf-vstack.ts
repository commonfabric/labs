import { css, html } from "lit";
import { classMap } from "lit/directives/class-map.js";
import { BaseElement } from "../../core/base-element.ts";
import { layoutSpacingUtilityStyles } from "../../styles/layout-spacing.ts";

/**
 * CFVStack - Vertical stack layout component using flexbox
 *
 * @element cf-vstack
 *
 * @attr {string} gap - Gap between items (0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, xs, sm, md, lg, xl)
 * @attr {string} align - Align items (start, center, end, stretch)
 * @attr {string} justify - Justify content (start, center, end, between, around, evenly)
 * @attr {boolean} reverse - Reverse the direction
 * @attr {string} padding - Padding around the stack (0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, xs, sm, md, lg, xl)
 * @attr {string} px - Horizontal (left/right) padding; same scale as padding
 * @attr {string} py - Vertical (top/bottom) padding; same scale as padding
 * @attr {string} pt - Padding-top; same scale as padding
 * @attr {string} pr - Padding-right; same scale as padding
 * @attr {string} pb - Padding-bottom; same scale as padding
 * @attr {string} pl - Padding-left; same scale as padding
 *
 * Directional padding overrides the uniform `padding` on its side, and the
 * single-side props (pt/pr/pb/pl) override the axis props (px/py) on theirs.
 *
 * @slot - Content to be stacked vertically
 *
 * @example
 * <cf-vstack gap="4" align="center">
 *   <div>Item 1</div>
 *   <div>Item 2</div>
 * </cf-vstack>
 */
export class CFVStack extends BaseElement {
  static override styles = [
    layoutSpacingUtilityStyles,
    css`
      :host {
        display: block;
      }

      .stack {
        display: flex;
        flex-direction: column;
        box-sizing: border-box;
        height: 100%;
        width: 100%;
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

      /* Reverse */
      .reverse {
        flex-direction: column-reverse;
      }

      /* Direct children styling */
      ::slotted(*) {
        flex-shrink: 0;
      }
    `,
  ];

  static override properties = {
    gap: { type: String },
    align: { type: String },
    justify: { type: String },
    reverse: { type: Boolean },
    padding: { type: String },
    px: { type: String },
    py: { type: String },
    pt: { type: String },
    pr: { type: String },
    pb: { type: String },
    pl: { type: String },
  };

  declare gap: string;
  declare align: string;
  declare justify: string;
  declare reverse: boolean;
  declare padding: string;
  declare px: string;
  declare py: string;
  declare pt: string;
  declare pr: string;
  declare pb: string;
  declare pl: string;

  constructor() {
    super();
    this.gap = "0";
    this.align = "stretch";
    this.justify = "start";
    this.reverse = false;
    this.padding = "0";
    this.px = "";
    this.py = "";
    this.pt = "";
    this.pr = "";
    this.pb = "";
    this.pl = "";
  }

  override render() {
    const classes = {
      stack: true,
      [`gap-${this.gap}`]: true,
      [`align-${this.align}`]: true,
      [`justify-${this.justify}`]: true,
      [`p-${this.padding}`]: true,
      [`px-${this.px}`]: !!this.px,
      [`py-${this.py}`]: !!this.py,
      [`pt-${this.pt}`]: !!this.pt,
      [`pr-${this.pr}`]: !!this.pr,
      [`pb-${this.pb}`]: !!this.pb,
      [`pl-${this.pl}`]: !!this.pl,
      reverse: this.reverse,
    };

    return html`
      <div class="${classMap(classes)}" part="stack">
        <slot></slot>
      </div>
    `;
  }
}
