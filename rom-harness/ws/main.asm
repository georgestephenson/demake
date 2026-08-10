; demake WonderSwan (mono) ROM harness (doc 06 §rom, doc 10).
;
; The colour harness's program on the machine Bandai built first. A V30MZ is a
; V30MZ and a screen map is a screen map, so this is `rom-harness/wsc/main.asm`
; with the four differences `codegen/wsc/machine.ts` already writes down for the
; game backend — reached here through NASM rather than through an emitter, but
; the same four:
;
;   - **A quarter of the memory**, and the tile bank is the top half of it. RAM
;     is $0000-$3FFF, tiles are sixteen planar 2bpp bytes at $2000 and the screen
;     map is at $1000 — so every address below moves and there is no port $60 to
;     select a tile format with, because an ASWAN has one.
;   - **A palette is thirty-six ports rather than five hundred and twelve bytes
;     of RAM**: four for the shade pool at $1C-$1F and thirty-two for the sixteen
;     four-entry palettes at $20-$3F. Same bytes in the cartridge, a different
;     destination — so this is a run of `out` rather than a `rep movsb`.
;   - **The backdrop is a pool slot**, not a palette entry. Colour zero is
;     transparent for any cell whose palette has bit 2 set, and what shows
;     through is port $01's three bits straight into the pool. The `ws` codegen
;     family puts the backdrop in entry 0 of every palette, so the low nibble of
;     the palette block's first byte *is* that slot and it is read back out
;     rather than restated — a second copy of it is a picture with the wrong
;     paper wherever the fit reached for a transparent palette.
;   - **The footer's minimum-system byte is 0**, which is what says a mono
;     console may run this cartridge.
;
; This source assembles the cartridge's **last 64 KiB bank**; the CLI prepends
; the rest of a 4 Mbit cartridge and patches the footer checksum. Reset puts
; CS:IP at FFFF:0000 and no bank register has been touched, so the last bank
; answers segment $F — the entry point sits at bank offset $FFF0 and far-jumps
; to the code at the bank's base.
;
; RAM map (segment 0, 16 KiB on a mono WonderSwan):
;   $1000  background screen map, 32x32 entries   (port $07 selects it)
;   $2000  tile bank, 512 tiles x 16 bytes

bits 16
org 0x0000

main:
  cli
  cld
  xor ax, ax
  mov ss, ax
  mov sp, 0x0f00                ; stack below the screen map
  mov es, ax                    ; ES = RAM
  mov ax, 0xf000
  mov ds, ax                    ; DS = this ROM bank

  mov si, tiles_data
  mov di, 0x2000
  mov cx, tiles_len
  rep movsb

  mov si, map_data
  mov di, 0x1000
  mov cx, map_len
  rep movsb

  ; The shade pool and the palettes are ports, so they go out a byte at a time
  ; from $1C upward: four pool bytes and then the thirty-two palette ones, which
  ; is exactly how the two blobs are laid out beside each other.
  mov si, pool_data
  mov dx, 0x001c
  mov cx, pool_len + pal_len
.palette:
  lodsb
  out dx, al
  inc dx
  loop .palette

  ; The backdrop: the pool slot the fit put in entry 0 of every palette, which
  ; is the low nibble of the palette block's first byte.
  mov al, [pal_data]
  and al, 0x07
  out 0x01, al

  xor al, al
  out 0x10, al                  ; background X scroll
  out 0x11, al                  ; background Y scroll
  mov al, 0x02
  out 0x07, al                  ; screen map base = $02 x 2048 = $1000
  mov al, 0x01
  out 0x14, al                  ; LCD on
  mov al, 0x01
  out 0x00, al                  ; display control: background layer only
halt_loop:
  jmp halt_loop

tiles_data:
  incbin "tiles.bin"
tiles_end:
map_data:
  incbin "screen.bin"
map_end:
; The pool and the palettes are adjacent on purpose: ports $1C-$3F are one run.
pool_data:
  incbin "pool.bin"
pool_end:
pal_data:
  incbin "pal.bin"
pal_end:

tiles_len equ tiles_end - tiles_data
map_len   equ map_end - map_data
pool_len  equ pool_end - pool_data
pal_len   equ pal_end - pal_data

; --- reset entry + cartridge footer -----------------------------------------
  times 0xfff0 - ($ - $$) db 0xff
  jmp 0xf000:main               ; $FFF0: where the V30MZ starts fetching
  times 0xfff6 - ($ - $$) db 0xff

  db 0x00                       ; $FFF6 developer id
  db 0x00                       ; $FFF7 minimum system: a mono WonderSwan runs it
  db 0x00                       ; $FFF8 cartridge id
  db 0x00                       ; $FFF9 reserved
  db 0x02                       ; $FFFA ROM size: 4 Mbit
  db 0x00                       ; $FFFB no save memory
  db 0x05                       ; $FFFC landscape orientation
  db 0x00                       ; $FFFD no real-time clock
  dw 0x0000                     ; $FFFE checksum, patched by the CLI
