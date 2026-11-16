use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use crate::{
    copy::CopyRowReader,
    domain::{DataErrorCode, DataPage},
};

use super::*;
use crate::query::chart::{ChartCell, ChartRowVisitor, ChartStore, ProjectedChartSource};

const GRID: usize = 256;
const GRID_ROWS: usize = GRID * GRID;
const OFFSET: i128 = 8_000_000_000_000_000_000;

struct Validity(AtomicBool);

impl CopyRowReader for Validity {
    fn read_rows(&self, _: u64, _: usize, _: &[String]) -> Result<DataPage, DataError> {
        panic!("the fixture must use the projected reader");
    }

    fn validate_current(&self) -> Result<(), DataError> {
        if self.0.load(Ordering::Relaxed) {
            Ok(())
        } else {
            Err(DataError::task_cancelled())
        }
    }
}

struct Fixture {
    visits: AtomicUsize,
    grouped: bool,
}

impl ProjectedChartSource for Fixture {
    fn visit(
        &self,
        columns: &[String],
        _: &[bool],
        check: &dyn Fn() -> Result<(), DataError>,
        visit: &mut ChartRowVisitor<'_>,
    ) -> Result<bool, DataError> {
        self.visits.fetch_add(1, Ordering::Relaxed);
        if self.grouped {
            for id in 0..64 {
                let label = format!("Category {id:02}");
                for y in 0..=id % 3 {
                    let row = [ChartCell::Text(&label), ChartCell::Integer(y)];
                    visit(&row[..columns.len()])?;
                }
            }
        } else {
            // The multiplication is a permutation of the 16-bit grid. Values
            // appear interleaved across every chunk, unlike sorted source data.
            // Put the first value at the numeric origin for exact relative axes.
            for i in 0..GRID_ROWS {
                if i % 4096 == 0 {
                    check()?;
                }
                let cell = (i * 40_503) % GRID_ROWS;
                let row = [
                    ChartCell::Integer(OFFSET + (cell % GRID) as i128),
                    ChartCell::Integer(OFFSET + (cell / GRID) as i128),
                ];
                visit(&row[..columns.len()])?;
            }
            let row = [
                ChartCell::Integer(OFFSET + 1_234),
                ChartCell::Integer(OFFSET + 1_234),
            ];
            visit(&row[..columns.len()])?;
        }
        Ok(true)
    }
}

fn request(kind: ChartKind) -> ChartRequest {
    let mut request: ChartRequest = serde_json::from_value(serde_json::json!({
        "requestId": "overview",
        "kind": "scatter",
        "source": { "kind": "file", "documentId": "document", "sessionId": "session" },
        "x": "x",
        "y": "y"
    }))
    .unwrap();
    request.kind = kind;
    request
}

struct Test {
    store: ChartStore,
    temp: QueryTempManager,
    _directory: tempfile::TempDir,
    fixture: Arc<Fixture>,
    validity: Arc<Validity>,
}

impl Test {
    fn new(grouped: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        Self {
            store: ChartStore::default(),
            temp: QueryTempManager::open(directory.path(), MAX_INDEX_BYTES * 2).unwrap(),
            _directory: directory,
            fixture: Arc::new(Fixture {
                visits: AtomicUsize::new(0),
                grouped,
            }),
            validity: Arc::new(Validity(AtomicBool::new(true))),
        }
    }

    fn compute(
        &self,
        request: &ChartRequest,
        detail: Option<&ChartDetail>,
    ) -> Result<ChartData, DataError> {
        self.store.compute_with_detail(
            request,
            Some(self.validity.clone()),
            Some(self.fixture.clone()),
            detail,
            Some(&self.temp),
        )
    }

    fn visits(&self) -> usize {
        self.fixture.visits.load(Ordering::Relaxed)
    }

    fn audit(&self) -> (u64, u64, u64) {
        let state = self.store.detail.lock().unwrap();
        let index = state.indexes[0].1.index.lock().unwrap();
        index.as_ref().unwrap().audit()
    }
}

#[test]
fn phase25_scatter_detail_reads_only_matching_tiles_and_preserves_exact_values() {
    let test = Test::new(false);
    let mut request = request(ChartKind::Scatter);
    let overview = test.compute(&request, None).unwrap();
    assert_eq!(overview.valid_rows, GRID_ROWS as u64 + 1);
    assert_eq!(
        overview.x_origin.as_deref(),
        Some(OFFSET.to_string().as_str())
    );
    assert!(overview.sampled);

    request.request_id = "range-one".to_owned();
    let narrow = ChartDetail::Range {
        x: [100.0, 105.0],
        y: Some([100.0, 105.0]),
    };
    let result = test.compute(&request, Some(&narrow)).unwrap();
    assert_eq!(result.valid_rows, 36);
    assert_eq!(result.x_origin, overview.x_origin);
    assert_eq!(result.y_origin, overview.y_origin);
    assert_eq!(result.points.as_ref().unwrap().len(), 36);
    assert!(!result.sampled);
    assert_eq!(test.visits(), 2, "one overview plus one index preparation");
    let first = test.audit();
    assert!(first.0 <= 4);
    assert!(first.1 > 0);
    assert!(first.2 < GRID_ROWS as u64 / 8);

    request.request_id = "range-repeat".to_owned();
    assert_eq!(test.compute(&request, Some(&narrow)).unwrap(), result);
    assert_eq!(test.visits(), 2, "warm range must never read the source");
    let repeated = test.audit();
    assert_eq!(repeated, (first.0 * 2, first.1 * 2, first.2 * 2));

    request.request_id = "range-island".to_owned();
    let island = ChartDetail::Range {
        x: [1_234.0, 1_234.0],
        y: Some([1_234.0, 1_234.0]),
    };
    let isolated = test.compute(&request, Some(&island)).unwrap();
    assert_eq!(isolated.points, Some(vec![[1_234.0, 1_234.0]]));
    let points = isolated.point_details.unwrap();
    assert_eq!(points[0].row, GRID_ROWS as u64 + 1);
    assert_eq!(points[0].x, (OFFSET + 1_234).to_string());
    assert_eq!(test.audit().2 - repeated.2, 1);
    assert_eq!(test.visits(), 2);
    assert_eq!(test.temp.usage().unwrap().active_queries, 1);

    test.validity.0.store(false, Ordering::Relaxed);
    request.request_id = "stale-range".to_owned();
    assert_eq!(
        test.compute(&request, Some(&narrow)).unwrap_err().code,
        DataErrorCode::TaskCancelled
    );
    assert_eq!(test.temp.usage().unwrap().active_queries, 0);
}

#[test]
fn phase25_group_directory_and_late_group_detail_reuse_prepared_data() {
    let test = Test::new(true);
    let mut request = request(ChartKind::Violin);
    let overview = test.compute(&request, None).unwrap();
    assert_eq!(overview.group_count, Some(64));
    assert!(overview.groups_truncated);
    assert_eq!(test.visits(), 1);

    request.request_id = "groups".to_owned();
    let directory = test
        .compute(
            &request,
            Some(&ChartDetail::Groups {
                offset: 1,
                search: Some("cAtEgOrY 6".to_owned()),
            }),
        )
        .unwrap()
        .group_directory
        .unwrap();
    assert_eq!(directory.total, 4);
    assert_eq!(directory.offset, 1);
    assert_eq!(directory.entries[0].label, "Category 61");
    assert_eq!(directory.entries[0].count, 2);
    assert_eq!(test.visits(), 1);

    request.request_id = "late-group".to_owned();
    let group = test
        .compute(
            &request,
            Some(&ChartDetail::Group {
                label: "Category 62".to_owned(),
            }),
        )
        .unwrap();
    assert_eq!(group.valid_rows, 3);
    assert_eq!(
        group.groups.unwrap()[0].observations,
        Some(vec![0.0, 1.0, 2.0])
    );
    assert_eq!(test.visits(), 2);

    request.request_id = "different-late-group".to_owned();
    let second = test
        .compute(
            &request,
            Some(&ChartDetail::Group {
                label: "Category 63".to_owned(),
            }),
        )
        .unwrap();
    assert_eq!(second.valid_rows, 1);
    assert_eq!(test.visits(), 2);
    assert_eq!(test.audit().2, 4);
}

#[test]
fn phase25_detail_validation_rejects_reversed_bounds_before_reading() {
    let test = Test::new(false);
    let request = request(ChartKind::Scatter);
    let result = test.compute(
        &request,
        Some(&ChartDetail::Range {
            x: [1.0, -1.0],
            y: None,
        }),
    );
    assert!(result.is_err());
    assert_eq!(test.visits(), 0);
}

#[test]
fn phase25_bar_sort_limit_and_search_share_the_same_aggregate() {
    use crate::query::chart::BarAggregate;
    let test = Test::new(true);
    let mut request = request(ChartKind::Bar);
    request.y = None;
    request.bar = Some(BarOptions {
        aggregate: BarAggregate::Count,
        sort: BarSort::Category,
        limit: 4,
    });
    let first = test.compute(&request, None).unwrap();
    assert_eq!(first.groups.as_ref().unwrap()[0].label, "Category 00");
    assert_eq!(first.groups.as_ref().unwrap().len(), 4);
    assert_eq!(first.group_count, Some(64));
    assert_eq!(test.visits(), 1);

    request.request_id = "resorted".to_owned();
    request.bar.as_mut().unwrap().sort = BarSort::Desc;
    request.bar.as_mut().unwrap().limit = 8;
    let next = test.compute(&request, None).unwrap();
    assert_eq!(next.groups.as_ref().unwrap()[0].label, "Category 02");
    assert_eq!(next.groups.as_ref().unwrap().len(), 8);
    assert_eq!(next.valid_rows, first.valid_rows);
    assert_eq!(next.bar_total, first.bar_total);
    let page = test
        .compute(
            &request,
            Some(&ChartDetail::Groups {
                offset: 0,
                search: Some("Category 6".to_owned()),
            }),
        )
        .unwrap()
        .group_directory
        .unwrap();
    assert_eq!(page.total, 4);
    assert_eq!(page.entries[0].label, "Category 62");
    assert_eq!(page.entries[0].value, Some(3.0));
    assert_eq!(test.visits(), 1);
}

#[test]
fn phase25_histogram_detail_counts_exact_endpoints_in_the_original_frame() {
    let test = Test::new(false);
    let mut request = request(ChartKind::Histogram);
    request.y = None;
    request.histogram = Some(HistogramOptions::Count { count: 4 });
    let overview = test.compute(&request, None).unwrap();
    assert_eq!(test.visits(), 2);

    request.request_id = "histogram-range".to_owned();
    let detail = test
        .compute(
            &request,
            Some(&ChartDetail::Range {
                x: [253.0, 255.0],
                y: None,
            }),
        )
        .unwrap();
    assert_eq!(detail.x_origin, overview.x_origin);
    assert_eq!(detail.valid_rows, 768);
    let bins = detail.bins.unwrap();
    assert_eq!(bins.first().unwrap().start, 253.0);
    assert_eq!(bins.last().unwrap().end, 255.0);
    assert_eq!(
        bins.iter().map(|bin| bin.count).collect::<Vec<_>>(),
        [256, 0, 256, 256]
    );
    assert!(test.audit().2 < GRID_ROWS as u64 / 8);

    request.request_id = "histogram-island".to_owned();
    let detail = test
        .compute(
            &request,
            Some(&ChartDetail::Range {
                x: [1_200.0, 1_234.0],
                y: None,
            }),
        )
        .unwrap();
    assert_eq!(detail.valid_rows, 1);
    assert_eq!(test.visits(), 3);
}
