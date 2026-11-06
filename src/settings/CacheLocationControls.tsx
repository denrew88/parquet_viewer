import { useEffect, useRef, useState } from "react";
import type {
  CacheLocationSelection,
  CacheManagementBackend,
  CacheMigrationStatus,
} from "../column-values/backend";

interface Props {
  backend: CacheManagementBackend;
  openDocumentCount: number;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
  onComplete(): Promise<void>;
}
const format = (bytes: number) =>
  bytes < 1024 ** 3
    ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
    : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
export function CacheLocationControls({
  backend,
  openDocumentCount,
  disabled,
  onBusyChange,
  onComplete,
}: Props) {
  const [selection, setSelection] = useState<CacheLocationSelection | null>(null);
  const [status, setStatus] = useState<CacheMigrationStatus | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [replacement, setReplacement] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef<string | null>(null);
  const alive = useRef(true);
  const pendingRequest = useRef(false);
  const requestSequence = useRef(0);
  const ineligible = useRef(disabled || openDocumentCount > 0);
  ineligible.current = disabled || openDocumentCount > 0;
  const busy = choosing || status?.state === "queued" || status?.state === "running";
  useEffect(() => {
    const sequence = ++requestSequence.current;
    alive.current = true;
    setChoosing(false);
    setStarting(false);
    setSelection(null);
    setStatus(null);
    setReplacement(false);
    return () => {
      alive.current = false;
      requestSequence.current = sequence + 1;
      pendingRequest.current = false;
    };
  }, [backend]);
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (!status || !["queued", "running"].includes(status.state)) return;
    let active = true;
    const timer = setTimeout(
      () =>
        void backend.getCsvCacheMigrationStatus(status.operationId).then(
          (next) => {
            if (active) setStatus(next);
          },
          (e) => {
            if (active) setError(e instanceof Error ? e.message : String(e));
          },
        ),
      200,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [backend, status]);
  useEffect(() => {
    if (status?.state !== "complete" || completed.current === status.operationId) return;
    completed.current = status.operationId;
    setSelection(null);
    void onComplete().catch((e) => {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    });
  }, [status, onComplete]);
  async function choose() {
    if (pendingRequest.current || busy || ineligible.current) return;
    pendingRequest.current = true;
    const sequence = requestSequence.current;
    setChoosing(true);
    setError(null);
    try {
      const next = await backend.chooseCsvCacheLocation();
      if (alive.current && sequence === requestSequence.current) {
        setSelection(ineligible.current ? null : next);
        setStatus(null);
      }
    } catch (e) {
      if (alive.current && sequence === requestSequence.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (sequence === requestSequence.current) {
        pendingRequest.current = false;
        if (alive.current) setChoosing(false);
      }
    }
  }
  async function start() {
    if (!selection || pendingRequest.current || busy || ineligible.current) return;
    pendingRequest.current = true;
    const sequence = requestSequence.current;
    const selectionId = selection.selectionId;
    setReplacement(selection.preview.sourceUnavailable === true);
    setSelection(null);
    setError(null);
    setChoosing(true);
    setStarting(true);
    try {
      const next = await backend.startCsvCacheMigration(selectionId);
      if (alive.current && sequence === requestSequence.current) setStatus(next);
    } catch (e) {
      if (alive.current && sequence === requestSequence.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (sequence === requestSequence.current) {
        pendingRequest.current = false;
        if (alive.current) {
          setChoosing(false);
          setStarting(false);
        }
      }
    }
  }
  return (
    <div className="cache-location-controls">
      <button
        type="button"
        disabled={disabled || busy || openDocumentCount > 0}
        onClick={() => void choose()}
      >
        {starting
          ? "Starting cache move…"
          : choosing
            ? "Choosing location…"
            : "Choose cache location…"}
      </button>
      {openDocumentCount > 0 && (
        <p className="settings-field-description">
          Close all open files before moving the cache. {openDocumentCount}{" "}
          {openDocumentCount === 1 ? "file is" : "files are"} open.
        </p>
      )}
      {disabled && (
        <p className="settings-field-description">
          Apply your storage settings before choosing a new cache location.
        </p>
      )}
      {selection && (
        <section className="cache-migration-preview" aria-label="Cache migration preview">
          <strong>
            {selection.preview.sourceUnavailable
              ? "Use a new CSV cache location"
              : "Move existing CSV cache"}
          </strong>
          <dl>
            <dt>From</dt>
            <dd>{selection.preview.sourcePath}</dd>
            <dt>To</dt>
            <dd>{selection.preview.targetPath}</dd>
            <dt>Cache to move</dt>
            <dd>
              {selection.preview.entries.toLocaleString()} items · {format(selection.preview.bytes)}
            </dd>
            <dt>Required free space</dt>
            <dd>{format(selection.preview.requiredFreeBytes)} including disk reserve</dd>
            <dt>Available on destination</dt>
            <dd>{format(selection.preview.availableBytes)}</dd>
          </dl>
          <p>
            {selection.preview.sourceUnavailable
              ? "Previous cache location is unavailable. Use this location for new caches; existing cache files will not be moved or deleted."
              : "Existing cache is copied and verified before the location changes. Source CSV files are not moved."}
          </p>
          {selection.preview.activeEntries > 0 && (
            <p role="alert">
              {selection.preview.activeEntries} cache items are in use. Close other viewer windows
              using this cache.
            </p>
          )}
          {selection.preview.availableBytes < selection.preview.requiredFreeBytes && (
            <p role="alert">The destination does not have enough free space.</p>
          )}
          <div>
            <button type="button" disabled={busy} onClick={() => setSelection(null)}>
              Cancel location change
            </button>
            <button
              type="button"
              disabled={
                busy ||
                disabled ||
                openDocumentCount > 0 ||
                selection.preview.activeEntries > 0 ||
                selection.preview.availableBytes < selection.preview.requiredFreeBytes
              }
              onClick={() => void start()}
            >
              {selection.preview.sourceUnavailable ? "Use this cache location" : "Move cache here"}
            </button>
          </div>
        </section>
      )}
      {status && (
        <div role="status" className="cache-migration-status">
          <strong>
            {status.state === "complete"
              ? replacement
                ? "Cache location updated successfully"
                : "Cache moved successfully"
              : status.state === "cancelled"
                ? "Cache move cancelled"
                : status.state === "failed"
                  ? "Cache move failed"
                  : "Moving CSV cache…"}
          </strong>
          <p title={status.targetPath}>Destination: {status.targetPath}</p>
          <p>
            {status.error?.message ??
              `${status.progress.copiedEntries.toLocaleString()} / ${status.progress.totalEntries.toLocaleString()} items · ${format(status.progress.copiedBytes)} / ${format(status.progress.totalBytes)} · ${status.progress.phase}`}
          </p>
          {["queued", "running"].includes(status.state) && (
            <>
              <progress
                aria-label="Cache migration progress"
                value={status.progress.copiedBytes}
                max={Math.max(1, status.progress.totalBytes)}
              />
              <button
                type="button"
                onClick={() =>
                  void backend
                    .cancelCsvCacheMigration(status.operationId)
                    .then(setStatus, (e) => setError(e instanceof Error ? e.message : String(e)))
                }
              >
                Cancel cache move
              </button>
            </>
          )}
          {status.result?.cleanupFailures.length ? (
            <p>
              Cache is available at the new location. Some old files could not be removed:{" "}
              {status.result.cleanupFailures.join(" ")}
            </p>
          ) : null}
        </div>
      )}
      {error && (
        <p role="alert" className="storage-error">
          {error}
        </p>
      )}
    </div>
  );
}
