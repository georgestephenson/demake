/* Place the display program at $200, which is where a Neo Geo cartridge's code
   starts: the 68000's vectors and the console's own header occupy everything
   below it, and `packNeoHeader` writes those bytes rather than this source.
   objcopy -O binary then yields the P region's body, which the builder puts
   behind that header. */
OUTPUT_ARCH(m68k)
ENTRY(_start)
SECTIONS
{
  . = 0x200;
  .text : { *(.text) *(.data) *(.rodata*) }
}
