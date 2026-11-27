"""
The numpy CRNN must read exactly like cnocr 1.2 on MXNet did.

tests/ocr/fixtures/expected.json was produced by the original MXNet models
(mxnet 1.6.0, cnocr 1.2.2) on the line images next to it, without and with a
digit alphabet, all images in one padded batch, as Ocr.ocr() calls it.
"""
import json
from pathlib import Path

import cv2
import pytest

from module.ocr.models import OCR_MODEL

FIXTURES = Path(__file__).parent / 'fixtures'
EXPECTED = json.loads((FIXTURES / 'expected.json').read_text(encoding='utf-8'))
IMAGES = [cv2.imread(str(FIXTURES / f'line{i}.png'), cv2.IMREAD_GRAYSCALE) for i in range(8)]


@pytest.mark.parametrize('key', sorted(EXPECTED))
def test_same_reading_as_mxnet(key):
    lang, alphabet = key.split('|')
    model = getattr(OCR_MODEL, lang)
    result = model.atomic_ocr_for_single_lines(IMAGES, alphabet or None)
    assert [''.join(r) for r in result] == EXPECTED[key]


def test_single_line_equals_batch_of_one():
    model = OCR_MODEL.azur_lane
    assert model.atomic_ocr_for_single_line(IMAGES[0]) == model.atomic_ocr_for_single_lines([IMAGES[0]])[0]


def test_empty_batch():
    assert OCR_MODEL.azur_lane.atomic_ocr_for_single_lines([]) == []
