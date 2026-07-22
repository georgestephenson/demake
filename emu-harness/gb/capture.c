/*
 * Headless GB/GBC frame capture for the demake pixel-perfect E2E (doc 10).
 *
 * Boots a ROM in SameBoy (the accuracy reference emulator) via its public
 * `libsameboy` API, runs it for a fixed number of frames, and writes the
 * 160x144 framebuffer as a binary PPM (P6). Color correction is DISABLED so the
 * output is the raw hardware readout: RGB555 expanded as (x<<3)|(x>>2) on CGB —
 * byte-identical to demake's `expandChannel` — and, on DMG, the exact shade
 * palette we pass in. That makes the capture directly comparable to demake's
 * DAC reference with no emulator-specific calibration.
 *
 * Usage: capture <dmg|cgb> <boot.bin> <rom> <frames> <out.ppm>
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <Core/gb.h>

static uint32_t rgb_encode(GB_gameboy_t *gb, uint8_t r, uint8_t g, uint8_t b) {
    (void)gb;
    return ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;
}

/*
 * demake's classic DMG green ramp, in SameBoy's palette order. SameBoy indexes
 * GB_palette_t darkest-first and maps BG pixel value v to colors[3 - v], so this
 * is demake's lightest-first `dmg` ramp reversed. colors[4] is the LCD-off shade.
 */
static const GB_palette_t DMG_RAMP = {
    .colors = {
        {15, 56, 15}, {48, 98, 48}, {139, 172, 15}, {155, 188, 15}, {155, 188, 15},
    },
};

int main(int argc, char **argv) {
    if (argc != 6) {
        fprintf(stderr, "usage: %s <dmg|cgb> <boot.bin> <rom> <frames> <out.ppm>\n", argv[0]);
        return 2;
    }
    const int is_cgb = strcmp(argv[1], "cgb") == 0;
    GB_gameboy_t gb;
    GB_init(&gb, is_cgb ? GB_MODEL_CGB_E : GB_MODEL_DMG_B);

    if (GB_load_boot_rom(&gb, argv[2])) {
        fprintf(stderr, "capture: failed to load boot rom '%s'\n", argv[2]);
        return 1;
    }
    if (GB_load_rom(&gb, argv[3])) {
        fprintf(stderr, "capture: failed to load rom '%s'\n", argv[3]);
        return 1;
    }

    GB_set_rgb_encode_callback(&gb, rgb_encode);
    GB_set_color_correction_mode(&gb, GB_COLOR_CORRECTION_DISABLED);
    if (!is_cgb) GB_set_palette(&gb, &DMG_RAMP);

    const unsigned w = GB_get_screen_width(&gb);
    const unsigned h = GB_get_screen_height(&gb);
    uint32_t *fb = calloc((size_t)w * h, sizeof(uint32_t));
    if (!fb) return 1;
    GB_set_pixels_output(&gb, fb);

    const int frames = atoi(argv[4]);
    for (int i = 0; i < frames; i += 1) GB_run_frame(&gb);

    FILE *f = fopen(argv[5], "wb");
    if (!f) {
        fprintf(stderr, "capture: cannot write '%s'\n", argv[5]);
        return 1;
    }
    fprintf(f, "P6\n%u %u\n255\n", w, h);
    for (unsigned i = 0; i < w * h; i += 1) {
        const uint32_t p = fb[i];
        const unsigned char rgb[3] = {(p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff};
        fwrite(rgb, 1, 3, f);
    }
    fclose(f);
    free(fb);
    GB_free(&gb);
    return 0;
}
