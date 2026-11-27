//! Native helpers of ALAS, imported as `alas_native` when built (native/build.sh).
//! Every caller has a Python fallback, so ALAS runs without this module.
//!
//! Only what profiling showed worth it lives here. Measured on a 720p frame (2026-11):
//! - LZ4 block decode for aScreenCap: 3.2 ms here, 43 ms in pure Python (no `lz4` wheel for 3.15).
//! - Not worth it: RGB565 of DroidCast_raw (3.8 ms vs 3.6 ms with OpenCV, the copies eat the gain),
//!   template matching and OCR (OpenCV / BLAS already), screenshots (waiting on the emulator).

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

/// Decompress one LZ4 block (no frame header), like `lz4.block.decompress(data, uncompressed_size=n)`.
///
/// Raises ValueError on corrupted input or when the output size differs.
#[pyfunction]
fn lz4_block_decompress<'py>(py: Python<'py>, data: &[u8], uncompressed_size: usize) -> PyResult<Bound<'py, PyBytes>> {
    let out = py
        .detach(|| lz4_flex::block::decompress(data, uncompressed_size))
        .map_err(|e| PyValueError::new_err(format!("Corrupted LZ4 block: {e}")))?;
    if out.len() != uncompressed_size {
        return Err(PyValueError::new_err(format!(
            "Decompressed {} bytes, expected {uncompressed_size}",
            out.len()
        )));
    }
    Ok(PyBytes::new(py, &out))
}

#[pymodule]
fn alas_native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(lz4_block_decompress, m)?)?;
    Ok(())
}
