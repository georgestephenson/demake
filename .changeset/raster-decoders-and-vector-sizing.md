---
"@demake/core": minor
"demake": minor
---

Decode JPEG, GIF and BMP, rasterise a vector source at the size the demake needs,
and report what the source actually was.

**Three more codecs, and all of them ours** (doc 02 §Image codecs). BMP and GIF
are lossless, so they are ours for PNG's reason and the work is in the formats'
variety — four DIB headers, two row orders, channel masks and both run-length
encodings; LZW, the interlace order and the transparent index. JPEG is ours for a
stronger reason: it is lossy, the standard fixes its inverse transform only to a
_tolerance_, and two correct libraries differ in the low bits of an edge pixel —
so a picture demade in the browser and the same picture demade by the CLI would
not have matched. The transform is the scaled-integer IDCT with its constants
written out, the colour conversion is fixed-point, and the chroma upsampling is
the triangle filter; nothing in the path touches a float or `Math.*`. Baseline
sequential only — progressive, lossless, hierarchical and arithmetic-coded files
are refused by name rather than half-decoded. WebP is still absent and still says
so.

Each is held to a second implementation rather than to an encoder written beside
it: the fixtures are a file and the RGBA a browser produced from those exact
bytes, compared exactly for the lossless formats and to ±2 for JPEG.

**A drawing is drawn at the size it is wanted at.** An SVG has no pixels of its
own, but it was rasterised at whatever size its author declared and then scaled
to the target, so a 64×64 file asked for at 160×144 came out as a 64×64 raster
stretched — a blur the file never contained. `decodeImage` takes an `atLeast`
raster, and the two places that know a target size pass it: an explicit
`--size`, and a sprite's cell box. It scales the document's own declared size, so
`--fit`, the auto size and the cell box all mean exactly what they meant before,
and every raster format ignores it because there the pixels are the file.

This changes output bytes only where a conversion was previously upscaling a
vector source; every fixture in the repository demakes _down_ from a drawing
bigger than the screen and is byte-identical.

**`PrepResult` gains `source`** — the format the bytes turned out to be, the
raster the pipeline fitted from, and whether that raster was a choice (`vector`)
or a fact. `demake prep --json` reports it and `-v` names it, because for a
vector source there was nothing to read it off: measuring an SVG by putting it in
an `<img>` gives the CSS answer, which is 300×150 for a document carrying only a
`viewBox` and is not the raster anything downstream used.
