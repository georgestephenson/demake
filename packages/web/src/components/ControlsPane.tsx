/**
 * Controls pane (doc 07 §UX 2): the console picker grouped by tier, then the
 * doc-05 options in the order `demake prep --help` lists them, with the advanced
 * ones collapsed. Underneath sits the live equivalent-command line — the feature
 * that lets someone graduate from the page to the CLI without translating
 * anything by hand.
 */

import { useState } from "preact/hooks";

import { equivalentCommand } from "../lib/options.js";
import type { ConsoleInfo, PrepOptionsUi } from "../worker/protocol.js";
import type { StrategyInfo } from "@demake/core";

interface Props {
  options: PrepOptionsUi;
  consoles: ConsoleInfo[];
  strategies: StrategyInfo[];
  onChange: (options: PrepOptionsUi) => void;
  onReset: () => void;
  sourceName: string;
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
}: Props) {
  const [advanced, setAdvanced] = useState(false);
  const [copied, setCopied] = useState(false);
  const set = <K extends keyof PrepOptionsUi>(key: K, value: PrepOptionsUi[K]): void =>
    onChange({ ...options, [key]: value });

  const tiers = [1, 2, 3].filter((t) => consoles.some((c) => c.tier === t));
  const active = consoles.find((c) => c.id === options.console);
  const command = equivalentCommand(options, sourceName);

  return (
    <section class="pane controls-pane" aria-labelledby="controls-heading">
      <h2 id="controls-heading">Console &amp; options</h2>

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
          <span>Size</span>
          <input
            type="text"
            placeholder="auto"
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

      <div class="command">
        <span class="command-label">Equivalent command</span>
        <code data-testid="equivalent-command">{command}</code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(command).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              },
              () => {},
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </section>
  );
}
