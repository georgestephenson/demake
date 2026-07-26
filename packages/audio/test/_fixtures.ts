/**
 * Purpose-made MIDI fixtures.
 *
 * Generated from a script rather than checked in as files, on doc 10's reasoning
 * for `hd-many-colors.png`: no licensing question, perfectly stable, and each one
 * exists to stress something specific rather than to be a nice tune.
 */

const PPQ = 480;

interface Event {
  tick: number;
  bytes: number[];
}

/** A note-on/note-off pair. */
export function note(
  channel: number,
  pitch: number,
  tick: number,
  duration: number,
  velocity = 100,
): Event[] {
  return [
    { tick, bytes: [0x90 | channel, pitch, velocity] },
    { tick: tick + duration, bytes: [0x80 | channel, pitch, 0] },
  ];
}

/** Build a one-track Standard MIDI File from events plus a tempo. */
export function midiFile(events: Event[], bpm = 120): Uint8Array {
  const usPerQuarter = Math.round(60000000 / bpm);
  const meta: Event[] = [
    {
      tick: 0,
      bytes: [
        0xff,
        0x51,
        0x03,
        (usPerQuarter >> 16) & 0xff,
        (usPerQuarter >> 8) & 0xff,
        usPerQuarter & 0xff,
      ],
    },
  ];
  const all = [...meta, ...events].sort((a, b) => a.tick - b.tick);

  const track: number[] = [];
  let previous = 0;
  for (const event of all) {
    track.push(...varint(event.tick - previous));
    track.push(...event.bytes);
    previous = event.tick;
  }
  track.push(...varint(0), 0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff];
  const trackHeader = [
    0x4d,
    0x54,
    0x72,
    0x6b,
    (track.length >> 24) & 0xff,
    (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff,
    track.length & 0xff,
  ];
  return Uint8Array.from([...header, ...trackHeader, ...track]);
}

function varint(value: number): number[] {
  if (value === 0) return [0];
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0x7f);
    remaining >>= 7;
  }
  for (let i = 0; i < bytes.length - 1; i += 1) bytes[i]! |= 0x80;
  return bytes;
}

/** A scale on one channel: monophonic, obvious contour, easy to reason about. */
export function scaleFixture(bpm = 120): Uint8Array {
  const events: Event[] = [];
  const degrees = [0, 2, 4, 5, 7, 9, 11, 12];
  for (let i = 0; i < degrees.length; i += 1) {
    events.push(...note(0, 60 + degrees[i]!, i * PPQ, PPQ - 10));
  }
  return midiFile(events, bpm);
}

/**
 * A band: bass, chords, melody and drums — four parts for four channels, and
 * the one fixture where the arranger's assignment actually has to be right.
 */
export function bandFixture(bpm = 140, bars = 4): Uint8Array {
  const events: Event[] = [];
  for (let bar = 0; bar < bars; bar += 1) {
    const base = bar * PPQ * 4;
    // Bass: roots, low, on the beat.
    for (let beat = 0; beat < 4; beat += 1) {
      events.push(...note(1, 36 + (bar % 2) * 5, base + beat * PPQ, PPQ - 20, 110));
    }
    // Chords: three notes at once, held.
    for (const pitch of [60, 64, 67]) {
      events.push(...note(2, pitch + (bar % 2) * 5, base, PPQ * 4 - 20, 70));
    }
    // Melody: eighth notes, high, moving.
    const line = [72, 74, 76, 74, 77, 76, 74, 72];
    for (let i = 0; i < line.length; i += 1) {
      events.push(...note(3, line[i]!, base + (i * PPQ) / 2, PPQ / 2 - 10, 100));
    }
    // Drums on channel 10: kick, snare, hats.
    for (let eighth = 0; eighth < 8; eighth += 1) {
      events.push(...note(9, 42, base + (eighth * PPQ) / 2, 10, 70));
      if (eighth % 4 === 0) events.push(...note(9, 36, base + (eighth * PPQ) / 2, 10, 120));
      if (eighth % 4 === 2) events.push(...note(9, 38, base + (eighth * PPQ) / 2, 10, 110));
    }
  }
  return midiFile(events, bpm);
}

/** The same band, sixteen bars long — for showing that error does not grow. */
export function longBandFixture(bpm = 140): Uint8Array {
  return bandFixture(bpm, 16);
}

/** A bassline that lives below the SN76489's ~109 Hz floor. */
export function deepBassFixture(): Uint8Array {
  const events: Event[] = [];
  for (let i = 0; i < 8; i += 1) {
    // E1 is 41 Hz: far below what a PSG tone channel can produce.
    events.push(...note(0, 28, i * PPQ, PPQ - 10, 110));
  }
  return midiFile(events, 120);
}

export { PPQ as FIXTURE_PPQ };
