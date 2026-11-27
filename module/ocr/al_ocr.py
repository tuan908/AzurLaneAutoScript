import os

import cv2
import numpy as np
from PIL import Image

from module.exception import RequestHumanTakeover
from module.logger import logger
from module.ocr.crnn import CrnnModel

MODEL_FILE_PREFIX = 'cnocr-v1.2.0'
IMG_HEIGHT = 32
# densenet models shrink the width by 4 before the GRU
SEQ_LEN_CMPR_RATIO = 4


def _limit_blas_threads():
    """
    The OCR inputs are tiny, a multi-threaded BLAS spends more time waking its
    threads than computing (100ms vs 18ms per image), and several ALAS instances
    run side by side anyway.
    """
    try:
        from threadpoolctl import threadpool_limits
        threadpool_limits(limits=1, user_api='blas')
    except Exception as e:
        logger.warning(f'Failed to limit BLAS threads: {e}')


def read_charset(charset_fp):
    alphabet = [None]
    # Index 0 is the CTC blank
    with open(charset_fp, encoding='utf-8') as fp:
        for line in fp:
            alphabet.append(line.rstrip('\n'))
    try:
        space_idx = alphabet.index('<space>')
        alphabet[space_idx] = ' '
    except ValueError:
        pass
    inv_alph_dict = {_char: idx for idx, _char in enumerate(alphabet)}
    return alphabet, inv_alph_dict


def ctc_label(p):
    """
    Collapse a CTC path: drop blanks (0) and repeats.

    Args:
        p (list[int]):

    Returns:
        list[int]:
    """
    ret = []
    prev = 0
    for c in p:
        if c != 0 and c != prev:
            ret.append(c)
        prev = c
    return ret


class AlOcr:
    """
    Recognizer of single text lines, the cnocr 1.2 `CnOcr` API on top of a numpy
    CRNN, so it runs on any Python without MXNet.
    """

    def __init__(
            self,
            model_name='densenet-lite-gru',
            model_epoch=None,
            cand_alphabet=None,
            root='',
            context='cpu',
            name=None,
    ):
        self._args = (model_name, model_epoch, cand_alphabet, root, context, name)
        self._model_loaded = False

    def init(self,
             model_name='densenet-lite-gru',
             model_epoch=None,
             cand_alphabet=None,
             root='',
             context='cpu',
             name=None,
             ):
        self._model_name = model_name
        self._model_file_prefix = '{}-{}'.format(MODEL_FILE_PREFIX, model_name)
        self._model_epoch = model_epoch
        self._model_dir = root
        self._assert_and_prepare_model_files()
        self._alphabet, self._inv_alph_dict = read_charset(os.path.join(self._model_dir, 'label_cn.txt'))
        self._cand_alph_idx = None
        _limit_blas_threads()
        logger.info('Loading OCR model: %s' % self._model_dir)
        prefix = os.path.join(self._model_dir, self._model_file_prefix)
        self._model = CrnnModel(
            symbol_file='%s-symbol.json' % prefix,
            params_file='%s-%04d.params' % (prefix, self._model_epoch),
        )
        self._model_loaded = True

    def _ensure_loaded(self):
        if not self._model_loaded:
            self.init(*self._args)

    def ocr(self, img_fp):
        """
        Treat the whole image as one line.

        Returns:
            list[list[str]]:
        """
        self._ensure_loaded()
        if min(img_fp.shape[0], img_fp.shape[1]) < 2:
            return []
        return self.ocr_for_single_lines([img_fp])

    def ocr_for_single_line(self, img_fp):
        self._ensure_loaded()
        return self.ocr_for_single_lines([img_fp])[0]

    def ocr_for_single_lines(self, img_list):
        """
        Args:
            img_list (list[np.ndarray]): Line images, (height, width) or (height, width, 3), 0 to 255.

        Returns:
            list[list[str]]: Such as [['第', '一', '行'], ['第', '二', '行']]
        """
        self._ensure_loaded()
        if len(img_list) == 0:
            return []
        img_list = [self._preprocess_img_array(img) for img in img_list]
        batch_size = len(img_list)
        img_list, img_widths = self._pad_arrays(img_list)

        prob = self._model.forward(np.stack(img_list))
        # [seq_len, batch_size, num_classes]
        prob = np.reshape(prob, (-1, batch_size, prob.shape[1]))
        if self._cand_alph_idx is not None:
            prob = prob * self._gen_mask(prob.shape)

        max_width = max(img_widths)
        return [self._gen_line_pred_chars(prob[:, i, :], img_widths[i], max_width) for i in range(batch_size)]

    def set_cand_alphabet(self, cand_alphabet):
        self._ensure_loaded()
        if cand_alphabet is None:
            self._cand_alph_idx = None
        else:
            self._cand_alph_idx = sorted([0] + [self._inv_alph_dict[word] for word in cand_alphabet])

    """
    Atomic version of the OCR methods above
    handling set_cand_alphabet inside
    """

    def atomic_ocr(self, img_fp, cand_alphabet=None):
        self.set_cand_alphabet(cand_alphabet)
        return self.ocr(img_fp)

    def atomic_ocr_for_single_line(self, img_fp, cand_alphabet=None):
        self.set_cand_alphabet(cand_alphabet)
        return self.ocr_for_single_line(img_fp)

    def atomic_ocr_for_single_lines(self, img_list, cand_alphabet=None):
        self.set_cand_alphabet(cand_alphabet)
        return self.ocr_for_single_lines(img_list)

    def _assert_and_prepare_model_files(self):
        model_dir = self._model_dir
        model_files = [
            'label_cn.txt',
            '%s-%04d.params' % (self._model_file_prefix, self._model_epoch),
            '%s-symbol.json' % self._model_file_prefix,
        ]
        for f in model_files:
            if not os.path.exists(os.path.join(model_dir, f)):
                logger.warning('can not find file %s', f)
                logger.warning(f'Ocr model not prepared: {model_dir}')
                logger.warning(f'Required files: {model_files}')
                logger.critical('Please check if required files of pre-trained OCR model exist')
                raise RequestHumanTakeover

    def _gen_mask(self, prob_shape):
        mask_shape = list(prob_shape)
        mask_shape[1] = 1
        mask = np.zeros(mask_shape, dtype='int8')
        mask[:, :, self._cand_alph_idx] = 1
        return mask

    @staticmethod
    def _preprocess_img_array(img):
        """
        Args:
            img (np.ndarray): (height, width) or (height, width, 3)

        Returns:
            np.ndarray: (1, 32, new_width) float32 in [0, 1]
        """
        if img.ndim == 3:
            img = cv2.cvtColor(img.astype(np.uint8), cv2.COLOR_RGB2GRAY)
        # Resize image using `cv2.resize` instead of `mxnet.image.imresize`
        new_width = int(round(IMG_HEIGHT / img.shape[0] * img.shape[1]))
        img = cv2.resize(img, (new_width, IMG_HEIGHT))
        return np.expand_dims(img, 0).astype('float32') / 255.0

    @staticmethod
    def _pad_arrays(img_list):
        """Padding to make sure all the elements have the same width."""
        img_widths = [img.shape[2] for img in img_list]
        if len(img_list) <= 1:
            return img_list, img_widths
        max_width = max(img_widths)
        padded = []
        for img in img_list:
            if img.shape[2] < max_width:
                img = np.pad(img, ((0, 0), (0, 0), (0, max_width - img.shape[2])), 'constant', constant_values=0.0)
            padded.append(img)
        return padded, img_widths

    def _gen_line_pred_chars(self, line_prob, img_width, max_img_width):
        """
        Args:
            line_prob: (seq_length, num_classes)
        """
        class_ids = np.argmax(line_prob, axis=-1)
        class_ids *= np.max(line_prob, axis=-1) > 0.5  # Delete low confidence result

        if img_width < max_img_width:
            end_idx = img_width // SEQ_LEN_CMPR_RATIO
            if end_idx < len(class_ids):
                class_ids[end_idx:] = 0
        prediction = ctc_label(class_ids.tolist())
        alphabet = self._alphabet
        return [alphabet[p] if alphabet[p] != '<space>' else ' ' for p in prediction]

    def debug(self, img_list):
        """
        Args:
            img_list: List of numpy array, (height, width)
        """
        self._ensure_loaded()
        img_list = [(self._preprocess_img_array(img) * 255.0).astype(np.uint8) for img in img_list]
        img_list, img_widths = self._pad_arrays(img_list)
        image = cv2.hconcat(img_list)[0, :, :]
        Image.fromarray(image).show()
