"""
LZ4 decoders of aScreenCap. The fixtures were compressed by the `lz4` package
(lz4.block.compress(data, store_size=False)), which has no wheels for Python 3.15.
"""
from pathlib import Path

import pytest

from module.device.method import lz4_block

FIXTURES = Path(__file__).parent / "fixtures" / "lz4"
CASES = sorted(p.stem for p in FIXTURES.glob("*.lz4"))

try:
    import alas_native
except ImportError:
    alas_native = None

DECODERS = {"python": lz4_block.decompress_python}
if alas_native is not None:
    DECODERS["native"] = alas_native.lz4_block_decompress


@pytest.mark.parametrize("case", CASES)
@pytest.mark.parametrize("decoder", sorted(DECODERS))
def test_same_as_lz4(case, decoder):
    data = (FIXTURES / f"{case}.raw").read_bytes()
    compressed = (FIXTURES / f"{case}.lz4").read_bytes()
    assert DECODERS[decoder](compressed, len(data)) == data


@pytest.mark.parametrize("decoder", sorted(DECODERS))
def test_truncated_raises(decoder):
    data = (FIXTURES / "repeat.raw").read_bytes()
    compressed = (FIXTURES / "repeat.lz4").read_bytes()
    with pytest.raises(ValueError):
        DECODERS[decoder](compressed[:len(compressed) // 2], len(data))


def test_module_decompress_raises_lz4_block_error():
    compressed = (FIXTURES / "repeat.lz4").read_bytes()
    with pytest.raises(lz4_block.LZ4BlockError):
        lz4_block.decompress(compressed[:5], 3000)


def test_wrong_size_raises():
    compressed = (FIXTURES / "repeat.lz4").read_bytes()
    with pytest.raises(lz4_block.LZ4BlockError):
        lz4_block.decompress(compressed, 2999)
