# Raster-decoder fixtures

Each file here is half of a pair. `pattern.gif` is the input; `pattern.gif.rgba`
is the raw 8-bit RGBA a browser produced from those exact bytes, 24×16 pixels,
row-major, four bytes a pixel. `raster.test.ts` compares our decoder against the
second half.

The point is the oracle. A decoder tested only against an encoder written beside
it agrees with itself and with nothing else — the argument `arm-gnu.test.ts`
makes about an instruction encoder, one layer down — so nothing in this
directory came out of `packages/core/src`:

- The **BMPs** and **GIFs** were written from the format specifications by a
  throwaway script (a BMP is a header and rows; a GIF needed a real LZW encoder,
  dictionary and all, so the decoder's dictionary path is genuinely exercised).
- The **JPEGs** came out of a browser's own encoder, because a JPEG encoder
  written beside a JPEG decoder is exactly the oracle this directory exists to
  avoid.
- Every `.rgba` is that browser's decode of the file beside it.

The picture is the same 24×16 pattern in all of them: a flat band, a horizontal
ramp, a second flat band, and a single-pixel checkerboard — flat areas, a
gradient and the highest frequency the format can carry, which between them
catch a wrong stride, a wrong colour table and a wrong transform.

`overhang.jpg` is the exception, and it is 21×19 for one reason: against a 16×16
macroblock the last block of every row _and_ every column is coded in full and
mostly outside the picture. 24×16 covers the horizontal case and cannot cover the
vertical one.

**Why the fixtures are what they are, where they could have been more:**

- `pattern-32.bmp` is fully opaque even though it declares an alpha mask. The
  reference comes back through a canvas, and a canvas stores premultiplied
  alpha: a half-transparent pixel read back is a level or two off whatever wrote
  it, so the _oracle's_ rounding would present as our error. Translucency, the
  sub-byte depths, the 16-bit channel masks and the run-length encodings are
  checked by hand in `raster.test.ts` instead, against files it builds inline.
- The JPEGs are 4:2:0 (which is what the encoder produces) and baseline. A file
  with **restart markers** would be worth adding: no encoder reachable from this
  repository emits them, so the code that resets the predictions and starts a
  fresh bit reader at each one is written from the standard and unproven.

To regenerate, drive a browser: encode the pattern, decode each file back, and
write the pairs. Do not regenerate them from our own decoders — that would turn
the oracle into a mirror.
