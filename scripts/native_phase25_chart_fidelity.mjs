import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const round = (value) => Math.round(value * 10) / 10;

export async function verifyPhase25ChartFidelity({ fixtureDir, openSources, invoke }) {
  const golden = JSON.parse(await fs.readFile(path.join(fixtureDir, "golden.json"), "utf8"));
  const files = Object.keys(golden.files);
  for (const file of files) {
    const sha256 = createHash("sha256").update(await fs.readFile(path.join(fixtureDir, file))).digest("hex");
    assert.equal(sha256, golden.files[file]);
  }
  const inputs = await openSources(files.map((file) => path.join(fixtureDir, file)));
  const observations = [];
  for (const [index, identity] of inputs.entries()) {
    const source = { kind: "file", ...identity };
    const run = (options, detail) => invoke("compute_chart", {
      request: { requestId: `p25-fidelity-${randomUUID()}`, source, ...options },
      ...(detail ? { detail } : {}),
    });
    const scatter = { kind: "scatter", x: "x", y: "y" };
    let start = performance.now();
    const overview = await run(scatter);
    const overviewMs = round(performance.now() - start);
    assert.equal(overview.validRows, golden.rows);
    assert.equal(overview.points.length, 20_000);
    const tiles = overview.scatterTiles;
    assert.equal(tiles.reduce((count, tile) => count + tile[4], 0), golden.rows);
    const [x, y] = golden.rarePoint;
    assert.ok(tiles.some(([xMin, xMax, yMin, yMax, count]) =>
      xMin <= x && x <= xMax && yMin <= y && y <= yMax && count === 1));
    const selection = { kind: "range", x: [x - 0.5, x], y: [y - 0.5, y] };
    start = performance.now();
    const detail = await run(scatter, selection);
    const prepareDetailMs = round(performance.now() - start);
    assert.equal(detail.validRows, 1);
    assert.deepEqual(detail.points, [[x, y]]);
    const warm = [];
    for (let i = 0; i < 20; i++) {
      const startX = 1 + i * 4;
      start = performance.now();
      const result = await run(scatter, { kind: "range", x: [startX, startX + 0.001], y: [0, 10] });
      warm.push(performance.now() - start);
      assert.ok(result.validRows >= 10 && result.validRows <= 11);
      assert.equal(result.points.length, result.validRows);
    }
    start = performance.now();
    const repeated = await run(scatter, selection);
    const repeatMs = round(performance.now() - start);
    assert.deepEqual(repeated.points, detail.points);
    warm.sort((a, b) => a - b);
    observations.push({
      file: files[index], overviewMs, prepareDetailMs, repeatMs,
      warmP50Ms: round(warm[9]), warmP95Ms: round(warm[18]), rareTileRows: 1,
    });
    if (index !== 0) continue;

    const line = { kind: "line", x: "x", y: "y", line: { aggregate: "raw" } };
    const reduced = await run(line);
    assert.ok(reduced.lineBuckets.some((bucket) => bucket[3] === 1_000));
    const lineDetail = await run(line, { kind: "range", x: [x - 0.5, x] });
    assert.deepEqual(lineDetail.points, [[x, y]]);

    const histogram = { kind: "histogram", x: "x", histogram: { mode: "count", count: 40 } };
    const histogramOverview = await run(histogram);
    assert.ok(histogramOverview.bins.some(({ count }) => count === 0));
    assert.equal(histogramOverview.bins[histogramOverview.bins.length - 1].count, 1);
    const histogramDetail = await run(histogram, { kind: "range", x: [x - 0.5, x] });
    assert.equal(histogramDetail.bins.reduce((sum, { count }) => sum + count, 0), 1);

    for (const kind of ["bar", "box", "violin"]) {
      const options = {
        kind,
        x: "category",
        ...(kind === "bar"
          ? { bar: { aggregate: "count", sort: "desc", limit: 8 } }
          : { y: "y", ...(kind === "box" ? { whiskers: "iqr" } : {}) }),
      };
      const initial = await run(options);
      assert.equal(initial.groupCount, golden.groupCount);
      const directory = await run(options, { kind: "groups", offset: 0, search: "Rare group" });
      assert.equal(directory.groupDirectory.total, 1);
      assert.equal(directory.groupDirectory.entries[0].count, 1);
      if (kind !== "bar") {
        const group = await run(options, { kind: "group", label: "Rare group" });
        assert.equal(group.groups[0].count, 1);
        assert.deepEqual(group.groups[0].observations, [y]);
      }
    }
  }
  return { rowsPerFile: golden.rows, observations };
}
