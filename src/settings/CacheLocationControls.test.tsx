// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CacheLocationControls } from "./CacheLocationControls";
import type { CacheManagementBackend, CacheMigrationStatus } from "../column-values/backend";

const preview = {
  sourcePath: "C:/cache",
  targetPath: "D:/viewer/data-viewer-csv-cache",
  bytes: 100,
  entries: 2,
  activeEntries: 0,
  availableBytes: 20 * 1024 ** 3,
  requiredFreeBytes: 5 * 1024 ** 3 + 100,
};
const status: CacheMigrationStatus = {
  operationId: "move-1",
  state: "complete",
  progress: {
    copiedBytes: 100,
    totalBytes: 100,
    copiedEntries: 2,
    totalEntries: 2,
    phase: "complete",
  },
  sourcePath: preview.sourcePath,
  targetPath: preview.targetPath,
  error: null,
  result: {
    sourcePath: preview.sourcePath,
    targetPath: preview.targetPath,
    movedBytes: 100,
    movedEntries: 2,
    cleanupFailures: [],
  },
};
function backend(): CacheManagementBackend {
  return {
    chooseCsvCacheLocation: vi.fn().mockResolvedValue({ selectionId: "selected-1", preview }),
    startCsvCacheMigration: vi.fn().mockResolvedValue(status),
    getCsvCacheMigrationStatus: vi.fn(),
    cancelCsvCacheMigration: vi.fn(),
    getQueryTempUsage: vi.fn(),
  };
}
describe("Phase 21 cache location", () => {
  it("explicitly switches to new caches when the previous drive is unavailable", async () => {
    const api = backend();
    vi.mocked(api.chooseCsvCacheLocation).mockResolvedValue({
      selectionId: "replacement",
      preview: { ...preview, sourceUnavailable: true, bytes: 0, entries: 0 },
    });
    const onComplete = vi.fn().mockResolvedValue(undefined);
    render(
      <CacheLocationControls
        backend={api}
        openDocumentCount={0}
        disabled={false}
        onBusyChange={vi.fn()}
        onComplete={onComplete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose cache location…" }));
    expect(
      await screen.findByText(/existing cache files will not be moved or deleted/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move cache here" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use this cache location" }));
    expect(await screen.findByText("Cache location updated successfully")).toBeInTheDocument();
    expect(api.startCsvCacheMigration).toHaveBeenCalledWith("replacement");
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
  });
  it("does not open duplicate pickers and ignores a grant after files are opened", async () => {
    const api = backend();
    let finish: ((selection: { selectionId: string; preview: typeof preview }) => void) | undefined;
    vi.mocked(api.chooseCsvCacheLocation).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const props = {
      backend: api,
      openDocumentCount: 0,
      disabled: false,
      onBusyChange: vi.fn(),
      onComplete: vi.fn(),
    };
    const { rerender } = render(<CacheLocationControls {...props} />);
    const choose = screen.getByRole("button", { name: "Choose cache location…" });
    fireEvent.click(choose);
    fireEvent.click(choose);
    expect(api.chooseCsvCacheLocation).toHaveBeenCalledTimes(1);
    rerender(<CacheLocationControls {...props} openDocumentCount={1} />);
    await act(async () => finish?.({ selectionId: "stale", preview }));
    expect(screen.queryByRole("button", { name: "Move cache here" })).not.toBeInTheDocument();
    expect(api.startCsvCacheMigration).not.toHaveBeenCalled();
  });
  it("starts migration only once and consumes the selected grant", async () => {
    const api = backend();
    let finish: ((status: CacheMigrationStatus) => void) | undefined;
    vi.mocked(api.startCsvCacheMigration).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <CacheLocationControls
        backend={api}
        openDocumentCount={0}
        disabled={false}
        onBusyChange={vi.fn()}
        onComplete={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose cache location…" }));
    const move = await screen.findByRole("button", { name: "Move cache here" });
    fireEvent.click(move);
    fireEvent.click(move);
    expect(api.startCsvCacheMigration).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Move cache here" })).not.toBeInTheDocument();
    await act(async () => finish?.(status));
    expect(await screen.findByText("Cache moved successfully")).toBeInTheDocument();
  });
  it("requires files closed and storage edits applied before selecting a target", () => {
    const api = backend();
    const props = {
      backend: api,
      openDocumentCount: 2,
      disabled: false,
      onBusyChange: vi.fn(),
      onComplete: vi.fn(),
    };
    const { rerender } = render(<CacheLocationControls {...props} />);
    expect(screen.getByRole("button", { name: "Choose cache location…" })).toBeDisabled();
    expect(screen.getByText(/Close all open files/)).toBeInTheDocument();
    rerender(<CacheLocationControls {...props} openDocumentCount={0} disabled />);
    expect(screen.getByText(/Apply your storage settings/)).toBeInTheDocument();
    expect(api.chooseCsvCacheLocation).not.toHaveBeenCalled();
  });
  it("shows a preview and migrates only with the backend-granted selection token", async () => {
    const api = backend(),
      onComplete = vi.fn().mockResolvedValue(undefined);
    render(
      <CacheLocationControls
        backend={api}
        openDocumentCount={0}
        disabled={false}
        onBusyChange={vi.fn()}
        onComplete={onComplete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose cache location…" }));
    await screen.findByText(preview.targetPath);
    expect(api.startCsvCacheMigration).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move cache here" }));
    await screen.findByText("Cache moved successfully");
    expect(api.startCsvCacheMigration).toHaveBeenCalledWith("selected-1");
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });
  it("folder picker cancel changes nothing and occupied or full destinations cannot migrate", async () => {
    const api = backend();
    vi.mocked(api.chooseCsvCacheLocation)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        selectionId: "bad",
        preview: { ...preview, activeEntries: 1, availableBytes: 0 },
      });
    render(
      <CacheLocationControls
        backend={api}
        openDocumentCount={0}
        disabled={false}
        onBusyChange={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose cache location…" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Choose cache location…" })).toBeEnabled(),
    );
    expect(
      screen.queryByRole("region", { name: "Cache migration preview" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose cache location…" }));
    await screen.findByText(/Close other viewer windows/);
    expect(screen.getByRole("button", { name: "Move cache here" })).toBeDisabled();
    expect(api.startCsvCacheMigration).not.toHaveBeenCalled();
  });
});
