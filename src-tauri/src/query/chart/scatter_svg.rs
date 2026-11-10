use std::{io::Write, sync::Arc};

use serde::{Deserialize, Serialize};

use crate::{
    copy::CopyRowReader,
    domain::{DataError, DataErrorCode},
};

use super::{
    axis::Axis,
    invalid,
    statistics::{matches_filter, ratio, scatter_point},
    ChartKind, ChartRequest, ChartStore, Job,
};

const MAX_FRAME_EDGE: f64 = 16_384.0;
const MAX_RADIUS: f64 = 128.0;
const PROGRESS_INTERVAL: u64 = 2_048;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScatterSvgFrame {
    pub(crate) x_min: f64,
    pub(crate) x_max: f64,
    pub(crate) y_min: f64,
    pub(crate) y_max: f64,
    pub(crate) left: f64,
    pub(crate) top: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) radius: f64,
}

impl ScatterSvgFrame {
    pub(crate) fn validate(&self) -> Result<(), DataError> {
        let values = [
            self.x_min,
            self.x_max,
            self.y_min,
            self.y_max,
            self.left,
            self.top,
            self.width,
            self.height,
            self.radius,
        ];
        if values.iter().any(|value| !value.is_finite())
            || self.x_min >= self.x_max
            || self.y_min >= self.y_max
            || self.left < 0.0
            || self.top < 0.0
            || self.width < 1.0
            || self.height < 1.0
            || self.left + self.width > MAX_FRAME_EDGE
            || self.top + self.height > MAX_FRAME_EDGE
            || !(0.001..=MAX_RADIUS).contains(&self.radius)
        {
            return Err(invalid(
                "The scatter SVG frame has invalid bounds or dimensions.",
            ));
        }
        Ok(())
    }

    fn project(&self, [x, y]: [f64; 2]) -> Option<[f64; 2]> {
        if !(self.x_min..=self.x_max).contains(&x) || !(self.y_min..=self.y_max).contains(&y) {
            return None;
        }
        Some([
            ratio(x, self.x_min, self.x_max).mul_add(self.width, self.left),
            (1.0 - ratio(y, self.y_min, self.y_max)).mul_add(self.height, self.top),
        ])
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChartImageProgress {
    pub(crate) scanned_rows: u64,
    pub(crate) written_points: u64,
}

fn svg_io(error: std::io::Error) -> DataError {
    DataError {
        code: DataErrorCode::Io,
        message: format!("Could not write scatter SVG points: {error}"),
    }
}

impl ChartStore {
    pub(crate) fn write_scatter_svg_points<'a>(
        &'a self,
        request: &'a ChartRequest,
        reader: Option<Arc<dyn CopyRowReader>>,
        frame: &ScatterSvgFrame,
        writer: &mut impl Write,
        mut progress: impl FnMut(ChartImageProgress),
    ) -> Result<Job<'a>, DataError> {
        if request.kind != ChartKind::Scatter {
            return Err(invalid("Only a scatter chart can export all its points."));
        }
        frame.validate()?;
        let mut projection = request.projection()?;
        if projection.scatter_label.take().is_some_and(|index| {
            index != 0 && projection.y != Some(index) && projection.filter != Some(index)
        }) {
            // The label is added last. An independent label is unused by the SVG layer.
            projection.columns.pop();
        }
        let job = self.begin(&request.request_id, false)?;
        let input = self.input(&request.source, &projection, reader)?;
        writeln!(
            writer,
            r##"<defs><clipPath id="dv-chart-export-points-clip"><rect x="{:.4}" y="{:.4}" width="{:.4}" height="{:.4}"/></clipPath></defs><g data-chart-points="all" clip-path="url(#dv-chart-export-points-clip)" fill="#087f78" fill-opacity="0.64">"##,
            frame.left, frame.top, frame.width, frame.height
        )
        .map_err(svg_io)?;

        let mut status = ChartImageProgress::default();
        let mut x_axis = Axis::default();
        let mut y_axis = Axis::default();
        progress(status);
        input.visit(&projection.columns, &job, |row, indices| {
            status.scanned_rows += 1;
            if matches_filter(request, &projection, row, indices) {
                let x = &row[indices[0]];
                let y = projection.y.map(|slot| &row[indices[slot]]);
                if let Some([cx, cy]) = scatter_point(request, &mut x_axis, &mut y_axis, x, y)
                    .ok()
                    .and_then(|point| frame.project(point))
                {
                    writeln!(
                        writer,
                        r#"<circle cx="{cx:.4}" cy="{cy:.4}" r="{:.4}"/>"#,
                        frame.radius
                    )
                    .map_err(svg_io)?;
                    status.written_points += 1;
                }
            }
            if status.scanned_rows.is_multiple_of(PROGRESS_INTERVAL) {
                progress(status);
                job.check()?;
            }
            Ok(())
        })?;
        job.check()?;
        writer.write_all(b"</g>\n").map_err(svg_io)?;
        if !status.scanned_rows.is_multiple_of(PROGRESS_INTERVAL) {
            progress(status);
        }
        job.check()?;
        Ok(job)
    }
}
