import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { DataViewerError, type BackendAdapter, type DataValue } from "./backend";
import {
  MAX_CHART_BLOCK_CELLS,
  MAX_HISTOGRAM_BINS,
  type ChartData,
  type ChartImageCopy,
  type ChartImageProgress,
  type ChartLiveSource,
  type ChartSource,
  type ChartRequest,
  type ChartScale,
  type ChartTransport,
} from "./chart-workspace/contract";
import { TEAL } from "./chart-workspace/chartSeries";

async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (cause) {
    const error = cause as { code?: string; message?: string } | null;
    throw new DataViewerError(error?.code ?? "QueryFailed", error?.message ?? String(cause));
  }
}

export function createChartTransport(backend: BackendAdapter): ChartTransport {
  if (!isTauri()) return browserCharts(backend);
  return {
    compute: ({ detail, ...request }) =>
      call("compute_chart", { request, ...(detail === undefined ? {} : { detail }) }),
    capture: (request) => call("capture_chart_selection", { request }),
    readBlockPreview: (blockId, limit, columns) =>
      call("read_chart_block_preview", { blockId, limit, columns }),
    cancel: (requestId) => call("cancel_chart", { requestId }),
    releaseBlock: (blockId) => call("release_chart_block", { blockId }),
    retainResult: ({ runId, resultId }) => call("retain_chart_sql_result", { runId, resultId }),
    releaseResult: ({ runId, resultId }) => call("release_chart_sql_result", { runId, resultId }),
    copyImage: (request) => call("copy_chart_image", { request }),
    saveImage(request, onProgress) {
      const progress = new Channel<ChartImageProgress>();
      if (onProgress) progress.onmessage = onProgress;
      return call("save_chart_image", { request, progress });
    },
  };
}

// The browser adapter drives UI tests with the same logical grid rows. Native
// statistics, numeric precision, sampling and quotas are exercised in Rust.
function browserCharts(backend: BackendAdapter): ChartTransport {
  type Block = { columns: string[]; rows: DataValue[][]; start: number };
  type ReferenceBlock = {
    columns: string[];
    source: Extract<ChartLiveSource, { kind: "sql" }>;
    start: number;
    end: number;
  };
  const mockDetailRows = 64_000;
  const blocks = new Map<string, Block | ReferenceBlock>();
  const detailInputs = new Map<string, Block>();
  const jobs = new Map<string, AbortController>();

  function remember(key: string, input: Block) {
    detailInputs.delete(key);
    detailInputs.set(key, input);
    if (detailInputs.size > 2) detailInputs.delete(detailInputs.keys().next().value!);
  }

  async function read(
    source: ChartSource,
    offset: number,
    limit: number,
    columns: string[],
  ): Promise<import("./backend").DataPage> {
    if (source.kind === "block") {
      const block = blocks.get(source.blockId);
      if (!block || columns.some((id) => !block.columns.includes(id)))
        throw new Error("The chart selection is unavailable.");
      const totalRows = "rows" in block ? block.rows.length : block.end - block.start;
      const count = Math.max(0, Math.min(limit, totalRows - offset));
      const values =
        "rows" in block
          ? block.rows
              .slice(offset, offset + count)
              .map((row) => columns.map((id) => row[block.columns.indexOf(id)]!))
          : count
            ? (await read(block.source, block.start + offset, count, columns)).rows
            : [];
      return {
        sessionId: source.blockId,
        offset,
        limit,
        columns,
        totalRows,
        hasMore: offset + values.length < totalRows,
        rows: values,
      };
    }
    if (source.kind === "sql") {
      if (!backend.sqlWorkspace) throw new Error("SQL is unavailable.");
      return backend.sqlWorkspace.readPage({
        runId: source.runId,
        resultId: source.resultId,
        ...(source.viewId ? { viewId: source.viewId } : {}),
        offset,
        limit,
        columns,
      });
    }
    const page = {
      offset,
      limit,
      columns,
      documentId: source.documentId,
      sessionId: source.sessionId,
    };
    return source.queryId
      ? (await backend.readQueryPage({ ...page, queryId: source.queryId })).page
      : backend.readPage(page);
  }

  async function visitRows(
    source: ChartSource,
    columns: string[],
    signal: AbortSignal,
    visit: (batch: DataValue[][], offset: number) => void,
    start = 0,
    end = Number.MAX_SAFE_INTEGER,
  ) {
    for (let offset = start; offset < end;) {
      signal.throwIfAborted();
      const page = await read(source, offset, Math.min(100, end - offset), columns);
      signal.throwIfAborted();
      if (!page.rows.length) break;
      const block = source.kind === "block" ? blocks.get(source.blockId) : undefined;
      visit(page.rows, offset + (block?.start ?? 0));
      offset += page.rows.length;
      if (!page.hasMore) break;
    }
  }

  async function rows(
    source: ChartSource,
    columns: string[],
    signal: AbortSignal,
    start = 0,
    end = 20_000,
  ): Promise<Block> {
    const values: DataValue[][] = [];
    await visitRows(source, columns, signal, (batch) => values.push(...batch), start, end);
    signal.throwIfAborted();
    const block = source.kind === "block" ? blocks.get(source.blockId) : undefined;
    return { columns, rows: values, start: start + (block?.start ?? 0) };
  }

  async function run<T>(id: string, work: (signal: AbortSignal) => Promise<T>) {
    const controller = new AbortController();
    jobs.set(id, controller);
    try {
      return await work(controller.signal);
    } finally {
      jobs.delete(id);
    }
  }

  return {
    async compute(request) {
      return run(request.requestId, async (signal) => {
        if (request.source.kind === "block") {
          const block = blocks.get(request.source.blockId);
          if (!block) throw new Error("The chart selection is unavailable.");
          if ("rows" in block)
            return summarizeMock(request, block.columns, block.rows, block.start);
        }
        const columns = [
          ...new Set(
            [request.x, request.y, request.filter?.columnId, request.scatterLabel].filter(
              (column): column is string => column !== undefined,
            ),
          ),
        ];
        const key = JSON.stringify({ ...request, requestId: undefined, detail: undefined });
        if (request.detail) {
          let input = detailInputs.get(key);
          if (!input) {
            input = await rows(request.source, columns, signal, 0, mockDetailRows + 1);
            if (input.rows.length > mockDetailRows)
              throw new Error("The browser detail fixture exceeds its row limit.");
            remember(key, input);
          }
          return summarizeMock(request, input.columns, input.rows, input.start);
        }
        if (request.kind === "scatter") {
          const output: ChartData = {
            totalRows: 0,
            validRows: 0,
            excludedRows: 0,
            filteredRows: 0,
            groupsTruncated: false,
            sampled: false,
          };
          const points: NonNullable<ChartData["points"]> = [];
          const details: NonNullable<ChartData["pointDetails"]> = [];
          let retained: DataValue[][] | undefined = [];
          let coordinates: [number, number][] | undefined = [];
          let seen = 0;
          let state = 1;
          await visitRows(request.source, columns, signal, (batch, offset) => {
            const page = summarizeMock(request, columns, batch, offset);
            if (retained && retained.length + batch.length <= mockDetailRows) {
              retained.push(...batch);
              coordinates?.push(...(page.points ?? []));
            } else {
              retained = undefined;
              coordinates = undefined;
            }
            output.totalRows += page.totalRows;
            output.validRows += page.validRows;
            output.excludedRows += page.excludedRows;
            output.filteredRows += page.filteredRows;
            if (page.scaleExcludedRows)
              output.scaleExcludedRows = (output.scaleExcludedRows ?? 0) + page.scaleExcludedRows;
            if (page.scatterExtent) {
              const [xMin, xMax, yMin, yMax] = page.scatterExtent;
              const current = output.scatterExtent ?? page.scatterExtent;
              output.scatterExtent = [
                Math.min(current[0], xMin),
                Math.max(current[1], xMax),
                Math.min(current[2], yMin),
                Math.max(current[3], yMax),
              ];
            }
            for (const [index, point] of (page.points ?? []).entries()) {
              seen++;
              // A fixed seed makes the mock sample independent of page boundaries.
              state = (Math.imul(1664525, state) + 1013904223) >>> 0;
              const slot = points.length < 20_000 ? points.length : state % seen;
              if (slot < 20_000) {
                points[slot] = point;
                details[slot] = page.pointDetails![index]!;
              }
            }
          });
          output.sampled = seen > points.length;
          output.points = points;
          output.pointDetails = details;
          if (retained) remember(key, { columns, rows: retained, start: 0 });
          if (output.sampled && coordinates && output.scatterExtent)
            output.scatterTiles = mockScatterTiles(coordinates, output.scatterExtent);
          return output;
        }
        const limit = request.kind === "line" ? mockDetailRows : 20_000;
        const input = await rows(request.source, columns, signal, 0, limit);
        if (input.rows.length < limit) remember(key, input);
        return summarizeMock(request, columns, input.rows);
      });
    },
    async capture({ requestId, source, selection }) {
      const length = selection.rowEndExclusive - selection.rowStart;
      if (
        !Number.isSafeInteger(selection.rowStart) ||
        selection.rowStart < 0 ||
        !Number.isSafeInteger(selection.rowEndExclusive) ||
        length < 1 ||
        selection.columnIds.length < 1 ||
        selection.columnIds.length > 64 ||
        new Set(selection.columnIds).size !== selection.columnIds.length ||
        (source.kind !== "sql" && length * selection.columnIds.length > MAX_CHART_BLOCK_CELLS) ||
        blocks.has(requestId) ||
        jobs.has(requestId) ||
        blocks.size >= 32
      )
        throw new Error("The chart selection exceeds the snapshot limit.");
      await run(requestId, async (signal) => {
        if (source.kind === "sql") {
          await backend.sqlWorkspace?.retainMockChartResult?.(
            source.runId,
            source.resultId,
            source.viewId,
            selection,
          );
          try {
            signal.throwIfAborted();
            blocks.set(requestId, {
              columns: [...selection.columnIds],
              source: { ...source },
              start: selection.rowStart,
              end: selection.rowEndExclusive,
            });
          } catch (error) {
            await backend.sqlWorkspace?.releaseMockChartResult?.(
              source.runId,
              source.resultId,
              source.viewId,
            );
            throw error;
          }
          return;
        }
        const block = await rows(
          source,
          selection.columnIds,
          signal,
          selection.rowStart,
          selection.rowEndExclusive,
        );
        if (block.rows.length !== length)
          throw new Error("The chart selection is outside the source.");
        blocks.set(requestId, block);
      });
    },
    async cancel(requestId) {
      jobs
        .get(requestId)
        ?.abort(new DataViewerError("TaskCancelled", "The data task was cancelled."));
    },
    async releaseBlock(blockId) {
      const block = blocks.get(blockId);
      blocks.delete(blockId);
      if (block && !("rows" in block))
        await backend.sqlWorkspace?.releaseMockChartResult?.(
          block.source.runId,
          block.source.resultId,
          block.source.viewId,
        );
    },
    async readBlockPreview(blockId, limit, columns) {
      const block = blocks.get(blockId);
      if (!block) throw new Error("The chart selection is unavailable.");
      const positions = columns.map((id) => block.columns.indexOf(id));
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 6 ||
        columns.length < 1 ||
        columns.length > 8 ||
        new Set(columns).size !== columns.length ||
        positions.some((position) => position < 0)
      )
        throw new Error("Invalid chart selection preview request.");
      return read({ kind: "block", blockId }, 0, limit, columns);
    },
    async retainResult({ runId, resultId }) {
      await backend.sqlWorkspace?.retainMockChartResult?.(runId, resultId);
    },
    async releaseResult({ runId, resultId }) {
      await backend.sqlWorkspace?.releaseMockChartResult?.(runId, resultId);
    },
    async copyImage(request) {
      return copyMockImage(request);
    },
    async saveImage({ title, image }, onProgress) {
      if (image.kind === "png") {
        downloadMockImage(title, "png", [decodeBase64(image.data)]);
        return true;
      }
      const scatter = image.scatter;
      if (!scatter) {
        downloadMockImage(title, "svg", [image.data]);
        return true;
      }
      return run(scatter.chart.requestId, async (signal) => {
        const { chart, frame } = scatter;
        const { source } = chart;
        const columns = [
          ...new Set([chart.x, chart.y!, ...(chart.filter ? [chart.filter.columnId] : [])]),
        ];
        const { xMin, xMax, yMin, yMax, left, top, width, height, radius } = frame;
        const parts: string[] = [
          image.data.slice(0, -"</svg>".length),
          `<defs><clipPath id="chart-export-points-clip"><rect x="${left}" y="${top}" width="${width}" height="${height}"/></clipPath></defs><g data-chart-points="all" fill="${TEAL}" fill-opacity="0.64" clip-path="url(#chart-export-points-clip)">`,
        ];
        let scannedRows = 0;
        let writtenPoints = 0;
        function append(batch: DataValue[][], projection: string[]) {
          scannedRows += batch.length;
          const points = summarizeMock(chart, projection, batch).points ?? [];
          const circles: string[] = [];
          for (const [x, y] of points) {
            if (x < xMin || x > xMax || y < yMin || y > yMax) continue;
            const cx = left + ((x - xMin) / (xMax - xMin)) * width;
            const cy = top + ((yMax - y) / (yMax - yMin)) * height;
            circles.push(`<circle cx="${cx.toFixed(4)}" cy="${cy.toFixed(4)}" r="${radius}"/>`);
            writtenPoints++;
          }
          parts.push(circles.join(""));
          onProgress?.({ scannedRows, writtenPoints });
        }
        await visitRows(source, columns, signal, (batch) => append(batch, columns));
        signal.throwIfAborted();
        parts.push("</g></svg>");
        downloadMockImage(title, "svg", parts);
        return true;
      });
    },
  };
}

function mockScatterTiles(
  points: readonly [number, number][],
  [xMin, xMax, yMin, yMax]: NonNullable<ChartData["scatterExtent"]>,
): NonNullable<ChartData["scatterTiles"]> {
  const side = 32;
  const dx = (xMax - xMin) / side;
  const dy = (yMax - yMin) / side;
  const counts = new Map<number, number>();
  for (const [x, y] of points) {
    const col = dx > 0 ? Math.min(side - 1, Math.floor((x - xMin) / dx)) : 0;
    const row = dy > 0 ? Math.min(side - 1, Math.floor((y - yMin) / dy)) : 0;
    const index = row * side + col;
    counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  return Array.from(counts, ([index, count]) => {
    const col = index % side;
    const row = Math.floor(index / side);
    return [xMin + col * dx, xMin + (col + 1) * dx, yMin + row * dy, yMin + (row + 1) * dy, count];
  });
}

function decodeBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function downloadMockImage(title: string, kind: "png" | "svg", parts: BlobPart[]) {
  const basename = title
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  const type = kind === "png" ? "image/png" : "image/svg+xml";
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${basename || "chart"}.${kind}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

async function copyMockImage({ width, height, rgba }: ChartImageCopy) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The image clipboard renderer is unavailable.");
  context.putImageData(
    new ImageData(new Uint8ClampedArray(decodeBase64(rgba).buffer), width, height),
    0,
    0,
  );
  const image = new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The chart image could not be encoded."));
    });
  });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
}

function numeric(cell: DataValue | undefined, scale?: ChartScale): number {
  if (!cell) return NaN;
  const raw = cell.display;
  if (raw == null || raw === "" || cell.state === "invalid") return NaN;
  if (["date", "datetime", "timestamp"].includes(cell.kind)) {
    return !scale || scale === "linear" ? Date.parse(raw) : NaN;
  }
  return Number(raw);
}

function scaleValue(value: number, scale?: ChartScale): number {
  if (scale === "log") return Math.log(value);
  if (scale === "log10") return Math.log10(value);
  if (scale === "log1p") return Math.log1p(value);
  return value;
}

function mockHistogram(
  samples: number[],
  binning: ChartRequest["histogram"],
  range: ChartRequest["histogramRange"],
) {
  if (!samples.length && !range) return [];
  const min = range?.min ?? Math.min(...samples);
  const max = range?.max ?? Math.max(...samples);
  let bins =
    min === max
      ? 1
      : binning?.mode === "count"
        ? binning.count
        : Math.max(1, Math.min(MAX_HISTOGRAM_BINS, Math.ceil(Math.sqrt(samples.length))));
  const width = binning?.mode === "width" ? binning.width : (max - min) / bins;
  if (binning?.mode === "width") {
    if (!Number.isFinite(width) || width <= 0)
      throw new Error("Bin width must be positive and finite.");
    bins = 1;
    while (min + bins * width < max && bins <= MAX_HISTOGRAM_BINS) bins++;
  }
  if (!Number.isInteger(bins) || bins < 1 || bins > MAX_HISTOGRAM_BINS)
    throw new Error(`The histogram supports at most ${MAX_HISTOGRAM_BINS} bins.`);
  const result = Array.from({ length: bins }, (_, i) => ({
    start: min + i * width,
    end: i === bins - 1 && (range || binning?.mode !== "width") ? max : min + (i + 1) * width,
    count: 0,
  }));
  for (const value of samples) {
    const index = result.findIndex((bin) => value < bin.end);
    result[index < 0 ? bins - 1 : index]!.count++;
  }
  return result;
}

function summarizeMock(
  request: ChartRequest,
  columns: string[],
  rows: DataValue[][],
  startRow = 0,
): ChartData {
  const x = columns.indexOf(request.x);
  const y = request.y && request.bar?.aggregate !== "count" ? columns.indexOf(request.y) : -1;
  const filter = request.filter ? columns.indexOf(request.filter.columnId) : -1;
  const id = request.scatterLabel ? columns.indexOf(request.scatterLabel) : -1;
  const data: ChartData = {
    totalRows: rows.length,
    validRows: 0,
    excludedRows: 0,
    filteredRows: 0,
    groupsTruncated: false,
    sampled: false,
  };
  const points: [number, number][] = [];
  const pointDetails: NonNullable<ChartData["pointDetails"]> = [];
  const lineBuckets = new Map<number, { sum: number; count: number }>();
  const histogramOutside = { below: 0, above: 0 };
  const samples: number[] = [];
  const groups = new Map<string, number[]>();
  const detail = request.detail;
  const range = detail?.kind === "range" ? detail : undefined;
  const inRange = (x: number, y?: number) =>
    !range ||
    (x >= range.x[0] &&
      x <= range.x[1] &&
      (!range.y || (y !== undefined && y >= range.y[0] && y <= range.y[1])));
  let temporalOrigin: number | undefined;
  const aggregateLine =
    request.kind === "line" &&
    request.line?.aggregate !== undefined &&
    request.line.aggregate !== "raw";
  for (const [rowIndex, row] of rows.entries()) {
    if (request.filter && row[filter]?.display !== request.filter.equals) {
      data.filteredRows += 1;
      continue;
    }
    const rawX = numeric(row[x], request.xScale);
    const rawY = y < 0 ? 1 : numeric(row[y], aggregateLine ? undefined : request.yScale);
    const category = row[x]?.display;
    const plottedX =
      request.kind === "scatter" || request.kind === "line" || request.kind === "histogram";
    const plottedY = request.kind !== "histogram";
    const xv = scaleValue(rawX, request.xScale);
    const yv = aggregateLine ? rawY : scaleValue(rawY, request.yScale);
    if (
      (plottedX ? !Number.isFinite(rawX) : category == null) ||
      (plottedY && !Number.isFinite(rawY))
    ) {
      data.excludedRows++;
      continue;
    }
    if ((plottedX && !Number.isFinite(xv)) || (plottedY && !Number.isFinite(yv))) {
      data.excludedRows++;
      data.scaleExcludedRows = (data.scaleExcludedRows ?? 0) + 1;
      continue;
    }
    if (request.kind === "scatter") {
      if (!inRange(xv, yv)) continue;
      points.push([xv, yv]);
      const extent = data.scatterExtent ?? [xv, xv, yv, yv];
      data.scatterExtent = [
        Math.min(extent[0]!, xv),
        Math.max(extent[1]!, xv),
        Math.min(extent[2]!, yv),
        Math.max(extent[3]!, yv),
      ];
      const label = row[id]?.sourceDisplay ?? row[id]?.display;
      pointDetails.push({
        row: startRow + rowIndex + 1,
        x: row[x]?.sourceDisplay ?? row[x]?.display ?? String(rawX),
        y: row[y]?.sourceDisplay ?? row[y]?.display ?? String(rawY),
        ...(label == null ? {} : { label }),
      });
    } else if (request.kind === "line") {
      const temporal =
        row[x]?.kind === "date" ? "days" : row[x]?.kind === "timestamp" ? "ns" : null;
      if (temporal && temporalOrigin === undefined) {
        temporalOrigin = rawX;
        const iso = new Date(temporalOrigin).toISOString();
        data.xUnit = temporal;
        data.xOrigin = temporal === "days" ? iso.slice(0, 10) : iso;
      }
      const toCoordinate = (value: number) =>
        temporalOrigin === undefined
          ? value
          : (value - temporalOrigin) * (data.xUnit === "days" ? 1 / 86_400_000 : 1e6);
      if (aggregateLine) {
        const interval = (request.line?.bucketSeconds ?? 0) * 1000;
        const key = toCoordinate(interval > 0 ? Math.floor(xv / interval) * interval : xv);
        if (!inRange(key)) continue;
        const bucket = lineBuckets.get(key) ?? { sum: 0, count: 0 };
        bucket.sum += rawY;
        bucket.count++;
        lineBuckets.set(key, bucket);
      } else {
        const coordinate = toCoordinate(xv);
        if (!inRange(coordinate)) continue;
        points.push([coordinate, yv]);
      }
    } else if (request.kind === "histogram") {
      const range = request.histogramRange;
      if (range && (xv < range.min || xv > range.max)) {
        histogramOutside[xv < range.min ? "below" : "above"]++;
        data.excludedRows++;
        continue;
      }
      if (!inRange(xv) && request.histogram?.mode !== "width") continue;
      samples.push(xv);
    } else {
      const group = category!;
      if (detail?.kind === "group" && detail.label !== group) continue;
      const values = groups.get(group) ?? [];
      values.push(yv);
      groups.set(group, values);
    }
    data.validRows++;
  }
  if (request.kind === "line") {
    for (const [key, { sum, count }] of lineBuckets) {
      const value = scaleValue(
        request.line?.aggregate === "mean" ? sum / count : sum,
        request.yScale,
      );
      if (Number.isFinite(value)) points.push([key, value]);
      else {
        data.validRows -= count;
        data.excludedRows += count;
        data.scaleExcludedRows = (data.scaleExcludedRows ?? 0) + count;
      }
    }
    const ordered = points.sort((a, b) => a[0] - b[0]);
    data.points = ordered;
    if (ordered.length > 20_000) summarizeMockLine(ordered, data);
  } else if (request.kind === "scatter") {
    if (points.length > 20_000 && data.scatterExtent) {
      data.sampled = true;
      data.scatterTiles = mockScatterTiles(points, data.scatterExtent);
    }
    data.points = points.slice(0, 20_000);
    data.pointDetails = pointDetails.slice(0, 20_000);
  } else if (request.kind === "histogram") {
    const binRange =
      range && request.histogram?.mode !== "width"
        ? { min: range.x[0], max: range.x[1] }
        : request.histogramRange;
    data.bins = mockHistogram(samples, request.histogram, binRange);
    if (range && request.histogram?.mode === "width") {
      data.validRows = samples.filter((value) => inRange(value)).length;
      data.bins = data.bins.filter(({ start, end }) => start <= range.x[1] && end >= range.x[0]);
    }
    if (request.histogramRange) data.histogramOutside = histogramOutside;
  } else if (request.kind === "bar") {
    const result = [...groups].map(([label, values]) => {
      const sum = values.reduce((total, value) => total + value, 0);
      return {
        label,
        count: values.length,
        value: request.bar?.aggregate === "mean" ? sum / values.length : sum,
      };
    });
    data.groupCount = result.length;
    if (request.bar) {
      const { aggregate, sort, limit } = request.bar;
      if (aggregate !== "mean") data.barTotal = result.reduce((sum, group) => sum + group.value, 0);
      result.sort((a, b) => {
        const byValue =
          sort === "asc" ? a.value - b.value : sort === "desc" ? b.value - a.value : 0;
        return byValue || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
      });
      data.groups = result.slice(0, limit);
    } else data.groups = result.slice(0, 32);
    data.groupDirectory = mockGroupDirectory(result, detail);
    data.groupsTruncated = result.length > data.groups.length;
  } else {
    data.groupCount = groups.size;
    data.groupDirectory = mockGroupDirectory(
      [...groups].map(([label, values]) => ({ label, count: values.length })),
      detail,
    );
    if (detail?.kind === "groups") return data;
    data.groups = [...groups]
      .slice(0, 32)
      .map(([label, values]) => mockDistribution(request, label, values));
    data.groupsTruncated = groups.size > data.groups.length;
    data.sampled = data.groups.some((group) => (group.sampleCount ?? 0) < group.count);
  }
  return data;
}

function summarizeMockLine(ordered: [number, number][], data: ChartData) {
  const xMin = ordered[0][0];
  const xMax = ordered[ordered.length - 1][0];
  const width = (xMax - xMin) / 5_000;
  type Point = [number, number];
  const buckets = new Map<
    number,
    { first: Point; last: Point; min: Point; max: Point; count: number }
  >();
  for (const point of ordered) {
    const key = width === 0 ? 0 : Math.min(4_999, Math.floor((point[0] - xMin) / width));
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { first: point, last: point, min: point, max: point, count: 1 });
      continue;
    }
    bucket.last = point;
    if (point[1] < bucket.min[1]) bucket.min = point;
    if (point[1] > bucket.max[1]) bucket.max = point;
    bucket.count++;
  }
  data.sampled = true;
  data.lineBuckets = Array.from(buckets, ([key, bucket]) => [
    xMin + key * width,
    xMin + (key + 1) * width,
    bucket.min[1],
    bucket.max[1],
    bucket.count,
  ]);
  data.points = [...buckets.values()]
    .flatMap(({ first, last, min, max }) => [...new Set([first, last, min, max])])
    .sort((a, b) => a[0] - b[0]);
}

function mockGroupDirectory(
  entries: NonNullable<ChartData["groupDirectory"]>["entries"],
  detail: ChartRequest["detail"],
): NonNullable<ChartData["groupDirectory"]> {
  const search = detail?.kind === "groups" ? detail.search?.trim().toLowerCase() : undefined;
  const matches = search
    ? entries.filter(({ label }) => label.toLowerCase().includes(search))
    : entries;
  const offset = detail?.kind === "groups" ? detail.offset : 0;
  return { total: matches.length, offset, entries: matches.slice(offset, offset + 32) };
}

function mockDistribution(request: ChartRequest, label: string, values: number[]) {
  values.sort((a, b) => a - b);
  const count = values.length;
  const sample =
    count <= 2048
      ? values
      : Array.from({ length: 2048 }, (_, index) => values[Math.floor((index * count) / 2048)]!);
  function quantile(probability: number) {
    const position = probability * (sample.length - 1);
    const lower = Math.floor(position);
    const a = sample[lower]!;
    return a + (sample[Math.ceil(position)]! - a) * (position - lower);
  }
  const min = values[0]!;
  const max = values[count - 1]!;
  const q1 = quantile(0.25);
  const q3 = quantile(0.75);
  const summary: [number, number, number, number, number] = [min, q1, quantile(0.5), q3, max];
  const iqr = q3 - q1;
  const lower = request.kind === "box" && request.whiskers !== "iqr" ? min : q1 - 1.5 * iqr;
  const upper = request.kind === "box" && request.whiskers !== "iqr" ? max : q3 + 1.5 * iqr;
  const inliers = values.filter((value) => value >= lower && value <= upper);
  const outliers = values.filter((value) => value < lower || value > upper);
  const whiskers: [number, number] = [inliers[0] ?? min, inliers[inliers.length - 1] ?? max];
  const density: [number, number][] =
    request.kind === "violin" && max > min
      ? Array.from({ length: 32 }, (_, i) => {
          const value = min + (i * (max - min)) / 31;
          const band = Math.max((max - min) / 10, Number.EPSILON) * (request.violinBandwidth ?? 1);
          return [
            value,
            sample.reduce((sum, v) => sum + Math.exp(-0.5 * ((value - v) / band) ** 2), 0),
          ];
        })
      : [];
  const peak = Math.max(1e-10, ...density.map((entry) => entry[1]));
  for (const entry of density) entry[1] /= peak;
  return {
    label,
    count,
    sampleCount: sample.length,
    summary,
    density,
    whiskers,
    outlierCount: outliers.length,
    outliers:
      outliers.length > 128
        ? [...outliers.slice(0, 127), outliers[outliers.length - 1]!]
        : outliers,
    ...(count <= 128 ? { observations: values } : {}),
  };
}
