use std::collections::HashMap;

// A width of 2^(floor(log2(span)) - 5) spans fewer than 64 widths,
// plus one cell for a value that falls exactly on an outer edge.
const SPAN_EXPONENT_SHIFT: i32 = 5;
const MIN_EXPONENT: i32 = -1074;

#[derive(Default)]
pub(crate) struct ScatterTiles {
    axes: [TileAxis; 2],
    counts: HashMap<[i64; 2], u64>,
}

impl ScatterTiles {
    pub(crate) fn add(&mut self, [x, y]: [f64; 2]) {
        let x_shift = self.axes[0].include(x);
        let y_shift = self.axes[1].include(y);
        if (x_shift != 0 || y_shift != 0) && !self.counts.is_empty() {
            // The grid is aligned to zero. Every old cell is contained in
            // exactly one wider cell, so coarsening never discards counts.
            let previous = std::mem::take(&mut self.counts);
            self.counts.reserve(previous.len());
            for ([ix, iy], count) in previous {
                let key = [coarsen(ix, x_shift), coarsen(iy, y_shift)];
                *self.counts.entry(key).or_default() += count;
            }
        }
        let key = [self.axes[0].cell(x), self.axes[1].cell(y)];
        *self.counts.entry(key).or_default() += 1;
    }

    pub(crate) fn finish(self) -> Vec<[f64; 5]> {
        let mut cells = self.counts.into_iter().collect::<Vec<_>>();
        cells.sort_unstable_by_key(|&(key, _)| key);
        cells
            .into_iter()
            .map(|([ix, iy], count)| {
                let [left, right] = self.axes[0].edges(ix);
                let [bottom, top] = self.axes[1].edges(iy);
                [left, right, bottom, top, count as f64]
            })
            .collect()
    }
}

struct TileAxis {
    min: f64,
    max: f64,
    exponent: i32,
    width: f64,
}

impl Default for TileAxis {
    fn default() -> Self {
        Self {
            min: f64::INFINITY,
            max: f64::NEG_INFINITY,
            exponent: MIN_EXPONENT,
            width: f64::from_bits(1),
        }
    }
}

impl TileAxis {
    fn include(&mut self, value: f64) -> u32 {
        if value >= self.min && value <= self.max {
            return 0;
        }
        self.min = self.min.min(value);
        self.max = self.max.max(value);
        let span = self.max - self.min;
        let span_exponent = if span.is_finite() {
            binary_exponent(span)
        } else {
            binary_exponent(self.max / 2.0 - self.min / 2.0) + 1
        };
        // Also keep integer cell keys exactly representable as f64 at their
        // edges. This matters when the entire view is far from zero.
        let key_exponent = binary_exponent(self.min.abs().max(self.max.abs())) - 52;
        let exponent = self
            .exponent
            .max(span_exponent - SPAN_EXPONENT_SHIFT)
            .max(key_exponent);
        let shift = (exponent - self.exponent) as u32;
        if shift != 0 {
            self.exponent = exponent;
            self.width = if exponent >= -1022 {
                f64::from_bits(((exponent + 1023) as u64) << 52)
            } else {
                f64::from_bits(1 << (exponent - MIN_EXPONENT))
            };
        }
        shift
    }

    fn cell(&self, value: f64) -> i64 {
        let key = value / self.width;
        if key == 0.0 && value < 0.0 {
            -1
        } else {
            key.floor() as i64
        }
    }

    fn edges(&self, cell: i64) -> [f64; 2] {
        [
            (cell as f64 * self.width).max(self.min),
            ((cell + 1) as f64 * self.width).min(self.max),
        ]
    }
}

fn binary_exponent(value: f64) -> i32 {
    let bits = value.to_bits();
    let normal = (bits >> 52) as i32;
    if normal == 0 {
        (63 - bits.leading_zeros() as i32 + MIN_EXPONENT).max(MIN_EXPONENT)
    } else {
        normal - 1023
    }
}

fn coarsen(key: i64, shift: u32) -> i64 {
    // Arithmetic shift is floor division for negative grid keys as well.
    key >> shift.min(i64::BITS - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_isolated_occupancy_during_coarsening() {
        let mut tiles = ScatterTiles::default();
        for _ in 0..25_000 {
            tiles.add([0.25, 0.5]);
        }
        tiles.add([-50.0, 20.0]);
        tiles.add([100.0, -100.0]);
        let tiles = tiles.finish();
        assert_eq!(tiles.len(), 3);
        assert_eq!(tiles.iter().map(|tile| tile[4]).sum::<f64>(), 25_002.0);
        assert!(tiles.iter().any(|tile| tile[4] == 1.0 && tile[0] == -50.0));
        assert!(tiles.iter().any(|tile| tile[4] == 1.0 && tile[1] == 100.0));
    }

    #[test]
    fn covers_subnormal_and_extreme_finite_coordinates() {
        let smallest = f64::from_bits(1);
        let points = [
            [smallest, -smallest],
            [-f64::MAX, f64::MAX],
            [f64::MAX, -f64::MAX],
            [0.0, 0.0],
        ];
        let mut tiles = ScatterTiles::default();
        for point in points {
            tiles.add(point);
        }
        let tiles = tiles.finish();
        assert_eq!(tiles.iter().map(|tile| tile[4]).sum::<f64>(), 4.0);
        assert!(tiles.iter().flatten().all(|value| value.is_finite()));
        let mut reversed = ScatterTiles::default();
        for point in points.into_iter().rev() {
            reversed.add(point);
        }
        assert_eq!(reversed.finish(), tiles);
        for [x, y] in points {
            assert!(tiles
                .iter()
                .any(|tile| { x >= tile[0] && x <= tile[1] && y >= tile[2] && y <= tile[3] }));
        }
    }
}
