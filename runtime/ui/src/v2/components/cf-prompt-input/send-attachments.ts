// Pure, DOM/Lit-free helpers for cf-prompt-input's send-time attachment
// handling. They live in their own module so the two data-loss-prevention rules
// — backward-compatible raw-data passthrough, and blocking a send when an
// opted-in upload failed — are unit-testable without standing up the full web
// component.

import type { PromptAttachment } from "./cf-prompt-input.ts";

/** The serializable subset of an attachment emitted on `cf-send`. */
export type SendAttachment = Omit<PromptAttachment, "previewUrl">;

/**
 * Build the `cf-send` view of an attachment.
 *
 * Drops the raw `data` ONLY for a successfully-uploaded blob (a `url` is
 * present): the consumer should reference the blob by `url`, and a non-cloneable
 * `File`/`Blob` left in the event detail is silently dropped when the detail is
 * structured-cloned into a sandboxed handler (the bug that made an uploaded
 * image vanish). For every other attachment — upload disabled, no runtime/space
 * context, string clipboard content — `data` is preserved so existing
 * (default-off) consumers keep receiving the bytes/text unchanged.
 *
 * `previewUrl` is never emitted: it's a local `blob:` URL, useless to a
 * consumer and revoked the moment the composer clears.
 */
export function toSendAttachment(a: PromptAttachment): SendAttachment {
  const view: SendAttachment = {
    id: a.id,
    name: a.name,
    type: a.type,
    url: a.url,
    mediaType: a.mediaType,
    size: a.size,
    uploading: a.uploading,
    error: a.error,
  };
  // Preserve raw bytes/text unless this was an uploaded blob (url present).
  if (a.url === undefined) view.data = a.data;
  return view;
}

/**
 * True when an attachment was meant to be uploaded but has no usable `url` —
 * i.e. upload is opted in, a runtime + space context exist, the data is binary
 * (`File`/`Blob`), and the upload failed or never produced a `url`. Used to
 * block a send so a failed upload can't emit an attachment with neither a usable
 * `url` nor recoverable raw bytes (the upload consumed them).
 *
 * String clipboard content and non-binary data are never "incomplete": they are
 * passed through verbatim by {@link toSendAttachment}.
 */
export function isUploadIncomplete(
  a: PromptAttachment,
  opts: { uploadAttachments: boolean; hasContext: boolean },
): boolean {
  if (!opts.uploadAttachments || !opts.hasContext) return false;
  const isBinary = a.data instanceof File || a.data instanceof Blob;
  if (!isBinary) return false;
  return a.url === undefined;
}

/**
 * True if ANY attachment is a failed/incomplete upload (see
 * {@link isUploadIncomplete}). `_handleSend` consults this AFTER awaiting
 * in-flight uploads and refuses to send (keeping the composer intact) when it
 * holds.
 */
export function hasIncompleteUpload(
  attachments: Iterable<PromptAttachment>,
  opts: { uploadAttachments: boolean; hasContext: boolean },
): boolean {
  for (const a of attachments) {
    if (isUploadIncomplete(a, opts)) return true;
  }
  return false;
}
