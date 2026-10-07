export const HARNESS_IMAGE_ATTACHMENT_TYPE = "cf-harness.image-attachment";

export type HarnessImageMediaType =
  | "image/gif"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface HarnessImageAttachment {
  type: typeof HARNESS_IMAGE_ATTACHMENT_TYPE;
  hostPath: string;
  mediaType: HarnessImageMediaType;
  bytes: number;
  digest: string;

  /**
   * Content-addressed copy of the image taken when the attachment was
   * created. When present, materialization reads this snapshot instead of
   * `hostPath`, so the working file may be regenerated mid-run (e.g. an
   * agent iterating on a rendered image it already viewed) without
   * invalidating the attachment. Absent on run-start `--image` inputs,
   * which stay integrity-locked to their source file, and on attachments
   * persisted by older versions.
   */
  snapshotPath?: string;
}

/** Image bytes supplied by a host, with no authority to read a host path. */
export interface HarnessInlineImageAttachment {
  mediaType: HarnessImageMediaType;
  base64: string;
}
