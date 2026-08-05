---
"@demake/core": minor
---

Add a V30MZ assembler and the WonderSwan cartridge wrapper — the spine the
WonderSwan Color's Demotic backend stands on.

`Asm30` is 16-bit x86: the WonderSwan's processor is an 8086 core with the
80186's additions, so the instruction set here is the one a stock `nasm -f bin`
assembles for `bits 16`. It is the first encoder here whose _operand_ is a value
the caller builds rather than a spelling of a method name — this architecture
spends a mod/reg/rm byte where every 8-bit CPU in this project spends an opcode
per addressing form, so one method covers "register", "[address]" and
"[base+displacement]" and the operand decides. A memory operand also carries a
segment, because a table in cartridge ROM and a variable in RAM are two segments
rather than two addresses.

It has two oracles, on the ARM encoder's precedent: hand-read encodings, as every
encoder here gets, and a differential battery against NASM — which the display-ROM
harness already provisions, so it costs a bare machine nothing and self-skips
without it. That second oracle earns its place for the inverse of the ARM
encoder's reason: three fields packed into eight bits and a displacement whose
length depends on its value mean a register written into the wrong field still
decodes as _an_ instruction.

`packWsRom` is the other half. The program goes in the cartridge's last 64 KiB
bank because that is what the processor answers segment `$F000` with from reset;
the entry point is a far jump at that bank's `$FFF0` because that is physically
where reset starts fetching; and the checksum covers every byte of the finished
image but its own two. There is one board — the header's size byte has no value
below 4 Mbit to say — so unlike the NES's or the Mega Drive's this cartridge
cannot move in either direction.

No output bytes change: nothing yet builds through either path.
