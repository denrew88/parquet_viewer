// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import {
  browserMockBackend,
  createDefaultBackend,
  DataViewerError,
  parseDataPage,
  parseFileSummary,
  parseOpenDataRequest,
  parseOpenDataResponse,
  parseOpenFileResponse,
  parseOpenedDataFile,
  tauriBackend,
} from "./backend";

const validSummary = {
  sessionId: "session-1",
  fileName: "fixture.parquet",
  path: "C:\\fixtures\\fixture.parquet",
  format: "parquet",
  fileSize: 512,
  rowCount: 1,
  rowCountStatus: {
    state: "complete",
    rowsScanned: 1,
    bytesScanned: 512,
    totalBytes: 512,
    generation: 0,
    message: null,
  },
  columnCount: 1,
  rowGroupCount: 1,
  columns: [{ name: "value", logicalType: "Utf8", nullable: true, physicalType: "BYTE_ARRAY" }],
  rowGroups: [
    {
      index: 0,
      rowCount: 1,
      totalByteSize: 100,
      compressedSize: 64,
      compression: ["SNAPPY"],
      statisticsColumnCount: 1,
    },
  ],
  csvMetadata: null,
};

const validPage = {
  sessionId: "session-1",
  offset: 0,
  limit: 200,
  totalRows: 1,
  hasMore: false,
  columns: ["value"],
  rows: [[{ kind: "string", display: "" }]],
};

const validCsvSummary = {
  sessionId: "csv-session",
  fileName: "quoted.csv",
  path: "C:\\fixtures\\quoted.csv",
  format: "csv",
  fileSize: 100,
  rowCount: null,
  rowCountStatus: {
    state: "calculating",
    rowsScanned: 2,
    bytesScanned: 50,
    totalBytes: 100,
    generation: 3,
    message: null,
  },
  columnCount: 3,
  rowGroupCount: 0,
  columns: ["name", "note", "empty"].map((name) => ({
    name,
    logicalType: "Utf8",
    nullable: false,
    physicalType: "UTF8",
  })),
  rowGroups: [],
  csvMetadata: {
    delimiter: ",",
    encoding: "utf-8",
    headerMode: "auto",
    suggestedHeader: true,
    headerUsed: true,
    structureIssueCount: 1,
    structureIssues: [{ row: 4, expectedColumns: 3, actualColumns: 2 }],
    rawHeaderCount: 3,
    rawHeaders: ["name", "note", "empty"],
    rawHeadersTruncated: false,
    headerIssueCount: 0,
    headerIssues: [],
  },
};

describe("backend adapters", () => {
  it("uses the explicit browser mock outside a Tauri runtime", async () => {
    expect(createDefaultBackend()).toBe(browserMockBackend);
    await expect(browserMockBackend.healthCheck()).resolves.toEqual({
      status: "ok",
      appVersion: "browser-mock",
    });
  });

  it("forwards open cancellation to the Tauri request command", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await tauriBackend.cancelOpenRequest("frontend-dragDrop-9");

    expect(invokeMock).toHaveBeenCalledWith("cancel_open_request", {
      requestId: "frontend-dragDrop-9",
    });
  });

  it("cancels a browser mock open request as one batch", async () => {
    const request = parseOpenDataRequest({
      requestId: "browser-cancel-batch",
      origin: "dragDrop",
      paths: ["C:\\alpha.csv", "C:\\beta.parquet"],
    });
    const opening = browserMockBackend.openDataFile(request);
    await browserMockBackend.cancelOpenRequest(request.requestId);
    const response = await opening;
    if (!("opened" in response)) throw new Error("Expected a batch open response.");

    expect(response.opened).toHaveLength(0);
    expect(response.failures).toHaveLength(2);
    expect(
      response.failures.every((failure) => failure.error.code === "OpenRequestCancelled"),
    ).toBe(true);
  });

  it("accepts a complete summary and page while preserving empty strings", () => {
    expect(parseFileSummary(validSummary)).toEqual(validSummary);
    expect(parseDataPage(validPage)).toEqual(validPage);
  });

  it("accepts a calculating CSV summary and an unknown-total preview page", () => {
    expect(parseFileSummary(validCsvSummary)).toEqual(validCsvSummary);
    expect(
      parseDataPage({
        ...validPage,
        sessionId: "csv-session",
        totalRows: null,
        hasMore: true,
        columns: ["name", "note", "empty"],
        rows: [
          [
            { kind: "string", display: "Kim, Mina" },
            { kind: "string", display: "line one\nline two" },
            { kind: "string", display: "" },
          ],
        ],
      }).rows[0],
    ).toEqual([
      { kind: "string", display: "Kim, Mina" },
      { kind: "string", display: "line one\nline two" },
      { kind: "string", display: "" },
    ]);
  });

  it.each([
    ["missing CSV metadata", { ...validCsvSummary, csvMetadata: null }],
    [
      "invalid delimiter",
      { ...validCsvSummary, csvMetadata: { ...validCsvSummary.csvMetadata, delimiter: ";" } },
    ],
    [
      "invalid header mode",
      { ...validCsvSummary, csvMetadata: { ...validCsvSummary.csvMetadata, headerMode: "guess" } },
    ],
    [
      "issue count underflow",
      {
        ...validCsvSummary,
        csvMetadata: { ...validCsvSummary.csvMetadata, structureIssueCount: 0 },
      },
    ],
    [
      "raw header truncation mismatch",
      {
        ...validCsvSummary,
        csvMetadata: { ...validCsvSummary.csvMetadata, rawHeadersTruncated: true },
      },
    ],
    [
      "invalid header issue column",
      {
        ...validCsvSummary,
        csvMetadata: {
          ...validCsvSummary.csvMetadata,
          headerIssueCount: 1,
          headerIssues: [
            { columnIndex: 3, rawName: "name", resolvedName: "name_2", reason: "duplicate" },
          ],
        },
      },
    ],
    [
      "invalid progress",
      {
        ...validCsvSummary,
        rowCountStatus: { ...validCsvSummary.rowCountStatus, bytesScanned: 101 },
      },
    ],
    [
      "complete without row count",
      {
        ...validCsvSummary,
        rowCountStatus: { ...validCsvSummary.rowCountStatus, state: "complete" },
      },
    ],
    ["CSV row groups", { ...validCsvSummary, rowGroupCount: 1, rowGroups: validSummary.rowGroups }],
  ])("rejects malformed CSV summaries: %s", (_name, value) => {
    expect(() => parseFileSummary(value)).toThrowError(DataViewerError);
  });

  it("requires hasMore while the CSV total is unknown", () => {
    expect(() => parseDataPage({ ...validPage, totalRows: null, hasMore: undefined })).toThrowError(
      DataViewerError,
    );
  });

  it.each([
    ["int", "9223372036854775807"],
    ["decimal", "1234567890.123456789"],
    ["date", "1969-12-31"],
    ["timestamp", "2026-07-14T12:34:56.123456789+09:00"],
    ["binary", "base64:AAECAwQ= (5 bytes)"],
    ["list", "[1,null,9223372036854775807]"],
    ["struct", '{"id":1,"nested":{"active":true}}'],
    ["map", '{"key":18446744073709551615}'],
    ["unsupported", "Duration(Millisecond)"],
  ])("accepts exact string display for %s values", (kind, display) => {
    const parsed = parseDataPage({
      ...validPage,
      rows: [[{ kind, display }]],
    });
    expect(parsed.rows[0][0]).toEqual({ kind, display });
  });

  it("accepts a normal empty page at and beyond EOF", () => {
    expect(parseDataPage({ ...validPage, offset: 1, rows: [] }).rows).toEqual([]);
    expect(parseDataPage({ ...validPage, offset: 99, rows: [] }).offset).toBe(99);
  });

  it.each([
    ["missing session", { ...validSummary, sessionId: "" }],
    ["fractional row count", { ...validSummary, rowCount: 1.5 }],
    ["column count mismatch", { ...validSummary, columnCount: 2 }],
    ["malformed column", { ...validSummary, columns: [{ name: "value" }] }],
    ["missing row groups", { ...validSummary, rowGroups: undefined }],
    ["row group count mismatch", { ...validSummary, rowGroupCount: 2 }],
    [
      "row group index mismatch",
      { ...validSummary, rowGroups: [{ ...validSummary.rowGroups[0], index: 1 }] },
    ],
    [
      "row group rows mismatch",
      { ...validSummary, rowGroups: [{ ...validSummary.rowGroups[0], rowCount: 2 }] },
    ],
    [
      "invalid compression",
      { ...validSummary, rowGroups: [{ ...validSummary.rowGroups[0], compression: [""] }] },
    ],
    [
      "statistics exceed columns",
      { ...validSummary, rowGroups: [{ ...validSummary.rowGroups[0], statisticsColumnCount: 2 }] },
    ],
  ])("rejects malformed summary DTOs: %s", (_name, value) => {
    expect(() => parseFileSummary(value)).toThrowError(DataViewerError);
    expect(() => parseFileSummary(value)).toThrowError("invalid file summary");
  });

  it.each([
    ["zero limit", { ...validPage, limit: 0 }],
    ["limit over cap", { ...validPage, limit: 201 }],
    ["row width mismatch", { ...validPage, rows: [[]] }],
    ["premature empty page", { ...validPage, rows: [] }],
    ["invalid null representation", { ...validPage, rows: [[{ kind: "null", display: "null" }]] }],
    [
      "precision sent as a number",
      { ...validPage, rows: [[{ kind: "int", display: 9_007_199_254_740_992 }]] },
    ],
    ["page beyond total", { ...validPage, rows: [validPage.rows[0], validPage.rows[0]] }],
  ])("rejects malformed page DTOs: %s", (_name, value) => {
    expect(() => parseDataPage(value)).toThrowError(DataViewerError);
    expect(() => parseDataPage(value)).toThrowError("invalid data page");
  });

  it("parses a platform open request and merges its session into the result DTOs", () => {
    const request = parseOpenDataRequest({
      requestId: "startup-1",
      origin: "startupArg",
      paths: ["C:\\fixtures\\fixture.parquet"],
    });
    const summaryWithoutSession = { ...validSummary, sessionId: undefined };
    const pageWithoutSession = { ...validPage, sessionId: undefined };

    expect(
      parseOpenedDataFile(
        {
          requestId: request.requestId,
          origin: request.origin,
          sessionId: "session-1",
          summary: summaryWithoutSession,
          initialPage: pageWithoutSession,
        },
        request,
      ),
    ).toEqual({
      requestId: "startup-1",
      origin: "startupArg",
      summary: validSummary,
      initialPage: validPage,
    });
  });

  it("parses ordered batch open results with partial failures and document identities", () => {
    const request = parseOpenDataRequest({
      requestId: "drop-batch-1",
      origin: "dragDrop",
      paths: ["C:\\fixtures\\fixture.parquet", "C:\\fixtures\\broken.csv"],
    });
    const response = parseOpenDataResponse(
      {
        requestId: request.requestId,
        origin: request.origin,
        opened: [
          {
            itemIndex: 0,
            path: request.paths[0],
            disposition: "opened",
            documentId: "document-1",
            sessionId: "session-1",
            summary: { ...validSummary, sessionId: undefined },
            initialPage: { ...validPage, sessionId: undefined },
          },
        ],
        failures: [
          {
            itemIndex: 1,
            path: request.paths[1],
            error: { code: "InvalidCsv", message: "Malformed row." },
          },
        ],
        activeDocumentId: "document-1",
      },
      request,
    );

    expect(response.opened[0]).toMatchObject({
      documentId: "document-1",
      sessionId: "session-1",
      disposition: "opened",
    });
    expect(response.opened[0].summary.sessionId).toBe("session-1");
    expect(response.failures[0].error.code).toBe("InvalidCsv");
    expect(response.activeDocumentId).toBe("document-1");
  });

  it.each([
    [
      "drive device prefix",
      "C:\\fixtures\\fixture.parquet",
      "\\\\?\\C:\\fixtures\\fixture.parquet",
    ],
    [
      "UNC device prefix",
      "\\\\server\\share\\fixture.parquet",
      "\\\\?\\UNC\\SERVER\\SHARE\\fixture.parquet",
    ],
    [
      "slash, drive case, and trailing separator",
      "c:/fixtures/fixture.parquet/",
      "C:\\fixtures\\fixture.parquet",
    ],
  ])(
    "matches requested Windows paths after normalizing %s",
    (_name, requestedPath, responsePath) => {
      const request = parseOpenDataRequest({
        requestId: "windows-canonical-path",
        origin: "dragDrop",
        paths: [requestedPath],
      });
      const response = parseOpenDataResponse(
        {
          requestId: request.requestId,
          origin: request.origin,
          opened: [
            {
              itemIndex: 0,
              path: responsePath,
              disposition: "opened",
              documentId: "document-1",
              sessionId: "session-1",
              summary: { ...validSummary, sessionId: undefined },
              initialPage: { ...validPage, sessionId: undefined },
            },
          ],
          failures: [],
          activeDocumentId: "document-1",
        },
        request,
      );

      expect(response.opened[0].path).toBe(responsePath);
    },
  );

  it.each([
    [
      "duplicate item indexes",
      {
        opened: [
          {
            itemIndex: 0,
            path: "C:\\fixtures\\fixture.parquet",
            disposition: "opened",
            documentId: "document-1",
            sessionId: "session-1",
            summary: { ...validSummary, sessionId: undefined },
            initialPage: { ...validPage, sessionId: undefined },
          },
        ],
        failures: [
          {
            itemIndex: 0,
            path: "C:\\fixtures\\broken.csv",
            error: { code: "InvalidCsv", message: "Malformed row." },
          },
        ],
        activeDocumentId: "document-1",
      },
    ],
    [
      "mismatched request path",
      {
        opened: [
          {
            itemIndex: 0,
            path: "C:\\fixtures\\other.parquet",
            disposition: "opened",
            documentId: "document-1",
            sessionId: "session-1",
            summary: { ...validSummary, sessionId: undefined },
            initialPage: { ...validPage, sessionId: undefined },
          },
        ],
        failures: [
          {
            itemIndex: 1,
            path: "C:\\fixtures\\broken.csv",
            error: { code: "InvalidCsv", message: "Malformed row." },
          },
        ],
        activeDocumentId: "document-1",
      },
    ],
    [
      "unknown active document",
      {
        opened: [
          {
            itemIndex: 0,
            path: "C:\\fixtures\\fixture.parquet",
            disposition: "opened",
            documentId: "document-1",
            sessionId: "session-1",
            summary: { ...validSummary, sessionId: undefined },
            initialPage: { ...validPage, sessionId: undefined },
          },
        ],
        failures: [
          {
            itemIndex: 1,
            path: "C:\\fixtures\\broken.csv",
            error: { code: "InvalidCsv", message: "Malformed row." },
          },
        ],
        activeDocumentId: "document-unknown",
      },
    ],
  ])("rejects a batch open response with %s", (_name, result) => {
    const request = parseOpenDataRequest({
      requestId: "drop-batch-invalid",
      origin: "dragDrop",
      paths: ["C:\\fixtures\\fixture.parquet", "C:\\fixtures\\broken.csv"],
    });
    expect(() =>
      parseOpenDataResponse(
        { requestId: request.requestId, origin: request.origin, ...result },
        request,
      ),
    ).toThrowError(DataViewerError);
  });

  it("parses the document-scoped select_data_file response before exposing its summary", () => {
    const response = parseOpenFileResponse({
      documentId: "document-selected-1",
      sessionId: "session-1",
      summary: { ...validSummary, sessionId: undefined },
      initialPage: { ...validPage, sessionId: undefined },
    });

    expect(response).toEqual({
      documentId: "document-selected-1",
      sessionId: "session-1",
      summary: validSummary,
      initialPage: validPage,
    });
  });

  it("rejects a selected file response whose first page does not match the summary", () => {
    expect(() =>
      parseOpenFileResponse({
        documentId: "document-selected-1",
        sessionId: "session-1",
        summary: { ...validSummary, sessionId: undefined },
        initialPage: {
          ...validPage,
          sessionId: undefined,
          totalRows: validPage.totalRows! + 1,
          hasMore: true,
        },
      }),
    ).toThrowError("does not match its summary");
  });

  it("keeps browser mock CSV configuration isolated by session", async () => {
    const request = parseOpenDataRequest({
      requestId: "browser-two-csv",
      origin: "dragDrop",
      paths: ["C:\\alpha\\same.csv", "C:\\beta\\same.csv"],
    });
    const response = await browserMockBackend.openDataFile(request);
    if (!("opened" in response)) throw new Error("Expected a batch open response.");
    const [first, second] = response.opened;

    const configured = await browserMockBackend.configureCsv(
      first.documentId,
      first.sessionId,
      "absent",
    );
    const firstStatus = await browserMockBackend.getDataFileStatus(
      first.documentId,
      first.sessionId,
    );
    const secondStatus = await browserMockBackend.getDataFileStatus(
      second.documentId,
      second.sessionId,
    );
    const configuredSummary = "summary" in configured ? configured.summary : configured;
    const firstSummary = "summary" in firstStatus ? firstStatus.summary : firstStatus;
    const secondSummary = "summary" in secondStatus ? secondStatus.summary : secondStatus;

    expect(configuredSummary.csvMetadata?.headerMode).toBe("absent");
    expect(firstSummary.csvMetadata?.headerMode).toBe("absent");
    expect(firstSummary.rowCountStatus.generation).toBe(2);
    expect(secondSummary.csvMetadata?.headerMode).toBe("auto");
    expect(secondSummary.rowCountStatus.generation).toBe(1);
  });

  it.each([
    ["empty request id", { requestId: "", origin: "dragDrop", paths: ["a.csv"] }],
    ["unknown origin", { requestId: "1", origin: "drop", paths: ["a.csv"] }],
    ["empty path", { requestId: "1", origin: "dragDrop", paths: [""] }],
    ["non-array paths", { requestId: "1", origin: "dragDrop", paths: "a.csv" }],
  ])("rejects malformed platform requests: %s", (_name, request) => {
    expect(() => parseOpenDataRequest(request)).toThrowError(DataViewerError);
  });

  it("preserves typed platform errors and rejects mismatched response identities", () => {
    const request = parseOpenDataRequest({
      requestId: "drop-1",
      origin: "dragDrop",
      paths: ["C:\\fixtures\\fixture.parquet"],
    });
    expect(() =>
      parseOpenedDataFile(
        {
          requestId: "drop-1",
          origin: "dragDrop",
          error: { code: "MultipleFilesNotSupported", message: "Open one file." },
        },
        request,
      ),
    ).toThrowError("Open one file.");
    expect(() =>
      parseOpenedDataFile(
        {
          requestId: "drop-2",
          origin: "dragDrop",
          error: { code: "InvalidParquet", message: "Damaged." },
        },
        request,
      ),
    ).toThrowError("does not match");
  });
});
