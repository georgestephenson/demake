/**
 * What each of the sixteen registers holds, and the calling convention.
 *
 * The 6502 backend has `zp.ts` for the same reason: a machine with a scarce
 * cheap resource needs one file that says who owns what, or two emitters will
 * both decide they own it. On this machine the scarce resource is *not* scarce —
 * there are fourteen general registers — so what this file actually settles is
 * the convention, and the convention is the ARM ABI's own split rather than
 * something invented here:
 *
 *   - **`r0`–`r3` and `r12` are the caller's to lose.** A helper may clobber
 *     them freely, and anything an emitter needs across a call goes higher.
 *   - **`r4`–`r11` survive a call.** A helper that wants one saves it.
 *   - **`r11` is the work-RAM base and is never anything else.** A load reaches
 *     ±4095 from a base register, so holding `$03000000` there makes every access
 *     inside the first four kilobytes of the heap a single instruction. Nothing
 *     may borrow it, not even briefly: a rule body that clobbered it would
 *     produce a game that reads its own state from the wrong place, which is a
 *     wrong number rather than a crash.
 *   - **`r12` is the address scratch.** An address past the base register's reach
 *     is materialised into it immediately before the access that uses it, which
 *     is what lets the whole 28 KiB of internal RAM be addressable without every
 *     emitter carrying a second case.
 *
 * The one thing an emitter here has to remember that no other backend's does:
 * **a routine that calls anything must save `lr`**, because a call is a register
 * write rather than a stack push on this architecture. {@link GbaCtx.routine} is
 * how that is spelled, so it cannot be forgotten in a body that later grows a
 * call.
 */

/** Scratch, and where a helper takes its arguments and leaves its result. */
export const A0 = 0;
/** The second argument, and the value layer's second operand. */
export const A1 = 1;
/** Scratch. */
export const A2 = 2;
/** Scratch. */
export const A3 = 3;

/** Working registers an emitter keeps values in across a call. */
export const V0 = 4;
/** A working register. */
export const V1 = 5;
/** A working register. */
export const V2 = 6;
/** A working register. */
export const V3 = 7;
/** A working register. */
export const V4 = 8;
/** A working register. */
export const V5 = 9;
/** A working register. */
export const V6 = 10;

/**
 * The work-RAM base, held for the whole program.
 *
 * `$03000000`. See the file header: nothing borrows it.
 */
export const RAM = 11;

/** Where an address past the base register's reach is materialised. */
export const ADDR = 12;

/** The stack pointer. */
export const SP = 13;
/** The link register. */
export const LR = 14;
/** The program counter. */
export const PC = 15;

/** First byte of internal work RAM, which is what {@link RAM} holds. */
export const RAM_BASE = 0x03000000;

/**
 * How far a word load or store reaches from a base register.
 *
 * The reason the memory plan's heap starts exactly at {@link RAM_BASE}: the hot
 * state lands inside this window and costs one instruction, and anything beyond
 * it costs two rather than being unreachable.
 */
export const RAM_WINDOW = 0x1000;
