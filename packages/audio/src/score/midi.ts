/**
 * Standard MIDI File ingest (doc 17 §Stage 0).
 *
 * Ours, for the reason every codec in this repository is ours: the parse has to
 * be identical everywhere, and the messy parts need deciding rather than
 * inheriting. Running status, note-on with velocity 0 meaning note-off,
 * overlapping notes on one channel, tempo and time-signature meta events, and
 * channel 10 as percussion under the General MIDI drum map are all handled here
 * and nowhere else.
 *
 * MIDI is the richest input the pipeline has, because the things audio input
 * has to *infer* — the tempo map, the note grid, the separation into parts — are
 * simply stated.
 */

import { PPQ, type DrumClass, type MeterPoint, type Note, type Part, type Score } from "./types.js";

/** Thrown when a file is not a MIDI file, or is one we cannot read. */
export class MidiParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MidiParseError";
  }
}

interface RawEvent {
  tick: number;
  /** Ordering index within a tick, so simultaneous events stay stable. */
  order: number;
  status: number;
  data1: number;
  data2: number;
  meta?: { type: number; bytes: Uint8Array };
}

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  u8(): number {
    if (this.offset >= this.bytes.length) throw new MidiParseError("unexpected end of file");
    return this.bytes[this.offset++]!;
  }

  u16(): number {
    return (this.u8() << 8) | this.u8();
  }

  u32(): number {
    return ((this.u8() << 24) | (this.u16() << 8) | this.u8()) >>> 0;
  }

  /** MIDI's 7-bits-per-byte variable-length quantity. */
  varint(): number {
    let value = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = this.u8();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new MidiParseError("variable-length quantity longer than four bytes");
  }

  slice(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.bytes.length) throw new MidiParseError("chunk runs past the end of the file");
    const out = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return out;
  }
}

/** True when the bytes begin with an `MThd` chunk. */
export function isMidi(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x4d &&
    bytes[1] === 0x54 &&
    bytes[2] === 0x68 &&
    bytes[3] === 0x64
  );
}

/**
 * The General MIDI drum map, reduced to the classes a chip can actually play.
 *
 * The reduction is the point: a console has one noise channel, so 47 percussion
 * sounds have to become a handful of gestures, and deciding which is a musical
 * choice rather than a lookup. Anything unmapped becomes `perc`, the first thing
 * the arranger drops.
 */
function drumClassOf(noteNumber: number): DrumClass {
  if (noteNumber === 35 || noteNumber === 36) return "kick";
  if (noteNumber === 38 || noteNumber === 40 || noteNumber === 37 || noteNumber === 39) {
    return "snare";
  }
  if (noteNumber === 42 || noteNumber === 44) return "hat-closed";
  if (noteNumber === 46) return "hat-open";
  if (noteNumber >= 41 && noteNumber <= 50) return "tom";
  if (noteNumber === 49 || noteNumber === 51 || noteNumber === 52 || noteNumber === 57) {
    return "cymbal";
  }
  return "perc";
}

/** Parse a Standard MIDI File (format 0 or 1) into a {@link Score}. */
export function parseMidi(bytes: Uint8Array): Score {
  if (!isMidi(bytes)) throw new MidiParseError("not a Standard MIDI File (no MThd header)");
  const reader = new Reader(bytes);
  reader.slice(4);
  const headerLength = reader.u32();
  const format = reader.u16();
  const trackCount = reader.u16();
  const division = reader.u16();
  reader.slice(Math.max(headerLength - 6, 0));

  if (format === 2) {
    throw new MidiParseError("format 2 files hold independent sequences, not one piece");
  }
  if ((division & 0x8000) !== 0) {
    throw new MidiParseError("SMPTE time division is not supported; use metrical (PPQ) timing");
  }
  if (division === 0) throw new MidiParseError("time division of zero");

  const tracks: RawEvent[][] = [];
  for (let i = 0; i < trackCount; i += 1) {
    if (reader.offset >= bytes.length) break;
    const tag = reader.slice(4);
    const length = reader.u32();
    const body = reader.slice(length);
    if (tag[0] !== 0x4d || tag[1] !== 0x54 || tag[2] !== 0x72 || tag[3] !== 0x6b) continue;
    tracks.push(readTrack(body));
  }

  return buildScore(tracks, division);
}

function readTrack(body: Uint8Array): RawEvent[] {
  const reader = new Reader(body);
  const events: RawEvent[] = [];
  let tick = 0;
  let runningStatus = 0;
  let order = 0;

  while (reader.offset < body.length) {
    tick += reader.varint();
    let status = reader.u8();
    if ((status & 0x80) === 0) {
      // Running status: the byte we just read is the first data byte.
      reader.offset -= 1;
      status = runningStatus;
      if (status === 0) throw new MidiParseError("data byte before any status byte");
    } else if (status < 0xf0) {
      runningStatus = status;
    }

    if (status === 0xff) {
      const type = reader.u8();
      const length = reader.varint();
      const data = reader.slice(length);
      events.push({
        tick,
        order: order++,
        status,
        data1: type,
        data2: 0,
        meta: { type, bytes: data },
      });
      if (type === 0x2f) break;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      reader.slice(reader.varint());
      continue;
    }

    const high = status & 0xf0;
    const data1 = reader.u8();
    const data2 = high === 0xc0 || high === 0xd0 ? 0 : reader.u8();
    events.push({ tick, order: order++, status, data1, data2 });
  }
  return events;
}

interface PendingNote {
  tick: number;
  velocity: number;
}

function buildScore(tracks: RawEvent[][], division: number): Score {
  const scale = PPQ / division;
  const tempo: { tick: number; microsecondsPerQuarter: number }[] = [];
  const meter: MeterPoint[] = [];
  const trackNames = new Map<number, string>();
  const programs = new Map<string, number>();
  const noteLists = new Map<string, Note[]>();
  const pending = new Map<string, Map<number, PendingNote>>();
  let durationTicks = 0;

  const keyOf = (track: number, channel: number): string => `t${track}c${channel}`;

  for (let t = 0; t < tracks.length; t += 1) {
    for (const event of tracks[t]!) {
      const tick = Math.round(event.tick * scale);
      durationTicks = Math.max(durationTicks, tick);

      if (event.meta) {
        if (event.meta.type === 0x51 && event.meta.bytes.length === 3) {
          const [a, b, c] = [event.meta.bytes[0]!, event.meta.bytes[1]!, event.meta.bytes[2]!];
          tempo.push({ tick, microsecondsPerQuarter: (a << 16) | (b << 8) | c });
        } else if (event.meta.type === 0x58 && event.meta.bytes.length >= 2) {
          meter.push({
            tick,
            numerator: event.meta.bytes[0]!,
            denominator: 1 << event.meta.bytes[1]!,
          });
        } else if (event.meta.type === 0x03) {
          trackNames.set(t, decodeAscii(event.meta.bytes));
        }
        continue;
      }

      const channel = event.status & 0x0f;
      const kind = event.status & 0xf0;
      const key = keyOf(t, channel);

      if (kind === 0xc0) {
        programs.set(key, event.data1);
        continue;
      }
      if (kind !== 0x80 && kind !== 0x90) continue;

      const noteNumber = event.data1;
      const velocity = event.data2;
      const isOn = kind === 0x90 && velocity > 0;
      let open = pending.get(key);
      if (!open) {
        open = new Map();
        pending.set(key, open);
      }

      if (isOn) {
        // A second note-on for a sounding pitch ends the first, which is what
        // sequencers mean by it and what a naive parser turns into a stuck note.
        const existing = open.get(noteNumber);
        if (existing) closeNote(noteLists, key, noteNumber, existing, tick, channel);
        open.set(noteNumber, { tick, velocity });
        continue;
      }
      const start = open.get(noteNumber);
      if (start) {
        open.delete(noteNumber);
        closeNote(noteLists, key, noteNumber, start, tick, channel);
      }
    }
  }

  // Anything still sounding at the end gets a nominal quarter note; a truncated
  // file should not silently lose its last chord.
  for (const [key, open] of pending) {
    const channel = Number(key.slice(key.indexOf("c") + 1));
    for (const [noteNumber, start] of open) {
      closeNote(noteLists, key, noteNumber, start, start.tick + PPQ, channel);
      durationTicks = Math.max(durationTicks, start.tick + PPQ);
    }
  }

  const parts: Part[] = [];
  const keys = [...noteLists.keys()].sort();
  for (const key of keys) {
    const notes = noteLists.get(key)!;
    if (notes.length === 0) continue;
    notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
    const track = Number(key.slice(1, key.indexOf("c")));
    const channel = Number(key.slice(key.indexOf("c") + 1));
    parts.push({
      id: key,
      name: trackNames.get(track) ?? `channel ${channel + 1}`,
      // Roles are assigned by analysis; ingest only marks what MIDI states
      // outright, which is that channel 10 is percussion.
      role: channel === 9 ? "percussion" : "harmony",
      roleConfidence: channel === 9 ? 1 : 0,
      notes,
      polyphony: meanPolyphony(notes),
      ...(programs.has(key) ? { program: programs.get(key)! } : {}),
    });
  }

  if (tempo.length === 0) tempo.push({ tick: 0, microsecondsPerQuarter: 500000 });
  tempo.sort((a, b) => a.tick - b.tick);
  meter.sort((a, b) => a.tick - b.tick);
  if (meter.length === 0) meter.push({ tick: 0, numerator: 4, denominator: 4 });

  return {
    ppq: PPQ,
    tempo,
    meter,
    parts,
    sections: [],
    durationTicks,
    provenance: { format: "midi" },
  };
}

function closeNote(
  lists: Map<string, Note[]>,
  key: string,
  noteNumber: number,
  start: PendingNote,
  endTick: number,
  channel: number,
): void {
  let list = lists.get(key);
  if (!list) {
    list = [];
    lists.set(key, list);
  }
  list.push({
    tick: start.tick,
    durationTicks: Math.max(endTick - start.tick, 1),
    pitch: noteNumber * 100,
    velocity: start.velocity,
    ...(channel === 9 ? { drum: drumClassOf(noteNumber) } : {}),
    salience: 0,
  });
}

function meanPolyphony(notes: readonly Note[]): number {
  if (notes.length === 0) return 0;
  // Sounding-time-weighted: a part that holds three-note chords for half its
  // length and single notes for the other half is not "two voices".
  let sounding = 0;
  let overlap = 0;
  for (let i = 0; i < notes.length; i += 1) {
    const note = notes[i]!;
    sounding += note.durationTicks;
    for (let j = i + 1; j < notes.length; j += 1) {
      const other = notes[j]!;
      if (other.tick >= note.tick + note.durationTicks) break;
      overlap +=
        Math.min(note.tick + note.durationTicks, other.tick + other.durationTicks) - other.tick;
    }
  }
  if (sounding === 0) return 0;
  return 1 + overlap / sounding;
}

function decodeAscii(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out.trim();
}
