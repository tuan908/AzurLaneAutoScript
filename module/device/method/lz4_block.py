"""
LZ4 block decompression for aScreenCap.

In order: alas_native (Rust, native/build.sh), the `lz4` package, then the pure
Python decoder below (tens of ms per 720p frame). `lz4` has no wheels for Python 3.15.
"""


class LZ4BlockError(ValueError):
    pass


def decompress_python(source, uncompressed_size):
    """
    Args:
        source (bytes): One LZ4 block, without frame header.
        uncompressed_size (int):

    Returns:
        bytes:
    """
    src = memoryview(source)
    end = len(src)
    dst = bytearray()
    i = 0
    try:
        while i < end:
            token = src[i]
            i += 1
            # Literals
            length = token >> 4
            if length == 15:
                while True:
                    b = src[i]
                    i += 1
                    length += b
                    if b != 255:
                        break
            if length:
                dst += src[i:i + length]
                i += length
            if i >= end:
                # The last sequence has literals only
                break
            # Match
            offset = src[i] | (src[i + 1] << 8)
            i += 2
            if offset == 0 or offset > len(dst):
                raise LZ4BlockError(f'Invalid match offset {offset} at {i}')
            length = token & 0x0F
            if length == 15:
                while True:
                    b = src[i]
                    i += 1
                    length += b
                    if b != 255:
                        break
            length += 4
            start = len(dst) - offset
            if length <= offset:
                dst += dst[start:start + length]
            else:
                # Overlapping copy repeats the last `offset` bytes
                chunk = dst[start:]
                repeat, rest = divmod(length, offset)
                dst += chunk * repeat + chunk[:rest]
    except IndexError:
        raise LZ4BlockError('Truncated LZ4 block')
    if len(dst) != uncompressed_size:
        raise LZ4BlockError(f'Decompressed {len(dst)} bytes, expected {uncompressed_size}')
    return bytes(dst)


try:
    import alas_native as _native
except ImportError:
    _native = None

if _native is not None:
    def decompress(source, uncompressed_size):
        try:
            return _native.lz4_block_decompress(source, uncompressed_size)
        except ValueError as e:
            raise LZ4BlockError(str(e)) from None
else:
    try:
        from lz4.block import LZ4BlockError, decompress
    except ImportError:
        decompress = decompress_python
