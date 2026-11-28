"""
Pure numpy inference of the cnocr 1.2 CRNN models (densenet-lite + bidirectional GRU).

The models in ./bin/cnocr_models were trained with MXNet, which has no wheels for
modern Python. This module reads the MXNet files directly:
    - `*-symbol.json` the computation graph, interpreted node by node
    - `*-NNNN.params` the weights, an MXNet NDArray list in binary

Only the operators these models use are implemented, in inference mode.
"""
import json
import struct

import numpy as np

_LIST_MAGIC = 0x112
_NDARRAY_V1_MAGIC = 0xF993FAC8
_NDARRAY_V2_MAGIC = 0xF993FAC9
_NDARRAY_V3_MAGIC = 0xF993FACA
# mshadow type flags
_DTYPES = {0: np.float32, 1: np.float64, 2: np.float16, 3: np.uint8, 4: np.int32, 5: np.int8, 6: np.int64}


def load_params(path):
    """
    Read an MXNet `.params` file.

    Returns:
        dict[str, np.ndarray]: Keys without the `arg:` / `aux:` prefix.
    """
    with open(path, 'rb') as f:
        buf = f.read()
    offset = 0

    def read(fmt):
        nonlocal offset
        values = struct.unpack_from(fmt, buf, offset)
        offset += struct.calcsize(fmt)
        return values

    magic, _ = read('<QQ')
    if magic != _LIST_MAGIC:
        raise ValueError(f'Not an MXNet params file: {path}')
    count, = read('<Q')
    arrays = []
    for _ in range(count):
        magic, = read('<I')
        if magic in (_NDARRAY_V2_MAGIC, _NDARRAY_V3_MAGIC):
            stype, = read('<i')
            if stype != 0:
                raise ValueError('Sparse NDArray is not supported')
            ndim, = read('<I')
            shape = read(f'<{ndim}q')
        elif magic == _NDARRAY_V1_MAGIC:
            ndim, = read('<I')
            shape = read(f'<{ndim}q')
        else:
            # Legacy format, the magic is ndim and dims are uint32
            ndim = magic
            shape = read(f'<{ndim}I')
        if ndim == 0:
            arrays.append(np.zeros((), dtype=np.float32))
            continue
        _dev_type, _dev_id, type_flag = read('<iii')
        dtype = np.dtype(_DTYPES[type_flag])
        size = int(np.prod(shape))
        array = np.frombuffer(buf, dtype=dtype, count=size, offset=offset).reshape(shape)
        offset += size * dtype.itemsize
        arrays.append(array)
    count, = read('<Q')
    names = []
    for _ in range(count):
        length, = read('<Q')
        names.append(buf[offset:offset + length].decode('utf-8'))
        offset += length
    params = {}
    # A params file with more names than arrays (or fewer) is corrupt
    for name, array in zip(names, arrays, strict=True):
        name = name.split(':', 1)[-1]
        params[name] = array.astype(np.float32)
    return params


def _tuple(value):
    value = value.strip('()[] ')
    if not value:
        return ()
    return tuple(int(v) for v in value.split(',') if v.strip())


def _im2col(x, kernel, stride, pad):
    """
    Args:
        x: (N, C, H, W)

    Returns:
        np.ndarray: (N, C, kh, kw, OH, OW) view-like array
    """
    kh, kw = kernel
    sh, sw = stride
    ph, pw = pad
    if ph or pw:
        x = np.pad(x, ((0, 0), (0, 0), (ph, ph), (pw, pw)))
    n, c, h, w = x.shape
    oh = (h - kh) // sh + 1
    ow = (w - kw) // sw + 1
    s = x.strides
    return np.lib.stride_tricks.as_strided(
        x, shape=(n, c, kh, kw, oh, ow),
        strides=(s[0], s[1], s[2], s[3], s[2] * sh, s[3] * sw), writeable=False)


def convolution(x, weight, bias, kernel, stride, pad, groups):
    n = x.shape[0]
    out_c = weight.shape[0]
    cols = _im2col(x, kernel, stride, pad)
    _, c, kh, kw, oh, ow = cols.shape
    if groups == 1:
        # (O, C*kh*kw) @ (N, C*kh*kw, OH*OW)
        cols = np.ascontiguousarray(cols).reshape(n, c * kh * kw, oh * ow)
        out = np.matmul(weight.reshape(out_c, -1), cols)
    elif groups == c == out_c:
        # Depthwise
        out = np.einsum('nckloq,ckl->ncoq', cols, weight[:, 0], optimize=True).reshape(n, out_c, oh * ow)
    else:
        raise ValueError(f'Grouped convolution is not supported: groups={groups}')
    out = out.reshape(n, out_c, oh, ow)
    if bias is not None:
        out += bias.reshape(1, -1, 1, 1)
    return out


def max_pooling(x, kernel, stride):
    cols = _im2col(x, kernel, stride, (0, 0))
    return cols.max(axis=(2, 3))


def _sigmoid(x):
    # tanh form never overflows
    return 0.5 * (np.tanh(0.5 * x) + 1.)


def gru_direction(x, w_ih, w_hh, b_ih, b_hh, reverse):
    """
    MXNet / cuDNN GRU, gate order (r, z, n).

    Args:
        x: (T, N, I)

    Returns:
        np.ndarray: (T, N, H)
    """
    t_len, n, _ = x.shape
    hidden = w_hh.shape[1]
    # Input projection for all time steps at once
    gi = np.matmul(x, w_ih.T) + b_ih
    h = np.zeros((n, hidden), dtype=np.float32)
    out = np.empty((t_len, n, hidden), dtype=np.float32)
    steps = range(t_len - 1, -1, -1) if reverse else range(t_len)
    w_hh_t = np.ascontiguousarray(w_hh.T)
    for t in steps:
        gh = h @ w_hh_t + b_hh
        i_r, i_z, i_n = gi[t, :, :hidden], gi[t, :, hidden:2 * hidden], gi[t, :, 2 * hidden:]
        h_r, h_z, h_n = gh[:, :hidden], gh[:, hidden:2 * hidden], gh[:, 2 * hidden:]
        r = _sigmoid(i_r + h_r)
        z = _sigmoid(i_z + h_z)
        cand = np.tanh(i_n + r * h_n)
        h = (1. - z) * cand + z * h
        out[t] = h
    return out


class CrnnModel:
    def __init__(self, symbol_file, params_file):
        with open(symbol_file, encoding='utf-8') as f:
            symbol = json.load(f)
        self.nodes = symbol['nodes']
        self.params = load_params(params_file)
        # Output: the FullyConnected layer feeding SoftmaxActivation
        self.output = None
        for index, node in enumerate(self.nodes):
            if node['op'] == 'SoftmaxActivation':
                self.output = index
        if self.output is None:
            raise ValueError(f'No SoftmaxActivation in {symbol_file}')
        self._prepare()

    def _param(self, node_index):
        return self.params[self.nodes[node_index]['name']]

    def _prepare(self):
        """Pre-compute what does not depend on the input."""
        for node in self.nodes:
            if node['op'] == 'BatchNorm':
                attrs = node.get('attrs', {})
                inputs = [i[0] for i in node['inputs']]
                gamma, beta, mean, var = [self._param(i) for i in inputs[1:5]]
                if attrs.get('fix_gamma', 'True') == 'True':
                    gamma = np.ones_like(gamma)
                eps = float(attrs.get('eps', '1e-3'))
                scale = gamma / np.sqrt(var + eps)
                node['_scale'] = scale.reshape(1, -1, 1, 1).astype(np.float32)
                node['_shift'] = (beta - mean * scale).reshape(1, -1, 1, 1).astype(np.float32)
            elif node['op'] == 'RNN':
                self._prepare_rnn(node)

    def _prepare_rnn(self, node):
        attrs = node['attrs']
        if attrs.get('mode') != 'gru' or int(attrs.get('num_layers', 1)) != 1:
            raise ValueError('Only single layer GRU is supported')
        bidirectional = attrs.get('bidirectional') == 'True'
        concat = self.nodes[node['inputs'][1][0]]
        # Each input of _rnn_param_concat is Reshape(-1) of a weight variable
        names = [self.nodes[self.nodes[i[0]]['inputs'][0][0]]['name'] for i in concat['inputs']]
        weights = {}
        for name in names:
            # gru0_l0_i2h_weight -> l0_i2h_weight
            key = '_'.join(name.split('_')[-3:])
            weights[key] = self.params[name]
        directions = ['l0', 'r0'] if bidirectional else ['l0']
        node['_gru'] = [
            (weights[f'{d}_i2h_weight'], weights[f'{d}_h2h_weight'],
             weights[f'{d}_i2h_bias'], weights[f'{d}_h2h_bias'], d == 'r0')
            for d in directions]

    def forward(self, data):
        """
        Args:
            data: (N, 1, 32, W) float32 in [0, 1]

        Returns:
            np.ndarray: Probability (T * N, num_classes), same layout as cnocr.
        """
        values = {}
        nodes = self.nodes
        for index, node in enumerate(nodes[:self.output + 1]):
            op = node['op']
            attrs = node.get('attrs', {})
            inputs = [i[0] for i in node['inputs']]
            if op == 'null':
                if index == 0 or node['name'] == 'data':
                    values[index] = data
                continue
            if op == 'Convolution':
                weight = self._param(inputs[1])
                bias = self._param(inputs[2]) if attrs.get('no_bias') != 'True' else None
                values[index] = convolution(
                    values[inputs[0]], weight, bias, _tuple(attrs['kernel']),
                    _tuple(attrs.get('stride', '(1, 1)')) or (1, 1), _tuple(attrs.get('pad', '(0, 0)')) or (0, 0),
                    int(attrs.get('num_group', 1)))
            elif op == 'BatchNorm':
                values[index] = values[inputs[0]] * node['_scale'] + node['_shift']
            elif op == 'Activation':
                if attrs['act_type'] != 'relu':
                    raise ValueError(f'Unsupported activation: {attrs["act_type"]}')
                values[index] = np.maximum(values[inputs[0]], 0)
            elif op == 'Concat':
                values[index] = np.concatenate([values[i] for i in inputs], axis=int(attrs.get('dim', 1)))
            elif op == 'Pooling':
                if attrs.get('pool_type') != 'max' or attrs.get('global_pool') == 'True':
                    raise ValueError('Only max pooling is supported')
                values[index] = max_pooling(values[inputs[0]], _tuple(attrs['kernel']), _tuple(attrs['stride']))
            elif op == 'Reshape':
                if inputs[0] not in values:
                    # Weight reshapes of the RNN parameter concat, handled in _prepare_rnn
                    continue
                values[index] = self._reshape(values[inputs[0]], _tuple(attrs['shape']))
            elif op == 'expand_dims':
                values[index] = np.expand_dims(values[inputs[0]], int(attrs['axis']))
            elif op == 'squeeze':
                values[index] = np.squeeze(values[inputs[0]], axis=int(attrs['axis']))
            elif op == 'Dropout':
                values[index] = values[inputs[0]]
            elif op == 'transpose':
                values[index] = np.transpose(values[inputs[0]], _tuple(attrs['axes']))
            elif op in ('_rnn_param_concat', '_zeros'):
                continue
            elif op == 'RNN':
                x = np.ascontiguousarray(values[inputs[0]], dtype=np.float32)
                outs = [gru_direction(x, *gru) for gru in node['_gru']]
                values[index] = np.concatenate(outs, axis=-1)
            elif op == 'FullyConnected':
                x = values[inputs[0]]
                x = x.reshape(x.shape[0], -1)
                values[index] = x @ self._param(inputs[1]).T + self._param(inputs[2])
            elif op == 'SoftmaxActivation':
                x = values[inputs[0]]
                x = np.exp(x - x.max(axis=-1, keepdims=True))
                values[index] = x / x.sum(axis=-1, keepdims=True)
            else:
                raise ValueError(f'Unsupported operator: {op}')
        return values[self.output]

    @staticmethod
    def _reshape(x, shape):
        # Only the special codes used by the cnocr graphs
        if shape == (0, -3, 0):
            return x.reshape(x.shape[0], x.shape[1] * x.shape[2], *x.shape[3:])
        if shape == (-3, -2):
            return x.reshape(x.shape[0] * x.shape[1], *x.shape[2:])
        if shape == (-1,):
            return x.reshape(-1)
        raise ValueError(f'Unsupported reshape: {shape}')
