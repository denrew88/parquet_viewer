use std::sync::{mpsc, Mutex};

use crate::domain::{DataPage, ValueKind};

use super::*;

struct TestReader {
    rows: Vec<Vec<DataValue>>,
    columns: Vec<String>,
    batch_size: usize,
}

impl TestReader {
    fn new(columns: &[&str], rows: Vec<Vec<DataValue>>, batch_size: usize) -> Self {
        Self {
            columns: columns.iter().map(|column| (*column).to_owned()).collect(),
            rows,
            batch_size,
        }
    }
}

impl CopyRowReader for TestReader {
    fn read_rows(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        let positions = columns
            .iter()
            .map(|column| {
                self.columns
                    .iter()
                    .position(|name| name == column)
                    .ok_or_else(|| invalid("Unknown test column."))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let rows = self
            .rows
            .iter()
            .skip(offset as usize)
            .take(limit.min(self.batch_size))
            .map(|row| positions.iter().map(|index| row[*index].clone()).collect())
            .collect::<Vec<_>>();
        Ok(DataPage {
            offset,
            limit,
            total_rows: Some(self.rows.len() as u64),
            has_more: offset + (rows.len() as u64) < self.rows.len() as u64,
            columns: columns.to_vec(),
            rows,
        })
    }
}

fn int(value: impl ToString) -> DataValue {
    DataValue::displayed(ValueKind::Int, value.to_string())
}

fn text(value: &str) -> DataValue {
    DataValue::displayed(ValueKind::String, value)
}

fn request(kind: ChartKind, x: &str, y: Option<&str>) -> ChartRequest {
    ChartRequest {
        request_id: "chart-test".to_owned(),
        source: ChartSource::File {
            document_id: "document".to_owned(),
            session_id: "session".to_owned(),
            query_id: None,
        },
        kind,
        x: x.to_owned(),
        y: y.map(str::to_owned),
        filter: None,
        x_scale: ChartScale::Linear,
        y_scale: ChartScale::Linear,
        histogram: None,
        violin_bandwidth: None,
        scatter_label: None,
        line: None,
        histogram_range: None,
        whiskers: None,
        bar: None,
    }
}

fn compute(
    kind: ChartKind,
    x: &str,
    y: Option<&str>,
    columns: &[&str],
    rows: Vec<Vec<DataValue>>,
) -> ChartData {
    compute_request(&request(kind, x, y), columns, rows).unwrap()
}

fn compute_request(
    request: &ChartRequest,
    columns: &[&str],
    rows: Vec<Vec<DataValue>>,
) -> Result<ChartData, DataError> {
    ChartStore::default().compute(request, Some(Arc::new(TestReader::new(columns, rows, 3))))
}

#[test]
fn wire_envelope_rejects_unknown_fields_and_reuses_projection_indices() {
    let raw = serde_json::json!({
        "requestId": "job-1",
        "source": { "kind": "sql", "runId": "run-2", "resultId": "r", "viewId": "v" },
        "kind": "scatter",
        "x": "amount",
        "y": "amount",
        "filter": { "columnId": "amount", "equals": "12" }
    });
    let request: ChartRequest = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(request.x_scale, ChartScale::Linear);
    assert_eq!(request.y_scale, ChartScale::Linear);
    assert!(request.histogram.is_none());
    assert!(request.violin_bandwidth.is_none());
    assert!(request.scatter_label.is_none());
    assert!(request.line.is_none());
    assert!(request.histogram_range.is_none());
    assert!(request.whiskers.is_none());
    assert!(request.bar.is_none());
    let projection = request.projection().unwrap();
    assert_eq!(projection.columns, ["amount"]);
    assert_eq!(projection.y, Some(0));
    assert_eq!(projection.filter, Some(0));
    let mut unknown = raw;
    unknown["source"]["path"] = serde_json::Value::String("file.csv".to_owned());
    assert!(serde_json::from_value::<ChartRequest>(unknown).is_err());

    let output = ChartData {
        points: Some(vec![[1.0, 2.0]]),
        ..ChartData::default()
    };
    assert_eq!(
        serde_json::to_value(output).unwrap(),
        serde_json::json!({
            "totalRows": 0,
            "validRows": 0,
            "excludedRows": 0,
            "filteredRows": 0,
            "sampled": false,
            "groupsTruncated": false,
            "points": [[1.0, 2.0]],
        })
    );
}

#[test]
fn analytical_wire_fields_validate_chart_type_and_bounds() {
    let mut raw = serde_json::json!({
        "requestId": "line",
        "source": { "kind": "block", "blockId": "block" },
        "kind": "line",
        "x": "time",
        "y": "revenue",
        "line": { "aggregate": "sum", "bucketSeconds": 3600 }
    });
    let projection = |raw| {
        serde_json::from_value::<ChartRequest>(raw)
            .unwrap()
            .projection()
    };
    assert!(projection(raw.clone()).is_ok());
    raw["line"]["aggregate"] = "raw".into();
    assert!(projection(raw.clone()).is_err());
    raw["line"] = serde_json::json!({"aggregate":"mean","bucketSeconds":0.0000000001});
    assert!(projection(raw.clone()).is_err());
    raw["line"] = serde_json::Value::Null;
    raw["scatterLabel"] = "customer".into();
    assert!(projection(raw.clone()).is_err());
    raw["scatterLabel"] = serde_json::Value::Null;
    raw["histogramRange"] = serde_json::json!({ "min": 0, "max": 1 });
    assert!(projection(raw.clone()).is_err());
    raw["kind"] = "histogram".into();
    raw["y"] = serde_json::Value::Null;
    assert!(projection(raw.clone()).is_ok());
    raw["histogramRange"]["max"] = 0.into();
    assert!(projection(raw.clone()).is_err());
    raw["histogramRange"] = serde_json::Value::Null;
    raw["kind"] = "box".into();
    raw["y"] = "revenue".into();
    raw["whiskers"] = "minmax".into();
    assert!(projection(raw.clone()).is_ok());
    raw["kind"] = "violin".into();
    assert!(projection(raw.clone()).is_err());
    raw["whiskers"] = serde_json::Value::Null;
    raw["kind"] = "bar".into();
    raw["bar"] = serde_json::json!({"aggregate": "mean", "sort": "desc", "limit": 32});
    assert!(projection(raw.clone()).is_ok());
    raw["bar"]["limit"] = 33.into();
    assert!(projection(raw.clone()).is_err());
    raw["bar"]["limit"] = 1.into();
    raw["y"] = serde_json::Value::Null;
    assert!(projection(raw.clone()).is_err());
    raw["bar"]["aggregate"] = "count".into();
    assert!(projection(raw).is_ok());
}

#[test]
fn scatter_details_preserve_canonical_axes_label_and_original_block_row() {
    let store = ChartStore::default();
    let label = "한".repeat(60);
    let rows = vec![
        vec![int(0), int(0), text("outside")],
        vec![int(1), int(1), text("outside")],
        vec![
            int(u64::MAX - 1),
            DataValue::converted(ValueKind::Decimal, "round", "raw").with_source("4.125"),
            text(&label),
        ],
        vec![DataValue::null(), int(2), text("invalid")],
        vec![int(u64::MAX), int(3), DataValue::null()],
    ];
    store
        .capture(
            "details",
            Arc::new(TestReader::new(&["x", "y", "label"], rows, 1)),
            &CopySelectionSnapshot {
                row_start: 2,
                row_end_exclusive: 5,
                column_ids: vec!["x".to_owned(), "y".to_owned(), "label".to_owned()],
            },
        )
        .unwrap();
    let mut request = request(ChartKind::Scatter, "x", Some("y"));
    request.source = ChartSource::Block {
        block_id: "details".to_owned(),
    };
    request.scatter_label = Some("label".to_owned());
    let chart = store.compute(&request, None).unwrap();
    let points = chart.points.unwrap();
    let details = chart.point_details.unwrap();
    assert_eq!(points.len(), details.len());
    assert_eq!((details[0].row, details[1].row), (3, 5));
    assert_eq!(details[0].x, (u64::MAX - 1).to_string());
    assert_eq!(details[0].y, "4.125");
    let label = details[0].label.as_deref().unwrap();
    assert!(label.len() <= 128 && label.ends_with('…'));
    assert!(details[1].label.is_none());
}

#[test]
fn line_aggregates_canonical_x_and_raw_y_before_final_scale() {
    let mut request = request(ChartKind::Line, "x", Some("y"));
    request.line = Some(LineOptions {
        aggregate: LineAggregate::Mean,
        bucket_seconds: None,
    });
    request.y_scale = ChartScale::Log10;
    let rows = [
        ("1.0", 1),
        ("1.00", 100),
        ("2", -100),
        ("2.00", 0),
        ("3", -1),
        ("3", 21),
    ]
    .into_iter()
    .map(|(x, y)| vec![DataValue::displayed(ValueKind::Decimal, x), int(y)])
    .collect();
    let chart = compute_request(&request, &["x", "y"], rows).unwrap();
    assert_eq!(chart.points.unwrap(), [[1.0, 50.5_f64.log10()], [3.0, 1.0]]);
    assert_eq!(
        (
            chart.valid_rows,
            chart.excluded_rows,
            chart.scale_excluded_rows
        ),
        (4, 2, 2)
    );
    assert!(chart.y_origin.is_none());
}

#[test]
fn line_time_buckets_are_absolute_across_epoch_and_keep_origin_offsets() {
    let mut request = request(ChartKind::Line, "time", Some("y"));
    request.line = Some(LineOptions {
        aggregate: LineAggregate::Sum,
        bucket_seconds: Some(10.0),
    });
    let rows = [
        ("1969-12-31T23:59:58Z", 1),
        ("1970-01-01T00:00:01Z", 2),
        ("1969-12-31T23:59:59Z", 4),
    ]
    .into_iter()
    .map(|(time, y)| vec![DataValue::displayed(ValueKind::Timestamp, time), int(y)])
    .collect();
    let chart = compute_request(&request, &["time", "y"], rows).unwrap();
    assert_eq!(chart.x_unit, Some("ns"));
    assert_eq!(chart.x_origin.as_deref(), Some("1969-12-31T23:59:58Z"));
    assert_eq!(
        chart.points.unwrap(),
        [[-8_000_000_000.0, 5.0], [2_000_000_000.0, 2.0]]
    );
    assert!(compute_request(&request, &["time", "y"], vec![vec![int(3), int(5)]]).is_err());
}

#[test]
fn reduced_raw_line_keeps_peaks_troughs_and_x_endpoints() {
    let peak = 21_050;
    let trough = 21_051;
    let end = 22_000;
    let rows = (0..=end)
        .rev()
        .map(|x| {
            let y = match x {
                x if x == peak => 1_000_000,
                x if x == trough => -1_000_000,
                _ => 0,
            };
            vec![int(x), int(y)]
        })
        .collect();
    let request = request(ChartKind::Line, "x", Some("y"));
    let chart = ChartStore::default()
        .compute(
            &request,
            Some(Arc::new(TestReader::new(&["x", "y"], rows, 4_096))),
        )
        .unwrap();
    assert!(chart.sampled);
    let points = chart.points.unwrap();
    assert!(points.len() <= 20_000);
    assert_eq!(points.first(), Some(&[0.0, 0.0]));
    assert_eq!(points.last(), Some(&[f64::from(end), 0.0]));
    assert!(points.contains(&[f64::from(peak), 1_000_000.0]));
    assert!(points.contains(&[f64::from(trough), -1_000_000.0]));
}

#[test]
fn locked_histogram_counts_outside_rows_and_clips_final_width() {
    let mut request = request(ChartKind::Histogram, "x", None);
    request.histogram_range = Some(HistogramRange {
        min: -1.0,
        max: 4.0,
    });
    request.histogram = Some(HistogramOptions::Width { width: 1.5 });
    let chart = compute_request(
        &request,
        &["x"],
        [-2, -1, 0, 1, 2, 4, 5]
            .into_iter()
            .map(|x| vec![int(x)])
            .collect(),
    )
    .unwrap();
    assert_eq!(
        chart.histogram_outside,
        Some(HistogramOutside { below: 1, above: 1 })
    );
    assert_eq!((chart.valid_rows, chart.excluded_rows), (5, 2));
    let bins = chart.bins.unwrap();
    assert_eq!(
        bins.last().unwrap(),
        &ChartBin {
            start: 3.5,
            end: 4.0,
            count: 1
        }
    );
    assert_eq!(bins.iter().map(|bin| bin.count).sum::<u64>(), 5);
    let empty = compute_request(&request, &["x"], vec![vec![int(99)]]).unwrap();
    assert_eq!(empty.bins.unwrap().len(), 4);
    assert!(compute_request(&request, &["x"], vec![vec![int(u64::MAX)]]).is_err());
    assert!(compute_request(
        &request,
        &["x"],
        vec![vec![DataValue::displayed(ValueKind::Date, "2026-01-01")]]
    )
    .is_err());
}

#[test]
fn box_and_violin_report_iqr_outliers_and_minmax_preserves_legacy_summary() {
    let rows = || {
        [1, 2, 3, 4, 100]
            .into_iter()
            .map(|x| vec![text("A"), int(x)])
            .collect()
    };
    let mut request = request(ChartKind::Box, "category", Some("y"));
    let iqr = compute_request(&request, &["category", "y"], rows()).unwrap();
    let iqr = &iqr.groups.as_ref().unwrap()[0];
    assert_eq!(iqr.summary, Some([1.0, 2.0, 3.0, 4.0, 100.0]));
    assert_eq!(iqr.whiskers, Some([1.0, 4.0]));
    assert_eq!(iqr.sample_count, Some(5));
    assert_eq!(iqr.outlier_count, Some(1));
    assert_eq!(iqr.outliers.as_deref(), Some(&[100.0][..]));
    request.whiskers = Some(WhiskerMode::Minmax);
    let minmax = compute_request(&request, &["category", "y"], rows()).unwrap();
    let minmax = &minmax.groups.as_ref().unwrap()[0];
    assert_eq!(minmax.summary, iqr.summary);
    assert_eq!(minmax.whiskers, Some([1.0, 100.0]));
    assert_eq!(minmax.outlier_count, Some(0));
    assert!(minmax.outliers.as_ref().unwrap().is_empty());
    request.kind = ChartKind::Violin;
    request.whiskers = None;
    let violin = compute_request(&request, &["category", "y"], rows()).unwrap();
    let violin = &violin.groups.as_ref().unwrap()[0];
    assert_eq!(violin.whiskers, iqr.whiskers);
    assert_eq!(violin.outliers, iqr.outliers);
}

#[test]
fn outlier_scan_counts_all_rows_and_limits_rendered_dots() {
    let rows = (0..4_512)
        .map(|index| vec![text("A"), int(if index < 4_096 { 0 } else { index })])
        .collect();
    let request = request(ChartKind::Box, "g", Some("y"));
    let chart = ChartStore::default()
        .compute(
            &request,
            Some(Arc::new(TestReader::new(&["g", "y"], rows, 4_096))),
        )
        .unwrap();
    assert!(chart.sampled);
    let group = &chart.groups.as_ref().unwrap()[0];
    assert_eq!(group.sample_count, Some(2_048));
    assert_eq!(group.outlier_count, Some(416));
    assert_eq!(group.whiskers, Some([0.0, 0.0]));
    assert_eq!(group.outliers.as_ref().unwrap().len(), 128);
}

#[test]
fn bar_ranking_includes_categories_beyond_the_legacy_group_limit() {
    let rows = || {
        (0..40)
            .map(|index| {
                let label = format!("g{index:02}");
                vec![text(&label), int(if index == 39 { 1_000 } else { index })]
            })
            .collect()
    };
    let mut request = request(ChartKind::Bar, "g", Some("y"));
    request.bar = Some(BarOptions {
        aggregate: BarAggregate::Sum,
        sort: BarSort::Desc,
        limit: 2,
    });
    let bar = compute_request(&request, &["g", "y"], rows()).unwrap();
    assert_eq!(bar.group_count, Some(40));
    assert_eq!(bar.bar_total, Some(1_741.0));
    assert!(!bar.groups_truncated);
    assert_eq!(
        bar.groups
            .unwrap()
            .into_iter()
            .map(|g| g.label)
            .collect::<Vec<_>>(),
        ["g39", "g38"]
    );
    request.bar = Some(BarOptions {
        aggregate: BarAggregate::Mean,
        sort: BarSort::Asc,
        limit: 1,
    });
    let mean = compute_request(
        &request,
        &["g", "y"],
        vec![
            vec![text("b"), int(10)],
            vec![text("b"), int(2)],
            vec![text("a"), int(7)],
        ],
    )
    .unwrap();
    assert!(mean.bar_total.is_none());
    assert_eq!(mean.groups.unwrap()[0].value, Some(6.0));
    request.bar = Some(BarOptions {
        aggregate: BarAggregate::Count,
        sort: BarSort::Category,
        limit: 1,
    });
    request.y = Some("ignored".to_owned());
    let count = compute_request(&request, &["g", "y"], rows()).unwrap();
    assert_eq!(count.bar_total, Some(40.0));
    assert_eq!(count.groups.unwrap()[0].label, "g00");
}

#[test]
fn validates_nonlinear_and_statistical_options_against_the_chart_kind() {
    let decode = |kind: &str, extra: serde_json::Value| {
        let mut raw = serde_json::json!({
            "requestId": "options", "source": { "kind": "block", "blockId": "b" },
            "kind": kind, "x": "x",
        });
        if matches!(kind, "scatter" | "violin" | "box" | "line") {
            raw["y"] = serde_json::json!("y");
        }
        raw.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value::<ChartRequest>(raw)
    };
    for (kind, options) in [
        ("bar", serde_json::json!({"xScale": "log"})),
        ("bar", serde_json::json!({"yScale": "log10"})),
        ("violin", serde_json::json!({"xScale": "log1p"})),
        ("histogram", serde_json::json!({"yScale": "log"})),
        (
            "scatter",
            serde_json::json!({"histogram": {"mode": "count", "count": 2}}),
        ),
        (
            "histogram",
            serde_json::json!({"histogram": {"mode": "count", "count": 0}}),
        ),
        (
            "histogram",
            serde_json::json!({"histogram": {"mode": "count", "count": 49}}),
        ),
        (
            "histogram",
            serde_json::json!({"histogram": {"mode": "width", "width": 0}}),
        ),
        (
            "histogram",
            serde_json::json!({"histogram": {"mode": "width", "width": -1}}),
        ),
        ("box", serde_json::json!({"violinBandwidth": 1})),
        ("violin", serde_json::json!({"violinBandwidth": 0.249})),
        ("violin", serde_json::json!({"violinBandwidth": 4.001})),
    ] {
        let request = decode(kind, options.clone()).unwrap();
        assert!(request.projection().is_err(), "{kind} {options}");
    }
    for (kind, options) in [
        (
            "scatter",
            serde_json::json!({"xScale": "log10", "yScale": "log"}),
        ),
        ("line", serde_json::json!({"xScale": "log1p"})),
        (
            "histogram",
            serde_json::json!({"histogram": {"mode": "count", "count": 1}}),
        ),
        (
            "histogram",
            serde_json::json!({"histogram": {"mode": "count", "count": 48}}),
        ),
        (
            "histogram",
            serde_json::json!({"histogram": {"mode": "width", "width": 0.001}}),
        ),
        ("box", serde_json::json!({"yScale": "log10"})),
        (
            "violin",
            serde_json::json!({"yScale": "log1p", "violinBandwidth": 0.25}),
        ),
        ("violin", serde_json::json!({"violinBandwidth": 4})),
    ] {
        assert!(decode(kind, options).unwrap().projection().is_ok());
    }
    assert!(decode("scatter", serde_json::json!({"xScale": "log2"})).is_err());
    assert!(decode(
        "histogram",
        serde_json::json!({
            "histogram": {"mode": "width", "width": 1, "count": 2}
        })
    )
    .is_err());
    let mut request = request(ChartKind::Histogram, "x", None);
    request.histogram = Some(HistogramOptions::Width {
        width: f64::INFINITY,
    });
    assert!(request.projection().is_err());
}

#[test]
fn nonlinear_axes_use_absolute_canonical_numbers_and_separate_domain_exclusions() {
    let mut request = request(ChartKind::Scatter, "x", Some("y"));
    request.x_scale = ChartScale::Log10;
    request.y_scale = ChartScale::Log;
    let chart = compute_request(
        &request,
        &["x", "y"],
        vec![
            vec![
                int(100),
                DataValue::converted(ValueKind::Int, "1,000", "1,000").with_source("1000"),
            ],
            vec![int(0), int(1)],
            vec![int(-1), int(0)],
            vec![int(0), DataValue::null()],
            vec![DataValue::displayed(ValueKind::Float, "inf"), int(1)],
            vec![
                DataValue::displayed(ValueKind::Timestamp, "2026-01-01T00:00:00Z"),
                int(1),
            ],
            vec![int(u64::MAX), int(1)],
        ],
    )
    .unwrap();
    assert_eq!(chart.valid_rows, 2);
    assert_eq!(chart.excluded_rows, 5);
    assert_eq!(chart.scale_excluded_rows, 2);
    assert!(chart.x_origin.is_none() && chart.y_origin.is_none());
    assert!(chart.x_unit.is_none() && chart.y_unit.is_none());
    assert_eq!(
        chart.points.as_deref().unwrap(),
        &[[2.0, 1_000_f64.ln()], [(u64::MAX as f64).log10(), 0.0]]
    );
    assert_eq!(serde_json::to_value(chart).unwrap()["scaleExcludedRows"], 2);
}

#[test]
fn log1p_preserves_valid_decimal_values_just_above_negative_one() {
    let mut request = request(ChartKind::Line, "x", Some("y"));
    request.x_scale = ChartScale::Log1p;
    let chart = compute_request(
        &request,
        &["x", "y"],
        [
            "3",
            "-0.99999999999999999999",
            "-1",
            "-1.00000000000000000001",
            "0",
        ]
        .into_iter()
        .enumerate()
        .map(|(row, value)| vec![DataValue::displayed(ValueKind::Decimal, value), int(row)])
        .collect(),
    )
    .unwrap();
    assert_eq!(chart.valid_rows, 3);
    assert_eq!(chart.scale_excluded_rows, 2);
    let points = chart.points.unwrap();
    assert!((points[0][0] - 1e-20_f64.ln()).abs() < 1e-13);
    assert_eq!(points[0][1], 1.0);
    assert_eq!(points[1], [0.0, 4.0]);
    assert_eq!(points[2], [3_f64.ln_1p(), 0.0]);
}

#[test]
fn histogram_count_and_width_use_displayed_edges_and_include_the_final_boundary() {
    let mut request = request(ChartKind::Histogram, "x", None);
    let values = || (0..=4).map(|value| vec![int(value)]).collect();
    request.histogram = Some(HistogramOptions::Count { count: 2 });
    let count = compute_request(&request, &["x"], values()).unwrap();
    assert_eq!(
        count.bins.unwrap(),
        [
            ChartBin {
                start: 0.0,
                end: 2.0,
                count: 2
            },
            ChartBin {
                start: 2.0,
                end: 4.0,
                count: 3
            },
        ]
    );
    request.histogram = Some(HistogramOptions::Width { width: 1.5 });
    let width = compute_request(&request, &["x"], values()).unwrap();
    assert_eq!(
        width.bins.unwrap(),
        [
            ChartBin {
                start: 0.0,
                end: 1.5,
                count: 2
            },
            ChartBin {
                start: 1.5,
                end: 3.0,
                count: 1
            },
            ChartBin {
                start: 3.0,
                end: 4.5,
                count: 2
            },
        ]
    );
    let constant = compute_request(&request, &["x"], vec![vec![int(4)]; 3]).unwrap();
    assert_eq!(
        constant.bins.unwrap(),
        [ChartBin {
            start: 4.0,
            end: 5.5,
            count: 3
        }]
    );
    request.histogram = Some(HistogramOptions::Width { width: 0.3 });
    let rounded = compute_request(
        &request,
        &["x"],
        ["0.2", "0.8"]
            .into_iter()
            .map(|value| vec![DataValue::displayed(ValueKind::Decimal, value)])
            .collect(),
    )
    .unwrap();
    assert_eq!(rounded.bins.unwrap().len(), 2);
}

#[test]
fn histogram_width_obeys_48_bin_limit_and_detects_unrepresentable_bounds() {
    let mut request = request(ChartKind::Histogram, "x", None);
    request.histogram = Some(HistogramOptions::Width { width: 1.0 });
    let exact = compute_request(&request, &["x"], vec![vec![int(0)], vec![int(48)]]).unwrap();
    assert_eq!(exact.bins.unwrap().len(), 48);
    assert!(compute_request(&request, &["x"], vec![vec![int(0)], vec![int(49)]]).is_err());
    let floats = || {
        [1e308, 1e308_f64.next_up()]
            .into_iter()
            .map(|value| vec![DataValue::displayed(ValueKind::Float, value.to_string())])
            .collect()
    };
    assert!(compute_request(&request, &["x"], floats()).is_err());
    request.histogram = Some(HistogramOptions::Count { count: 48 });
    assert!(compute_request(&request, &["x"], floats()).is_err());
}

#[test]
fn nonlinear_histogram_uses_transformed_widths_and_exact_large_bin_counts() {
    let mut request = request(ChartKind::Histogram, "x", None);
    request.x_scale = ChartScale::Log10;
    request.histogram = Some(HistogramOptions::Width { width: 1.0 });
    let rows = (0..30_000)
        .map(|i| vec![int([0, 1, 10, 100, 1000][i % 5])])
        .collect();
    let chart = ChartStore::default()
        .compute(
            &request,
            Some(Arc::new(TestReader::new(&["x"], rows, 4_096))),
        )
        .unwrap();
    assert!(!chart.sampled);
    assert_eq!(chart.valid_rows, 24_000);
    assert_eq!(chart.scale_excluded_rows, 6_000);
    assert_eq!(
        chart.bins.unwrap(),
        [
            ChartBin {
                start: 0.0,
                end: 1.0,
                count: 6_000
            },
            ChartBin {
                start: 1.0,
                end: 2.0,
                count: 6_000
            },
            ChartBin {
                start: 2.0,
                end: 3.0,
                count: 12_000
            },
        ]
    );
}

#[test]
fn violin_bandwidth_changes_density_without_changing_transformed_quartiles() {
    let mut request = request(ChartKind::Violin, "group", Some("value"));
    request.y_scale = ChartScale::Log10;
    let rows = || {
        [0, 1, 10, 100, 1000]
            .into_iter()
            .map(|value| vec![text("A"), int(value)])
            .collect()
    };
    request.violin_bandwidth = Some(0.25);
    let narrow = compute_request(&request, &["group", "value"], rows()).unwrap();
    request.violin_bandwidth = Some(4.0);
    let wide = compute_request(&request, &["group", "value"], rows()).unwrap();
    assert_eq!(narrow.scale_excluded_rows, 1);
    let narrow = &narrow.groups.as_ref().unwrap()[0];
    let wide = &wide.groups.as_ref().unwrap()[0];
    assert_eq!(narrow.summary, Some([0.0, 0.75, 1.5, 2.25, 3.0]));
    assert_eq!(narrow.summary, wide.summary);
    assert_ne!(narrow.density, wide.density);
    assert_eq!(narrow.count, wide.count);
}

#[test]
fn scatter_preserves_unsigned_and_decimal_differences_before_f64() {
    let big = "99999999999999999999999999999999999999.9999";
    let next = "100000000000000000000000000000000000000.0000";
    let rows = vec![
        vec![
            int(u64::MAX - 1),
            DataValue::converted(ValueKind::Decimal, "wrong", "original").with_source(big),
        ],
        vec![
            int(u64::MAX),
            DataValue::displayed(ValueKind::Decimal, next),
        ],
    ];
    let chart = compute(ChartKind::Scatter, "x", Some("y"), &["x", "y"], rows);
    assert_eq!(chart.x_origin, Some((u64::MAX - 1).to_string()));
    assert_eq!(chart.y_origin.as_deref(), Some(big));
    let points = chart.points.unwrap();
    assert_eq!(points[0], [0.0, 0.0]);
    assert_eq!(points[1][0], 1.0);
    assert!((points[1][1] - 0.0001).abs() < 1e-15);
}

#[test]
fn line_sorts_source_timestamps_without_losing_adjacent_nanoseconds() {
    let timestamp = |raw: i64, label: &str| {
        DataValue::converted(ValueKind::Timestamp, label, "raw metadata")
            .with_source(raw.to_string())
            .with_temporal_metadata("ns", Some("UTC"))
    };
    let rows = vec![
        vec![
            timestamp(1_767_225_600_000_000_002, "2026-01-01 00:00:00.000000002"),
            int(3),
        ],
        vec![
            timestamp(1_767_225_600_000_000_000, "2026-01-01 00:00:00"),
            int(1),
        ],
        vec![
            timestamp(1_767_225_600_000_000_001, "2026-01-01 00:00:00.000000001"),
            int(2),
        ],
    ];
    let chart = compute(ChartKind::Line, "time", Some("y"), &["time", "y"], rows);
    assert_eq!(chart.x_unit, Some("ns"));
    assert_eq!(
        chart.x_origin.as_deref(),
        Some("2026-01-01 00:00:00.000000002 [UTC]")
    );
    assert_eq!(
        chart.points.unwrap(),
        [[-2.0, 1.0], [-1.0, 2.0], [0.0, 3.0]]
    );
}

#[test]
fn dates_and_csv_timestamps_use_canonical_values() {
    let a =
        DataValue::converted(ValueKind::Date, "different display", "raw").with_source("2024-02-28");
    let b = DataValue::displayed(ValueKind::Date, "2024-03-01");
    let c = DataValue::displayed(ValueKind::Timestamp, "2026-01-01T09:00:00.000000001+09:00");
    let d = DataValue::displayed(ValueKind::Timestamp, "2026-01-01T00:00:00.000000003Z");
    let chart = compute(
        ChartKind::Line,
        "date",
        Some("instant"),
        &["date", "instant"],
        vec![vec![a, c], vec![b, d]],
    );
    assert_eq!(chart.x_origin.as_deref(), Some("2024-02-28"));
    assert_eq!(chart.x_unit, Some("days"));
    assert_eq!(chart.y_unit, Some("ns"));
    assert_eq!(chart.points.unwrap(), [[0.0, 0.0], [2.0, 2.0]]);
}

#[test]
fn mixed_csv_timestamps_do_not_equate_a_local_clock_with_an_instant() {
    let timestamp = |value| DataValue::displayed(ValueKind::Timestamp, value);
    let chart = compute(
        ChartKind::Line,
        "time",
        Some("value"),
        &["time", "value"],
        vec![
            vec![timestamp("2026-01-01T09:00:00"), int(1)],
            vec![timestamp("2026-01-01T00:00:00Z"), int(2)],
            vec![timestamp("2026-01-01T09:00:00.000000001"), int(3)],
        ],
    );
    assert_eq!(chart.excluded_rows, 1);
    assert_eq!(chart.points.unwrap(), [[0.0, 1.0], [1.0, 3.0]]);
}

#[test]
fn histogram_counts_are_exact_beyond_sampling_threshold() {
    let rows = (0..25_000).map(|value| vec![int(value % 100)]).collect();
    let chart = compute(ChartKind::Histogram, "amount", None, &["amount"], rows);
    assert!(!chart.sampled);
    assert_eq!(chart.valid_rows, 25_000);
    let bins = chart.bins.unwrap();
    assert_eq!(bins.len(), 48);
    assert_eq!(bins.first().unwrap().start, 0.0);
    assert_eq!(bins.last().unwrap().end, 99.0);
    assert_eq!(bins.iter().map(|bin| bin.count).sum::<u64>(), 25_000);
    let histogram = compute(
        ChartKind::Histogram,
        "v",
        None,
        &["v"],
        vec![vec![int(7)]; 3],
    );
    assert_eq!(
        histogram.bins.unwrap(),
        [ChartBin {
            start: 7.0,
            end: 7.0,
            count: 3
        }]
    );
    let empty = compute(ChartKind::Histogram, "v", None, &["v"], vec![]);
    assert!(empty.bins.unwrap().is_empty());
}

#[test]
fn box_violin_and_bar_share_group_count_and_handle_constant_groups() {
    let rows = [1, 2, 3, 4, 5]
        .into_iter()
        .map(|value| vec![text("a"), int(value)])
        .chain([vec![text("b"), int(6)], vec![text("b"), int(6)]])
        .collect::<Vec<_>>();
    let chart = compute(ChartKind::Box, "g", Some("v"), &["g", "v"], rows.clone());
    let box_groups = chart.groups.unwrap();
    assert_eq!(box_groups[0].summary, Some([1.0, 2.0, 3.0, 4.0, 5.0]));
    assert_eq!(box_groups[1].summary, Some([6.0; 5]));
    let chart = compute(ChartKind::Violin, "g", Some("v"), &["g", "v"], rows.clone());
    let violin_groups = chart.groups.unwrap();
    assert_eq!(violin_groups[0].count, 5);
    let density = violin_groups[0].density.as_ref().unwrap();
    assert_eq!(density.len(), 41);
    assert_eq!(density.first().unwrap()[0], 1.0);
    assert_eq!(density.last().unwrap()[0], 5.0);
    assert!(density.iter().all(|item| item[1] > 0.0 && item[1] <= 1.0));
    assert!(density.iter().any(|item| item[1] == 1.0));
    assert!(violin_groups[1].density.is_none());
    let bar = compute(ChartKind::Bar, "g", Some("v"), &["g", "v"], rows.clone());
    assert_eq!(bar.groups.unwrap()[0].value, Some(15.0));
    let count = compute(ChartKind::Bar, "g", None, &["g", "v"], rows);
    assert_eq!(count.groups.unwrap()[0].value, Some(5.0));
}

#[test]
fn filtered_invalid_and_excess_groups_are_reported_separately() {
    let store = ChartStore::default();
    let mut req = request(ChartKind::Scatter, "x", Some("y"));
    req.filter = Some(ChartFilter {
        column_id: "tag".to_owned(),
        equals: "keep".to_owned(),
    });
    let rows = vec![
        vec![int(1), int(2), text("keep")],
        vec![int(3), int(4), text("drop")],
        vec![DataValue::null(), int(2), text("keep")],
        vec![
            int(3),
            DataValue::displayed(ValueKind::Float, "NaN"),
            text("keep"),
        ],
        vec![
            DataValue::invalid(ValueKind::Int, "garbage", "invalid", "invalid"),
            int(2),
            text("keep"),
        ],
    ];
    let chart = store
        .compute(
            &req,
            Some(Arc::new(TestReader::new(&["x", "y", "tag"], rows, 1))),
        )
        .unwrap();
    assert_eq!(
        (
            chart.total_rows,
            chart.valid_rows,
            chart.filtered_rows,
            chart.excluded_rows
        ),
        (5, 1, 1, 3)
    );
    let rows = (0..35)
        .map(|value| vec![DataValue::displayed(ValueKind::String, format!("g{value}"))])
        .collect();
    let chart = compute(ChartKind::Bar, "g", None, &["g"], rows);
    assert!(chart.groups_truncated);
    assert_eq!(chart.excluded_rows, 3);
    assert_eq!(chart.groups.unwrap().len(), 32);
}

#[test]
fn scatter_sampling_is_bounded_and_independent_of_read_batch_size() {
    let make_rows = || {
        (0..23_000)
            .map(|value| vec![int(value), int(value * 2)])
            .collect()
    };
    let store = ChartStore::default();
    let req = request(ChartKind::Scatter, "x", Some("y"));
    let a = store
        .compute(
            &req,
            Some(Arc::new(TestReader::new(&["x", "y"], make_rows(), 37))),
        )
        .unwrap();
    let b = store
        .compute(
            &req,
            Some(Arc::new(TestReader::new(&["x", "y"], make_rows(), 3_300))),
        )
        .unwrap();
    assert_eq!(a, b);
    assert_eq!(a.valid_rows, 23_000);
    assert!(a.sampled);
    assert_eq!(a.scatter_extent, Some([0.0, 22_999.0, 0.0, 45_998.0]));
    assert_eq!(a.points.unwrap().len(), 20_000);
}

fn svg_frame() -> ScatterSvgFrame {
    ScatterSvgFrame {
        x_min: 0.0,
        x_max: 1.0,
        y_min: 0.0,
        y_max: 1.0,
        left: 10.0,
        top: 20.0,
        width: 100.0,
        height: 200.0,
        radius: 3.0,
    }
}

#[test]
fn scatter_svg_streams_every_row_beyond_the_display_limit_and_keeps_job_cancellable() {
    let store = ChartStore::default();
    let mut req = request(ChartKind::Scatter, "x", Some("y"));
    // Labels do not affect the numeric scatter layer and need not be loaded.
    req.scatter_label = Some("label".to_owned());
    let rows = (0..23_001)
        .map(|value| vec![int(value), int(value * 2)])
        .collect();
    let reader = Arc::new(TestReader::new(&["x", "y"], rows, 113));
    let frame = ScatterSvgFrame {
        x_max: 23_000.0,
        y_max: 46_000.0,
        ..svg_frame()
    };
    let mut svg = Vec::new();
    let mut progress = Vec::new();
    let job = store
        .write_scatter_svg_points(&req, Some(reader), &frame, &mut svg, |value| {
            progress.push(value)
        })
        .unwrap();
    let svg = String::from_utf8(svg).unwrap();
    assert_eq!(svg.matches("<circle ").count(), 23_001);
    assert!(svg.contains(r#"<circle cx="10.0000" cy="220.0000" r="3.0000"/>"#));
    assert!(svg.contains(r#"<circle cx="110.0000" cy="20.0000" r="3.0000"/>"#));
    assert_eq!(progress.first(), Some(&ChartImageProgress::default()));
    assert_eq!(
        progress.last(),
        Some(&ChartImageProgress {
            scanned_rows: 23_001,
            written_points: 23_001,
        })
    );
    assert!(progress.windows(2).all(|pair| {
        pair[0].scanned_rows < pair[1].scanned_rows
            && pair[0].written_points < pair[1].written_points
    }));
    assert!(progress.len() < 20);
    store.cancel(&req.request_id).unwrap();
    assert_eq!(job.check().unwrap_err().code, DataErrorCode::TaskCancelled);
}

#[test]
fn scatter_svg_uses_source_filter_scale_and_inclusive_zoom_bounds() {
    let store = ChartStore::default();
    let mut req = request(ChartKind::Scatter, "x", Some("y"));
    req.source = ChartSource::Sql {
        run_id: "run".to_owned(),
        result_id: "result".to_owned(),
        view_id: None,
    };
    req.x_scale = ChartScale::Log10;
    req.filter = Some(ChartFilter {
        column_id: "status".to_owned(),
        equals: "keep".to_owned(),
    });
    let rows = vec![
        vec![int(1), int(2), text("keep")],
        vec![int(10), int(3), text("keep")],
        vec![int(10), int(3), text("keep")],
        vec![int(100), int(4), text("keep")],
        vec![int(1000), int(4), text("keep")],
        vec![int(10), int(4), text("hide")],
        vec![int(0), int(4), text("keep")],
        vec![int(-1), int(4), text("keep")],
        vec![DataValue::null(), int(4), text("keep")],
    ];
    let frame = ScatterSvgFrame {
        x_min: 1.0,
        x_max: 2.0,
        y_min: 3.0,
        y_max: 4.0,
        ..svg_frame()
    };
    let reader = Arc::new(TestReader::new(&["x", "y", "status"], rows, 2));
    let chart = store.compute(&req, Some(reader.clone())).unwrap();
    assert_eq!(chart.scatter_extent, Some([0.0, 3.0, 2.0, 4.0]));
    assert_eq!(chart.valid_rows, 5);
    let mut svg = Vec::new();
    let mut progress = ChartImageProgress::default();
    store
        .write_scatter_svg_points(&req, Some(reader), &frame, &mut svg, |value| {
            progress = value
        })
        .unwrap();
    let svg = String::from_utf8(svg).unwrap();
    assert_eq!(
        svg.matches(r#"<circle cx="10.0000" cy="220.0000""#).count(),
        2
    );
    assert_eq!(
        svg.matches(r#"<circle cx="110.0000" cy="20.0000""#).count(),
        1
    );
    assert_eq!(
        progress,
        ChartImageProgress {
            scanned_rows: 9,
            written_points: 3
        }
    );
}

#[test]
fn scatter_svg_keeps_block_precision_and_can_stop_mid_scan() {
    let store = ChartStore::default();
    let mut req = request(ChartKind::Scatter, "x", Some("y"));
    let mut rows = vec![vec![int(u64::MAX - 2), DataValue::null()]];
    rows.extend((0..4096).map(|_| vec![int(u64::MAX), int(1)]));
    let reader = Arc::new(TestReader::new(&["x", "y"], rows, 197));
    store
        .capture(
            "block-svg",
            reader,
            &CopySelectionSnapshot {
                row_start: 0,
                row_end_exclusive: 4097,
                column_ids: vec!["x".to_owned(), "y".to_owned()],
            },
        )
        .unwrap();
    req.source = ChartSource::Block {
        block_id: "block-svg".to_owned(),
    };
    let frame = ScatterSvgFrame {
        x_min: 1.0,
        x_max: 2.0,
        ..svg_frame()
    };
    let chart = store.compute(&req, None).unwrap();
    assert_eq!(chart.scatter_extent, Some([2.0, 2.0, 1.0, 1.0]));
    let mut svg = Vec::new();
    let error = store
        .write_scatter_svg_points(&req, None, &frame, &mut svg, |status| {
            if status.scanned_rows > 0 {
                store.cancel(&req.request_id).unwrap();
            }
        })
        .err()
        .unwrap();
    assert_eq!(error.code, DataErrorCode::TaskCancelled);
    let svg = String::from_utf8(svg).unwrap();
    assert_eq!(
        svg.matches(r#"<circle cx="110.0000" cy="20.0000""#).count(),
        2_047
    );
    assert!(!svg.ends_with("</g>\n"));
}

#[test]
fn scatter_svg_rejects_invalid_frame_before_writing() {
    let store = ChartStore::default();
    let req = request(ChartKind::Scatter, "x", Some("y"));
    let mut svg = Vec::new();
    let frame = ScatterSvgFrame {
        width: f64::INFINITY,
        ..svg_frame()
    };
    let error = store
        .write_scatter_svg_points(&req, None, &frame, &mut svg, |_| {})
        .err()
        .unwrap();
    assert_eq!(error.code, DataErrorCode::InvalidRequest);
    assert!(svg.is_empty());
}

#[test]
fn block_captures_exact_projected_range_and_release_is_idempotent() {
    let store = ChartStore::default();
    let rows = (0..180)
        .map(|value| vec![int(value), int(-value)])
        .collect();
    let reader = Arc::new(TestReader::new(&["a", "b"], rows, 3));
    let selection = CopySelectionSnapshot {
        row_start: 98,
        row_end_exclusive: 106,
        column_ids: vec!["b".to_owned(), "a".to_owned()],
    };
    store
        .capture("snapshot", reader.clone(), &selection)
        .unwrap();
    assert!(store
        .capture("snapshot", reader.clone(), &selection)
        .is_err());
    let mut req = request(ChartKind::Scatter, "b", Some("a"));
    req.source = ChartSource::Block {
        block_id: "snapshot".to_owned(),
    };
    let chart = store.compute(&req, None).unwrap();
    assert_eq!(chart.total_rows, 8);
    let points = chart.points.unwrap();
    assert_eq!(points[0], [-98.0, 98.0]);
    assert_eq!(points[7], [-105.0, 105.0]);
    let too_large = CopySelectionSnapshot {
        row_end_exclusive: 50_099,
        ..selection.clone()
    };
    assert!(store
        .capture("too-large", reader.clone(), &too_large)
        .is_err());
    let incomplete = CopySelectionSnapshot {
        row_end_exclusive: 181,
        ..selection
    };
    assert!(store.capture("incomplete", reader, &incomplete).is_err());
    assert!(!store.lock().unwrap().blocks.contains_key("incomplete"));
    store.release("snapshot").unwrap();
    store.release("snapshot").unwrap();
    assert!(store.compute(&req, None).is_err());
    assert_eq!(store.lock().unwrap().block_bytes, 0);
}

#[test]
fn wide_chart_pages_retry_at_the_same_offset_with_smaller_batches() {
    let store = ChartStore::default();
    let wide = DataValue::displayed(ValueKind::String, "a".repeat(2 * 1024 * 1024));
    let rows = (1..=3)
        .map(|value| vec![wide.clone(), int(value)])
        .collect();
    let reader = Arc::new(TestReader::new(&["wide", "amount"], rows, 10));
    let selection = CopySelectionSnapshot {
        row_start: 0,
        row_end_exclusive: 3,
        column_ids: vec!["wide".to_owned(), "amount".to_owned()],
    };
    store.capture("wide-block", reader, &selection).unwrap();
    let mut request = request(ChartKind::Histogram, "amount", None);
    request.source = ChartSource::Block {
        block_id: "wide-block".to_owned(),
    };
    let chart = store.compute(&request, None).unwrap();
    assert_eq!(chart.valid_rows, 3);
    assert_eq!(
        chart.bins.unwrap().iter().map(|bin| bin.count).sum::<u64>(),
        3
    );
}

struct PausedReader {
    entered: mpsc::Sender<()>,
    resume: Mutex<mpsc::Receiver<()>>,
}

impl CopyRowReader for PausedReader {
    fn read_rows(&self, _: u64, _: usize, _: &[String]) -> Result<DataPage, DataError> {
        self.entered.send(()).unwrap();
        self.resume.lock().unwrap().recv().unwrap();
        // A blocked source may finish its batch after cancellation. The chart
        // must reject it before processing or publishing the batch.
        Ok(DataPage {
            offset: 0,
            limit: 1,
            total_rows: Some(1),
            has_more: false,
            columns: vec!["a".to_owned()],
            rows: vec![vec![int(1)]],
        })
    }
}

#[test]
fn cancellation_discards_a_late_capture_and_releases_the_job_slot() {
    let store = ChartStore::default();
    let (entered_send, entered_receive) = mpsc::channel();
    let (resume_send, resume_receive) = mpsc::channel();
    let reader = Arc::new(PausedReader {
        entered: entered_send,
        resume: Mutex::new(resume_receive),
    });
    std::thread::scope(|scope| {
        let capture = scope.spawn(|| {
            store.capture(
                "capture-1",
                reader,
                &CopySelectionSnapshot {
                    row_start: 0,
                    row_end_exclusive: 1,
                    column_ids: vec!["a".to_owned()],
                },
            )
        });
        entered_receive.recv().unwrap();
        store.cancel("capture-1").unwrap();
        resume_send.send(()).unwrap();
        assert_eq!(
            capture.join().unwrap().unwrap_err().code,
            DataErrorCode::TaskCancelled
        );
    });
    let state = store.lock().unwrap();
    assert!(state.blocks.is_empty());
    assert!(state.jobs.is_empty());
}

#[test]
fn cancellation_before_admission_does_not_publish_a_snapshot() {
    let store = ChartStore::default();
    let reader = Arc::new(TestReader::new(&["a"], vec![vec![int(1)]], 1));
    let selection = CopySelectionSnapshot {
        row_start: 0,
        row_end_exclusive: 1,
        column_ids: vec!["a".to_owned()],
    };
    store.cancel("pre-cancelled").unwrap();
    store.release("pre-released").unwrap();
    for id in ["pre-cancelled", "pre-released"] {
        assert_eq!(
            store
                .capture(id, reader.clone(), &selection)
                .unwrap_err()
                .code,
            DataErrorCode::TaskCancelled
        );
    }
    assert!(store.lock().unwrap().blocks.is_empty());
}
