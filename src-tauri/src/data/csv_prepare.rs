use crate::domain::{
    CsvConversionFailurePolicy, CsvParsingProfile, CsvTargetType, CsvTimezonePolicy,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CsvPreparationBackend {
    Rust,
    Polars,
}

impl CsvPreparationBackend {
    pub(super) const fn diagnostic_name(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Polars => "polars",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CsvRustRequiredReason {
    FeatureDisabled,
    AllowListPending,
    UnsupportedDelimiter,
    UnsupportedQuoteDialect,
    InconsistentWidth,
    UnsafeHeader,
    SourceBelowThreshold,
    ValueParityMismatch,
    UnsupportedProfile,
}

impl CsvRustRequiredReason {
    pub(super) const fn diagnostic_code(self) -> &'static str {
        match self {
            Self::FeatureDisabled => "featureDisabled",
            Self::AllowListPending => "allowListPending",
            Self::UnsupportedDelimiter => "unsupportedDelimiter",
            Self::UnsupportedQuoteDialect => "unsupportedQuoteDialect",
            Self::InconsistentWidth => "inconsistentWidth",
            Self::UnsafeHeader => "unsafeHeader",
            Self::SourceBelowThreshold => "sourceBelowThreshold",
            Self::ValueParityMismatch => "valueParityMismatch",
            Self::UnsupportedProfile => "unsupportedProfile",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CsvInvalidReason {
    InvalidEncoding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CsvEligibilityDecision {
    PolarsEligible,
    RustRequired(CsvRustRequiredReason),
    Invalid(CsvInvalidReason),
}

impl CsvEligibilityDecision {
    pub(super) const fn backend(self) -> Option<CsvPreparationBackend> {
        match self {
            Self::PolarsEligible => Some(CsvPreparationBackend::Polars),
            Self::RustRequired(_) => Some(CsvPreparationBackend::Rust),
            Self::Invalid(_) => None,
        }
    }

    pub(super) const fn diagnostic_reason(self) -> Option<&'static str> {
        match self {
            Self::RustRequired(reason) => Some(reason.diagnostic_code()),
            Self::PolarsEligible | Self::Invalid(_) => None,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(super) struct CsvDialectSnapshot {
    pub delimiter: u8,
    pub quote: u8,
    pub double_quote: bool,
    pub utf8: bool,
    pub known_inconsistent_width: bool,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct CsvEligibilityInput<'a> {
    pub dialect: CsvDialectSnapshot,
    pub profile: &'a CsvParsingProfile,
    pub resolved_targets: &'a [CsvTargetType],
    pub unsafe_header: bool,
    pub source_bytes: u64,
    pub value_compatible: bool,
}

/// The initial rectangular/default-dialect class is enabled only after the
/// csv-crate oracle, compact-v3 parity, and hard process-cancellation spikes
/// pass. Unknown combinations remain on the existing Rust path.
const POLARS_FAST_LANE_ENABLED: bool = true;
const POLARS_FAST_LANE_MIN_BYTES: u64 = 64 * 1024 * 1024;

pub(super) fn classify_csv_preparation(
    input: CsvEligibilityInput<'_>,
    feature_enabled: bool,
) -> CsvEligibilityDecision {
    if !input.dialect.utf8 {
        return CsvEligibilityDecision::Invalid(CsvInvalidReason::InvalidEncoding);
    }
    if input.dialect.delimiter != b',' {
        return CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::UnsupportedDelimiter);
    }
    if input.dialect.quote != b'"' || !input.dialect.double_quote {
        return CsvEligibilityDecision::RustRequired(
            CsvRustRequiredReason::UnsupportedQuoteDialect,
        );
    }
    if input.dialect.known_inconsistent_width {
        return CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::InconsistentWidth);
    }
    if input.unsafe_header || !headers_are_safe(input.profile) {
        return CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::UnsafeHeader);
    }
    if !profile_is_initial_fast_lane_candidate(input.profile, input.resolved_targets) {
        return CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::UnsupportedProfile);
    }
    if !feature_enabled {
        return CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::FeatureDisabled);
    }
    if input.source_bytes < POLARS_FAST_LANE_MIN_BYTES {
        return CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::SourceBelowThreshold);
    }
    if !input.value_compatible {
        return CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::ValueParityMismatch);
    }
    if !POLARS_FAST_LANE_ENABLED {
        return CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::AllowListPending);
    }
    CsvEligibilityDecision::PolarsEligible
}

fn headers_are_safe(profile: &CsvParsingProfile) -> bool {
    let mut names = std::collections::HashSet::with_capacity(profile.columns.len());
    profile.columns.iter().all(|column| {
        !column.source_name.is_empty()
            && !column.source_name.starts_with("__dv_")
            && names.insert(column.source_name.as_str())
    })
}

fn profile_is_initial_fast_lane_candidate(
    profile: &CsvParsingProfile,
    resolved_targets: &[CsvTargetType],
) -> bool {
    if resolved_targets.len()
        != profile
            .columns
            .iter()
            .filter(|column| column.target_type != CsvTargetType::Skip)
            .count()
    {
        return false;
    }
    let mut resolved = resolved_targets.iter();
    profile.columns.iter().all(|column| {
        let resolved_supported = if column.target_type == CsvTargetType::Skip {
            true
        } else {
            resolved.next().is_some_and(|target| {
                matches!(
                    target,
                    CsvTargetType::Text
                        | CsvTargetType::Boolean
                        | CsvTargetType::Int64
                        | CsvTargetType::UInt64
                        | CsvTargetType::Float64
                        | CsvTargetType::Decimal
                )
            })
        };
        resolved_supported
            && matches!(
                column.target_type,
                CsvTargetType::Auto
                    | CsvTargetType::Text
                    | CsvTargetType::Boolean
                    | CsvTargetType::Int64
                    | CsvTargetType::UInt64
                    | CsvTargetType::Float64
                    | CsvTargetType::Decimal
                    | CsvTargetType::Skip
            )
            && !column.trim
            && column.null_tokens == ["NULL", "N/A"]
            && column.true_tokens == ["true", "TRUE", "1"]
            && column.false_tokens == ["false", "FALSE", "0"]
            && column.decimal_separator == "."
            && column.thousand_separator.is_none()
            && column.temporal_formats.is_empty()
            && column.timezone_policy == CsvTimezonePolicy::Preserve
            && column.timezone_offset_minutes.is_none()
            && column.duration_unit.is_none()
            && column.duration_input_format.is_none()
            && column.failure_policy == CsvConversionFailurePolicy::PreserveInvalid
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{CsvColumnProfile, CsvProfileMode};

    fn profile(target: CsvTargetType) -> CsvParsingProfile {
        CsvParsingProfile {
            mode: CsvProfileMode::Custom,
            generation: 1,
            columns: vec![CsvColumnProfile::new(0, String::from("value"), target)],
        }
    }

    fn input(profile: &CsvParsingProfile) -> CsvEligibilityInput<'_> {
        let resolved_targets = profile
            .columns
            .iter()
            .filter(|column| column.target_type != CsvTargetType::Skip)
            .map(|column| column.target_type)
            .collect::<Vec<_>>();
        input_with_targets(profile, Box::leak(resolved_targets.into_boxed_slice()))
    }

    fn input_with_targets<'a>(
        profile: &'a CsvParsingProfile,
        resolved_targets: &'a [CsvTargetType],
    ) -> CsvEligibilityInput<'a> {
        CsvEligibilityInput {
            dialect: CsvDialectSnapshot {
                delimiter: b',',
                quote: b'"',
                double_quote: true,
                utf8: true,
                known_inconsistent_width: false,
            },
            profile,
            resolved_targets,
            unsafe_header: false,
            source_bytes: POLARS_FAST_LANE_MIN_BYTES,
            value_compatible: true,
        }
    }

    #[test]
    fn feature_flag_is_the_final_gate_for_the_verified_fast_lane() {
        let profile = profile(CsvTargetType::Int64);
        assert_eq!(
            classify_csv_preparation(input(&profile), false),
            CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::FeatureDisabled)
        );
        assert_eq!(
            classify_csv_preparation(input(&profile), true),
            CsvEligibilityDecision::PolarsEligible
        );
    }

    #[test]
    fn small_sources_stay_on_the_existing_rust_path() {
        let profile = profile(CsvTargetType::Int64);
        let mut case = input(&profile);
        case.source_bytes = POLARS_FAST_LANE_MIN_BYTES - 1;
        assert_eq!(
            classify_csv_preparation(case, true),
            CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::SourceBelowThreshold)
        );
    }

    #[test]
    fn resolved_decimal_is_admitted_but_runtime_parity_can_close_the_gate() {
        let decimal = profile(CsvTargetType::Decimal);
        assert_eq!(
            classify_csv_preparation(input(&decimal), true),
            CsvEligibilityDecision::PolarsEligible
        );
        let mut mismatch = input(&decimal);
        mismatch.value_compatible = false;
        assert_eq!(
            classify_csv_preparation(mismatch, true),
            CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::ValueParityMismatch)
        );
    }

    #[test]
    fn unknown_dialect_width_and_profile_never_enter_the_fast_lane() {
        let base = profile(CsvTargetType::Text);
        let mut case = input(&base);
        case.dialect.delimiter = b';';
        assert_eq!(
            classify_csv_preparation(case, true),
            CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::UnsupportedDelimiter)
        );

        let mut case = input(&base);
        case.dialect.double_quote = false;
        assert_eq!(
            classify_csv_preparation(case, true),
            CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::UnsupportedQuoteDialect)
        );

        let mut case = input(&base);
        case.dialect.known_inconsistent_width = true;
        assert_eq!(
            classify_csv_preparation(case, true),
            CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::InconsistentWidth)
        );

        let mut custom = profile(CsvTargetType::Timestamp);
        custom.columns[0].trim = true;
        assert_eq!(
            classify_csv_preparation(input(&custom), true),
            CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::UnsupportedProfile)
        );
    }

    #[test]
    fn invalid_encoding_is_not_silently_routed_to_a_different_parser() {
        let profile = profile(CsvTargetType::Text);
        let mut case = input(&profile);
        case.dialect.utf8 = false;
        assert_eq!(
            classify_csv_preparation(case, true),
            CsvEligibilityDecision::Invalid(CsvInvalidReason::InvalidEncoding)
        );
    }

    #[test]
    fn auto_with_unsupported_resolved_type_and_unsafe_header_stay_on_rust() {
        let auto_profile = profile(CsvTargetType::Auto);
        assert_eq!(
            classify_csv_preparation(
                input_with_targets(&auto_profile, &[CsvTargetType::Timestamp]),
                true,
            ),
            CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::UnsupportedProfile)
        );

        let mut unsafe_profile = profile(CsvTargetType::Int64);
        unsafe_profile.columns[0].source_name = String::from("__dv_row_id");
        assert_eq!(
            classify_csv_preparation(input(&unsafe_profile), true),
            CsvEligibilityDecision::RustRequired(CsvRustRequiredReason::UnsafeHeader)
        );
    }
}
