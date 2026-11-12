import { css, html } from "lit";
import { BaseElement } from "../../core/base-element.ts";

// TODO(v2-token-migration): Migrate this component to component-level tokens,
// matching the prior phase-1 token migration pattern.

/**
 * The styles of the table's rows and cells. They are light DOM children of the
 * table, beyond the reach of its shadow styles, so the table adopts a sheet of
 * them into the root it is connected in. Their rules reach the rows and cells beneath
 * the table through any element between them, such as the `display: contents`
 * span a renderer wraps a list of children in, and stop at the content of a
 * cell: nothing within a cell takes them, and a `cf-table` within a cell takes
 * only its own.
 */
const ROW_STYLES = `
  @scope (cf-table) to (:is(th, td) > *) {
    :is(th, td) {
      padding: var(--cf-size-md-padding-v, 8px) var(--cf-size-lg-padding-h, 12px);
      border-bottom: 1px solid var(--border, #e2e8f0);
      text-align: inherit;
      vertical-align: middle;
      white-space: nowrap;
    }

    :scope[size="sm"] :is(th, td) {
      padding: var(--cf-size-sm-padding-v, 4px) var(--cf-size-md-padding-h, 8px);
    }

    :scope[size="lg"] :is(th, td) {
      padding: var(--cf-size-lg-spacing, 12px) var(--cf-size-xl-spacing, 16px);
    }

    th {
      font-weight: var(--cf-font-weight-semibold, 600);
      color: var(--foreground, #0f172a);
      background-color: var(--muted, #f8fafc);
    }

    :scope[sticky-header] thead th {
      position: sticky;
      top: 0;
      z-index: 10;
    }

    :scope[striped] tbody tr:nth-of-type(even) {
      background-color: var(--muted, #f8fafc);
    }

    :scope[hover] tbody tr:hover {
      background-color: var(--muted, #f1f5f9);
    }

    :scope[bordered] :is(th, td) {
      border: 1px solid var(--border, #e2e8f0);
    }

    :scope[bordered] thead tr:last-child :is(th, td) {
      border-bottom-width: 2px;
    }

    caption {
      padding: var(--cf-size-md-padding-v, 8px) var(--cf-size-lg-padding-h, 12px);
      color: var(--muted-foreground, #64748b);
      text-align: left;
    }

    :is(th, td).wrap {
      white-space: normal;
    }

    :is(th, td).text-left {
      text-align: left;
    }
    :is(th, td).text-center {
      text-align: center;
    }
    :is(th, td).text-right {
      text-align: right;
    }

    :is(th, td).align-top {
      vertical-align: top;
    }
    :is(th, td).align-middle {
      vertical-align: middle;
    }
    :is(th, td).align-bottom {
      vertical-align: bottom;
    }
  }
`;

/**
 * The sheet holding {@link ROW_STYLES}, adopted by every root a table is
 * connected in. It is made when a table first connects: this module also
 * loads where there are no stylesheets, as when the package is imported
 * outside a browser.
 */
let rowStyleSheet: CSSStyleSheet | undefined;

/**
 * CFTable - Semantic table component with styling
 *
 * Its row and cell styles are adopted into the document or shadow root holding
 * the table, so they take part in that tree's cascade: a page rule of equal
 * specificity, such as `td { padding: 0 }`, does not override them as it would
 * a component's shadow styles, while an inline style does.
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
 * @slot - Table content: a caption, and rows in a thead, tbody, or tfoot
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

    .table-wrapper {
      width: 100%;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
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

    :host([size="sm"]) table {
      font-size: var(--cf-font-caption-size, 0.75rem);
    }

    :host([size="lg"]) table {
      font-size: var(--cf-font-body-large-size, 1rem);
    }
  `;

  static override properties = {
    striped: { type: Boolean, reflect: true },
    hover: { type: Boolean, reflect: true },
    bordered: { type: Boolean, reflect: true },
    size: { type: String, reflect: true },
    stickyHeader: { type: Boolean, attribute: "sticky-header", reflect: true },
    fullWidth: { type: Boolean, attribute: "full-width", reflect: true },
  };

  declare striped: boolean;
  declare hover: boolean;
  declare bordered: boolean;
  declare size: "sm" | "md" | "lg";
  declare stickyHeader: boolean;
  declare fullWidth: boolean;

  /**
   * The slot for the table's content. The HTML parser moves a `<slot>` that
   * a template writes inside `<table>` out in front of it, so the table takes
   * this element as a child value instead.
   */
  readonly #slot = document.createElement("slot");

  constructor() {
    super();
    this.striped = false;
    this.hover = false;
    this.bordered = false;
    this.size = "md";
    this.stickyHeader = false;
    this.fullWidth = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    const root = this.getRootNode();
    const styled = root instanceof ShadowRoot ? root : this.ownerDocument;
    if (!rowStyleSheet) {
      rowStyleSheet = new CSSStyleSheet();
      rowStyleSheet.replaceSync(ROW_STYLES);
    }
    if (!styled.adoptedStyleSheets.includes(rowStyleSheet)) {
      styled.adoptedStyleSheets = [...styled.adoptedStyleSheets, rowStyleSheet];
    }
  }

  override render() {
    return html`
      <div class="table-wrapper" part="wrapper">
        <table part="table">${this.#slot}</table>
      </div>
    `;
  }
}
