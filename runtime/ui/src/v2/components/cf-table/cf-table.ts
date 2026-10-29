import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * CFTable - Semantic table component with styling
 *
 * @element cf-table
 *
 * @attr {boolean} striped - Alternate row coloring
 * @attr {boolean} hover - Hover effect on rows
 * @attr {boolean} bordered - Add borders to all cells
 * @attr {string} size - Table size (sm, md, lg)
 * @attr {boolean} sticky-header - Make header sticky
 * @attr {boolean} full-width - Make table full width
 *
 * @slot - Table content (thead, tbody, tfoot)
 *
 * @fires cf-table-sort - Fired when table is sorted with detail: { columnIndex, ascending }
 *
 * @example
 * <cf-table striped hover>
 *   <thead>
 *     <tr>
 *       <th>Name</th>
 *       <th>Email</th>
 *     </tr>
 *   </thead>
 *   <tbody>
 *     <tr>
 *       <td>John Doe</td>
 *       <td>john@example.com</td>
 *     </tr>
 *   </tbody>
 * </cf-table>
 */
export class CFTable extends BaseElement {
  static override styles = css`
    :host {
      display: block;
      overflow: auto;
    }

    table {
      border-collapse: collapse;
      caption-side: bottom;
      text-align: left;
      font-size: var(--cf-font-body-size, 0.875rem);
      width: auto;
    }

    :host([full-width]) table {
      width: 100%;
    }

    /* Size variants */
    :host([size="sm"]) table {
      font-size: var(--cf-font-caption-size, 0.75rem);
    }

    :host([size="sm"]) ::slotted(th),
    :host([size="sm"]) ::slotted(td) {
      padding: var(--cf-size-sm-padding-v, 4px) var(--cf-size-md-padding-h, 8px);
    }

    :host([size="md"]) ::slotted(th),
    :host([size="md"]) ::slotted(td) {
      padding: var(--cf-size-md-padding-v, 8px) var(--cf-size-lg-padding-h, 12px);
    }

    :host([size="lg"]) table {
      font-size: var(--cf-font-body-large-size, 1rem);
    }

    :host([size="lg"]) ::slotted(th),
    :host([size="lg"]) ::slotted(td) {
      padding: var(--cf-size-lg-spacing, 12px) var(--cf-size-xl-spacing, 16px);
    }

    /* Base cell styles */
    ::slotted(th),
    ::slotted(td) {
      border-bottom: 1px solid var(--border, #e2e8f0);
      text-align: inherit;
      vertical-align: middle;
    }

    ::slotted(th) {
      font-weight: var(--cf-font-weight-semibold, 600);
      color: var(--foreground, #0f172a);
      background-color: var(--muted, #f8fafc);
    }

    /* Sticky header */
    :host([sticky-header]) ::slotted(thead) ::slotted(th) {
      position: sticky;
      top: 0;
      z-index: 10;
      background-color: var(--muted, #f8fafc);
    }

    /* Striped rows */
    :host([striped]) ::slotted(tbody) ::slotted(tr:nth-of-type(even)) {
      background-color: var(--muted, #f8fafc);
    }

    /* Hover effect */
    :host([hover]) ::slotted(tbody) ::slotted(tr:hover) {
      background-color: var(--muted, #f1f5f9);
    }

    /* Bordered variant */
    :host([bordered]) ::slotted(th),
    :host([bordered]) ::slotted(td) {
      border: 1px solid var(--border, #e2e8f0);
    }

    /* Remove double borders */
    :host([bordered]) ::slotted(thead) ::slotted(tr:last-child) ::slotted(th),
    :host([bordered]) ::slotted(thead) ::slotted(tr:last-child) ::slotted(td) {
      border-bottom-width: 2px;
    }

    /* Caption styling */
    ::slotted(caption) {
      padding: var(--cf-size-md-padding-v, 8px) var(--cf-size-lg-padding-h, 12px);
      color: var(--muted-foreground, #64748b);
      text-align: left;
    }

    /* Responsive wrapper for overflow */
    .table-wrapper {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }

    /* Ensure minimum width for cells */
    ::slotted(th),
    ::slotted(td) {
      white-space: nowrap;
    }

    /* Allow wrapping for specific cells if needed */
    ::slotted(th.wrap),
    ::slotted(td.wrap) {
      white-space: normal;
    }

    /* Alignment utilities */
    ::slotted(.text-left) {
      text-align: left;
    }
    ::slotted(.text-center) {
      text-align: center;
    }
    ::slotted(.text-right) {
      text-align: right;
    }

    /* Vertical alignment */
    ::slotted(.align-top) {
      vertical-align: top;
    }
    ::slotted(.align-middle) {
      vertical-align: middle;
    }
    ::slotted(.align-bottom) {
      vertical-align: bottom;
    }
  `;

  static override properties = {
    striped: { type: Boolean },
    hover: { type: Boolean },
    bordered: { type: Boolean },
    size: { type: String },
    stickyHeader: { type: Boolean, attribute: "sticky-header" },
    fullWidth: { type: Boolean, attribute: "full-width" },
  };

  declare striped: boolean;
  declare hover: boolean;
  declare bordered: boolean;
  declare size: "sm" | "md" | "lg";
  declare stickyHeader: boolean;
  declare fullWidth: boolean;

  constructor() {
    super();
    this.striped = false;
    this.hover = false;
    this.bordered = false;
    this.size = "md";
    this.stickyHeader = false;
    this.fullWidth = false;
  }

  override render() {
    return html`
      <div class="table-wrapper" part="wrapper">
        <table part="table">
          <slot></slot>
        </table>
      </div>
    `;
  }

  /**
   * Get all table rows
   */
  getRows(): HTMLTableRowElement[] {
    return Array.from(this.querySelectorAll("tbody tr"));
  }

  /**
   * Get table headers
   */
  getHeaders(): HTMLTableCellElement[] {
    return Array.from(this.querySelectorAll("thead th"));
  }

  /**
   * Sort table by column index
   */
  sortByColumn(columnIndex: number, ascending: boolean = true) {
    const tbody = this.querySelector("tbody");
    if (!tbody) return;

    const rows = this.getRows();
    const sortedRows = rows.sort((a, b) => {
      const aCell = a.cells[columnIndex]?.textContent || "";
      const bCell = b.cells[columnIndex]?.textContent || "";

      // Try to parse as numbers first
      const aNum = parseFloat(aCell);
      const bNum = parseFloat(bCell);

      if (!isNaN(aNum) && !isNaN(bNum)) {
        return ascending ? aNum - bNum : bNum - aNum;
      }

      // Otherwise sort as strings
      return ascending
        ? aCell.localeCompare(bCell)
        : bCell.localeCompare(aCell);
    });

    // Reorder rows in DOM
    sortedRows.forEach((row) => tbody.appendChild(row));

    // Emit sort event
    this.emit("cf-table-sort", {
      columnIndex,
      ascending,
    });
  }
}
