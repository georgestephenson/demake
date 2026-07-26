/**
 * The Demotic language registry — the single source of truth for its surface.
 *
 * This file is to the language what `packages/cli-spec` is to the CLI (doc 05
 * §Single source of truth): one typed declaration of every statement, property,
 * unit, builtin, constant, button, trigger and diagnostic, from which the
 * lexer's keyword tables, the compiler's property tables and the reference
 * documentation are all derived. A test fails if the generated docs drift.
 *
 * The point is not tidiness. A language whose surface is scattered across a
 * lexer, a compiler and three prose documents grows by accident: someone adds a
 * property in one place and the docs are wrong forever. Here, adding anything
 * means adding it *here*, and everything downstream follows or the build breaks.
 *
 * Every entry carries its own documentation. That is deliberate — the summary
 * next to the definition is the one people keep current, and it is what the
 * generated reference is built from.
 */

/** How a property's value is written and stored. */
export type PropertyKind = "number" | "asset" | "text";

/** One property an object can carry. */
export interface PropertySpec {
  name: string;
  kind: PropertyKind;
  /** Default for `number` properties, in cells. */
  default?: number;
  /** One line, used verbatim in the generated reference. */
  summary: string;
  /** Rounds to whole cells, because hardware sprites come in whole cells. */
  quantised?: boolean;
  /** Computed from other properties; readable but not assignable. */
  derived?: boolean;
  /** Settable only when the object is created. */
  createOnly?: boolean;
  /** Longer note, when the property has a trap worth spelling out. */
  note?: string;
}

/** Every property, in the order the reference lists them. */
export const PROPERTIES: readonly PropertySpec[] = [
  {
    name: "x",
    kind: "number",
    default: 0,
    summary: "Left edge, in cells from the left of the playfield.",
  },
  {
    name: "y",
    kind: "number",
    default: 0,
    summary: "Top edge, in cells from the top of the playfield.",
  },
  {
    name: "width",
    kind: "number",
    default: 1,
    quantised: true,
    summary: "Collision box width, in cells.",
    note: "This is the box that collides *and* the sprite's footprint, so it rounds to whole cells — hardware sprites come in whole 8×8 units and a 4.8-cell box corresponds to nothing that can be drawn.",
  },
  {
    name: "height",
    kind: "number",
    default: 1,
    quantised: true,
    summary: "Collision box height, in cells.",
  },
  {
    name: "speed",
    kind: "number",
    default: 0,
    summary: "Movement magnitude, in cells per second.",
    note: "Per *second*, not per tick: the frame rate is divided out at compile time, so a 50 Hz build plays at the same speed as a 60 Hz one rather than 5/6 as fast.",
  },
  {
    name: "xdirection",
    kind: "number",
    default: 0,
    summary: "Horizontal multiplier applied to `speed`, normally −1…1.",
    note: "Speed applies per axis, so a diagonal heading travels at `speed` on both. Nothing is normalised — that would need a square root, and the simulation stays in exact integers.",
  },
  {
    name: "ydirection",
    kind: "number",
    default: 0,
    summary: "Vertical multiplier applied to `speed`. Positive is downward.",
  },
  {
    name: "visible",
    kind: "number",
    default: 1,
    summary: "Non-zero to take part in the game at all.",
    note: "`visible 0` is inert: not drawn, not collided with, not moved. That is how an object leaves play — a broken brick, a spent bullet — and why there is no `destroy`. An object you cannot see but can still hit is a bug in every game that has ever shipped one.",
  },
  { name: "value", kind: "number", default: 0, summary: "The number a `number` object displays." },
  {
    name: "sprite",
    kind: "asset",
    createOnly: true,
    summary: "Art for this object. Unquoted filenames are read literally.",
  },
  { name: "text", kind: "text", createOnly: true, summary: "The string a `text` object displays." },
  {
    name: "direction",
    kind: "number",
    summary: "Compass shorthand that sets `xdirection` and `ydirection` together.",
    note: "Write-only sugar: `direction northwest` is exactly `xdirection -1, ydirection -1`.",
  },
  { name: "centerx", kind: "number", derived: true, summary: "`x + width / 2`." },
  { name: "centery", kind: "number", derived: true, summary: "`y + height / 2`." },
  { name: "left", kind: "number", derived: true, summary: "`x`." },
  { name: "right", kind: "number", derived: true, summary: "`x + width`." },
  { name: "top", kind: "number", derived: true, summary: "`y`." },
  { name: "bottom", kind: "number", derived: true, summary: "`y + height`." },
];

/** A numeric literal's unit suffix. */
export interface UnitSpec {
  name: string;
  aliases?: readonly string[];
  summary: string;
}

/** Units, absolute first. */
export const UNITS: readonly UnitSpec[] = [
  {
    name: "cells",
    aliases: ["cell"],
    summary: "One 8×8 hardware cell. The default when no unit is written.",
  },
  { name: "vw", summary: "One percent of the playfield's width." },
  { name: "vh", summary: "One percent of the playfield's height." },
  {
    name: "vmin",
    summary:
      "One percent of the playfield's shorter side. Use this for anything that must stay square.",
  },
  { name: "vmax", summary: "One percent of the playfield's longer side." },
];

/** A builtin function. */
export interface FunctionSpec {
  name: string;
  arity: number;
  signature: string;
  summary: string;
}

/**
 * Builtins. Deliberately tiny, and every one exactly representable in integer
 * arithmetic — each has to be reimplementable in a page of 6502, so nothing
 * transcendental will ever join them.
 */
export const FUNCTIONS: readonly FunctionSpec[] = [
  { name: "abs", arity: 1, signature: "abs(x)", summary: "Magnitude, dropping the sign." },
  { name: "min", arity: 2, signature: "min(a, b)", summary: "The smaller of two values." },
  { name: "max", arity: 2, signature: "max(a, b)", summary: "The larger of two values." },
  {
    name: "clamp",
    arity: 3,
    signature: "clamp(x, low, high)",
    summary: "`x` held between `low` and `high`. The basis of proportional control.",
  },
  {
    name: "random",
    arity: 2,
    signature: "random(low, high)",
    summary: "A whole number from `low` to `high`, from the game's seeded generator.",
  },
];

/** A bare name that resolves to a number. */
export interface ConstantSpec {
  name: string;
  summary: string;
}

/** Constants, resolved against the target console at compile time. */
export const CONSTANTS: readonly ConstantSpec[] = [
  {
    name: "screenwidth",
    summary: "Playfield width in cells — the overscan-*safe* width, not the raw frame.",
  },
  { name: "screenheight", summary: "Playfield height in cells, overscan-safe." },
  { name: "rawscreenwidth", summary: "Raw framebuffer width in cells, before the overscan crop." },
  { name: "rawscreenheight", summary: "Raw framebuffer height in cells." },
  { name: "centerx", summary: "Horizontal middle of the playfield." },
  { name: "centery", summary: "Vertical middle of the playfield." },
  { name: "screenleft", summary: "Zero. Reads better than `0` in a position." },
  { name: "screentop", summary: "Zero." },
  { name: "screenright", summary: "Same as `screenwidth`." },
  { name: "screenbottom", summary: "Same as `screenheight`." },
  { name: "fps", summary: "Logical ticks per second on this console." },
  { name: "levelwidth", summary: "Playfield width in cells — the level's, or the screen's." },
  { name: "levelheight", summary: "Playfield height in cells." },
  { name: "always", summary: "One. `when always` is how a rule says *every tick*." },
  { name: "never", summary: "Zero." },
];

/** An abstract button. */
export interface ButtonSpec {
  name: string;
  summary: string;
}

/**
 * The portable button set — the floor across every target console, which is why
 * it is this small. A pad drawn for it is the same on every machine.
 */
export const BUTTONS: readonly ButtonSpec[] = [
  { name: "left", summary: "D-pad left." },
  { name: "right", summary: "D-pad right." },
  { name: "up", summary: "D-pad up." },
  { name: "down", summary: "D-pad down." },
  { name: "a", summary: "The primary face button." },
  { name: "b", summary: "The secondary face button." },
  {
    name: "start",
    summary:
      "Start or pause. Not a face button everywhere — the Master System has none, and the compiler warns.",
  },
];

/** A screen edge usable as a collision target. */
export interface EdgeSpec {
  name: string;
  summary: string;
}

/** Screen edges. */
export const EDGES_SPEC: readonly EdgeSpec[] = [
  { name: "screenleft", summary: "The left edge of the playfield." },
  { name: "screenright", summary: "The right edge." },
  { name: "screentop", summary: "The top edge." },
  { name: "screenbottom", summary: "The bottom edge." },
];

/** A statement form. */
export interface StatementSpec {
  keyword: string;
  syntax: string;
  summary: string;
  example: string;
  note?: string;
}

/** Statements, in the order a program tends to use them. */
export const STATEMENTS: readonly StatementSpec[] = [
  {
    keyword: "start",
    syntax: "start <scene>",
    summary: "Names the scene the game begins on. Exactly one per program.",
    example: "start title",
  },
  {
    keyword: "seed",
    syntax: "seed <n>",
    summary: "Fixes the game's random source. Optional; the default is 1.",
    example: "seed 20260725",
    note: "The seed lives in the game, never in the Demakefile: a different seed is a different game, and the build file may not change how a game plays (doc 15). It is also what `stream` composes its levels with, so one number decides the whole course.",
  },
  {
    keyword: "scene",
    syntax: "scene <name>",
    summary: "Declares a scene. Objects and rules belong to one.",
    example: "scene play",
  },
  {
    keyword: "create object",
    syntax: "create object <class> ( <properties> )",
    summary: "Declares a class and its default properties.",
    example: "create object ball (width 1 cell, height 1 cell, speed 40vmin, sprite ball.svg)",
  },
  {
    keyword: "create",
    syntax: "create <class> <name> [in <scene>] ( <properties> )",
    summary: "Creates one object, overriding its class defaults.",
    example: "create ball ball1 in play (x centerx, y centery, direction southwest)",
  },
  {
    keyword: "level",
    syntax: "level <name> [in <scene>] from <file.dmtl>",
    summary: "Loads a level, which becomes the scene's playfield.",
    example: "level cavern from cavern.dmtl",
    note: "A scene with a level takes that level's size as its bounds, so `screenwidth` and the screen edges mean the *level's* edges — a player running right stops at the end of the level, not at an invisible wall a screen-width in. Object positions are level coordinates throughout; the camera decides what is on screen, which is why scrolling does not infect every rule in the game.",
  },
  {
    keyword: "stream",
    syntax: "stream <name> [in <scene>] from <file>, <file>, … <n> wide|tall",
    summary: "Builds a level by drawing `n` chunks at random and laying them end to end.",
    example: "stream course from gap.dmtl, low.dmtl, high.dmtl 24 wide",
    note: "An endless scroller is not an endless level — it is a short vocabulary of hand-made pieces played in an order nobody wrote down. Composition happens at compile time from the program's `seed`, so the result is an ordinary level: the simulator, the camera and a console runtime all see a tilemap and need no notion of streaming. Chunks share one legend, and must agree on the dimension they are not laid along.",
  },
  {
    keyword: "backdrop",
    syntax: "backdrop <file> [in <scene>]",
    summary: "Fills a scene's background with a demade picture.",
    example: "backdrop title.svg",
    note: "The picture goes through the *image* pipeline — the same fitter `prep` uses — so a title screen is demade exactly the way a photograph is, into tiles and a tilemap the background layer draws for free. It is scenery and nothing else: nothing collides with it, nothing reads it, and a scene that scrolls has a level instead. What it costs is tiles, and a console has a fixed number of them; art that needs more than are left over is a build error naming the number, because the alternative is a title screen with holes in it.",
  },
  {
    keyword: "camera",
    syntax: "camera follows <object> [in <scene>]",
    summary: "Keeps the viewport centred on an object, clamped inside the level.",
    example: "camera follows player",
    note: "The clamp is what stops the view running off the end of a level, and it means a level no bigger than the screen never scrolls — so a non-scrolling game needs no special case. `camera.x` and `camera.y` are readable in expressions.",
  },
  {
    keyword: "control",
    syntax: "control <object> <button> ( <assignments> ) on hold|press|release",
    summary: "Binds a button to property changes on one object.",
    example: "control paddle1 left (xdirection -1) on hold",
    note: "`on hold` restores the previous value when the button comes up, so releasing leaves the object stopped. Snapshots are per binding, which is what makes overlapping presses unwind in reverse order.",
  },
  {
    keyword: "when",
    syntax: "when <trigger> [in <scene>] [if <expr>] then <assignments> [else <assignments>]",
    summary: "Fires assignments when something happens, or while something holds.",
    example: "when ball hits screenleft, screenright then xdirection as flip",
    note: '`then` separates the condition from the consequence, which is what makes a long rule readable. `if` guards a trigger with a condition — `when a pressed if shot.visible = 0` is how a rule fires only when the state allows it. `else` runs when the rule was evaluated and did not fire, so it is allowed on level triggers and on any guarded rule, but not on a bare edge trigger, where "did not fire" would mean every other tick of the game. Brackets are optional around a single `name as value`.',
  },
];

/** A `when` trigger form. */
export interface TriggerSpec {
  syntax: string;
  timing: "edge" | "level";
  summary: string;
  example: string;
  note?: string;
}

/** Trigger forms. */
export const TRIGGERS: readonly TriggerSpec[] = [
  {
    syntax: "<a> hits <b>, <c>",
    timing: "edge",
    summary: "On contact, once — not once per tick of contact.",
    example: "when ball hits paddle then ydirection as flip",
    note: "Bare class names bind to the two objects that collided, and an unqualified property targets the subject.",
  },
  {
    syntax: "<a> touches <b>, <c>",
    timing: "level",
    summary: "Every tick two things overlap.",
    example: "when player touches ledge then ydirection as 0",
    note: "Resting contact is not an event. Under `hits`, a hero standing on a ledge keeps accumulating gravity into `ydirection` while the separation holds it in place — it looks right, then fights the next jump.",
  },
  {
    syntax: "<button> pressed | released",
    timing: "edge",
    summary: "On the button's edge, once per press.",
    example: "when a pressed in title then scene as play",
  },
  {
    syntax: "<expr> reaches <expr>",
    timing: "edge",
    summary: "When a value lands on a target or crosses it from either side.",
    example: "when score1.value reaches 10 in play then scene as gameover",
    note: "A crossing detector, not a threshold: `reaches 0` on falling lives and `reaches 10` on a rising score must mean the same thing, and `>=` cannot express both. A value that *starts* on its target has not reached it.",
  },
  {
    syntax: "<class>.<property> <op> <expr>",
    timing: "level",
    summary: "Every tick, once per object of that class, with it bound as the subject.",
    example: "when rock.y >= screenheight then y as 0",
    note: "A level rule naming exactly one class runs once per instance of it, so an unqualified property means *this* object's. One line replaces one rule per object, and one place to forget one. Naming two classes has no single subject to pick and is an error rather than a guess.",
  },
  {
    syntax: "<expr>",
    timing: "level",
    summary: "Every tick the expression is non-zero.",
    example: "when always in play then paddle2.xdirection as clamp(error / 1.5vw, -1, 1)",
    note: "Level rules apply in program order and the last write wins, which is how a proportional controller and its limits compose.",
  },
];

/** A diagnostic the compiler can emit. */
export interface DiagnosticSpec {
  code: string;
  severity: "error" | "warning";
  summary: string;
}

/**
 * Every diagnostic, with the reason it exists. Each is a mistake the cell-and-
 * tick model makes easy to write and hard to see, caught from the numbers rather
 * than left to be found in an emulator.
 */
export const DIAGNOSTICS: readonly DiagnosticSpec[] = [
  {
    code: "E_NO_ENTRY",
    severity: "error",
    summary: "No `start` statement, so the game has no entry point.",
  },
  {
    code: "E_UNKNOWN_SCENE",
    severity: "error",
    summary: "A scene was named that is never declared.",
  },
  { code: "E_DUPLICATE_SCENE", severity: "error", summary: "Two scenes share a name." },
  { code: "E_DUPLICATE_START", severity: "error", summary: "More than one `start` statement." },
  {
    code: "E_ELSE_NOT_ALLOWED",
    severity: "error",
    summary: '`else` on a bare edge trigger, where "did not fire" would mean every other tick.',
  },
  {
    code: "E_UNKNOWN_LEVEL",
    severity: "error",
    summary: "A level file that was never loaded, or could not be found.",
  },
  {
    code: "E_LEVEL_SYNTAX",
    severity: "error",
    summary: "A `.dmtl` line that is neither a `tile` legend entry nor `map`.",
  },
  { code: "E_LEVEL_NO_MAP", severity: "error", summary: "A `.dmtl` file with no `map` grid." },
  { code: "E_UNKNOWN_TILE", severity: "error", summary: "A grid character with no legend entry." },
  {
    code: "E_DUPLICATE_TILE",
    severity: "error",
    summary: "A legend reusing a character or a name.",
  },
  {
    code: "E_UNKNOWN_BACKDROP",
    severity: "error",
    summary: "A backdrop image that was never supplied, or could not be found.",
  },
  {
    code: "E_DUPLICATE_BACKDROP",
    severity: "error",
    summary: "More than one backdrop in a scene; a scene has one background.",
  },
  {
    code: "E_BACKDROP_WITH_LEVEL",
    severity: "error",
    summary: "A scene with both a level and a backdrop; the level is the background.",
  },
  {
    code: "E_BACKDROP_TILES",
    severity: "error",
    summary: "A backdrop needs more tiles than the console has left after the game's own art.",
  },
  {
    code: "E_DUPLICATE_LEVEL",
    severity: "error",
    summary: "More than one level in a scene; a scene has one playfield.",
  },
  {
    code: "E_LEVEL_TOO_SMALL",
    severity: "error",
    summary:
      "A level smaller than the screen on some console, so part of the view has nothing in it.",
  },
  {
    code: "E_STREAM_MISMATCH",
    severity: "error",
    summary: "Stream chunks that disagree on the dimension they are not laid along.",
  },
  {
    code: "E_STREAM_LEGEND",
    severity: "error",
    summary: "Stream chunks giving one character two different meanings.",
  },
  { code: "E_DUPLICATE_SEED", severity: "error", summary: "More than one `seed` statement." },
  {
    code: "E_AMBIGUOUS_CLASS",
    severity: "error",
    summary: "A level rule naming more than one class has no single object to bind as its subject.",
  },
  {
    code: "E_UNKNOWN_CLASS",
    severity: "error",
    summary: "An object was created from a class that is never declared.",
  },
  { code: "E_DUPLICATE_CLASS", severity: "error", summary: "Two classes share a name." },
  {
    code: "E_RESERVED_CLASS",
    severity: "error",
    summary: "A builtin class name (`number`, `text`) was redeclared.",
  },
  { code: "E_DUPLICATE_INSTANCE", severity: "error", summary: "Two objects share a name." },
  {
    code: "E_AMBIGUOUS_SCENE",
    severity: "error",
    summary: "An object could belong to more than one scene; add `in <scene>`.",
  },
  {
    code: "E_UNKNOWN_PROP",
    severity: "error",
    summary: "No such property, or a derived one was assigned.",
  },
  { code: "E_UNKNOWN_NAME", severity: "error", summary: "A bare name that is not a constant." },
  { code: "E_UNKNOWN_INSTANCE", severity: "error", summary: "No object of that name." },
  {
    code: "E_UNKNOWN_ENTITY",
    severity: "error",
    summary: "Not an object, a class or a screen edge.",
  },
  {
    code: "E_NO_INSTANCES",
    severity: "error",
    summary: "A class with no objects cannot collide with anything.",
  },
  { code: "E_UNKNOWN_ACTION", severity: "error", summary: "Not one of the portable buttons." },
  {
    code: "E_UNQUALIFIED_TARGET",
    severity: "error",
    summary: "A rule with no subject needs `<object>.<property>`.",
  },
  {
    code: "E_READONLY_PROP",
    severity: "error",
    summary: "A create-only property was assigned at run time.",
  },
  {
    code: "E_NOT_CONSTANT",
    severity: "error",
    summary: "An initial value that is not a constant; they are baked in at build time.",
  },
  { code: "E_BAD_DIRECTION", severity: "error", summary: "`direction` takes a compass name." },
  { code: "E_BAD_VALUE", severity: "error", summary: "A value of the wrong kind for its slot." },
  { code: "E_ARITY", severity: "error", summary: "Wrong number of arguments or values." },
  { code: "E_SYNTAX", severity: "error", summary: "The statement could not be parsed." },
  { code: "E_UNKNOWN_STATEMENT", severity: "error", summary: "Not a statement keyword." },
  {
    code: "E_GLUED_COMMENT",
    severity: "error",
    summary: "`--` run onto the token before it, which discards the rest of the line.",
  },
  {
    code: "E_UNTERMINATED_STRING",
    severity: "error",
    summary: "A string with no closing quote, which swallows the rest of the line.",
  },
  {
    code: "E_UNKNOWN_UNIT",
    severity: "error",
    summary: "A word attached to a number that is not one of the units.",
  },
  {
    code: "E_DUPLICATE_PROP",
    severity: "error",
    summary: "One list setting the same property twice, where the first value does nothing.",
  },
  {
    code: "E_DUPLICATE_CONTROL",
    severity: "error",
    summary: "Two bindings setting one property from one button, whose `on hold` restores fight.",
  },
  {
    code: "E_DUPLICATE_CAMERA",
    severity: "error",
    summary: "More than one camera in a scene; a scene has one viewport.",
  },
  {
    code: "E_SPRITE_BUDGET",
    severity: "error",
    summary: "A scene needs more hardware sprites than the console has.",
  },
  {
    code: "E_OBJECT_TOO_WIDE",
    severity: "error",
    summary: "An object is wider than the playfield.",
  },
  {
    code: "E_OBJECT_TOO_TALL",
    severity: "error",
    summary: "An object is taller than the playfield.",
  },
  {
    code: "W_SPRITE_BUDGET",
    severity: "warning",
    summary: "A scene is past three quarters of the sprite budget.",
  },
  {
    code: "W_OFFSCREEN_START",
    severity: "warning",
    summary: "An object starts partly outside the playfield.",
  },
  {
    code: "W_TUNNELLING",
    severity: "warning",
    summary:
      "A mover's per-tick step exceeds the thickness of what it collides with, so it can pass straight through.",
  },
  {
    code: "W_SUBTICK_SPEED",
    severity: "warning",
    summary: "A speed whose per-tick step floors to zero, leaving the object frozen.",
  },
  {
    code: "W_SIZE_ROUNDING",
    severity: "warning",
    summary: "The cell grid moved a relative size by more than a quarter.",
  },
  {
    code: "W_ASPECT_MISMATCH",
    severity: "warning",
    summary: "Width and height sized against different screen axes cannot stay square.",
  },
  {
    code: "W_TEXT_TOO_WIDE",
    severity: "warning",
    summary: "Text runs past the edge of a narrow playfield.",
  },
  {
    code: "W_START_MAPPING",
    severity: "warning",
    summary: "`start` is not a face button on this console.",
  },
  {
    code: "W_EMPTY_RULE",
    severity: "warning",
    summary: "A rule that triggers but assigns nothing.",
  },
];

// --- derived tables ----------------------------------------------------------
// Everything below is computed from the registry above, so the lexer, the
// compiler and the simulator cannot disagree with the documentation.

/** Assignable numeric properties and their defaults, in cells. */
export const NUMBER_DEFAULTS: Readonly<Record<string, number>> = Object.fromEntries(
  PROPERTIES.filter((p) => p.kind === "number" && !p.derived && p.default !== undefined).map(
    (p) => [p.name, p.default as number],
  ),
);

/** String-valued properties and their kinds. */
export const STRING_PROPS: Readonly<Record<string, "asset" | "text">> = Object.fromEntries(
  PROPERTIES.filter((p) => p.kind === "asset" || p.kind === "text").map((p) => [
    p.name,
    p.kind as "asset" | "text",
  ]),
);

/** Read-only properties computed from the geometry ones. */
export const DERIVED_PROPS: ReadonlySet<string> = new Set(
  PROPERTIES.filter((p) => p.derived).map((p) => p.name),
);

/** Properties that round to whole cells. */
export const CELL_QUANTISED: ReadonlySet<string> = new Set(
  PROPERTIES.filter((p) => p.quantised).map((p) => p.name),
);

/** Unit names the lexer accepts, aliases included. */
export const UNIT_NAMES: ReadonlySet<string> = new Set(
  UNITS.flatMap((u) => [u.name, ...(u.aliases ?? [])]),
);

/** Builtin name → arity. */
export const FUNCTION_ARITY: Readonly<Record<string, number>> = Object.fromEntries(
  FUNCTIONS.map((f) => [f.name, f.arity]),
);

/** Button names, in pad order. */
export const BUTTON_NAMES = BUTTONS.map((b) => b.name) as readonly string[];

/** Screen-edge names. */
export const EDGE_NAMES = EDGES_SPEC.map((e) => e.name) as readonly string[];

/** Every property name the reference documents, for the "known properties" hint. */
export function knownPropertyNames(): readonly string[] {
  return PROPERTIES.filter((p) => !p.derived)
    .map((p) => p.name)
    .sort();
}
