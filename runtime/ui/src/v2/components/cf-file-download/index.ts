import { CFFileDownload } from "./cf-file-download.ts";

if (!customElements.get("cf-file-download")) {
  customElements.define("cf-file-download", CFFileDownload);
}

export type { CFFileDownload as CFFileDownloadElement } from "./cf-file-download.ts";

export { CFFileDownload };
