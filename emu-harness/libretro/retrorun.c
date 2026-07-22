/*
 * Generic headless libretro frame capturer for the demake pixel-perfect E2E
 * (doc 10). Loads any libretro core (.so) via dlopen, runs a ROM for N frames,
 * and writes the final framebuffer as a binary PPM (P6). This one frontend
 * serves every console that has a libretro core (NES/SMS/MD/SNES/GBA/PCE/…),
 * so adding a console is adding its core + a demake DAC calibration — not a new
 * emulator harness.
 *
 * Core options are supplied as key=value args and answered via GET_VARIABLE, so
 * e.g. a custom-palette core option can point the core at a demake palette file
 * in the system directory for byte-exact color (as with fceumm + nes.pal).
 *
 * Usage: retrorun <core.so> <rom> <frames> <out.ppm> <system_dir> [key=value ...]
 */

#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libretro.h>

/* --- captured frame -------------------------------------------------------- */
static uint8_t *g_rgb = NULL; /* RGB888, width*height*3 */
static unsigned g_w = 0, g_h = 0;
static enum retro_pixel_format g_fmt = RETRO_PIXEL_FORMAT_0RGB1555;

/* --- core options supplied on the command line ----------------------------- */
#define MAX_OPTS 64
static const char *opt_key[MAX_OPTS];
static const char *opt_val[MAX_OPTS];
static int opt_count = 0;
static char g_system_dir[1024];

static const char *find_opt(const char *key) {
  for (int i = 0; i < opt_count; i++)
    if (!strcmp(opt_key[i], key)) return opt_val[i];
  return NULL;
}

static void log_cb(enum retro_log_level level, const char *fmt, ...) {
  (void)level;
  (void)fmt; /* swallow core logging */
}

static bool environ_cb(unsigned cmd, void *data) {
  switch (cmd) {
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      g_fmt = *(const enum retro_pixel_format *)data;
      return true;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
      *(const char **)data = g_system_dir;
      return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      struct retro_variable *var = (struct retro_variable *)data;
      var->value = find_opt(var->key);
      return var->value != NULL;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
      *(bool *)data = false;
      return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
      ((struct retro_log_callback *)data)->log = log_cb;
      return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
      *(bool *)data = true;
      return true;
    case RETRO_ENVIRONMENT_SET_VARIABLES:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
      return true;
    default:
      return false;
  }
}

static void store_frame(const void *data, unsigned width, unsigned height, size_t pitch) {
  if (!data) return; /* duped frame: keep the previous capture */
  g_w = width;
  g_h = height;
  g_rgb = realloc(g_rgb, (size_t)width * height * 3);
  for (unsigned y = 0; y < height; y++) {
    for (unsigned x = 0; x < width; x++) {
      unsigned r, g, b;
      if (g_fmt == RETRO_PIXEL_FORMAT_XRGB8888) {
        uint32_t p = *(const uint32_t *)((const uint8_t *)data + y * pitch + x * 4);
        r = (p >> 16) & 0xff;
        g = (p >> 8) & 0xff;
        b = p & 0xff;
      } else if (g_fmt == RETRO_PIXEL_FORMAT_RGB565) {
        uint16_t p = *(const uint16_t *)((const uint8_t *)data + y * pitch + x * 2);
        r = ((p >> 11) & 0x1f) * 255 / 31;
        g = ((p >> 5) & 0x3f) * 255 / 63;
        b = (p & 0x1f) * 255 / 31;
      } else { /* 0RGB1555 */
        uint16_t p = *(const uint16_t *)((const uint8_t *)data + y * pitch + x * 2);
        r = ((p >> 10) & 0x1f) * 255 / 31;
        g = ((p >> 5) & 0x1f) * 255 / 31;
        b = (p & 0x1f) * 255 / 31;
      }
      uint8_t *o = g_rgb + ((size_t)y * width + x) * 3;
      o[0] = r;
      o[1] = g;
      o[2] = b;
    }
  }
}

static void video_cb(const void *data, unsigned w, unsigned h, size_t pitch) {
  store_frame(data, w, h, pitch);
}
static void audio_sample_cb(int16_t l, int16_t r) {
  (void)l;
  (void)r;
}
static size_t audio_batch_cb(const int16_t *d, size_t frames) {
  (void)d;
  return frames;
}
static void input_poll_cb(void) {}
static int16_t input_state_cb(unsigned port, unsigned dev, unsigned idx, unsigned id) {
  (void)port;
  (void)dev;
  (void)idx;
  (void)id;
  return 0;
}

#define SYM(name)                                                     \
  typeof(&name) p_##name = (typeof(&name))dlsym(core, #name);         \
  if (!p_##name) {                                                    \
    fprintf(stderr, "retrorun: missing symbol %s\n", #name);          \
    return 1;                                                         \
  }

int main(int argc, char **argv) {
  if (argc < 6) {
    fprintf(stderr, "usage: %s core.so rom frames out.ppm system_dir [key=value ...]\n", argv[0]);
    return 2;
  }
  const char *core_path = argv[1];
  const char *rom_path = argv[2];
  int frames = atoi(argv[3]);
  const char *out_path = argv[4];
  snprintf(g_system_dir, sizeof(g_system_dir), "%s", argv[5]);
  for (int i = 6; i < argc && opt_count < MAX_OPTS; i++) {
    char *eq = strchr(argv[i], '=');
    if (!eq) continue;
    *eq = 0;
    opt_key[opt_count] = argv[i];
    opt_val[opt_count] = eq + 1;
    opt_count++;
  }

  void *core = dlopen(core_path, RTLD_NOW | RTLD_LOCAL);
  if (!core) {
    fprintf(stderr, "retrorun: dlopen failed: %s\n", dlerror());
    return 1;
  }

  SYM(retro_set_environment);
  SYM(retro_set_video_refresh);
  SYM(retro_set_audio_sample);
  SYM(retro_set_audio_sample_batch);
  SYM(retro_set_input_poll);
  SYM(retro_set_input_state);
  SYM(retro_init);
  SYM(retro_deinit);
  SYM(retro_load_game);
  SYM(retro_unload_game);
  SYM(retro_run);
  SYM(retro_get_system_info);

  p_retro_set_environment(environ_cb);
  p_retro_set_video_refresh(video_cb);
  p_retro_set_audio_sample(audio_sample_cb);
  p_retro_set_audio_sample_batch(audio_batch_cb);
  p_retro_set_input_poll(input_poll_cb);
  p_retro_set_input_state(input_state_cb);
  p_retro_init();

  struct retro_system_info sysinfo;
  memset(&sysinfo, 0, sizeof(sysinfo));
  p_retro_get_system_info(&sysinfo);

  /* Load the ROM into memory; pass data unless the core needs a full path. */
  FILE *f = fopen(rom_path, "rb");
  if (!f) {
    fprintf(stderr, "retrorun: cannot open rom %s\n", rom_path);
    return 1;
  }
  fseek(f, 0, SEEK_END);
  long size = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint8_t *rom = malloc(size);
  if (fread(rom, 1, size, f) != (size_t)size) {
    fprintf(stderr, "retrorun: short read on rom\n");
    return 1;
  }
  fclose(f);

  struct retro_game_info game;
  memset(&game, 0, sizeof(game));
  game.path = rom_path;
  game.data = sysinfo.need_fullpath ? NULL : rom;
  game.size = size;
  if (!p_retro_load_game(&game)) {
    fprintf(stderr, "retrorun: retro_load_game failed\n");
    return 1;
  }

  for (int i = 0; i < frames; i++) p_retro_run();

  if (!g_rgb || g_w == 0 || g_h == 0) {
    fprintf(stderr, "retrorun: no frame captured\n");
    return 1;
  }
  FILE *o = fopen(out_path, "wb");
  fprintf(o, "P6\n%u %u\n255\n", g_w, g_h);
  fwrite(g_rgb, 1, (size_t)g_w * g_h * 3, o);
  fclose(o);

  p_retro_unload_game();
  p_retro_deinit();
  return 0;
}
