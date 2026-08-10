/*
 * Headless GB/GBC/Mega Duck frame capture for the demake pixel-perfect E2E
 * (doc 10).
 *
 * Boots a ROM in SameBoy (the accuracy reference emulator) via its public
 * `libsameboy` API, runs it for a fixed number of frames, and writes the
 * 160x144 framebuffer as a binary PPM (P6). Color correction is DISABLED so the
 * output is the raw hardware readout: RGB555 expanded as (x<<3)|(x>>2) on CGB —
 * byte-identical to demake's `expandChannel` — and, on a mono model, the exact
 * shade palette we pass in. That makes the capture directly comparable to
 * demake's DAC reference with no emulator-specific calibration.
 *
 * **One source, two emulators.** The Mega Duck is a Game Boy clone whose I/O
 * pins were rewired (`core/src/asm/megaduck.ts`), and the emulator for it is
 * SameDuck — SameBoy's own fork, on that repository's `SameDuck` branch, where
 * the register map moved and the boot ROM went away entirely. Nothing about
 * *capturing a frame* differs, so this file is compiled twice rather than
 * copied: plain against SameBoy, and with -DDEMAKE_SAMEDUCK against SameDuck.
 * Each build accepts only the models its library really is, because a `duck`
 * that quietly ran on SameBoy would be a capture that is wrong and consistent —
 * the exact failure `megaduck.test.ts` exists to prevent one layer down.
 *
 * **The shade ramp is an argument, not a constant here.** It is a tested
 * artifact of the console spec (`consoles/dmg.ts`, `consoles/megaduck.ts`), and
 * a second copy of one in C is a copy that disagrees in one entry. The caller
 * passes demake's own ramp, lightest-first, and this file reverses it into
 * SameBoy's darkest-first order.
 *
 * Usage: capture <dmg|cgb|duck> <boot.bin|-> <rom> <frames> <out.ppm> [shades]
 *   shades: "RRGGBB,RRGGBB,RRGGBB,RRGGBB", lightest first (mono models only)
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
 * Parse "RRGGBB,..." into a GB_palette_t.
 *
 * SameBoy indexes GB_palette_t darkest-first and maps BG pixel value v to
 * colors[3 - v], so demake's lightest-first ramp is reversed on the way in.
 * colors[4] is the LCD-off shade, which takes the lightest.
 */
static int parse_ramp(const char *text, GB_palette_t *out) {
    unsigned long v[4];
    int n = 0;
    const char *p = text;
    while (n < 4) {
        char *end = NULL;
        char digits[7] = {0};
        if (strlen(p) < 6) return 0;
        memcpy(digits, p, 6);
        v[n] = strtoul(digits, &end, 16);
        if (end != digits + 6) return 0;
        n += 1;
        p += 6;
        if (*p == ',') p += 1;
        else if (*p != '\0') return 0;
    }
    if (*p != '\0') return 0;
    for (int i = 0; i < 4; i += 1) {
        const unsigned long c = v[3 - i];
        out->colors[i].r = (c >> 16) & 0xff;
        out->colors[i].g = (c >> 8) & 0xff;
        out->colors[i].b = c & 0xff;
    }
    out->colors[4] = out->colors[3];
    return 1;
}

int main(int argc, char **argv) {
    if (argc != 6 && argc != 7) {
        fprintf(stderr,
                "usage: %s <dmg|cgb|duck> <boot.bin|-> <rom> <frames> <out.ppm> [shades]\n",
                argv[0]);
        return 2;
    }
    const int is_duck = strcmp(argv[1], "duck") == 0;
    const int is_cgb = strcmp(argv[1], "cgb") == 0;
#ifdef DEMAKE_SAMEDUCK
    if (!is_duck) {
        fprintf(stderr, "capture: this build is SameDuck; only the 'duck' model exists\n");
        return 2;
    }
#else
    if (is_duck) {
        fprintf(stderr, "capture: this build is SameBoy; use the SameDuck build for 'duck'\n");
        return 2;
    }
#endif

    GB_gameboy_t gb;
    /*
     * A SameDuck build has one machine and it is the Mega Duck, so its
     * GB_MODEL_DMG_B *is* that console — the fork retargets the whole core
     * rather than adding a model.
     */
    GB_init(&gb, is_cgb ? GB_MODEL_CGB_E : GB_MODEL_DMG_B);

    /* The Mega Duck has no boot ROM at all: a cartridge begins at $0000. */
    if (strcmp(argv[2], "-") != 0 && GB_load_boot_rom(&gb, argv[2])) {
        fprintf(stderr, "capture: failed to load boot rom '%s'\n", argv[2]);
        return 1;
    }
    if (GB_load_rom(&gb, argv[3])) {
        fprintf(stderr, "capture: failed to load rom '%s'\n", argv[3]);
        return 1;
    }

    GB_set_rgb_encode_callback(&gb, rgb_encode);
    GB_set_color_correction_mode(&gb, GB_COLOR_CORRECTION_DISABLED);
    if (!is_cgb) {
        if (argc != 7) {
            fprintf(stderr, "capture: a mono model needs the shade ramp as argv[6]\n");
            return 2;
        }
        GB_palette_t ramp;
        if (!parse_ramp(argv[6], &ramp)) {
            fprintf(stderr, "capture: cannot parse shade ramp '%s'\n", argv[6]);
            return 2;
        }
        GB_set_palette(&gb, &ramp);
    }

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
