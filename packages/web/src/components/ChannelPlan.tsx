/**
 * The channel plan as a piano roll (doc 07 §The audio sections).
 *
 * One lane per *hardware* channel — not per source part — because the thing
 * worth seeing is what the console had to do with the music: which part won
 * which voice, where a channel was time-shared, what was arpeggiated or folded,
 * and which voices sat silent. A lane with nothing in it is information, so an
 * unused channel keeps its row.
 *
 * The grid behind the spans is bar lines, drawn from the *achieved* tempo rather
 * than the requested one, so a span that drifts against the bars is showing a
 * real timing error rather than a rounding artefact in this file.
 */

import type { ChannelSpan } from "@demake/audio";

import type { ChannelInfo } from "../worker/audio-protocol.js";

interface Props {
  channels: readonly ChannelInfo[];
  spans: readonly ChannelSpan[];
  /** Driver ticks in the schedule — the roll's full width. */
  ticks: number;
  /** Tick playback returns to; `-1` for a one-shot. */
  loopTick: number;
  /** Bars across the whole roll, for the grid; `0` draws no grid. */
  bars: number;
  /** Part id → the name the source gave it. */
  partNames: Readonly<Record<string, string>>;
}

/** How a part reached its channel, spelled out for the span's tooltip. */
const TREATMENT: Readonly<Record<string, string>> = {
  direct: "carried as written",
  arpeggiated: "chord spelled out in time",
  folded: "folded into the channel's range",
  merged: "merged with another part",
};

/**
 * Where the arranger placed this channel, for the span's tooltip.
 *
 * In words rather than as the number, because the number is a position on a
 * scale nobody outside the engine has seen — and empty at centre, since "no
 * placement" is what most channels correctly have and a tooltip that said
 * "centred" on every span of a mono console would be noise.
 */
function placement(pan: number): string {
  if (pan === 0) return "";
  const side = pan < 0 ? "left" : "right";
  const distance = Math.abs(pan) >= 0.75 ? "hard" : Math.abs(pan) >= 0.4 ? "" : "slightly ";
  return `, placed ${distance}${distance === "hard" ? " " : ""}${side}`;
}

export function ChannelPlan({ channels, spans, ticks, loopTick, bars, partNames }: Props) {
  const span = Math.max(ticks, 1);
  const grid =
    bars > 1 && bars < 200
      ? {
          backgroundImage:
            "repeating-linear-gradient(to right, var(--panel) 0 1px, transparent 1px 100%)",
          backgroundSize: `${100 / bars}% 100%`,
        }
      : undefined;

  return (
    <div class="roll" data-testid="channel-plan">
      {channels.map((channel) => {
        const mine = spans.filter((entry) => entry.channelId === channel.id);
        return (
          <div class="roll-lane" key={channel.id}>
            <span class="roll-label" title={channel.summary}>
              {channel.id}
            </span>
            <div class="roll-track">
              {mine.length === 0 ? <span class="roll-silent">silent</span> : null}
              {mine.map((entry, index) => (
                <span
                  key={`${entry.partId}-${index}`}
                  class="roll-span"
                  data-treatment={entry.treatment}
                  title={`${partNames[entry.partId] ?? entry.partId} — ${
                    TREATMENT[entry.treatment] ?? entry.treatment
                  }${placement(entry.pan)}`}
                  style={{
                    left: `${(entry.startTick / span) * 100}%`,
                    width: `${(Math.max(entry.endTick - entry.startTick, 1) / span) * 100}%`,
                  }}
                >
                  {partNames[entry.partId] ?? entry.partId}
                </span>
              ))}
              {loopTick > 0 ? (
                <span
                  class="roll-loop"
                  title={`loops from tick ${loopTick}`}
                  style={{ left: `${(loopTick / span) * 100}%` }}
                />
              ) : null}
              {/*
               * The bar grid sits *over* the spans rather than behind them. A
               * part that plays throughout covers its whole lane, and a grid
               * underneath one of those is a grid nobody can see — which loses
               * the only thing that makes this a roll rather than four bars.
               */}
              {grid ? <span class="roll-grid" style={grid} /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
