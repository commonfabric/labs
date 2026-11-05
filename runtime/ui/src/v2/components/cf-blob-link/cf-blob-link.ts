import { consume } from "@lit/context";
import { css, html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import type { RuntimeClient } from "@commonfabric/runtime-client";

import { BaseElement } from "../../core/base-element.ts";
import { runtimeContext } from "../../runtime-context.ts";
import { type BlobReference, BlobUrlResolver } from "../../utils/blob-url.ts";

/**
 * CFBlobLink - A link that downloads a blob from a space's blob store.
 *
 * `blob` names the blob, by its space's DID and its id there, as a FabriFile
 * entry holds them. The component asks the runtime for the URL that space's
 * host serves the blob at for saving, and renders its content as a link to it,
 * which saves the file under `name` from any origin. A pattern offers a stored
 * file this way without forming a URL itself. Until the URL arrives, and for a
 * reference that names no blob, the content is shown as plain text.
 *
 * @element cf-blob-link
 *
 * @property {object} blob - The blob, as `{ space, id }`
 * @attr {string} name - The name to save the file under
 * @slot - The link's content
 */
export class CFBlobLink extends BaseElement {
  static override styles = [
    BaseElement.baseStyles,
    css`
      :host {
        display: inline;
      }

      a {
        color: inherit;
      }
    `,
  ];

  /** The blob to link to, by its space and its id. */
  @property({ attribute: false })
  accessor blob: BlobReference | undefined = undefined;

  /** The name the file is saved under. */
  @property({ type: String })
  accessor name = "";

  /** The runtime that resolves `blob` to a URL. */
  @consume({ context: runtimeContext, subscribe: true })
  @property({ attribute: false })
  accessor runtime: RuntimeClient | undefined = undefined;

  #url = new BlobUrlResolver(this, { download: true });

  override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);
    if (changedProperties.has("blob") || changedProperties.has("runtime")) {
      this.#url.resolve(this.runtime, this.blob);
    }
  }

  override render() {
    const url = this.#url.url;
    return url === null ? html`<slot></slot>` : html`
      <a href="${url}" download="${this.name}"><slot></slot></a>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cf-blob-link": CFBlobLink;
  }
}
