/* Place the harness at ROM address 0 so the vector table and header land where
   the Mega Drive expects them; objcopy -O binary then yields the raw cartridge. */
OUTPUT_ARCH(m68k)
ENTRY(_start)
SECTIONS
{
  . = 0;
  .text : { *(.text) *(.data) *(.rodata*) }
}
