/* demake NDS harness link script — ARM7 (doc 06 §rom). Parked in the ARM7's
   main-RAM window at 0x02380000, the address homebrew conventionally uses. */
ENTRY(_start)
SECTIONS
{
  . = 0x02380000;
  .text : { *(.text) *(.rodata) }
}
