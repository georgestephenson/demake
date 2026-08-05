/**
 * Controls pane (doc 07 §UX 2): the console picker grouped by tier, then the
 * doc-05 options in the order `demake prep --help` lists them, with the advanced
 * ones collapsed. Underneath sits the live equivalent-command line — the feature
 * that lets someone graduate from the page to the CLI without translating
 * anything by hand.
 */

import { useState } from "preact/hooks";

import { CommandLine } from "./CommandLine.js";
import { equivalentCommand } from "../lib/options.js";
import type { ConsoleInfo, PrepOptionsUi, SourceInfo } from "../worker/protocol.js";
import type { StrategyInfo } from "@demake/core";

interface Props {
  options: PrepOptionsUi;
  consoles: ConsoleInfo[];
  strategies: StrategyInfo[];
  onChange: (options: PrepOptionsUi) => void;
  onReset: () => void;
  sourceName: string;
  /** What the engine decoded the source as, once a conversion has run. */
  decoded: SourceInfo | null;
  /** The size the last conversion actually produced — what `auto` resolved to. */
  outputSize: { w: number; h: number } | null;
  /**
   * Where a changed option is going, when it is going anywhere.
   *
   * With a project art file open these controls are a view of the Demakefile
   * (doc 19 §Options edit the Demakefile), and the pane says so — a control that
   * silently edited a file would be worse than one that silently did not.
   */
  writing?: { file: string; asset: string; inherited: readonly string[] };
}

const TIER_LABEL: Record<number, string> = {
  1: "Tier 1 — launch set",
  2: "Tier 2",
  3: "Tier 3 — long tail",
};

const DITHERS = [
  ["", "auto (strategy decides)"],
  ["none", "none"],
  ["bayer2", "bayer2"],
  ["bayer4", "bayer4"],
  ["bayer8", "bayer8"],
  ["floyd-steinberg", "floyd-steinberg"],
  ["atkinson", "atkinson"],
  ["riemersma", "riemersma"],
  ["ramp", "ramp"],
] as const;

export function ControlsPane({
  options,
  consoles,
  strategies,
  onChange,
  onReset,
  sourceName,
  decoded,
  outputSize,
  writing,
}: Props) {
  const [advanced, setAdvanced] = useState(false);
  const set = <K extends keyof PrepOptionsUi>(key: K, value: PrepOptionsUi[K]): void =>
    onChange({ ...options, [key]: value });

  const tiers = [1, 2, 3].filter((t) => consoles.some((c) => c.tier === t));
  const cascade =
    writing === undefined ? null : (
      <p class="hint demakefile-note" data-testid="writing-note">
        These settings are <code>{writing.file}</code>&rsquo;s <code>art {writing.asset}</code>{" "}
        block. Changing one writes it; setting one back to what it inherits removes the line again.
        {writing.inherited.length > 0 ? (
          <> Inherited right now: {writing.inherited.join(", ")}.</>
        ) : null}
      </p>
    );
  const active = consoles.find((c) => c.id === options.console);
  const command = equivalentCommand(options, sourceName);
  const autoPlaceholder = outputSize === null ? "auto" : `auto — ${outputSize.w}×${outputSize.h}`;

  return (
    <section class="pane controls-pane" aria-labelledby="controls-heading">
      <h2 id="controls-heading">Console &amp; options</h2>
      {cascade}

      <label class="field">
        <span>Console</span>
        <select
          value={options.console}
          data-testid="console-select"
          onChange={(e) => set("console", (e.currentTarget as HTMLSelectElement).value)}
        >
          {tiers.map((tier) => (
            <optgroup key={tier} label={TIER_LABEL[tier]}>
              {consoles
                .filter((c) => c.tier === tier)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>
      {active && (
        <p class="console-summary" data-testid="console-summary">
          {active.summary}
        </p>
      )}

      <label class="field">
        <span>Strategy</span>
        <select
          value={options.strategy}
          data-testid="strategy-select"
          onChange={(e) => set("strategy", (e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="auto">auto — run the tournament</option>
          {strategies.map((s) => (
            <option key={s.id} value={s.id} title={s.description}>
              {s.id} ({s.scale}/{s.dither})
            </option>
          ))}
        </select>
      </label>

      <div class="field-row">
        <label class="field">
          <span>Output size</span>
          <input
            type="text"
            // The placeholder carries the size auto *resolved to*, because "auto"
            // alone reads as a setting with no value rather than as a number
            // somebody may want to change. A source smaller than the screen is
            // kept at its own size, so a 64×64 drawing demakes to a 64×64 corner
            // of a Game Boy — correct, surprising, and invisible while the only
            // thing this box said was "auto".
            placeholder={autoPlaceholder}
            value={options.size}
            pattern="\d+x\d+"
            data-testid="size-input"
            onInput={(e) => set("size", (e.currentTarget as HTMLInputElement).value)}
          />
        </label>
        <label class="field">
          <span>Fit</span>
          <select
            value={options.fit}
            disabled={options.size === ""}
            onChange={(e) =>
              set("fit", (e.currentTarget as HTMLSelectElement).value as PrepOptionsUi["fit"])
            }
          >
            {["contain", "cover", "stretch", "pad"].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p class="hint size-presets" data-testid="size-presets">
        {active ? (
          <button
            type="button"
            class="link"
            data-testid="size-screen"
            onClick={() => set("size", `${active.width}x${active.height}`)}
          >
            fill the screen ({active.width}×{active.height})
          </button>
        ) : null}
        {/*
          Offered for a raster source and not for a drawing, because for a
          drawing there is no such size to go back to: what the engine reports is
          the raster it was *asked* for, so a "source" button here would move
          every time the box above it did.
        */}
        {decoded && !decoded.vector ? (
          <>
            {" · "}
            <button
              type="button"
              class="link"
              data-testid="size-source"
              onClick={() => set("size", `${decoded.width}x${decoded.height}`)}
            >
              source ({decoded.width}×{decoded.height})
            </button>
          </>
        ) : null}
        {options.size !== "" ? (
          <>
            {" · "}
            <button
              type="button"
              class="link"
              data-testid="size-auto"
              onClick={() => set("size", "")}
            >
              back to auto
            </button>
          </>
        ) : null}
        {/*
          An SVG is the case this row exists for. It has no pixels of its own, so
          the box above is a *choice* the rasteriser is handed rather than
          anything the file states — asking it for more costs nothing and loses
          nothing, which is true of no other format here.
        */}
        {decoded?.vector ? (
          <span data-testid="vector-note">
            {" "}
            — {sourceName} is vector, so a bigger size is rasterised at that size rather than scaled
            up: there is no detail to lose.
          </span>
        ) : null}
      </p>

      <div class="field-row">
        <label class="field">
          <span>Dither</span>
          <select
            value={options.dither}
            data-testid="dither-select"
            onChange={(e) => set("dither", (e.currentTarget as HTMLSelectElement).value)}
          >
            {DITHERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span>Scale kernel</span>
          <select
            value={options.scale}
            onChange={(e) =>
              set("scale", (e.currentTarget as HTMLSelectElement).value as PrepOptionsUi["scale"])
            }
          >
            {["auto", "majority", "lanczos3", "box", "nearest"].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset class="field effort">
        <legend>Effort</legend>
        {(["fast", "default", "max"] as const).map((v) => (
          <label key={v} class="radio">
            <input
              type="radio"
              name="effort"
              value={v}
              checked={options.effort === v}
              onChange={() => set("effort", v)}
            />
            <span>{v}</span>
          </label>
        ))}
        {options.effort === "max" && (
          <p class="hint">High effort: more restarts and a full annealing pass. Slower.</p>
        )}
      </fieldset>

      <button
        type="button"
        class="disclosure"
        aria-expanded={advanced}
        onClick={() => setAdvanced(!advanced)}
      >
        {advanced ? "▾" : "▸"} Advanced options
      </button>

      {advanced && (
        <div class="advanced" data-testid="advanced">
          <div class="field-row">
            <label class="field">
              <span>Profile</span>
              <select
                value={options.profile}
                onChange={(e) =>
                  set(
                    "profile",
                    (e.currentTarget as HTMLSelectElement).value as PrepOptionsUi["profile"],
                  )
                }
              >
                {["auto", "art", "photo"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label class="field">
              <span>Metric</span>
              <select
                value={options.metric}
                onChange={(e) =>
                  set(
                    "metric",
                    (e.currentTarget as HTMLSelectElement).value as PrepOptionsUi["metric"],
                  )
                }
              >
                {["oklab", "wrgb"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div class="field-row">
            <label class="field">
              <span>Background</span>
              <input
                type="color"
                value={options.background}
                onInput={(e) => set("background", (e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label class="field">
              <span>Seed</span>
              <input
                type="number"
                placeholder="default"
                value={options.seed}
                onInput={(e) => set("seed", (e.currentTarget as HTMLInputElement).value)}
              />
            </label>
          </div>
          <label class="field">
            <span>Protect colors</span>
            <input
              type="text"
              placeholder="#ffffff, #ff0000"
              value={options.protect}
              disabled={options.noProtect}
              onInput={(e) => set("protect", (e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={options.noProtect}
              onChange={(e) => set("noProtect", (e.currentTarget as HTMLInputElement).checked)}
            />
            <span>No automatic highlight/outline protection</span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={options.dacColors}
              onChange={(e) => {
                const on = (e.currentTarget as HTMLInputElement).checked;
                onChange({ ...options, dacColors: on, rawColors: on ? false : options.rawColors });
              }}
            />
            <span>Store DAC-simulated display colors (--dac-colors)</span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={options.rawColors}
              onChange={(e) => {
                const on = (e.currentTarget as HTMLInputElement).checked;
                onChange({ ...options, rawColors: on, dacColors: on ? false : options.dacColors });
              }}
            />
            <span>Force raw lattice colors (--raw-colors)</span>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={options.strict}
              onChange={(e) => set("strict", (e.currentTarget as HTMLInputElement).checked)}
            />
            <span>Strict: fail rather than degrade (--strict)</span>
          </label>
          <button type="button" class="link" onClick={onReset}>
            Reset all options
          </button>
        </div>
      )}

      <CommandLine command={command} />
    </section>
  );
}
