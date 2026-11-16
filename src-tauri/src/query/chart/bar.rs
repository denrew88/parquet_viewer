use std::collections::BTreeMap;

use crate::domain::DataError;

use super::{
    axis::{absolute_number, group_label},
    invalid,
    statistics::{
        matches_filter, populate_group_directory, CompensatedSum, MAX_GROUP_CATEGORIES,
        MAX_GROUP_LABEL_BYTES,
    },
    BarAggregate, BarSort, ChartData, ChartGroup, ChartGroupEntry, ChartRequest, Input, Job,
    Projection, MAX_GROUPS,
};

#[derive(Default)]
struct Bar {
    count: u64,
    sum: CompensatedSum,
}

pub(super) fn compute(
    request: &ChartRequest,
    projection: &Projection,
    input: &Input,
    job: &Job<'_>,
) -> Result<ChartData, DataError> {
    let mut output = ChartData::default();
    let mut groups = BTreeMap::<String, Bar>::new();
    let mut total = CompensatedSum::default();
    let aggregate = request.bar.map_or_else(
        || {
            if projection.y.is_some() {
                BarAggregate::Sum
            } else {
                BarAggregate::Count
            }
        },
        |bar| bar.aggregate,
    );
    input.visit(&projection.columns, job, |row| {
        output.total_rows += 1;
        if !matches_filter(request, projection, row) {
            output.filtered_rows += 1;
            return Ok(());
        }
        let label = group_label(row[0])
            .filter(|label| label.len() <= MAX_GROUP_LABEL_BYTES);
        let value = projection
            .y
            .map_or(Some(1.0), |index| absolute_number(row[index]));
        let Some((label, value)) = label.zip(value) else {
            output.excluded_rows += 1;
            return Ok(());
        };
        let group = if let Some(group) = groups.get_mut(label.as_ref()) {
            group
        } else if groups.len() < MAX_GROUP_CATEGORIES {
            groups.entry(label.into_owned()).or_default()
        } else {
            return Err(invalid(
                "A bar chart supports at most 65,536 categories. Filter the data or group categories first.",
            ));
        };
        group.count += 1;
        if aggregate != BarAggregate::Count {
            group.sum.add(value)?;
        }
        if request.bar.is_some() && aggregate == BarAggregate::Sum {
            total.add(value)?;
        }
        output.valid_rows += 1;
        Ok(())
    })?;

    let mut summaries = Vec::with_capacity(groups.len());
    for (label, group) in groups {
        job.check()?;
        let value = match aggregate {
            BarAggregate::Count => group.count as f64,
            BarAggregate::Sum => group.sum.total()?,
            BarAggregate::Mean => group.sum.mean(group.count)?,
        };
        summaries.push((label, group.count, value));
    }
    if let Some(options) = request.bar {
        output.bar_total = match aggregate {
            BarAggregate::Count => Some(output.valid_rows as f64),
            BarAggregate::Sum => Some(total.total()?),
            BarAggregate::Mean => None,
        };
        match options.sort {
            BarSort::Category => {}
            BarSort::Asc => {
                summaries.sort_unstable_by(|a, b| a.2.total_cmp(&b.2).then_with(|| a.0.cmp(&b.0)))
            }
            BarSort::Desc => {
                summaries.sort_unstable_by(|a, b| b.2.total_cmp(&a.2).then_with(|| a.0.cmp(&b.0)))
            }
        }
    } else {
        output.groups_truncated = summaries.len() > MAX_GROUPS;
    }
    let limit = request.bar.map_or(MAX_GROUPS, |options| options.limit);
    output.groups = Some(
        summaries
            .iter()
            .take(limit)
            .map(|(label, count, value)| ChartGroup {
                label: label.clone(),
                count: *count,
                value: Some(*value),
                ..ChartGroup::default()
            })
            .collect(),
    );
    populate_group_directory(
        &mut output,
        summaries
            .into_iter()
            .map(|(label, count, value)| ChartGroupEntry {
                label,
                count,
                value: Some(value),
            })
            .collect(),
    );
    Ok(output)
}
