---
"@demake/core": minor
---

Export the deterministic math kernels and PRNG from the public API. Every
package under the determinism rule needs them, and a second implementation
would defeat the point (doc 02 §Floating-point discipline).
