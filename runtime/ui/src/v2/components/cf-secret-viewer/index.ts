import { CFSecretViewer } from "./cf-secret-viewer.ts";

if (!customElements.get("cf-secret-viewer")) {
  customElements.define("cf-secret-viewer", CFSecretViewer);
}

export type { CFSecretViewer as CFSecretViewerElement } from "./cf-secret-viewer.ts";

export { CFSecretViewer };
