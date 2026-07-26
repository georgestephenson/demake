; demake WonderSwan Color ROM harness (doc 06 §rom, doc 10).
;
; A minimal NASM (16-bit x86 — the V30MZ is an 8086-compatible core) display
; program: it copies the generated tiles, screen map and palettes from ROM into
; the WonderSwan's RAM, programs the display controller for the colour "packed"
; tile mode, and turns the background layer on. The CLI writes the generated
; data beside this file as tiles.bin / screen.bin (a full 32×32-entry map with
; the image top-left) / pal.bin.
;
; This source assembles the cartridge's **last 64 KiB bank**; the CLI prepends
; the rest of a 4 Mbit cartridge and patches the header checksum. The V30MZ
; resets with CS:IP = FFFF:0000, and with no bank registers touched the last
; bank answers segment $F — so the entry point sits at bank offset $FFF0, five
; bytes ahead of the 10-byte footer header, and far-jumps to the code at the
; bank's base through segment $F000.
;
; RAM map (segment 0, 64 KiB on a Color):
;   $1000  background screen map, 32×32 entries   (port $07 selects it)
;   $4000  tile bank 0, 512 tiles × 32 bytes
;   $FE00  palette RAM, 16 palettes × 16 RGB444 words

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

  ; Video mode $E0: 16 colours per tile, colour palettes, "packed" tile format
  ; (two pixels per byte, left pixel in the high nibble). Selecting the mode
  ; first means the controller decodes the tiles we are about to write with the
  ; layout they were emitted in.
  mov al, 0xe0
  out 0x60, al

  mov si, tiles_data
  mov di, 0x4000
  mov cx, tiles_len
  rep movsb

  mov si, map_data
  mov di, 0x1000
  mov cx, map_len
  rep movsb

  mov si, pal_data
  mov di, 0xfe00
  mov cx, pal_len
  rep movsb

  xor al, al
  out 0x01, al                  ; backdrop = palette 0, colour 0
  out 0x10, al                  ; background X scroll
  out 0x11, al                  ; background Y scroll
  mov al, 0x02
  out 0x07, al                  ; screen map base = $02 × 2048 = $1000
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
pal_data:
  incbin "pal.bin"
pal_end:

tiles_len equ tiles_end - tiles_data
map_len   equ map_end - map_data
pal_len   equ pal_end - pal_data

; --- reset entry + cartridge footer -----------------------------------------
  times 0xfff0 - ($ - $$) db 0xff
  jmp 0xf000:main               ; $FFF0: where the V30MZ starts fetching
  times 0xfff6 - ($ - $$) db 0xff

  db 0x00                       ; $FFF6 developer id
  db 0x01                       ; $FFF7 minimum system: WonderSwan Color
  db 0x00                       ; $FFF8 cartridge id
  db 0x00                       ; $FFF9 reserved
  db 0x02                       ; $FFFA ROM size: 4 Mbit
  db 0x00                       ; $FFFB no save memory
  db 0x05                       ; $FFFC landscape orientation
  db 0x00                       ; $FFFD no real-time clock
  dw 0x0000                     ; $FFFE checksum, patched by the CLI
