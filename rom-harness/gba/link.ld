/* demake GBA harness link script (doc 06 §rom): one flat image at the
   cartridge base, 0x08000000, so `objcopy -O binary` yields the ROM. */
ENTRY(_start)
SECTIONS
{
  . = 0x08000000;
  .text : { *(.text) *(.rodata) }
}
