use std::sync::OnceLock;

use crate::domain::DataError;

static HDF5_RUNTIME: OnceLock<Result<(), DataError>> = OnceLock::new();

const NO_DYNAMIC_PLUGINS: u32 = 0;

unsafe extern "C" {
    // hdf5-metno-sys 0.12.0 declares both functions with pointer arguments,
    // but the bundled HDF5 2.0 H5PLpublic.h takes the set mask by value.
    #[link_name = "H5PLset_loading_state"]
    fn h5pl_set_loading_state(plugin_control_mask: u32) -> i32;

    #[link_name = "H5PLget_loading_state"]
    fn h5pl_get_loading_state(plugin_control_mask: *mut u32) -> i32;
}

trait Hdf5RuntimeApi {
    fn set_plugin_loading_state(&self, mask: u32) -> i32;
    fn plugin_loading_state(&self) -> Result<u32, i32>;
    fn blosc_available(&self) -> bool;
}

struct NativeHdf5RuntimeApi;

impl Hdf5RuntimeApi for NativeHdf5RuntimeApi {
    fn set_plugin_loading_state(&self, mask: u32) -> i32 {
        hdf5::sync::sync(|| {
            // SAFETY: the declaration matches the bundled HDF5 header. The
            // process-global call is serialized by hdf5-metno's runtime lock.
            unsafe { h5pl_set_loading_state(mask) }
        })
    }

    fn plugin_loading_state(&self) -> Result<u32, i32> {
        let mut mask = u32::MAX;
        let status = hdf5::sync::sync(|| {
            // SAFETY: HDF5 writes one unsigned mask to a valid out pointer and
            // the process-global call is serialized by hdf5-metno's lock.
            unsafe { h5pl_get_loading_state(&mut mask) }
        });
        if status < 0 {
            Err(status)
        } else {
            Ok(mask)
        }
    }

    fn blosc_available(&self) -> bool {
        hdf5::filters::blosc_available()
    }
}

pub fn initialize_hdf5_runtime() -> Result<(), DataError> {
    cached_initialize(&HDF5_RUNTIME, || initialize_with(&NativeHdf5RuntimeApi))
}

fn cached_initialize(
    state: &OnceLock<Result<(), DataError>>,
    initialize: impl FnOnce() -> Result<(), DataError>,
) -> Result<(), DataError> {
    state.get_or_init(initialize).clone()
}

fn initialize_with(api: &impl Hdf5RuntimeApi) -> Result<(), DataError> {
    let status = api.set_plugin_loading_state(NO_DYNAMIC_PLUGINS);
    if status < 0 {
        return Err(DataError::oes_hdf5_runtime(format!(
            "could not disable dynamic HDF5 plugins (status {status})"
        )));
    }

    let mask = api.plugin_loading_state().map_err(|status| {
        DataError::oes_hdf5_runtime(format!(
            "could not verify the dynamic HDF5 plugin state (status {status})"
        ))
    })?;
    if mask != NO_DYNAMIC_PLUGINS {
        return Err(DataError::oes_hdf5_runtime(format!(
            "dynamic HDF5 plugins remain enabled (mask 0x{mask:08x})"
        )));
    }

    if !api.blosc_available() {
        return Err(DataError::oes_hdf5_runtime(
            "the statically linked Blosc decoder is unavailable",
        ));
    }

    Ok(())
}

#[cfg(test)]
fn current_plugin_loading_state() -> Result<u32, DataError> {
    NativeHdf5RuntimeApi
        .plugin_loading_state()
        .map_err(|status| {
            DataError::oes_hdf5_runtime(format!(
                "could not read the dynamic HDF5 plugin state (status {status})"
            ))
        })
}

#[cfg(test)]
mod tests {
    use std::{
        cell::{Cell, RefCell},
        process::Command,
        sync::OnceLock,
    };

    use crate::domain::DataErrorCode;

    use super::*;

    const SUBPROCESS_ENV: &str = "DATA_VIEWER_HDF5_RUNTIME_SUBPROCESS";
    const SUBPROCESS_TEST: &str =
        "platform::hdf5_runtime::tests::real_runtime_disables_plugins_and_registers_blosc";

    struct FakeApi {
        set_status: i32,
        get_result: Result<u32, i32>,
        blosc_available: bool,
        calls: RefCell<Vec<&'static str>>,
    }

    impl FakeApi {
        fn successful() -> Self {
            Self {
                set_status: 0,
                get_result: Ok(NO_DYNAMIC_PLUGINS),
                blosc_available: true,
                calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl Hdf5RuntimeApi for FakeApi {
        fn set_plugin_loading_state(&self, _mask: u32) -> i32 {
            self.calls.borrow_mut().push("set");
            self.set_status
        }

        fn plugin_loading_state(&self) -> Result<u32, i32> {
            self.calls.borrow_mut().push("get");
            self.get_result
        }

        fn blosc_available(&self) -> bool {
            self.calls.borrow_mut().push("blosc");
            self.blosc_available
        }
    }

    #[test]
    fn initialization_locks_plugins_before_checking_static_blosc() {
        let api = FakeApi::successful();

        assert_eq!(initialize_with(&api), Ok(()));
        assert_eq!(&*api.calls.borrow(), &["set", "get", "blosc"]);
    }

    #[test]
    fn initialization_reports_each_runtime_failure_as_a_typed_error() {
        let cases = [
            FakeApi {
                set_status: -1,
                ..FakeApi::successful()
            },
            FakeApi {
                get_result: Err(-2),
                ..FakeApi::successful()
            },
            FakeApi {
                get_result: Ok(1),
                ..FakeApi::successful()
            },
            FakeApi {
                blosc_available: false,
                ..FakeApi::successful()
            },
        ];

        for api in cases {
            let error = initialize_with(&api).unwrap_err();
            assert_eq!(error.code, DataErrorCode::OesHdf5RuntimeUnavailable);
        }
    }

    #[test]
    fn cached_initialization_runs_once_and_caches_failures() {
        let success = OnceLock::new();
        let success_calls = Cell::new(0);
        assert_eq!(
            cached_initialize(&success, || {
                success_calls.set(success_calls.get() + 1);
                Ok(())
            }),
            Ok(())
        );
        assert_eq!(cached_initialize(&success, || unreachable!()), Ok(()));
        assert_eq!(success_calls.get(), 1);

        let failure = OnceLock::new();
        let expected = DataError::oes_hdf5_runtime("fixture failure");
        assert_eq!(
            cached_initialize(&failure, || Err(expected.clone())),
            Err(expected.clone())
        );
        assert_eq!(
            cached_initialize(&failure, || unreachable!()),
            Err(expected)
        );
    }

    #[test]
    fn real_runtime_disables_plugins_and_registers_blosc() {
        if std::env::var_os(SUBPROCESS_ENV).is_some() {
            initialize_hdf5_runtime().expect("the static HDF5 runtime must initialize");
            assert_eq!(current_plugin_loading_state(), Ok(NO_DYNAMIC_PLUGINS));
            assert!(hdf5::filters::blosc_available());

            let directory = tempfile::tempdir().expect("create isolated Blosc-Zstd fixture");
            let path = directory.path().join("static-blosc-zstd.h5");
            let expected = (0..4_096).map(|value| value % 17).collect::<Vec<i32>>();
            {
                let file = hdf5::File::create(&path).expect("create HDF5 fixture");
                let dataset = file
                    .new_dataset_builder()
                    .with_data(&expected)
                    .blosc_zstd(5, true)
                    .create("oes")
                    .expect("write static Blosc-Zstd dataset");
                assert_eq!(
                    dataset.filters(),
                    vec![hdf5::filters::Filter::blosc_zstd(5, true)]
                );
            }
            let file = hdf5::File::open(&path).expect("reopen HDF5 fixture read-only");
            let actual = file
                .dataset("oes")
                .and_then(|dataset| dataset.read_raw::<i32>())
                .expect("decode Blosc-Zstd without dynamic plugins");
            assert_eq!(actual, expected);
            return;
        }

        let output = Command::new(std::env::current_exe().expect("test executable path"))
            .args(["--exact", SUBPROCESS_TEST, "--nocapture"])
            .env(SUBPROCESS_ENV, "1")
            .output()
            .expect("launch isolated HDF5 runtime test");
        assert!(
            output.status.success(),
            "isolated HDF5 runtime test failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
