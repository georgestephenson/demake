/**
 * The sound side, held to the four things a demade cartridge depends on.
 *
 * This is a whole second computer with its own ROM on its own bus, so nothing
 * about it is reachable from the 68000 tests — and every case below is a way a
 * cartridge can be perfect and silent.
 *
 *   - **A request is an NMI**, and it is refused until the driver asks for it.
 *     A driver that never read port `$08` would ignore every track the game asked
 *     for while its own boot and its own timer worked perfectly.
 *   - **Reading the command acknowledges it.** There is no separate clear, so a
 *     model that needed one would re-enter the handler for ever.
 *   - **The chip's timer interrupts *this* processor.** That is the whole reason
 *     this console's driver keeps exact tempo where a Mega Drive's game cannot,
 *     and it is the opposite end of the same wire.
 *   - **The interrupt is level triggered.** The chip holds its overflow flag
 *     until the driver clears it, so a handler that forgot would spin. Modelling
 *     it as an edge would hide exactly that bug.
 *
 * The programs are assembled with `core`'s own Z80 assembler, so an encoder and a
 * decoder that agreed with each other and not with the hardware would still fail
 * against the opcode bytes `packages/core/test/z80.test.ts` pins.
 */

import { AsmZ80 } from "@demake/core";
import { Sound, SOUND_PORT, SOUND_RAM_BASE, SOUND_RAM_SIZE } from "@demake/neogeo";
import { describe, expect, it } from "vitest";

/** Where the test programs leave whatever they want looked at. */
const MARK = SOUND_RAM_BASE;
const COUNT = SOUND_RAM_BASE + 1;

/**
 * Assemble a program into a 32 KiB M ROM image, with a stack under it.
 *
 * The stack is not ceremony. This processor comes up with no usable one — the
 * only RAM it has is the two kilobytes at `$F800`, and everything below that is
 * ROM — so a program that takes an interrupt without setting `sp` pushes its
 * return address into a ROM that drops it and returns to whatever the ROM
 * happens to hold. The symptom is a driver that appears to *restart*, because
 * the address it comes back to is usually zero.
 */
function build(program: (asm: AsmZ80) => void): Uint8Array {
  const asm = new AsmZ80(0);
  asm.ld16("sp", SOUND_RAM_BASE + SOUND_RAM_SIZE - 2);
  program(asm);
  const out = new Uint8Array(0x8000);
  out.set(asm.assemble().subarray(0, out.length));
  return out;
}

/**
 * Add one to a byte, stopping at 255.
 *
 * Saturating rather than wrapping so a count is readable: these programs run for
 * hundreds of iterations and a plain `inc` would report whatever the total
 * happens to be modulo 256, which says nothing about which of two runs did more.
 */
function bump(asm: AsmZ80, address: number, tag: string): void {
  asm.lda(address);
  asm.inc("a");
  asm.jr(`${tag}Full`, "z");
  asm.sta(address);
  asm.label(`${tag}Full`);
}

/** A machine with no samples, which is every case here. */
function machine(rom: Uint8Array): Sound {
  return new Sound(rom, new Uint8Array(0), new Uint8Array(0));
}

describe("the letterbox from the 68000", () => {
  it("raises no interrupt until the driver has asked for one", () => {
    // Reset lands at `$0000`, the maskable vector is `$0038` and the
    // non-maskable one `$0066`, so the three are laid out around each other.
    const rom = build((asm) => {
      asm.ldn("a", 0x00);
      asm.sta(MARK);
      asm.label("Spin");
      asm.jp("Spin");
      asm.padTo(0x0066);
      asm.inN(SOUND_PORT.command);
      asm.sta(MARK);
      asm.retn();
    });

    const refused = machine(rom);
    refused.run(3000);
    refused.send(0x5a);
    refused.run(3000);
    expect(refused.ram[0]).toBe(0);

    const allowed = machine(rom);
    allowed.run(3000);
    allowed.in(SOUND_PORT.enableNmi);
    allowed.send(0x5a);
    allowed.run(3000);
    expect(allowed.ram[0]).toBe(0x5a);
  });

  it("acknowledges the command by reading it, with nothing else to clear", () => {
    const rom = build((asm) => {
      asm.ldn("a", 0);
      asm.sta(COUNT);
      asm.label("Spin");
      asm.jp("Spin");
      asm.padTo(0x0066);
      asm.inN(SOUND_PORT.command);
      asm.lda(COUNT);
      asm.inc("a");
      asm.sta(COUNT);
      asm.retn();
    });
    const sound = machine(rom);
    sound.run(3000);
    sound.in(SOUND_PORT.enableNmi);
    sound.send(0x11);
    sound.run(30_000);
    // One byte sent is one handler entry, however long the machine runs after it.
    expect(sound.ram[1]).toBe(1);
  });

  it("replies through a port the 68000 can read", () => {
    const rom = build((asm) => {
      asm.ldn("a", 0x77);
      asm.outN(SOUND_PORT.reply);
      asm.label("Spin");
      asm.jp("Spin");
    });
    const sound = machine(rom);
    sound.run(3000);
    expect(sound.reply).toBe(0x77);
  });
});

describe("the chip's timer, which is this processor's clock", () => {
  /**
   * Programme timer A and count its interrupts.
   *
   * `$27` bit 0 starts it, bit 2 lets it raise the line, and bit 4 clears the
   * overflow flag — which is the write the handler has to make. Both halves are
   * here because leaving either out is a driver that plays at the wrong speed or
   * not at all.
   */
  function timerRom(clearFlag: boolean): Uint8Array {
    return build((asm) => {
      asm.ldn("a", 0);
      asm.sta(COUNT);
      // Timer A's ten bits: the top eight at `$24`, the low two at `$25`. A
      // reload of 1000 is a count of 24, which is a few thousand chip cycles.
      const chip = (register: number, value: number): void => {
        asm.ldn("a", register);
        asm.outN(SOUND_PORT.addressA);
        asm.ldn("a", value);
        asm.outN(SOUND_PORT.dataA);
      };
      chip(0x24, 1000 >> 2);
      chip(0x25, 1000 & 3);
      chip(0x27, 0x05); // load and enable timer A
      asm.im(1);
      asm.ei();
      // The main loop counts too, so the case below can ask whether it ever gets
      // to run rather than comparing two handler rates.
      asm.label("Spin");
      bump(asm, MARK, "Loop");
      asm.jp("Spin");
      asm.padTo(0x0038);
      // `af` is saved because an interrupt lands *between* two instructions of
      // whatever it interrupted, and the main loop below is holding a value in
      // `a` across a load and a store. A handler that does not save it corrupts
      // the interrupted code rather than merely being slow, which is a Z80 rule a
      // generated driver has to keep as much as a hand-written one.
      asm.push("af");
      bump(asm, COUNT, "Handler");
      if (clearFlag) {
        // `$27` again: bit 4 resets the overflow flag while bits 0 and 2 keep the
        // timer running and enabled. Leaving this out is the case below.
        chip(0x27, 0x15);
      }
      asm.pop("af");
      asm.ei();
      asm.reti();
    });
  }

  it("interrupts this processor rather than the 68000", () => {
    const sound = machine(timerRom(true));
    sound.run(3_000_000);
    // A count of 24 at the chip's sample rate is about 1500 Hz; a second of the
    // 68000's clock is a quarter of a second here, so the handler runs hundreds
    // of times. What matters is that it runs at all.
    expect(sound.ram[1]).toBeGreaterThan(10);
    expect(sound.chip.timersRunning).toBe(true);
  });

  it("holds the line until the flag is cleared, which is what the hardware does", () => {
    // The same program with the acknowledge left out. The flag stays set, so the
    // moment `ei` runs the handler is entered again and the main loop never gets
    // another instruction — which on a real driver is a schedule performed as
    // fast as the handler can be re-entered, and sounds like a fault rather than
    // like a wrong tempo.
    const stuck = machine(timerRom(false));
    stuck.run(300_000);
    expect(stuck.ram[1]).toBe(255); // the handler, entered as fast as it returns
    expect(stuck.ram[0]).toBeLessThan(100); // the main loop, barely reached

    // With the acknowledge, the two swap over: the handler runs once per overflow
    // — about 58 of them in this window — and the loop has the rest of the time.
    const acked = machine(timerRom(true));
    acked.run(300_000);
    expect(acked.ram[1]).toBeLessThan(100);
    expect(acked.ram[0]).toBe(255);
  });
});

describe("the chip behind the four ports", () => {
  it("keeps the two pairs apart, which is what the register map depends on", () => {
    // `$27` is the timer control and lives on the *first* pair only; the second
    // pair's `$27` is an ADPCM-A register that does not exist. A model that
    // routed both to the same place would run a timer a driver never started,
    // and every schedule after it would play at a rate nobody chose.
    const first = machine(
      build((asm) => {
        asm.ldn("a", 0x27);
        asm.outN(SOUND_PORT.addressA);
        asm.ldn("a", 0x01);
        asm.outN(SOUND_PORT.dataA);
        asm.label("Spin");
        asm.jp("Spin");
      }),
    );
    first.run(3000);
    expect(first.chip.timersRunning).toBe(true);

    const second = machine(
      build((asm) => {
        asm.ldn("a", 0x27);
        asm.outN(SOUND_PORT.addressB);
        asm.ldn("a", 0x01);
        asm.outN(SOUND_PORT.dataB);
        asm.label("Spin");
        asm.jp("Spin");
      }),
    );
    second.run(3000);
    expect(second.chip.timersRunning).toBe(false);
  });
});
