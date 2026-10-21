"""The app's own 3D snapshot for the PDF, received as a data URL and treated as untrusted bytes:
strict size and format checks, a full decode under a pixel cap, then a clean re-encode, so only
plain pixels (no metadata, no extra chunks) ever reach the PDF.

JPEGs must be baseline: a progressive JPEG can repeat its scans thousands of times, and each scan
is another full pass over the image (minutes of CPU for a 2 MB file). Browsers' canvas export is
always baseline, so real snapshots are unaffected."""

from __future__ import annotations

import base64
import binascii
import io
import re

from PIL import Image

MAX_IMAGE_BYTES = 2_000_000  # decoded
MAX_SIDE = 2400
MIN_SIDE = 200
MAX_PIXELS = MAX_SIDE * MAX_SIDE
DATA_URL = re.compile(r"^data:image/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$")
FORMATS = {"png": "PNG", "jpeg": "JPEG"}
JPEG_SCAN = bytes((0xFF, 0xDA))  # start-of-scan marker (byte stuffing keeps it out of entropy data)
MAX_JPEG_SCANS = 4


class InvalidImage(ValueError):
    """The snapshot is not an acceptable PNG/JPEG. Never carries input text."""


def clean_snapshot(data_url: str) -> bytes:
    """Validate a PNG/JPEG data URL and return a freshly encoded RGB JPEG."""
    match = DATA_URL.match(data_url)
    if not match:
        raise InvalidImage()
    kind, payload = match.groups()
    if len(payload) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise InvalidImage()
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidImage() from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise InvalidImage()
    if kind == "jpeg" and raw.count(JPEG_SCAN) > MAX_JPEG_SCANS:
        raise InvalidImage()
    try:
        with Image.open(io.BytesIO(raw), formats=[FORMATS[kind]]) as image:
            width, height = image.size
            if not (MIN_SIDE <= width <= MAX_SIDE and MIN_SIDE <= height <= MAX_SIDE) or width * height > MAX_PIXELS:
                raise InvalidImage()
            if kind == "jpeg" and (image.info.get("progressive") or image.info.get("progression")):
                raise InvalidImage()
            image.load()  # full decode: truncated or corrupt data fails here
            clean = image.convert("RGB")
    except InvalidImage:
        raise
    except Exception as exc:  # any decoder failure is just "not a valid picture", never a 500
        raise InvalidImage() from exc
    clean.info.clear()  # convert() copies info; drop comments and anything else from the input
    out = io.BytesIO()
    clean.save(out, format="JPEG", quality=90)
    return out.getvalue()
