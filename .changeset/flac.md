---
"@demake/audio": minor
"@demake/cli-spec": minor
---

Write FLAC — the lossless artifact you can hand to somebody who does not have
this project. `--preview-format flac` on `arrange`, `sfx` and `render`, and a
FLAC button in the web app's two audio sections.

Doc 16 has called FLAC "the recommended shareable file" since the audio spine was
designed: lossless, and the only such format that plays natively in Chrome,
Firefox, Safari, macOS and Windows. Until now the flag rejected it.

**The encoder is ours**, like every other codec here, and for the strongest of
doc 02's reasons: a byte-identical artifact across the CLI, the browser and the
desktop cannot depend on a library that ships a different version in each. Every
arithmetic operation is integer, so the file is the same file on every engine.

"Sample-identical to the WAV" is now true **by construction** rather than by two
encoders agreeing — both go through one quantizer in `encode/pcm.ts`.

Constant, fixed (orders 0–4) and verbatim subframes, Rice-coded residuals over a
searched partition order, and stereo decorrelation; every choice is made by
**measuring the encoded size** rather than estimating it, which removes the whole
family of bugs where an estimator disagrees with the encoder after it. **LPC is
deliberately absent**: its coefficients come from floating-point autocorrelation
and Levinson-Durbin, and a predictor derived from `Math` would be a different file
on a different engine — exactly the property this format is here to provide. It
costs little on this material, because fixed predictors suit chip audio: a square
wave is piecewise constant, so its first difference is zero almost everywhere.
Measured on a demade Game Boy track, **61.7% of the WAV against the reference
encoder's 59.8% at `-8`**.

**The stream carries an MD5 of its own audio**, which the format leaves optional.
That is the load-bearing decision for testability: `flac -t` decodes the whole
stream and compares its own digest against ours, so it passes only if the
bitstream is bit-for-bit the samples we hashed. `flac-reference.test.ts` runs that
plus a decode-and-compare against `encodeWav` over fourteen shapes at both depths
— silence, a held level, identical channels, one side only, full-scale noise,
clipping, mono, eight channels, one sample, and the three block-boundary cases —
and self-skips without the tool, on `arm-gnu.test.ts`'s terms. `pnpm toolchains`
installs it; it is a stock distro package.

No existing output changes: this adds a format rather than altering one.
