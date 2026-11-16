use super::*;
use crate::domain::ValueKind;
use std::sync::atomic::AtomicUsize;

struct LazyReader {
    rows: u64,
    reads: AtomicUsize,
}
impl CopyRowReader for LazyReader {
    fn read_rows(
        &self,
        offset: u64,
        limit: usize,
        columns: &[String],
    ) -> Result<DataPage, DataError> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        assert!(limit <= MAX_BATCH_ROWS);
        let end = offset.saturating_add(limit as u64).min(self.rows);
        Ok(DataPage {
            offset,
            limit,
            total_rows: Some(self.rows),
            has_more: end < self.rows,
            columns: columns.to_vec(),
            rows: (offset..end)
                .map(|i| {
                    columns
                        .iter()
                        .map(|c| match c.as_str() {
                            "group" => {
                                DataValue::displayed(ValueKind::String, format!("g{}", i % 2))
                            }
                            "x" => DataValue::displayed(ValueKind::Int, i.to_string()),
                            "y" => DataValue::displayed(ValueKind::Int, (i * 2).to_string()),
                            "precise" => DataValue::displayed(
                                ValueKind::Int,
                                (9_007_199_254_740_993_u64 + i).to_string(),
                            ),
                            _ => unreachable!(),
                        })
                        .collect()
                })
                .collect(),
        })
    }
}
fn request(kind: ChartKind, x: &str, y: Option<&str>) -> ChartRequest {
    serde_json::from_value(serde_json::json!({"requestId":"reference-compute","source":{"kind":"block","blockId":"reference"},"kind":kind,"x":x,"y":y})).unwrap()
}

#[test]
fn p25_reference_capture_size_and_reads_do_not_scale_with_selected_rows() {
    let reader = Arc::new(LazyReader {
        rows: 10_000_000,
        reads: AtomicUsize::new(0),
    });
    let charts = ChartStore::default();
    for (id, end) in [("small", 3), ("large", 10_000_000)] {
        charts
            .capture_reference(
                id,
                reader.clone(),
                &CopySelectionSnapshot {
                    row_start: 0,
                    row_end_exclusive: end,
                    column_ids: vec!["y".into(), "x".into()],
                },
            )
            .unwrap();
    }
    assert_eq!(reader.reads.load(Ordering::Relaxed), 0);
    {
        let state = charts.state.lock().unwrap();
        let small = &state.blocks["small"];
        let large = &state.blocks["large"];
        assert!(small.rows.is_empty() && large.rows.is_empty());
        assert_eq!(small.bytes, large.bytes);
        assert!(large.bytes < 1024);
        assert_eq!(large.row_count, 10_000_000);
    }
    let page = charts.preview_block("large", 6, &["x".into()]).unwrap();
    assert_eq!(reader.reads.load(Ordering::Relaxed), 1);
    assert_eq!(page.rows.len(), 6);
    assert_eq!(page.total_rows, Some(10_000_000));
    charts.release("small").unwrap();
    charts.release("large").unwrap();
    assert_eq!(Arc::strong_count(&reader), 1);
}

#[test]
fn p25_every_chart_uses_only_referenced_rows_and_columns() {
    let reader = Arc::new(LazyReader {
        rows: 2_000_000,
        reads: AtomicUsize::new(0),
    });
    let charts = ChartStore::default();
    charts
        .capture_reference(
            "reference",
            reader,
            &CopySelectionSnapshot {
                row_start: 1_000_001,
                row_end_exclusive: 1_000_041,
                column_ids: vec!["group".into(), "y".into(), "x".into()],
            },
        )
        .unwrap();
    for (kind, x, y) in [
        (ChartKind::Scatter, "x", Some("y")),
        (ChartKind::Line, "x", Some("y")),
        (ChartKind::Histogram, "x", None),
        (ChartKind::Bar, "group", Some("y")),
        (ChartKind::Box, "group", Some("y")),
        (ChartKind::Violin, "group", Some("y")),
    ] {
        let chart = charts.compute(&request(kind, x, y), None).unwrap();
        assert_eq!(chart.total_rows, 40, "{kind:?}");
        assert_eq!(chart.valid_rows, 40, "{kind:?}");
        if let Some(points) = chart.points {
            assert!(points
                .iter()
                .all(|p| p[0] >= 1_000_001. && p[0] <= 1_000_040.));
        }
    }
    let mut invalid = request(ChartKind::Histogram, "outside", None);
    assert!(charts.compute(&invalid, None).is_err());
    invalid.source = ChartSource::Block {
        block_id: "missing".into(),
    };
    assert!(charts.compute(&invalid, None).is_err());
}

#[test]
fn p25_reference_cancel_and_invalid_projection_release_the_reader() {
    let reader = Arc::new(LazyReader {
        rows: 1_000_001,
        reads: AtomicUsize::new(0),
    });
    let charts = ChartStore::default();
    charts.cancel("cancelled-reference").unwrap();
    let selection = CopySelectionSnapshot {
        row_start: 0,
        row_end_exclusive: 1_000_001,
        column_ids: vec!["x".into()],
    };
    assert!(charts
        .capture_reference("cancelled-reference", reader.clone(), &selection)
        .is_err());
    assert_eq!(Arc::strong_count(&reader), 1);
    assert_eq!(reader.reads.load(Ordering::Relaxed), 0);
    let duplicate = CopySelectionSnapshot {
        column_ids: vec!["x".into(), "x".into()],
        ..selection
    };
    assert!(charts
        .capture_reference("duplicate-reference", reader.clone(), &duplicate)
        .is_err());
    assert_eq!(Arc::strong_count(&reader), 1);
}

#[test]
fn p25_reference_all_points_svg_uses_selected_range_and_preserves_preview_precision() {
    let charts = ChartStore::default();
    let reader = Arc::new(LazyReader {
        rows: 2_000_000,
        reads: AtomicUsize::new(0),
    });
    charts
        .capture_reference(
            "reference",
            reader.clone(),
            &CopySelectionSnapshot {
                row_start: 1_000_001,
                row_end_exclusive: 1_000_041,
                column_ids: vec!["y".into(), "x".into(), "precise".into()],
            },
        )
        .unwrap();
    assert_eq!(reader.reads.load(Ordering::Relaxed), 0);
    let preview = charts
        .preview_block("reference", 1, &["precise".into(), "x".into()])
        .unwrap();
    assert_eq!(
        preview.rows[0][0].display.as_deref(),
        Some("9007199255740994")
    );
    assert_eq!(preview.rows[0][1].display.as_deref(), Some("1000001"));
    let req = request(ChartKind::Scatter, "x", Some("y"));
    let frame = super::scatter_svg::ScatterSvgFrame {
        x_min: 1_000_001.,
        x_max: 1_000_010.,
        y_min: 2_000_002.,
        y_max: 2_000_020.,
        left: 0.,
        top: 0.,
        width: 200.,
        height: 100.,
        radius: 2.,
    };
    let mut svg = Vec::new();
    let mut progress = Vec::new();
    let export = charts
        .write_scatter_svg_points(&req, None, &frame, &mut svg, |value| progress.push(value))
        .unwrap();
    let svg = String::from_utf8(svg).unwrap();
    assert_eq!(svg.matches("<circle ").count(), 10);
    assert!(svg.contains(r#"<circle cx="0.0000" cy="100.0000" r="2.0000"/>"#));
    assert!(svg.contains(r#"<circle cx="200.0000" cy="0.0000" r="2.0000"/>"#));
    let last = progress.last().unwrap();
    assert_eq!(
        last.scanned_rows, 40,
        "Only captured rows are scanned, never the full two-million-row source"
    );
    assert_eq!(last.written_points, 10);
    drop(export);
}
