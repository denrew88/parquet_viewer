// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import {
  browserMockBackend,
  createDefaultBackend,
  DataViewerError,
  parseDataPage,
  parseDataValue,
  parseCsvParsingProfile,
  parseCsvProfilePreviewResponse,
  parseCsvValidationStatus,
  parseFileSummary,
  parseFormatDescriptor,
  parseQueryPlan,
  parseQueryStatus,
  parseDistinctValuesResponse,
  parseFindQueryMatchResponse,
  parseQueryTempCleanupResult,
  parseQueryTempUsage,
  parseOpenDataRequest,
  parseOpenDataResponse,
  parseOpenFileResponse,
  parseOpenedDataFile,
  parseSupportedFormats,
  tauriBackend,
  type CsvParsingProfileWire,
} from "./backend";
import { defaultAppSettings } from "./settings/model";

const validSummary = {
  sessionId: "session-1",
  fileName: "fixture.parquet",
  path: "C:\\fixtures\\fixture.parquet",
  format: "parquet",
  formatDescriptor: {
    id: "parquet",
    displayName: "Parquet",
    extensions: ["parquet"],
    mimeTypes: ["application/vnd.apache.parquet"],
    capabilities: ["typedSchema", "columnProjection", "rowGroups"],
  },
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
  formatDetails: [
    {
      id: "parquet-row-groups",
      title: "Row groups",
      kind: "table",
      columns: ["Index", "Rows"],
      rows: [["0", "1"]],
      truncated: false,
    },
  ],
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
  formatDescriptor: {
    id: "csv",
    displayName: "CSV",
    extensions: ["csv"],
    mimeTypes: ["text/csv"],
    capabilities: ["columnProjection", "backgroundRowCount"],
  },
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
  formatDetails: [
    {
      id: "csv-parsing",
      title: "CSV parsing",
      kind: "keyValue",
      entries: [{ label: "Encoding", value: "utf-8" }],
    },
  ],
};

const validCsvProfile: CsvParsingProfileWire = {
  mode: "auto" as const,
  generation: 3,
  columns: ["name", "note", "empty"].map((sourceName, sourceIndex) => ({
    sourceIndex,
    sourceName,
    targetType: "auto" as const,
    trim: false,
    nullTokens: ["NULL", "N/A"],
    trueTokens: ["true", "TRUE", "1"],
    falseTokens: ["false", "FALSE", "0"],
    decimalSeparator: ".",
    thousandSeparator: null,
    temporalFormats: [],
    timezonePolicy: "preserve" as const,
    timezoneOffsetMinutes: null,
    failurePolicy: "preserveInvalid" as const,
  })),
};

function validCsvPreview(generation = validCsvProfile.generation) {
  const profile = { ...validCsvProfile, generation };
  return {
    documentId: "document-csv",
    sessionId: "csv-session",
    preview: {
      generation,
      stage: "leading" as const,
      profile,
      columns: profile.columns.map((column) => ({
        sourceIndex: column.sourceIndex,
        sourceName: column.sourceName,
        recommendedType: "text" as const,
        confidence: 0.98,
        targetType: "text" as const,
        successCount: 1,
        nullCount: 0,
        invalidCount: 0,
      })),
      rows: [
        {
          sourceRow: 0,
          cells: ["Kim", "note", ""].map((raw) => ({
            raw,
            converted: {
              kind: "string",
              display: raw,
              state: raw === "" ? "empty" : "valid",
              rawDisplay: raw,
              diagnostic: null,
            },
          })),
        },
      ],
    },
  };
}

function validCsvValidation(state: "queued" | "running" | "complete" = "queued") {
  return {
    taskId: "csv-task-1",
    documentId: "document-csv",
    sessionId: "csv-session",
    generation: validCsvProfile.generation,
    state,
    rowsScanned: state === "complete" ? 1 : 0,
    totalRows: 1,
    columns: validCsvProfile.columns.map((column) => ({
      sourceIndex: column.sourceIndex,
      sourceName: column.sourceName,
      successCount: state === "complete" ? 1 : 0,
      nullCount: 0,
      invalidCount: 0,
      firstErrorRow: null,
      errorSamples: [],
    })),
    error: null,
  };
}

const validQueryPlan = {
  filters: [
    {
      id: "filter:value",
      columnId: "value",
      scalarType: "text" as const,
      operator: "contains" as const,
      values: ["alpha"],
    },
  ],
  search: null,
  sort: [{ columnId: "value", direction: "ascending" as const, nullsLast: true as const }],
  projection: [],
};

function validQueryStatus(state: "queued" | "running" | "complete" = "queued") {
  return {
    documentId: "document-1",
    sessionId: "session-1",
    queryId: "query-1",
    taskId: "task-1",
    state,
    progress: {
      rowsScanned: state === "complete" ? 1 : 0,
      totalRows: 1,
      resultRows: state === "complete" ? 1 : 0,
    },
    columns: ["value"],
    elapsedMs: state === "complete" ? 25 : 0,
    findMatchCount: null,
    error: null,
  };
}

describe("backend adapters", () => {
  it("uses the explicit browser mock outside a Tauri runtime", async () => {
    expect(createDefaultBackend()).toBe(browserMockBackend);
    await expect(browserMockBackend.healthCheck()).resolves.toEqual({
      status: "ok",
      appVersion: "browser-mock",
    });
    await expect(browserMockBackend.listSupportedFormats()).resolves.toEqual([
      expect.objectContaining({ id: "csv", extensions: ["csv"] }),
      expect.objectContaining({ id: "parquet", extensions: ["parquet"] }),
      expect.objectContaining({ id: "oesHdf5", extensions: ["h5", "hdf5"] }),
    ]);
  });

  it("FMT-007 validates the supported-format command response", async () => {
    const formats = [validCsvSummary.formatDescriptor, validSummary.formatDescriptor];
    invokeMock.mockResolvedValueOnce(formats);

    await expect(tauriBackend.listSupportedFormats()).resolves.toEqual(formats);
    expect(invokeMock).toHaveBeenLastCalledWith("list_supported_formats", undefined);
    expect(parseSupportedFormats(formats)).toEqual(formats);
  });

  it("strictly validates settings returned by the Tauri commands", async () => {
    const settings = {
      ...defaultAppSettings(),
      csvDefaultParsingMode: "allText" as const,
    };
    invokeMock.mockResolvedValueOnce(settings).mockResolvedValueOnce(settings);

    await expect(tauriBackend.getSettings()).resolves.toEqual(settings);
    expect(invokeMock).toHaveBeenLastCalledWith("get_settings", undefined);
    await expect(tauriBackend.updateSettings(settings)).resolves.toEqual(settings);
    expect(invokeMock).toHaveBeenLastCalledWith("update_settings", { settings });
  });

  it("CSV-001/012 sends exact CSV profile command arguments and validates identities", async () => {
    const previewRequest = {
      documentId: "document-csv",
      sessionId: "csv-session",
      generation: validCsvProfile.generation,
      profile: validCsvProfile,
    };
    const validationRequest = { ...previewRequest, taskId: "csv-task-1" };
    const appliedSummary = { ...validCsvSummary, sessionId: "csv-session-profile-3" };
    invokeMock
      .mockResolvedValueOnce({
        documentId: "document-csv",
        sessionId: "csv-session",
        profile: validCsvProfile,
      })
      .mockResolvedValueOnce(validCsvPreview())
      .mockResolvedValueOnce(validCsvValidation())
      .mockResolvedValueOnce(validCsvValidation("running"))
      .mockResolvedValueOnce({ ...validCsvValidation(), state: "cancelled" })
      .mockResolvedValueOnce({
        documentId: "document-csv",
        sessionId: "csv-session-profile-3",
        summary: appliedSummary,
      });

    await tauriBackend.getCsvProfile("document-csv", "csv-session");
    expect(invokeMock).toHaveBeenLastCalledWith("get_csv_profile", {
      documentId: "document-csv",
      sessionId: "csv-session",
    });
    await tauriBackend.previewCsvProfile(previewRequest);
    expect(invokeMock).toHaveBeenLastCalledWith("preview_csv_profile", {
      request: previewRequest,
    });
    await tauriBackend.validateCsvProfile(validationRequest);
    expect(invokeMock).toHaveBeenLastCalledWith("validate_csv_profile", {
      request: validationRequest,
    });
    await tauriBackend.getCsvProfileValidationStatus("document-csv", "csv-session", "csv-task-1");
    expect(invokeMock).toHaveBeenLastCalledWith("get_csv_profile_validation_status", {
      documentId: "document-csv",
      sessionId: "csv-session",
      taskId: "csv-task-1",
    });
    await tauriBackend.cancelCsvProfileValidation("document-csv", "csv-session", "csv-task-1");
    await expect(
      tauriBackend.applyCsvProfile({
        documentId: "document-csv",
        sessionId: "csv-session",
        profile: validCsvProfile,
      }),
    ).resolves.toMatchObject({ sessionId: "csv-session-profile-3" });
    expect(invokeMock).toHaveBeenLastCalledWith("apply_csv_profile", {
      request: {
        documentId: "document-csv",
        sessionId: "csv-session",
        profile: validCsvProfile,
      },
    });
  });

  it("CSV-003/014 rejects malformed profile, preview, cell-state, and validation DTOs", () => {
    expect(() =>
      parseCsvParsingProfile({
        ...validCsvProfile,
        columns: validCsvProfile.columns.map((column, index) =>
          index === 0 ? { ...column, timezoneOffsetMinutes: 60 } : column,
        ),
      }),
    ).toThrow(DataViewerError);
    const preview = validCsvPreview();
    expect(() =>
      parseCsvProfilePreviewResponse({
        ...preview,
        preview: {
          ...preview.preview,
          rows: [{ sourceRow: 0, cells: preview.preview.rows[0].cells.slice(1) }],
        },
      }),
    ).toThrow(DataViewerError);
    expect(
      parseDataValue({
        kind: "int",
        display: "bad",
        state: "invalid",
        rawDisplay: "bad",
        diagnostic: { code: "csvConversion", message: "Expected Int64" },
      }),
    ).toEqual(expect.objectContaining({ state: "invalid", rawDisplay: "bad" }));
    expect(
      parseDataValue({
        kind: "int",
        display: "bad",
        state: "invalid",
        rawDisplay: "bad",
        diagnostic: null,
      }),
    ).toBeNull();
    expect(() => parseCsvValidationStatus({ ...validCsvValidation(), taskId: "" })).toThrow(
      DataViewerError,
    );
  });

  it("accepts matching separators for integer profiles but rejects them for fractional profiles", () => {
    for (const targetType of ["auto", "int64", "uint64"] as const) {
      expect(() =>
        parseCsvParsingProfile({
          ...validCsvProfile,
          columns: validCsvProfile.columns.map((column, index) =>
            index === 0
              ? {
                  ...column,
                  targetType,
                  decimalSeparator: ".",
                  thousandSeparator: ".",
                }
              : column,
          ),
        }),
      ).not.toThrow();
    }

    for (const targetType of ["float64", "decimal"] as const) {
      expect(() =>
        parseCsvParsingProfile({
          ...validCsvProfile,
          columns: validCsvProfile.columns.map((column, index) =>
            index === 0
              ? {
                  ...column,
                  targetType,
                  decimalSeparator: ".",
                  thousandSeparator: ".",
                }
              : column,
          ),
        }),
      ).toThrow("invalid CSV profile");
    }
  });

  it("accepts the canonical Rust camelCase UInt64 preview spelling", () => {
    const response = validCsvPreview();
    const canonical = {
      ...response,
      preview: {
        ...response.preview,
        profile: {
          ...response.preview.profile,
          columns: response.preview.profile.columns.map((column, index) =>
            index === 0 ? { ...column, targetType: "uint64" as const } : column,
          ),
        },
        columns: response.preview.columns.map((column, index) =>
          index === 0
            ? {
                ...column,
                recommendedType: "uint64" as const,
                targetType: "uint64" as const,
              }
            : column,
        ),
      },
    };
    expect(parseCsvProfilePreviewResponse(canonical).preview.columns[0]).toMatchObject({
      recommendedType: "uint64",
      targetType: "uint64",
    });
    expect(() =>
      parseCsvProfilePreviewResponse({
        ...canonical,
        preview: {
          ...canonical.preview,
          columns: canonical.preview.columns.map((column, index) =>
            index === 0 ? { ...column, recommendedType: "uInt64" } : column,
          ),
        },
      }),
    ).toThrow(DataViewerError);
  });

  it("CSV-015 rejects valid-shaped responses belonging to another request", async () => {
    invokeMock
      .mockResolvedValueOnce({
        documentId: "another-document",
        sessionId: "csv-session",
        profile: validCsvProfile,
      })
      .mockResolvedValueOnce({
        ...validCsvPreview(validCsvProfile.generation + 1),
        documentId: "document-csv",
      })
      .mockResolvedValueOnce({ ...validCsvValidation(), taskId: "another-task" });

    await expect(tauriBackend.getCsvProfile("document-csv", "csv-session")).rejects.toThrow(
      "another document",
    );
    await expect(
      tauriBackend.previewCsvProfile({
        documentId: "document-csv",
        sessionId: "csv-session",
        generation: validCsvProfile.generation,
        profile: validCsvProfile,
      }),
    ).rejects.toThrow("another profile generation");
    await expect(
      tauriBackend.getCsvProfileValidationStatus("document-csv", "csv-session", "csv-task-1"),
    ).rejects.toThrow("another CSV validation task");
  });

  it("QRY-001 sends exact query, result, distinct, find, cancel, and temp commands", async () => {
    const executeRequest = {
      documentId: "document-1",
      sessionId: "session-1",
      queryId: "query-1",
      taskId: "task-1",
      plan: validQueryPlan,
    };
    const pageRequest = {
      documentId: "document-1",
      sessionId: "session-1",
      queryId: "query-1",
      offset: 0,
      limit: 200,
    };
    const distinctRequest = {
      documentId: "document-1",
      sessionId: "session-1",
      queryId: "query-1",
      columnId: "value",
      search: null,
      offset: 0,
      limit: 100,
    };
    const findRequest = {
      documentId: "document-1",
      sessionId: "session-1",
      queryId: "query-1",
      fromResultOffset: 0,
      fromMatchIndex: null,
      direction: "next" as const,
      wrap: true,
    };
    invokeMock
      .mockResolvedValueOnce(validQueryStatus())
      .mockResolvedValueOnce(validQueryStatus("running"))
      .mockResolvedValueOnce({
        documentId: "document-1",
        sessionId: "session-1",
        queryId: "query-1",
        page: Object.fromEntries(Object.entries(validPage).filter(([key]) => key !== "sessionId")),
      })
      .mockResolvedValueOnce({
        documentId: "document-1",
        sessionId: "session-1",
        queryId: "query-1",
        columnId: "value",
        values: [{ value: "alpha", isNull: false, isInvalid: false, count: 1 }],
        hasMore: false,
      })
      .mockResolvedValueOnce({
        documentId: "document-1",
        sessionId: "session-1",
        queryId: "query-1",
        match: {
          rowOffset: 0,
          columnId: "value",
          matchIndex: 0,
          totalMatches: 1,
          wrapped: false,
        },
      })
      .mockResolvedValueOnce({ ...validQueryStatus(), state: "cancelled" })
      .mockResolvedValueOnce({
        processBytes: 10,
        limitBytes: 1_000,
        availableBytes: 20_000,
        activeQueries: 0,
      })
      .mockResolvedValueOnce({
        deletedBytes: 10,
        orphanFailureCount: 0,
        cleanupFailures: [],
        remainingUsage: {
          processBytes: 0,
          limitBytes: 1_000,
          availableBytes: 20_010,
          activeQueries: 0,
        },
      });

    await tauriBackend.executeQuery(executeRequest);
    expect(invokeMock).toHaveBeenLastCalledWith("execute_query", { request: executeRequest });
    await tauriBackend.getQueryStatus("document-1", "session-1", "query-1", "task-1");
    await expect(tauriBackend.readQueryPage(pageRequest)).resolves.toMatchObject({
      page: { sessionId: "session-1" },
    });
    expect(invokeMock).toHaveBeenLastCalledWith("read_query_page", { request: pageRequest });
    await tauriBackend.listDistinctValues(distinctRequest);
    expect(invokeMock).toHaveBeenLastCalledWith("list_distinct_values", {
      request: distinctRequest,
    });
    await tauriBackend.findQueryMatch(findRequest);
    expect(invokeMock).toHaveBeenLastCalledWith("find_query_match", { request: findRequest });
    await tauriBackend.cancelQuery("document-1", "session-1", "query-1", "task-1");
    expect(invokeMock).toHaveBeenLastCalledWith("cancel_query", {
      documentId: "document-1",
      sessionId: "session-1",
      queryId: "query-1",
      taskId: "task-1",
    });
    await tauriBackend.getQueryTempUsage();
    expect(invokeMock).toHaveBeenLastCalledWith("get_query_temp_usage", undefined);
    await tauriBackend.clearQueryTemp();
    expect(invokeMock).toHaveBeenLastCalledWith("clear_query_temp", undefined);
  });

  it("QRY-002 rejects malformed query DTOs and cross-task responses", async () => {
    expect(() => parseQueryPlan({ ...validQueryPlan, projection: ["value", "value"] })).toThrow(
      DataViewerError,
    );
    expect(() =>
      parseQueryStatus({
        ...validQueryStatus(),
        progress: { rowsScanned: 2, totalRows: 1, resultRows: 0 },
      }),
    ).toThrow(DataViewerError);
    expect(() =>
      parseDistinctValuesResponse({
        documentId: "document-1",
        sessionId: "session-1",
        queryId: null,
        columnId: "value",
        values: [{ value: "not-null", isNull: true, isInvalid: false, count: 1 }],
        hasMore: false,
      }),
    ).toThrow(DataViewerError);
    expect(() =>
      parseFindQueryMatchResponse({
        documentId: "document-1",
        sessionId: "session-1",
        queryId: "query-1",
        match: { rowOffset: 0, columnId: "value", matchIndex: 1, totalMatches: 1, wrapped: false },
      }),
    ).toThrow(DataViewerError);
    expect(() => parseQueryTempUsage({ processBytes: -1 })).toThrow(DataViewerError);
    expect(() =>
      parseQueryTempCleanupResult({
        deletedBytes: 10,
        orphanFailureCount: 1,
        cleanupFailures: [],
        remainingUsage: {
          processBytes: 0,
          limitBytes: 1_000,
          availableBytes: 20_010,
          activeQueries: 0,
        },
      }),
    ).toThrow(DataViewerError);

    invokeMock.mockResolvedValueOnce({ ...validQueryStatus(), taskId: "another-task" });
    await expect(
      tauriBackend.executeQuery({
        documentId: "document-1",
        sessionId: "session-1",
        queryId: "query-1",
        taskId: "task-1",
        plan: validQueryPlan,
      }),
    ).rejects.toThrow("another task");
  });

  it("rejects invalid settings before invoking an atomic update", async () => {
    const callCount = invokeMock.mock.calls.length;
    const invalid = { ...defaultAppSettings(), queryTempLimitBytes: -1 };

    await expect(
      tauriBackend.updateSettings(invalid as unknown as ReturnType<typeof defaultAppSettings>),
    ).rejects.toThrow("queryTempLimitBytes");
    expect(invokeMock).toHaveBeenCalledTimes(callCount);
  });

  it("keeps the browser mock's last valid settings after a rejected write", async () => {
    const original = await browserMockBackend.getSettings();
    const changed = {
      ...original,
      csvDefaultParsingMode: "askEveryTime" as const,
      queryTempLimitBytes: 512 * 1024 * 1024,
    };
    try {
      await expect(browserMockBackend.updateSettings(changed)).resolves.toEqual(changed);
      await expect(browserMockBackend.getSettings()).resolves.toEqual(changed);
      await expect(
        browserMockBackend.updateSettings({
          ...changed,
          queryTempLimitBytes: 0,
        } as unknown as ReturnType<typeof defaultAppSettings>),
      ).rejects.toThrow("queryTempLimitBytes");
      await expect(browserMockBackend.getSettings()).resolves.toEqual(changed);
    } finally {
      await browserMockBackend.updateSettings(original);
    }
  });

  it.each([
    ["empty id", { ...validSummary.formatDescriptor, id: "" }],
    ["dotted extension", { ...validSummary.formatDescriptor, extensions: [".parquet"] }],
    ["uppercase extension", { ...validSummary.formatDescriptor, extensions: ["PARQUET"] }],
    [
      "duplicate extension",
      { ...validSummary.formatDescriptor, extensions: ["parquet", "parquet"] },
    ],
    ["blank capability", { ...validSummary.formatDescriptor, capabilities: [""] }],
  ])("rejects malformed format descriptors: %s", (_name, descriptor) => {
    expect(() => parseFormatDescriptor(descriptor)).toThrow(DataViewerError);
  });

  it("rejects catalogs with an extension claimed by multiple descriptors", () => {
    expect(() =>
      parseSupportedFormats([
        validSummary.formatDescriptor,
        { ...validCsvSummary.formatDescriptor, extensions: ["parquet"] },
      ]),
    ).toThrow(DataViewerError);
  });

  it("accepts a generic format summary without adding a format-id parser branch", () => {
    const parsed = parseFileSummary({
      ...validSummary,
      format: "test-table",
      formatDescriptor: {
        id: "test-table",
        displayName: "Test Table",
        extensions: ["table"],
        mimeTypes: ["application/x-test-table"],
        capabilities: ["columnProjection", "futureCapability"],
      },
      rowGroupCount: 0,
      rowGroups: [],
      formatDetails: [
        {
          id: "test-details",
          title: "Test details",
          kind: "keyValue",
          entries: [{ label: "Version", value: "1" }],
        },
      ],
    });

    expect(parsed.formatDescriptor?.capabilities).toContain("futureCapability");
    expect(parsed.formatDetails?.[0]).toEqual(
      expect.objectContaining({ id: "test-details", kind: "keyValue" }),
    );
  });

  it("rejects malformed generic table details", () => {
    expect(() =>
      parseFileSummary({
        ...validSummary,
        formatDetails: [
          {
            id: "broken-table",
            title: "Broken table",
            kind: "table",
            columns: ["A", "B"],
            rows: [["one cell"]],
            truncated: false,
          },
        ],
      }),
    ).toThrow(DataViewerError);
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
