/**
 * Drives File Share through its exported streams with descriptors shaped the
 * way `cf-file-input` reports an upload, so the list logic is covered without
 * a browser or a blob store. Identity is a profile cell claimed through the
 * pattern's `claimViewer` seam, since the `#profile` wish has no resolving
 * environment here.
 *
 * Run: deno task cf test patterns/apps/file-share/main.test.tsx --verbose
 */

import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElementByText,
  hasText,
  propsOf,
} from "../../tools/test-support/vnode-helpers.ts";
import FileShare from "./main.tsx";

export default pattern(() => {
  const tester = Writable.of<{ name?: string; avatar?: string }>({
    name: "Tester",
  });
  const share = FileShare({});

  const action_become_tester = action(() => {
    share.claimViewer.send({ profile: tester, name: "Tester" });
  });

  const action_add_report = action(() => {
    share.addFiles.send({
      detail: {
        files: [{
          id: "fid1:report",
          name: "report.pdf",
          mediaType: "application/pdf",
          size: 2048,
          url: "https://example.test/space/blobs/report.pdf",
        }],
      },
    });
  });

  const action_add_two_photos = action(() => {
    share.addFiles.send({
      detail: {
        files: [{
          id: "fid1:photo-a",
          name: "photo-a.png",
          mediaType: "image/png",
          size: 4096,
          url: "https://example.test/space/blobs/photo-a.png",
        }, {
          id: "fid1:photo-b",
          name: "photo-b.png",
          mediaType: "image/png",
          size: 3 * 1024 * 1024,
          url: "https://example.test/space/blobs/photo-b.png",
        }],
      },
    });
  });

  const action_add_nothing = action(() => {
    share.addFiles.send({ detail: {} });
  });

  // Removal is bound per row rather than exported, so the test fires the
  // first row's button the way a click would.
  const action_remove_first_row = action(() => {
    const button = findElementByText(share[UI], "cf-button", "Remove");
    const onClick = propsOf(button)?.onClick;
    if (typeof onClick === "object" && onClick !== null && "send" in onClick) {
      (onClick as { send: (event: Record<string, never>) => void }).send({});
    }
  });

  const assert_starts_empty = assert(() => share.fileCount === 0);
  const assert_refused_without_profile = assert(() => share.fileCount === 0);
  const assert_holds_report = assert(() =>
    share.files[0]?.name === "report.pdf"
  );
  const assert_report_keeps_url = assert(() =>
    share.files[0]?.url === "https://example.test/space/blobs/report.pdf"
  );
  const assert_report_names_uploader = assert(() =>
    share.files[0]?.uploadedBy?.get()?.name === "Tester"
  );
  const assert_holds_three = assert(() => share.fileCount === 3);
  const assert_name_counts_three = assert(() =>
    share[NAME] === "File Share (3)"
  );
  const assert_renders_megabytes = assert(() => hasText(share[UI], "3.0 MB"));
  const assert_photos_follow_report = assert(() =>
    share.files[1]?.name === "photo-a.png" &&
    share.files[2]?.name === "photo-b.png"
  );
  const assert_still_three = assert(() => share.fileCount === 3);
  const assert_holds_two = assert(() => share.fileCount === 2);
  const assert_photos_remain = assert(() =>
    share.files[0]?.id === "fid1:photo-a" &&
    share.files[1]?.id === "fid1:photo-b"
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_add_report },
      { assertion: assert_refused_without_profile },
      { action: action_become_tester },
      { action: action_add_report },
      { assertion: assert_holds_report },
      { assertion: assert_report_keeps_url },
      { assertion: assert_report_names_uploader },
      { action: action_add_two_photos },
      { assertion: assert_holds_three },
      { assertion: assert_name_counts_three },
      { assertion: assert_renders_megabytes },
      { assertion: assert_photos_follow_report },
      { action: action_add_nothing },
      { assertion: assert_still_three },
      { action: action_remove_first_row },
      { assertion: assert_holds_two },
      { assertion: assert_photos_remain },
    ],
    share,
  };
});
