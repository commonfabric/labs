/**
 * CFFragment - A transparent wrapper element with display:contents
 *
 * This element behaves like a React Fragment - it doesn't introduce
 * any layout boxes in the DOM tree. Children are rendered as if they
 * were direct children of the fragment's parent.
 *
 * @element cf-fragment
 *
 * @slot - Default slot for fragment content
 *
 * @example
 * <cf-fragment>
 *   <cf-button>Button 1</cf-button>
 *   <cf-button>Button 2</cf-button>
 * </cf-fragment>
 */
export class CFFragment extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" })
      // Add a slot to display the children
      .appendChild(document.createElement("slot"));
  }

  /** Tells the engine to ignore this element for layout purposes. */
  connectedCallback() {
    this.style.display = "contents";
  }
}
