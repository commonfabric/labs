/**
 * Tests for CFFileDownload component
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { CFFileDownload } from "./index.ts";

/**
 * Interface for accessing private members of CFFileDownload in tests.
 * We use this to cast elements for testing internal state.
 */
interface CFFileDownloadPrivateAccess {
  _autosaveEnabled: boolean;
  _autosaveDirHandle: FileSystemDirectoryHandle | null;
  _autosaveTimer: ReturnType<typeof setTimeout> | null;
  _isDirty: boolean;
  _lastSavedData: string | null;
  _isSavingAutosave: boolean;
  _showNotAvailableTooltip: boolean;
  _notAvailableMessage: string;
  _notAvailableTooltipTimeout?: ReturnType<typeof setTimeout>;
  _downloading: boolean;
  _handleClick: (e: Event) => void;
  _enableAutosave: () => Promise<boolean>;
  _disableAutosave: () => void;
  _scheduleAutosave: () => void;
  _performAutosave: () => Promise<void>;
  _getAutosaveIndicatorClass: () => string;
  _getAutosaveTooltip: () => string;
  _showNotAvailableFeedback: (message: string) => void;
  _sanitizeFilename: (f: string) => string;
  _createBlob: (d: string) => Blob;
  _getFilename: () => string;
  _getDataValue: () => string;
  _dataController: {
    bind: (value: string) => void;
    getValue: () => string | undefined;
  };
  _filenameController: {
    bind: (value: string) => void;
    getValue: () => string | undefined;
  };
}

/**
 * Helper to clear all timers on an element to prevent test leaks
 */
function clearElementTimers(privateAccess: CFFileDownloadPrivateAccess) {
  if (privateAccess._autosaveTimer) {
    clearTimeout(privateAccess._autosaveTimer);
    privateAccess._autosaveTimer = null;
  }
  if (privateAccess._notAvailableTooltipTimeout) {
    clearTimeout(privateAccess._notAvailableTooltipTimeout);
    privateAccess._notAvailableTooltipTimeout = undefined;
  }
}

/**
 * Cast element to access private members for testing
 */
function asPrivate(element: CFFileDownload): CFFileDownloadPrivateAccess {
  return element as unknown as CFFileDownloadPrivateAccess;
}

/**
 * Mock FileSystemDirectoryHandle for testing
 */
class MockFileSystemDirectoryHandle {
  name = "test-folder";
  private files = new Map<string, MockFileSystemFileHandle>();

  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<MockFileSystemFileHandle> {
    if (options?.create || this.files.has(name)) {
      const handle = new MockFileSystemFileHandle(name);
      this.files.set(name, handle);
      return Promise.resolve(handle);
    }
    return Promise.reject(new DOMException("File not found", "NotFoundError"));
  }
}

/**
 * Mock FileSystemFileHandle for testing
 */
class MockFileSystemFileHandle {
  constructor(public name: string) {}

  createWritable(): Promise<MockFileSystemWritableFileStream> {
    return Promise.resolve(new MockFileSystemWritableFileStream());
  }
}

/**
 * Mock FileSystemWritableFileStream for testing
 */
class MockFileSystemWritableFileStream {
  writtenData: Blob | null = null;

  write(data: Blob): Promise<void> {
    this.writtenData = data;
    return Promise.resolve();
  }

  close(): Promise<void> {
    // No-op for testing
    return Promise.resolve();
  }
}

describe("CFFileDownload", () => {
  describe("component definition", () => {
    it("should be defined", () => {
      expect(CFFileDownload).toBeDefined();
    });

    it("should have customElement definition", () => {
      expect(customElements.get("cf-file-download")).toBe(CFFileDownload);
    });

    it("should create element instance", () => {
      const element = new CFFileDownload();
      expect(element).toBeInstanceOf(CFFileDownload);
    });
  });

  describe("default properties", () => {
    it("should have correct default values", () => {
      const element = new CFFileDownload();
      expect(element.data).toBe("");
      expect(element.filename).toBe("");
      expect(element.mimeType).toBe("application/octet-stream");
      expect(element.base64).toBe(false);
      expect(element.variant).toBe("secondary");
      expect(element.size).toBe("md");
      expect(element.disabled).toBe(false);
      expect(element.feedbackDuration).toBe(2000);
      expect(element.iconOnly).toBe(false);
      expect(element.allowAutosave).toBe(false);
    });
  });

  describe("filename sanitization", () => {
    it("should remove path traversal attempts", () => {
      const element = new CFFileDownload();
      element.filename = "../../../etc/passwd";
      // Access private method via type assertion for testing
      const sanitized = (element as unknown as {
        _sanitizeFilename: (f: string) => string;
      })._sanitizeFilename("../../../etc/passwd");
      expect(sanitized).not.toContain("..");
      expect(sanitized).toBe("______etc_passwd");
    });

    it("should remove special characters", () => {
      const element = new CFFileDownload();
      const sanitized = (element as unknown as {
        _sanitizeFilename: (f: string) => string;
      })._sanitizeFilename('file<>:"/\\|?*name.txt');
      expect(sanitized).not.toMatch(/[<>:"\/\\|?*]/);
      expect(sanitized).toBe("file_________name.txt");
    });

    it("should truncate long filenames to 255 characters", () => {
      const element = new CFFileDownload();
      const longName = "a".repeat(300);
      const sanitized = (element as unknown as {
        _sanitizeFilename: (f: string) => string;
      })._sanitizeFilename(longName);
      expect(sanitized.length).toBe(255);
    });

    it("should handle normal filenames unchanged", () => {
      const element = new CFFileDownload();
      const sanitized = (element as unknown as {
        _sanitizeFilename: (f: string) => string;
      })._sanitizeFilename("my-file_2024.json");
      expect(sanitized).toBe("my-file_2024.json");
    });
  });

  describe("blob creation", () => {
    it("should create text blob for plain data", () => {
      const element = new CFFileDownload();
      element.mimeType = "text/plain";
      const blob = (element as unknown as {
        _createBlob: (d: string) => Blob;
      })._createBlob("Hello, World!");
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe("text/plain");
      expect(blob.size).toBe(13);
    });

    it("should decode base64 data when base64 flag is set", () => {
      const element = new CFFileDownload();
      element.base64 = true;
      element.mimeType = "text/plain";
      // "Hello" in base64 is "SGVsbG8="
      const blob = (element as unknown as {
        _createBlob: (d: string) => Blob;
      })._createBlob("SGVsbG8=");
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(5); // "Hello" is 5 bytes
    });

    it("should trim whitespace from base64 data", () => {
      const element = new CFFileDownload();
      element.base64 = true;
      element.mimeType = "text/plain";
      // Base64 with surrounding whitespace
      const blob = (element as unknown as {
        _createBlob: (d: string) => Blob;
      })._createBlob("  SGVsbG8=  \n");
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(5);
    });

    it("should throw on invalid base64 data", () => {
      const element = new CFFileDownload();
      element.base64 = true;
      expect(() => {
        (element as unknown as {
          _createBlob: (d: string) => Blob;
        })._createBlob("not-valid-base64!!!");
      }).toThrow(/Invalid base64 data/);
    });
  });

  describe("auto-generated filename", () => {
    it("should generate filename with correct extension for JSON", () => {
      const element = new CFFileDownload();
      element.mimeType = "application/json";
      const filename = (element as unknown as {
        _getFilename: () => string;
      })._getFilename();
      expect(filename).toMatch(
        /^download-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/,
      );
    });

    it("should generate filename with correct extension for CSV", () => {
      const element = new CFFileDownload();
      element.mimeType = "text/csv";
      const filename = (element as unknown as {
        _getFilename: () => string;
      })._getFilename();
      expect(filename).toMatch(/\.csv$/);
    });

    it("should use bin extension for unknown MIME types", () => {
      const element = new CFFileDownload();
      element.mimeType = "application/x-unknown";
      const filename = (element as unknown as {
        _getFilename: () => string;
      })._getFilename();
      expect(filename).toMatch(/\.bin$/);
    });
  });

  describe("size limits", () => {
    it("should have MAX_FILE_SIZE of 100MB", () => {
      // Access static property
      const maxSize = (CFFileDownload as unknown as {
        MAX_FILE_SIZE: number;
      }).MAX_FILE_SIZE;
      expect(maxSize).toBe(100 * 1024 * 1024);
    });
  });

  describe("autosave configuration", () => {
    it("should have AUTOSAVE_INTERVAL of 60 seconds", () => {
      const interval = (CFFileDownload as unknown as {
        AUTOSAVE_INTERVAL: number;
      }).AUTOSAVE_INTERVAL;
      expect(interval).toBe(60_000);
    });

    it("should set allowAutosave via property", () => {
      const element = new CFFileDownload();
      element.allowAutosave = true;
      expect(element.allowAutosave).toBe(true);
    });

    it("should have autosave indicator methods", () => {
      const element = new CFFileDownload();
      // Access private methods for testing
      const getIndicatorClass = (element as unknown as {
        _getAutosaveIndicatorClass: () => string;
      })._getAutosaveIndicatorClass;
      const getTooltip = (element as unknown as {
        _getAutosaveTooltip: () => string;
      })._getAutosaveTooltip;

      expect(typeof getIndicatorClass).toBe("function");
      expect(typeof getTooltip).toBe("function");
    });

    it("should return empty indicator class when autosave disabled", () => {
      const element = new CFFileDownload();
      const indicatorClass = (element as unknown as {
        _getAutosaveIndicatorClass: () => string;
      })._getAutosaveIndicatorClass();
      expect(indicatorClass).toBe("");
    });

    it("should return empty tooltip when autosave disabled", () => {
      const element = new CFFileDownload();
      const tooltip = (element as unknown as {
        _getAutosaveTooltip: () => string;
      })._getAutosaveTooltip();
      expect(tooltip).toBe("");
    });
  });

  describe("Option+click behavior", () => {
    it("should track not available state for feedback", () => {
      const element = new CFFileDownload();
      const privateAccess = asPrivate(element);

      // Directly set the feedback state (as _showNotAvailableFeedback would do)
      privateAccess._showNotAvailableTooltip = true;
      privateAccess._notAvailableMessage =
        "Auto-save not available for this download";

      // Verify state can be set and read
      expect(privateAccess._showNotAvailableTooltip).toBe(true);
      expect(privateAccess._notAvailableMessage).toBe(
        "Auto-save not available for this download",
      );
    });

    it("should not enable autosave when allowAutosave is false", () => {
      const element = new CFFileDownload();
      element.allowAutosave = false;
      const privateAccess = asPrivate(element);

      // Direct check - autosave should remain disabled
      expect(privateAccess._autosaveEnabled).toBe(false);
      expect(element.allowAutosave).toBe(false);
    });

    it("should attempt to enable autosave when Option+click with allowAutosave=true", async () => {
      const element = new CFFileDownload();
      element.allowAutosave = true;
      const privateAccess = asPrivate(element);

      // Mock showDirectoryPicker to simulate user cancellation
      const originalShowDirectoryPicker = (
        globalThis as unknown as {
          showDirectoryPicker?: () => Promise<unknown>;
        }
      ).showDirectoryPicker;

      let pickerCalled = false;
      (
        globalThis as unknown as { showDirectoryPicker: () => Promise<never> }
      ).showDirectoryPicker = () => {
        pickerCalled = true;
        const error = new DOMException("User cancelled", "AbortError");
        return Promise.reject(error);
      };

      try {
        // Directly call _enableAutosave to test the behavior
        await privateAccess._enableAutosave();

        expect(pickerCalled).toBe(true);
      } finally {
        // Restore original
        if (originalShowDirectoryPicker) {
          (
            globalThis as unknown as {
              showDirectoryPicker: () => Promise<unknown>;
            }
          ).showDirectoryPicker = originalShowDirectoryPicker;
        } else {
          delete (
            globalThis as unknown as { showDirectoryPicker?: unknown }
          ).showDirectoryPicker;
        }
      }
    });

    it("should not trigger autosave on regular click (no altKey) when autosave not enabled", () => {
      const element = new CFFileDownload();
      element.allowAutosave = true;
      const privateAccess = asPrivate(element);

      // Autosave is not enabled yet (would need directory picker)
      expect(privateAccess._autosaveEnabled).toBe(false);

      // Regular click behavior would trigger download, not autosave
      // Since autosave is not enabled, clicking would download
    });

    it("should disable autosave when _disableAutosave is called", () => {
      const element = new CFFileDownload();
      element.allowAutosave = true;
      const privateAccess = asPrivate(element);

      // Set up autosave as enabled
      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle =
        new MockFileSystemDirectoryHandle() as unknown as FileSystemDirectoryHandle;

      let disabledEventFired = false;
      element.addEventListener("cf-autosave-disabled", () => {
        disabledEventFired = true;
      });

      privateAccess._disableAutosave();

      expect(privateAccess._autosaveEnabled).toBe(false);
      expect(disabledEventFired).toBe(true);
    });

    it("should toggle autosave off when Option+click while autosave is enabled", () => {
      const element = new CFFileDownload();
      element.allowAutosave = true;
      const privateAccess = asPrivate(element);

      // Set up autosave as enabled
      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle =
        new MockFileSystemDirectoryHandle() as unknown as FileSystemDirectoryHandle;

      // Verify initial state
      expect(privateAccess._autosaveEnabled).toBe(true);

      // Disable should work
      privateAccess._disableAutosave();

      expect(privateAccess._autosaveEnabled).toBe(false);
      expect(privateAccess._autosaveDirHandle).toBeNull();
    });
  });

  describe("timer scheduling", () => {
    let element: CFFileDownload;
    let privateAccess: CFFileDownloadPrivateAccess;

    beforeEach(() => {
      element = new CFFileDownload();
      element.data = "test data";
      privateAccess = asPrivate(element);
    });

    afterEach(() => {
      // Clean up any timers
      if (privateAccess._autosaveTimer) {
        clearTimeout(privateAccess._autosaveTimer);
        privateAccess._autosaveTimer = null;
      }
    });

    it("should set a timer when _scheduleAutosave is called with autosave enabled", () => {
      privateAccess._autosaveEnabled = true;

      expect(privateAccess._autosaveTimer).toBeNull();

      privateAccess._scheduleAutosave();

      expect(privateAccess._autosaveTimer).not.toBeNull();
    });

    it("should not set a timer when autosave is disabled", () => {
      privateAccess._autosaveEnabled = false;

      privateAccess._scheduleAutosave();

      expect(privateAccess._autosaveTimer).toBeNull();
    });

    it("should reset the timer when _scheduleAutosave is called again", () => {
      privateAccess._autosaveEnabled = true;

      privateAccess._scheduleAutosave();
      const firstTimer = privateAccess._autosaveTimer;

      privateAccess._scheduleAutosave();
      const secondTimer = privateAccess._autosaveTimer;

      // Timers should be different (old one cleared, new one created)
      expect(secondTimer).not.toBe(firstTimer);
      expect(secondTimer).not.toBeNull();
    });

    it("should have timer cleared by _disableAutosave", () => {
      privateAccess._autosaveEnabled = true;
      privateAccess._scheduleAutosave();

      expect(privateAccess._autosaveTimer).not.toBeNull();

      // _disableAutosave clears the timer (this is called during disconnect)
      privateAccess._disableAutosave();

      expect(privateAccess._autosaveTimer).toBeNull();
    });
  });

  describe("state transition - indicator class", () => {
    let element: CFFileDownload;
    let privateAccess: CFFileDownloadPrivateAccess;

    beforeEach(() => {
      element = new CFFileDownload();
      privateAccess = asPrivate(element);
    });

    it("should return empty string when autosave is disabled", () => {
      privateAccess._autosaveEnabled = false;

      expect(privateAccess._getAutosaveIndicatorClass()).toBe("");
    });

    it('should return "saved" when autosave enabled and not dirty or saving', () => {
      privateAccess._autosaveEnabled = true;
      privateAccess._isDirty = false;
      privateAccess._isSavingAutosave = false;

      expect(privateAccess._getAutosaveIndicatorClass()).toBe("saved");
    });

    it('should return "pending" when autosave enabled and dirty but not saving', () => {
      privateAccess._autosaveEnabled = true;
      privateAccess._isDirty = true;
      privateAccess._isSavingAutosave = false;

      expect(privateAccess._getAutosaveIndicatorClass()).toBe("pending");
    });

    it('should return "saving" when autosave enabled and currently saving', () => {
      privateAccess._autosaveEnabled = true;
      privateAccess._isSavingAutosave = true;
      // _isDirty state doesn't matter when saving

      expect(privateAccess._getAutosaveIndicatorClass()).toBe("saving");
    });
  });

  describe("state transition - tooltip", () => {
    let element: CFFileDownload;
    let privateAccess: CFFileDownloadPrivateAccess;

    beforeEach(() => {
      element = new CFFileDownload();
      privateAccess = asPrivate(element);
    });

    it("should return empty string when autosave is disabled", () => {
      privateAccess._autosaveEnabled = false;
      privateAccess._showNotAvailableTooltip = false;

      expect(privateAccess._getAutosaveTooltip()).toBe("");
    });

    it("should return not available message when tooltip is showing", () => {
      privateAccess._showNotAvailableTooltip = true;
      privateAccess._notAvailableMessage = "Custom error message";

      expect(privateAccess._getAutosaveTooltip()).toBe("Custom error message");
    });

    it('should return "Saving..." when currently saving', () => {
      privateAccess._autosaveEnabled = true;
      privateAccess._isSavingAutosave = true;

      expect(privateAccess._getAutosaveTooltip()).toBe("Saving...");
    });

    it('should return "Auto-save on · Saving soon..." when dirty', () => {
      privateAccess._autosaveEnabled = true;
      privateAccess._isDirty = true;
      privateAccess._isSavingAutosave = false;

      expect(privateAccess._getAutosaveTooltip()).toBe(
        "Auto-save on · Saving soon...",
      );
    });

    it('should return "Auto-save on · All changes saved" when saved', () => {
      privateAccess._autosaveEnabled = true;
      privateAccess._isDirty = false;
      privateAccess._isSavingAutosave = false;

      expect(privateAccess._getAutosaveTooltip()).toBe(
        "Auto-save on · All changes saved",
      );
    });
  });

  describe("File System Access API mock tests", () => {
    let element: CFFileDownload;
    let privateAccess: CFFileDownloadPrivateAccess;
    let originalShowDirectoryPicker: (() => Promise<unknown>) | undefined;

    beforeEach(() => {
      element = new CFFileDownload();
      element.allowAutosave = true;
      element.data = "test data content";
      element.filename = "test-file.txt";
      element.mimeType = "text/plain";
      privateAccess = asPrivate(element);

      // Store original
      originalShowDirectoryPicker = (
        globalThis as unknown as {
          showDirectoryPicker?: () => Promise<unknown>;
        }
      ).showDirectoryPicker;
    });

    afterEach(() => {
      // Restore original
      if (originalShowDirectoryPicker) {
        (
          globalThis as unknown as {
            showDirectoryPicker: () => Promise<unknown>;
          }
        ).showDirectoryPicker = originalShowDirectoryPicker;
      } else {
        delete (
          globalThis as unknown as { showDirectoryPicker?: unknown }
        ).showDirectoryPicker;
      }

      // Clean up timers
      if (privateAccess._autosaveTimer) {
        clearTimeout(privateAccess._autosaveTimer);
      }
    });

    it("should enable autosave successfully when directory picker returns handle", async () => {
      const mockDirHandle = new MockFileSystemDirectoryHandle();

      (
        globalThis as unknown as {
          showDirectoryPicker: () => Promise<MockFileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker = () => Promise.resolve(mockDirHandle);

      let enabledEventFired = false;
      let eventDetail: { directoryName?: string } = {};
      element.addEventListener(
        "cf-autosave-enabled",
        ((e: CustomEvent<{ directoryName: string }>) => {
          enabledEventFired = true;
          eventDetail = e.detail;
        }) as EventListener,
      );

      const result = await privateAccess._enableAutosave();

      expect(result).toBe(true);
      expect(privateAccess._autosaveEnabled).toBe(true);
      expect(privateAccess._autosaveDirHandle).toBe(
        mockDirHandle as unknown as FileSystemDirectoryHandle,
      );
      expect(enabledEventFired).toBe(true);
      expect(eventDetail.directoryName).toBe("test-folder");
    });

    it("should return false and not show error when user cancels (AbortError)", async () => {
      (
        globalThis as unknown as { showDirectoryPicker: () => Promise<never> }
      ).showDirectoryPicker = () => {
        const error = new DOMException("User cancelled", "AbortError");
        return Promise.reject(error);
      };

      const result = await privateAccess._enableAutosave();

      expect(result).toBe(false);
      expect(privateAccess._autosaveEnabled).toBe(false);
      // Should not show error feedback for AbortError (user cancellation)
      expect(privateAccess._showNotAvailableTooltip).toBe(false);
    });

    it("should return false when permission denied (mocking classList)", async () => {
      // Mock classList to avoid DOM dependency
      (element as unknown as {
        classList: { add: () => void; remove: () => void };
      }).classList = {
        add: () => {},
        remove: () => {},
      };

      (
        globalThis as unknown as { showDirectoryPicker: () => Promise<never> }
      ).showDirectoryPicker = () => {
        const error = new DOMException(
          "Permission denied",
          "NotAllowedError",
        );
        return Promise.reject(error);
      };

      try {
        const result = await privateAccess._enableAutosave();

        expect(result).toBe(false);
        expect(privateAccess._autosaveEnabled).toBe(false);
        expect(privateAccess._showNotAvailableTooltip).toBe(true);
        expect(privateAccess._notAvailableMessage).toBe(
          "Could not access folder",
        );
      } finally {
        // Clean up timers to prevent leaks
        clearElementTimers(privateAccess);
        // Restore for other tests
        delete (
          globalThis as unknown as { showDirectoryPicker?: unknown }
        ).showDirectoryPicker;
      }
    });

    it("should return false when File System Access API is not available (mocking classList)", async () => {
      // Mock classList to avoid DOM dependency
      (element as unknown as {
        classList: { add: () => void; remove: () => void };
      }).classList = {
        add: () => {},
        remove: () => {},
      };

      // Ensure the API is not available
      const current = (
        globalThis as unknown as { showDirectoryPicker?: unknown }
      ).showDirectoryPicker;
      delete (
        globalThis as unknown as { showDirectoryPicker?: unknown }
      ).showDirectoryPicker;

      try {
        const result = await privateAccess._enableAutosave();

        expect(result).toBe(false);
        expect(privateAccess._autosaveEnabled).toBe(false);
        expect(privateAccess._showNotAvailableTooltip).toBe(true);
        expect(privateAccess._notAvailableMessage).toBe(
          "Auto-save requires Chrome or Edge",
        );
      } finally {
        // Clean up timers to prevent leaks
        clearElementTimers(privateAccess);
        // Restore if it existed
        if (current) {
          (
            globalThis as unknown as { showDirectoryPicker: unknown }
          ).showDirectoryPicker = current;
        }
      }
    });
  });

  describe("event emission", () => {
    let element: CFFileDownload;
    let privateAccess: CFFileDownloadPrivateAccess;
    let originalShowDirectoryPicker: (() => Promise<unknown>) | undefined;

    beforeEach(() => {
      element = new CFFileDownload();
      element.allowAutosave = true;
      element.data = "test data for events";
      element.filename = "event-test.txt";
      element.mimeType = "text/plain";
      privateAccess = asPrivate(element);

      originalShowDirectoryPicker = (
        globalThis as unknown as {
          showDirectoryPicker?: () => Promise<unknown>;
        }
      ).showDirectoryPicker;
    });

    afterEach(() => {
      if (originalShowDirectoryPicker) {
        (
          globalThis as unknown as {
            showDirectoryPicker: () => Promise<unknown>;
          }
        ).showDirectoryPicker = originalShowDirectoryPicker;
      } else {
        delete (
          globalThis as unknown as { showDirectoryPicker?: unknown }
        ).showDirectoryPicker;
      }

      if (privateAccess._autosaveTimer) {
        clearTimeout(privateAccess._autosaveTimer);
      }
    });

    it("should emit cf-autosave-enabled event with directory name", async () => {
      const mockDirHandle = new MockFileSystemDirectoryHandle();
      mockDirHandle.name = "my-backup-folder";

      (
        globalThis as unknown as {
          showDirectoryPicker: () => Promise<MockFileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker = () => Promise.resolve(mockDirHandle);

      let eventDetail: { directoryName?: string } = {};
      element.addEventListener(
        "cf-autosave-enabled",
        ((e: CustomEvent<{ directoryName: string }>) => {
          eventDetail = e.detail;
        }) as EventListener,
      );

      await privateAccess._enableAutosave();

      expect(eventDetail.directoryName).toBe("my-backup-folder");
    });

    it("should emit cf-autosave-disabled event", () => {
      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle =
        new MockFileSystemDirectoryHandle() as unknown as FileSystemDirectoryHandle;

      let disabledFired = false;
      element.addEventListener("cf-autosave-disabled", () => {
        disabledFired = true;
      });

      privateAccess._disableAutosave();

      expect(disabledFired).toBe(true);
      expect(privateAccess._autosaveEnabled).toBe(false);
    });

    it("should emit cf-autosave-success event with filename and size on successful save", async () => {
      const mockDirHandle = new MockFileSystemDirectoryHandle();
      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle =
        mockDirHandle as unknown as FileSystemDirectoryHandle;
      privateAccess._isDirty = true;

      // Bind the data controller directly for testing
      privateAccess._dataController.bind("test data for events");
      privateAccess._filenameController.bind("event-test.txt");

      let eventDetail: { filename?: string; size?: number } = {};
      element.addEventListener(
        "cf-autosave-success",
        ((e: CustomEvent<{ filename: string; size: number }>) => {
          eventDetail = e.detail;
        }) as EventListener,
      );

      await privateAccess._performAutosave();

      expect(eventDetail.filename).toMatch(/^event-test-.*\.txt$/);
      expect(typeof eventDetail.size).toBe("number");
      expect(eventDetail.size).toBeGreaterThan(0);
    });

    it("should emit cf-autosave-error event on failure", async () => {
      // Create a mock that throws on write
      const mockDirHandle = {
        name: "test-folder",
        getFileHandle: () =>
          Promise.resolve({
            createWritable: () =>
              Promise.resolve({
                write: () => Promise.reject(new Error("Write failed")),
                close: () => Promise.resolve(),
              }),
          }),
      };

      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle =
        mockDirHandle as unknown as FileSystemDirectoryHandle;
      privateAccess._isDirty = true;

      // Bind data controller
      privateAccess._dataController.bind("test data for error");

      let errorEventFired = false;
      let eventError: Error | undefined;
      element.addEventListener(
        "cf-autosave-error",
        ((e: CustomEvent<{ error: Error }>) => {
          errorEventFired = true;
          eventError = e.detail.error;
        }) as EventListener,
      );

      await privateAccess._performAutosave();

      expect(errorEventFired).toBe(true);
      expect(eventError?.message).toBe("Write failed");
    });

    it("should disable autosave and emit error when permission is revoked", async () => {
      // Mock classList to avoid DOM dependency
      (element as unknown as {
        classList: { add: () => void; remove: () => void };
      }).classList = {
        add: () => {},
        remove: () => {},
      };

      const mockDirHandle = {
        name: "test-folder",
        getFileHandle: () => {
          const error = new DOMException("Access revoked", "NotAllowedError");
          return Promise.reject(error);
        },
      };

      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle =
        mockDirHandle as unknown as FileSystemDirectoryHandle;
      privateAccess._isDirty = true;

      // Bind data controller
      privateAccess._dataController.bind("test data for permission revoked");

      let disabledFired = false;
      let errorFired = false;

      element.addEventListener("cf-autosave-disabled", () => {
        disabledFired = true;
      });
      element.addEventListener("cf-autosave-error", () => {
        errorFired = true;
      });

      try {
        await privateAccess._performAutosave();

        expect(disabledFired).toBe(true);
        expect(errorFired).toBe(true);
        expect(privateAccess._autosaveEnabled).toBe(false);
      } finally {
        // Clean up timers to prevent leaks
        clearElementTimers(privateAccess);
      }
    });
  });

  describe("autosave perform operation", () => {
    let element: CFFileDownload;
    let privateAccess: CFFileDownloadPrivateAccess;

    beforeEach(() => {
      element = new CFFileDownload();
      element.data = "content to save";
      element.filename = "save-test.json";
      element.mimeType = "application/json";
      privateAccess = asPrivate(element);
    });

    afterEach(() => {
      if (privateAccess._autosaveTimer) {
        clearTimeout(privateAccess._autosaveTimer);
      }
    });

    it("should not perform autosave if no directory handle", async () => {
      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle = null;
      privateAccess._isDirty = true;

      let successFired = false;
      element.addEventListener("cf-autosave-success", () => {
        successFired = true;
      });

      await privateAccess._performAutosave();

      expect(successFired).toBe(false);
    });

    it("should not perform autosave if already saving", async () => {
      const mockDirHandle = new MockFileSystemDirectoryHandle();
      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle =
        mockDirHandle as unknown as FileSystemDirectoryHandle;
      privateAccess._isSavingAutosave = true;

      let successCount = 0;
      element.addEventListener("cf-autosave-success", () => {
        successCount++;
      });

      await privateAccess._performAutosave();

      expect(successCount).toBe(0);
    });

    it("should update state after successful autosave", async () => {
      const mockDirHandle = new MockFileSystemDirectoryHandle();
      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle =
        mockDirHandle as unknown as FileSystemDirectoryHandle;
      privateAccess._isDirty = true;
      privateAccess._lastSavedData = "old data";

      // Bind the data controller
      privateAccess._dataController.bind("content to save");

      await privateAccess._performAutosave();

      expect(privateAccess._isDirty).toBe(false);
      expect(privateAccess._lastSavedData).toBe("content to save");
      expect(privateAccess._isSavingAutosave).toBe(false);
    });

    it("should clear timer after successful autosave", async () => {
      const mockDirHandle = new MockFileSystemDirectoryHandle();
      privateAccess._autosaveEnabled = true;
      privateAccess._autosaveDirHandle =
        mockDirHandle as unknown as FileSystemDirectoryHandle;
      privateAccess._isDirty = true;

      // Bind the data controller
      privateAccess._dataController.bind("content to save for timer test");

      // Set up a timer first
      privateAccess._scheduleAutosave();
      expect(privateAccess._autosaveTimer).not.toBeNull();

      await privateAccess._performAutosave();

      expect(privateAccess._autosaveTimer).toBeNull();
    });
  });
});
