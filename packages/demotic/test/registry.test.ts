/**
 * The registry describes nine backends without loading them, and this is what
 * stops the descriptions drifting from the things they describe.
 *
 * `codegen/registry.ts` answers "which consoles build", "what is the cartridge
 * called" and "what can this family not do" from a static table, so that asking
 * does not drag nine emitters and their assemblers into whatever asked. That is
 * worth a hundred kilobytes to a browser and nothing at all to the CLI — but it
 * is only safe while the table says what the backends say, and nothing in the
 * type system checks that. This does.
 */

import { describe, expect, it } from "vitest";

import { anyBackend, type AnyBackend } from "../src/codegen/backend.js";
import { gbBackend } from "../src/codegen/gb.js";
import { gbaBackend } from "../src/codegen/gba.js";
import { mdBackend } from "../src/codegen/md.js";
import { neogeoBackend } from "../src/codegen/neogeo.js";
import { nesBackend } from "../src/codegen/nes.js";
import { ngpcBackend } from "../src/codegen/ngpc.js";
import { pceBackend } from "../src/codegen/pce.js";
import { smsBackend } from "../src/codegen/sms.js";
import { snesBackend } from "../src/codegen/snes.js";
import { wscBackend } from "../src/codegen/wsc.js";
import {
  familyFor,
  hasRuntime,
  romExtension,
  runtimeConsoles,
  runtimeFamilies,
  unsupportedFor,
} from "../src/codegen/registry.js";
import { compile } from "../src/compile.js";
import { getProfile, profiles } from "../src/profiles.js";

const LOADED: readonly AnyBackend[] = [
  anyBackend(gbBackend),
  anyBackend(nesBackend),
  anyBackend(smsBackend),
  anyBackend(snesBackend),
  anyBackend(mdBackend),
  anyBackend(neogeoBackend),
  anyBackend(gbaBackend),
  anyBackend(pceBackend),
  anyBackend(wscBackend),
  anyBackend(ngpcBackend),
];

/** The smallest program that compiles, so a profile is all that varies. */
function program(consoleId: string) {
  return compile(
    ["start play", "scene play", "create object mark (x 1, y 1, sprite m.png)"].join("\n"),
    { profile: getProfile(consoleId) },
  );
}

describe("the backend registry", () => {
  it("lists the same consoles and families the backends claim", () => {
    expect([...runtimeConsoles].sort()).toEqual(LOADED.flatMap((b) => b.consoles).sort());
    expect([...runtimeFamilies].sort()).toEqual(LOADED.map((b) => b.family).sort());
  });

  it("routes every console to the family that owns it", () => {
    for (const backend of LOADED) {
      for (const consoleId of backend.consoles) {
        expect(familyFor(consoleId)).toBe(backend.family);
      }
    }
  });

  // The one that would bite: a cartridge saved as `.gb` when the backend meant
  // `.duck`, on a console whose emulators go by the extension.
  it("names a cartridge whatever its backend names it", () => {
    for (const backend of LOADED) {
      for (const consoleId of backend.consoles) {
        const compiled = program(consoleId);
        expect(romExtension(compiled)).toBe(backend.extension(compiled));
      }
    }
  });

  it("reports the same gaps the backends report", () => {
    for (const backend of LOADED) {
      for (const consoleId of backend.consoles) {
        expect(unsupportedFor(program(consoleId))).toEqual(backend.unsupported(program(consoleId)));
      }
    }
  });

  // Every profile has a backend today, which is the happy answer and not a
  // reason to leave this untested: the picker greys a console out on it, and the
  // next console to gain a `ConsoleSpec` before an emitter will be the first to
  // take this path. So the profile is stood in for rather than found.
  it("says so for a console nothing builds", () => {
    expect(profiles.every((profile) => runtimeConsoles.includes(profile.id))).toBe(true);
    expect(familyFor("lynx")).toBeUndefined();
    expect(hasRuntime("lynx")).toBe(false);
    const compiled = program("gb");
    const orphan = { ...compiled, profile: { ...compiled.profile, id: "lynx", name: "Lynx" } };
    expect(unsupportedFor(orphan)).toEqual(["a runtime for Lynx"]);
    expect(romExtension(orphan)).toBe("bin");
  });
});
