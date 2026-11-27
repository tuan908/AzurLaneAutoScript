import importlib
import os
import sys

import pytest

lz4 = pytest.importorskip('lz4.block', reason='The reference encoder needs the lz4 package')


def fallback():
    """The pure Python decoder, as it loads without the lz4 package."""
    sys.modules['lz4.block'] = None
    try:
        import module.device.method.lz4_block as mod
        mod = importlib.reload(mod)
        assert mod.decompress.__module__ == mod.__name__
        return mod
    finally:
        del sys.modules['lz4.block']


@pytest.mark.parametrize('data', [
    b'',
    b'a',
    b'abc' * 1000,
    bytes(range(256)) * 50,
    os.urandom(5000),
    b'\x00' * 100000 + os.urandom(300) + b'\xff' * 70000,
])
def test_same_as_lz4(data):
    mod = fallback()
    compressed = lz4.compress(data, store_size=False)
    assert mod.decompress(compressed, uncompressed_size=len(data)) == data


def test_truncated_raises():
    mod = fallback()
    data = b'hello world ' * 100
    compressed = lz4.compress(data, store_size=False)
    with pytest.raises(mod.LZ4BlockError):
        mod.decompress(compressed[:len(compressed) // 2], uncompressed_size=len(data))
