import { Download } from "lucide-react";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { ChartImageSnapshot } from "./chartImageRender";
import type { ChartBackend, ChartImageProgress } from "./contract";
import "./ChartImageControls.css";

interface Props {
  backend: ChartBackend;
  captureImage: RefObject<(() => ChartImageSnapshot) | null>;
  ready: boolean;
}

type ExportView = "current" | "entire";
type Pending = { requestId?: string; cancelRequested: boolean };
type Feedback = { text: string; error?: boolean };

const formatNumber = new Intl.NumberFormat("en-US");
let exportSequence = 0;

export function ChartImageControls({ backend, captureImage, ready }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const rangeName = useId();
  const pointsName = useId();
  const pending = useRef<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [cancellable, setCancellable] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [menu, setMenu] = useState<{
    snapshot: ChartImageSnapshot;
    step: "actions" | "svg";
  } | null>(null);
  const [view, setView] = useState<ExportView>("current");
  const [allPoints, setAllPoints] = useState(false);
  const [progress, setProgress] = useState<ChartImageProgress | null>(null);
  const [scanTotal, setScanTotal] = useState<number | undefined>();

  useEffect(
    () => () => {
      const requestId = pending.current?.requestId;
      pending.current = null;
      if (requestId) void backend.cancel(requestId).catch(() => {});
    },
    [backend],
  );

  function showError(cause: unknown) {
    const message = cause instanceof Error ? cause.message : "Could not export the chart image.";
    setFeedback({ text: message, error: true });
  }

  function close() {
    dialog.current?.close();
    trigger.current?.focus({ preventScroll: true });
  }

  function open() {
    if (pending.current || !ready) return;
    try {
      const capture = captureImage.current;
      if (!capture) throw new Error("Wait for the chart to finish drawing.");
      // The render and its request stay together while the modal is open,
      // even if a followed SQL tab delivers a newer result in the meantime.
      setMenu({ snapshot: capture(), step: "actions" });
      dialog.current?.showModal();
    } catch (cause) {
      showError(cause);
    }
  }

  function openSvg() {
    if (!menu) return;
    setMenu({ ...menu, step: "svg" });
    setView("current");
    setAllPoints(false);
  }

  async function exportImage(action: "copy" | "png" | "svg") {
    if (pending.current || !menu) return;
    const captured = menu.snapshot;
    const stream = action === "svg" && allPoints && captured.kind === "scatter";
    const requestId = stream ? `chart-image-${Date.now()}-${++exportSequence}` : undefined;
    const operation = { requestId, cancelRequested: false };
    pending.current = operation;
    setSaving(true);
    setCancellable(stream);
    setCancelRequested(false);
    setProgress(null);
    setScanTotal(stream ? captured.totalRows : undefined);
    setFeedback({
      text: action === "copy" ? "Copying chart image…" : "Saving chart image…",
    });
    close();
    try {
      const { renderChartPng, renderChartSvg, canvasClipboardImage } =
        await import("./chartImageRender");
      if (pending.current !== operation) return;
      let saved = false;
      if (action === "svg") {
        const rendered = await renderChartSvg(captured, view, stream);
        if (pending.current !== operation) return;
        if (operation.cancelRequested) {
          setFeedback({ text: "Chart image export cancelled." });
          return;
        }
        const scatter =
          requestId && rendered.frame
            ? { chart: { ...captured.request, requestId }, frame: rendered.frame }
            : undefined;
        if (stream && !scatter) throw new Error("The full scatter range is unavailable.");
        saved = await backend.saveImage(
          { title: captured.title, image: { kind: "svg", data: rendered.data, scatter } },
          (next) => {
            if (pending.current === operation && !operation.cancelRequested) setProgress(next);
          },
        );
      } else {
        const image = renderChartPng(captured);
        if (action === "copy") {
          await backend.copyImage(canvasClipboardImage(image));
          if (pending.current === operation) setFeedback({ text: "Chart image copied." });
          return;
        }
        saved = await backend.saveImage({
          title: captured.title,
          image: {
            kind: "png",
            data: image.toDataURL("image/png").slice("data:image/png;base64,".length),
          },
        });
      }
      if (pending.current === operation)
        setFeedback({ text: saved ? "Chart image saved." : "Chart image export cancelled." });
    } catch (cause) {
      if (pending.current !== operation) return;
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "TaskCancelled"
      )
        setFeedback({ text: "Chart image export cancelled." });
      else showError(cause);
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        setSaving(false);
        setCancellable(false);
        setProgress(null);
      }
    }
  }

  async function cancel() {
    const operation = pending.current;
    if (!operation?.requestId || operation.cancelRequested) return;
    operation.cancelRequested = true;
    setCancelRequested(true);
    setFeedback({ text: "Cancelling chart image export…" });
    try {
      await backend.cancel(operation.requestId);
    } catch (cause) {
      if (pending.current !== operation) return;
      operation.cancelRequested = false;
      setCancelRequested(false);
      showError(cause);
    }
  }

  const progressText = progress
    ? `Exporting SVG · ${formatNumber.format(progress.scannedRows)} rows scanned · ${formatNumber.format(progress.writtenPoints)} points written`
    : null;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="chart-icon-button"
        aria-label="Export chart image"
        aria-haspopup="dialog"
        title="Export chart image"
        disabled={!ready}
        aria-disabled={saving || undefined}
        onClick={open}
      >
        <Download aria-hidden="true" />
      </button>
      <dialog
        ref={dialog}
        className="chart-image-dialog"
        aria-labelledby={headingId}
        onClose={() => setMenu(null)}
      >
        <h3 id={headingId}>{menu?.step === "svg" ? "Save chart as SVG" : "Export chart image"}</h3>
        {menu?.step === "svg" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void exportImage("svg");
            }}
          >
            <fieldset>
              <legend>Chart range</legend>
              <label>
                <input
                  name={rangeName}
                  type="radio"
                  autoFocus
                  checked={view === "current"}
                  onChange={() => setView("current")}
                />
                Current zoom
              </label>
              <label>
                <input
                  name={rangeName}
                  type="radio"
                  checked={view === "entire"}
                  onChange={() => setView("entire")}
                />
                Entire chart
              </label>
            </fieldset>
            {menu.snapshot.kind === "scatter" && (
              <fieldset>
                <legend>Scatter points</legend>
                <label>
                  <input
                    name={pointsName}
                    type="radio"
                    checked={!allPoints}
                    onChange={() => setAllPoints(false)}
                  />
                  Displayed points
                </label>
                <label>
                  <input
                    name={pointsName}
                    type="radio"
                    checked={allPoints}
                    onChange={() => setAllPoints(true)}
                  />
                  All valid points
                </label>
                {allPoints && <p>Large exports can take longer and use more disk space.</p>}
              </fieldset>
            )}
            <div className="chart-image-actions">
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="chart-primary">
                Save SVG
              </button>
            </div>
          </form>
        ) : (
          <div className="chart-image-actions">
            <button type="button" onClick={() => void exportImage("copy")}>
              Copy image
            </button>
            <button type="button" onClick={() => void exportImage("png")}>
              Save PNG
            </button>
            <button type="button" onClick={openSvg}>
              Save SVG
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </div>
        )}
      </dialog>
      {feedback && (
        <div className="chart-image-feedback">
          <span role={feedback.error ? "alert" : "status"}>
            {cancelRequested || feedback.error ? feedback.text : (progressText ?? feedback.text)}
          </span>
          {progress && scanTotal && (
            <progress
              aria-label="SVG export progress"
              max={scanTotal}
              value={Math.min(progress.scannedRows, scanTotal)}
            />
          )}
          {cancellable && (
            <button type="button" disabled={cancelRequested} onClick={() => void cancel()}>
              Cancel export
            </button>
          )}
        </div>
      )}
    </>
  );
}
