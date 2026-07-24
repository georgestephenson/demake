/* demake NDS harness link script — ARM9 (doc 06 §rom). One flat image loaded
   to main RAM at 0x02000000, which is also the entry point recorded in the
   cartridge header. */
ENTRY(_start)
SECTIONS
{
  . = 0x02000000;
  .text : { *(.text) *(.rodata) }
}
