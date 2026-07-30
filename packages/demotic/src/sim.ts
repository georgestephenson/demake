/**
 * The reference interpreter.
 *
 * This is the semantic definition of the language. A console runtime is a
 * *conformance implementation* of what happens here — same input tape, same
 * fixed-point state, tick for tick — which is what makes the browser preview a
 * specification rather than a second, disagreeing implementation. Compare with
 * {@link module:trace}: state-trace equality catches every logic divergence
 * without needing a framebuffer, leaving the existing pixel-perfect emulator
 * E2E to test only rendering.
 *
 * Everything below is integer arithmetic. No floats, no wall clock, and no host
 * RNG — `random` draws from the seeded generator in `rng.ts`, which is part of
 * the language precisely so that two implementations can be compared at all.
 *
 * ## Tick order
 *
 * The order is load-bearing: a console runtime that reorders these will diverge
 * within a few seconds, so it is specified rather than incidental.
 *
 *  1. Resolve input edges (pressed / released since last tick).
 *  2. Apply `control` bindings.
 *  3. Apply level-triggered rules (`when <expression>`) — every tick they hold.
 *  4. Integrate positions from speed and direction.
 *  5. Detect collisions, fire `when ... hits ...`, then separate the overlap.
 *  6. Do the same against the level's tiles.
 *  7. Fire edge-triggered rules (`reaches`, `pressed`, `released`).
 *  8. Move the camera to follow its target.
 *  9. Apply any pending scene change, resetting the entered scene.
 *
 * Within one rule, all assignments are evaluated against the pre-rule state and
 * written together, so `(ydirection, xdirection) as (flip, ball.x - paddle.x)`
 * sees the values that were current when the rule fired.
 */

import { applyBinary, applyBuiltin } from "./compile.js";
import { type LevelFile } from "./level/parse.js";
import {
  type Bounds,
  type Camera,
  contactOf,
  follow,
  separateFromTile,
  tileContactSide,
  tilesUnder,
} from "./level/scene.js";
import { clampFixed, type Fixed, fromInt, ONE, toNumber } from "./fixed.js";
import type {
  Action,
  CAssignment,
  CExpr,
  Edge,
  EntityRef,
  InstanceDef,
  Program,
  RuleDef,
  Side,
} from "./program.js";
import { ACTIONS } from "./program.js";
import { advance, pick } from "./rng.js";

/** Which buttons are held this tick. */
export type InputState = Partial<Record<Action, boolean>>;

/** A recorded sequence of held-button sets, one entry per tick. */
export type InputTape = readonly InputState[];

/** Live state of one entity. */
export interface EntityState {
  id: number;
  name: string;
  className: string;
  scene: string;
  numbers: Readonly<Record<string, Fixed>>;
  strings: Readonly<Record<string, string>>;
}

/** What the simulator observed about hardware pressure while running. */
export interface RuntimeBudget {
  /** Worst per-scanline sprite count seen so far. */
  peakSpritesPerLine: number;
  /** Scanline (in pixels) where that peak occurred. */
  peakLine: number;
  /** Tick at which it occurred. */
  peakTick: number;
  /** The console's per-scanline limit, for comparison. */
  limit: number;
  /** True once the peak exceeded the limit — sprites would drop out on hardware. */
  exceeded: boolean;
}

/** One pending write, collected so a rule's assignments apply simultaneously. */
interface PendingWrite {
  entityId: number;
  prop: string;
  value: Fixed;
}

/** Context for resolving `subject` / `other` references while a rule runs. */
interface RuleContext {
  subject?: number;
  other?: number;
}

const EMPTY_INPUT: InputState = {};

/** The reference simulator for one compiled program on one console. */
export class Sim {
  private readonly numbers: Record<string, Fixed>[] = [];
  private readonly strings: Readonly<Record<string, string>>[] = [];
  private readonly bySceneName = new Map<string, readonly number[]>();

  /** Overlaps that existed at the end of the previous tick (edge triggering). */
  private overlaps = new Set<string>();
  /** The same, for object-versus-tile contacts. */
  private tileOverlaps = new Set<string>();
  /**
   * Distance from its target for each `reaches` rule at the end of last tick.
   *
   * `reaches` is a *crossing* detector, not a threshold test. "reaches 10" on a
   * rising score and "reaches 0" on falling lives have to mean the same thing,
   * and a `>=` test cannot: lives start at three, which is already past zero, so
   * the rule would fire on the first tick of the game. Remembering which side of
   * the target the value was on is what makes both readings work.
   */
  private reachedDelta = new Map<number, Fixed>();
  /** Property snapshots taken when an `on hold` binding engaged. */
  private readonly holdSnapshots = new Map<string, Fixed>();

  private held: InputState = EMPTY_INPUT;
  private pressed = new Set<Action>();
  private released = new Set<Action>();

  private currentScene: string;
  private pendingScene: string | undefined;
  private tickCount = 0;
  /** The effect asked for on the tick being run; the last one wins. */
  private soundFired = -1;

  private budget: RuntimeBudget;

  /** Where the viewport sits in the running scene, in cells. */
  private cameraAt: Camera = { x: 0, y: 0 };

  /**
   * The game's random source, re-seeded on scene entry so that replaying a scene
   * replays its draws. The generator itself lives in `rng.ts`, shared with the
   * compile-time composition `stream` does — one definition, so a console
   * runtime has one thing to reproduce.
   */
  private rng = 0;

  constructor(readonly program: Program) {
    for (const instance of program.instances) {
      this.numbers.push({ ...instance.numbers });
      this.strings.push(instance.strings);
    }
    for (const scene of program.scenes) {
      this.bySceneName.set(scene.name, scene.instanceIds);
    }
    this.currentScene = program.entryScene;
    this.rng = program.seed;
    this.budget = {
      peakSpritesPerLine: 0,
      peakLine: 0,
      peakTick: 0,
      limit: program.profile.sprites.perLine,
      exceeded: false,
    };
    this.resetScene(this.currentScene);
  }

  /** The scene currently running. */
  get scene(): string {
    return this.currentScene;
  }

  /** Where the viewport sits, in cells. Object positions are level coordinates. */
  get camera(): Readonly<Camera> {
    return this.cameraAt;
  }

  /** The running scene's playfield, which is its level's size or the screen's. */
  get bounds(): Bounds {
    return this.sceneDef().bounds;
  }

  /** The running scene's level, if it has one. */
  get level(): LevelFile | undefined {
    return this.sceneDef().level;
  }

  private sceneDef() {
    return (
      this.program.scenes.find((scene) => scene.name === this.currentScene) ??
      (this.program.scenes[0] as (typeof this.program.scenes)[number])
    );
  }

  /**
   * Next whole number in `[low, high]` from the seeded generator.
   *
   * Advancing the state is a side effect of *evaluating*, so the number of draws
   * per tick is part of the game's behaviour — which is exactly why the
   * generator has to be specified rather than borrowed from the host.
   */
  private nextRandom(low: Fixed, high: Fixed): Fixed {
    this.rng = advance(this.rng);
    const lo = Math.floor(low / ONE);
    const hi = Math.floor(high / ONE);
    return hi <= lo ? fromInt(lo) : fromInt(lo + pick(this.rng, hi - lo + 1));
  }

  /** Ticks elapsed since construction. */
  get tick(): number {
    return this.tickCount;
  }

  /**
   * The track the running scene asks for, as an index into `program.tracks`.
   *
   * `-1` for a silent scene. Music follows the scene rather than being started
   * by a rule, so this is derived rather than stored — there is no state here
   * that could disagree with the scene the game is in.
   */
  get music(): number {
    const file = this.sceneDef().music;
    return file === undefined ? -1 : this.program.tracks.indexOf(file);
  }

  /** The effect a rule asked for on this tick, or `-1`. */
  get sound(): number {
    return this.soundFired;
  }

  /** Hardware pressure observed so far. */
  get runtimeBudget(): Readonly<RuntimeBudget> {
    return this.budget;
  }

  /** Entities in the running scene, in declaration order. */
  entities(): EntityState[] {
    return (this.bySceneName.get(this.currentScene) ?? []).map((id) => this.entityState(id));
  }

  /** Look up one entity by name, regardless of scene. */
  entity(name: string): EntityState | undefined {
    const found = this.program.instances.find((instance) => instance.name === name.toLowerCase());
    return found ? this.entityState(found.id) : undefined;
  }

  private entityState(id: number): EntityState {
    const def = this.program.instances[id] as InstanceDef;
    return {
      id,
      name: def.name,
      className: def.className,
      scene: def.scene,
      numbers: this.numbers[id] as Record<string, Fixed>,
      strings: this.strings[id] as Record<string, string>,
    };
  }

  /** Advance one logical tick. */
  step(input: InputState = EMPTY_INPUT): void {
    this.resolveInputEdges(input);
    this.soundFired = -1;

    this.applyControls();
    this.applyLevelRules();
    this.integrate();
    this.resolveCollisions();
    this.resolveTiles();
    this.applyEdgeRules();
    this.updateCamera();
    this.observeSpriteBudget();

    if (this.pendingScene !== undefined) {
      const next = this.pendingScene;
      this.pendingScene = undefined;
      this.currentScene = next;
      this.resetScene(next);
      this.rng = this.program.seed;
      this.updateCamera();
      // A fresh scene has no collision or rule history to inherit.
      this.overlaps = new Set();
      this.tileOverlaps = new Set();
      this.reachedDelta.clear();
      this.holdSnapshots.clear();
    }

    this.tickCount += 1;
  }

  /** Run a whole input tape. Convenience for tests and trace generation. */
  run(tape: InputTape): void {
    for (const frame of tape) this.step(frame);
  }

  // --- 1. input --------------------------------------------------------------

  private resolveInputEdges(input: InputState): void {
    this.pressed = new Set();
    this.released = new Set();
    for (const action of ACTIONS) {
      const now = input[action] === true;
      const before = this.held[action] === true;
      if (now && !before) this.pressed.add(action);
      if (!now && before) this.released.add(action);
    }
    this.held = { ...input };
  }

  // --- 2. controls -----------------------------------------------------------

  private applyControls(): void {
    for (const [index, control] of this.program.controls.entries()) {
      const def = this.program.instances[control.instanceId] as InstanceDef;
      if (def.scene !== this.currentScene) continue;

      const isHeld = this.held[control.action] === true;
      const justPressed = this.pressed.has(control.action);
      const justReleased = this.released.has(control.action);

      switch (control.mode) {
        case "press":
          if (justPressed) this.applyAssignments(control.assignments, {});
          break;
        case "release":
          if (justReleased) this.applyAssignments(control.assignments, {});
          break;
        case "hold": {
          // Keyed per binding, not per object: two bindings on the same
          // property must keep their own snapshots or the second press
          // overwrites what the first press has to restore.
          if (justPressed) this.snapshotHold(index, control.instanceId, control.assignments);
          if (isHeld) this.applyAssignments(control.assignments, {});
          if (justReleased) this.restoreHold(index, control.instanceId, control.assignments);
          break;
        }
      }
    }
  }

  /**
   * `on hold` restores the property when the button comes up. Snapshots are
   * keyed per binding, so overlapping holds on the same property unwind in
   * reverse order: press left, press right, release right → back to left's
   * value, release left → back to neutral. That is the "last pressed wins"
   * behaviour, and it falls out of the stack rather than being special-cased.
   */
  private snapshotHold(
    controlIndex: number,
    instanceId: number,
    assignments: readonly CAssignment[],
  ): void {
    for (const assignment of assignments) {
      if (assignment.target.kind !== "prop") continue;
      const id = this.resolveEntity(assignment.target.entity, {}) ?? instanceId;
      const key = `${controlIndex}:${id}:${assignment.target.prop}`;
      this.holdSnapshots.set(key, this.readProp(id, assignment.target.prop));
    }
  }

  private restoreHold(
    controlIndex: number,
    instanceId: number,
    assignments: readonly CAssignment[],
  ): void {
    for (const assignment of assignments) {
      if (assignment.target.kind !== "prop") continue;
      const id = this.resolveEntity(assignment.target.entity, {}) ?? instanceId;
      const key = `${controlIndex}:${id}:${assignment.target.prop}`;
      const snapshot = this.holdSnapshots.get(key);
      if (snapshot !== undefined) {
        this.writeProp(id, assignment.target.prop, snapshot);
        this.holdSnapshots.delete(key);
      }
    }
  }

  // --- 3 & 6. rules ----------------------------------------------------------

  private applyLevelRules(): void {
    for (const rule of this.program.rules) {
      if (!this.ruleActive(rule)) continue;
      if (rule.event.kind !== "predicate") continue;
      for (const context of this.subjectsOf(rule)) {
        this.fire(rule, this.evaluate(rule.event.test, context) !== 0, context);
      }
    }
  }

  /**
   * The subject bindings a rule runs under.
   *
   * A rule naming a class runs once per instance, each bound as the subject;
   * everything else runs once with nothing bound. Inert objects are skipped, so
   * a spent bullet stops being steered as well as drawn.
   */
  private subjectsOf(rule: RuleDef): RuleContext[] {
    if (!rule.subjects) return [{}];
    return rule.subjects
      .filter((id) => this.isActive(id) && this.isSolid(id))
      .map((id) => ({ subject: id }));
  }

  /**
   * Apply a rule's outcome: its assignments when it fired and its guard held,
   * its `else` when it was evaluated and did not.
   */
  private fire(rule: RuleDef, triggered: boolean, context: RuleContext): void {
    const passed =
      triggered && (rule.guard === undefined || this.evaluate(rule.guard, context) !== 0);
    // A sound is *asked for* here, and that is all the trace records. Whether
    // the hardware could spare a channel for it is the driver's business, the
    // way sprite priority is the PPU's: recording the request keeps the two
    // implementations comparable without the simulator having to model an APU.
    if (passed && rule.sound !== undefined) this.soundFired = rule.sound;
    if (passed) this.applyAssignments(rule.assignments, context);
    else if (rule.otherwise) this.applyAssignments(rule.otherwise, context);
  }

  private applyEdgeRules(): void {
    for (const rule of this.program.rules) {
      if (!this.ruleActive(rule)) continue;

      if (rule.event.kind === "input") {
        const fired =
          rule.event.edge === "pressed"
            ? this.pressed.has(rule.event.action)
            : this.released.has(rule.event.action);
        // A guarded input rule is evaluated every tick, so its `else` can run;
        // an unguarded one only has something to say when the edge happens.
        for (const context of this.subjectsOf(rule)) {
          if (fired || rule.guard !== undefined) this.fire(rule, fired, context);
        }
        continue;
      }

      if (rule.event.kind === "reaches") {
        const delta = this.evaluate(rule.event.left, {}) - this.evaluate(rule.event.right, {});
        const previous = this.reachedDelta.get(rule.id);
        this.reachedDelta.set(rule.id, delta);

        // No history yet: record where the value started without firing. A
        // counter that begins on its target has not *reached* it.
        if (previous === undefined) continue;

        const landed = delta === 0 && previous !== 0;
        const crossed = previous !== 0 && delta !== 0 && previous < 0 !== delta < 0;
        for (const context of this.subjectsOf(rule)) {
          if (landed || crossed || rule.guard !== undefined) {
            this.fire(rule, landed || crossed, context);
          }
        }
      }
    }
  }

  /**
   * Whether a rule's `from` clause admits this contact.
   *
   * No clause means any side, which is what every rule written before `from`
   * existed means — so the narrowing is opt-in and nothing silently changed.
   */
  private sideAllowed(rule: RuleDef, side: Side): boolean {
    if (rule.event.kind !== "hits" || rule.event.sides.length === 0) return true;
    return rule.event.sides.includes(side);
  }

  private ruleActive(rule: RuleDef): boolean {
    return rule.scene === undefined || rule.scene === this.currentScene;
  }

  // --- 4. integration --------------------------------------------------------

  private integrate(): void {
    const fps = fromInt(this.program.profile.fps);
    for (const id of this.activeIds()) {
      const numbers = this.numbers[id] as Record<string, Fixed>;
      const speed = numbers["speed"] ?? 0;
      if (speed === 0 || (numbers["visible"] ?? 0) === 0) continue;
      const dx = perTick(numbers["xdirection"] ?? 0, speed, fps);
      const dy = perTick(numbers["ydirection"] ?? 0, speed, fps);
      if (dx !== 0) numbers["x"] = clampFixed((numbers["x"] ?? 0) + dx);
      if (dy !== 0) numbers["y"] = clampFixed((numbers["y"] ?? 0) + dy);
    }
  }

  // --- 5. collisions ---------------------------------------------------------

  private resolveCollisions(): void {
    const current = new Set<string>();

    for (const rule of this.program.rules) {
      if (!this.ruleActive(rule)) continue;
      if (rule.event.kind !== "hits") continue;

      for (const subjectId of rule.event.subjects) {
        if (!this.isActive(subjectId) || !this.isSolid(subjectId)) continue;

        for (const edge of rule.event.edges) {
          if (!this.touchesEdge(subjectId, edge)) continue;
          const key = `${rule.id}:${subjectId}:${edge}`;

          // `hits` fires on entry only — an object resting against a wall is
          // one event, not one per tick. `touches` fires every tick, which is
          // what resting contact needs.
          if (rule.event.level || !this.overlaps.has(key)) {
            this.fire(rule, true, { subject: subjectId });
          }
          // Separate every tick the contact persists, but re-test first: a rule
          // that moved its subject away (a ball reset to the middle after a
          // point) must not be dragged back to the wall it just left, and one
          // that hid it must not have it pushed around while it is out of play.
          if (this.isSolid(subjectId) && this.touchesEdge(subjectId, edge)) {
            this.separateFromEdge(subjectId, edge);
            current.add(key);
          }
        }

        for (const otherId of rule.event.others) {
          if (otherId === subjectId || !this.isActive(otherId) || !this.isSolid(otherId)) continue;
          if (!this.overlapping(subjectId, otherId)) continue;
          if (!this.sideAllowed(rule, this.contact(subjectId, otherId).side)) continue;
          const key = `${rule.id}:${subjectId}:${otherId}`;

          if (rule.event.level || !this.overlaps.has(key)) {
            this.fire(rule, true, { subject: subjectId, other: otherId });
          }
          // `visible 0` is inert — not drawn, *not collided with*, not moved —
          // and a rule that collects a coin by hiding it has said so before
          // this line runs. Separating anyway would shove the player off a
          // thing that no longer exists.
          if (
            this.isSolid(subjectId) &&
            this.isSolid(otherId) &&
            this.overlapping(subjectId, otherId)
          ) {
            this.separateFromEntity(subjectId, otherId);
            current.add(key);
          }
        }
      }
    }

    this.overlaps = current;
  }

  private touchesEdge(id: number, edge: Edge): boolean {
    const numbers = this.numbers[id] as Record<string, Fixed>;
    const { width: screenWidth, height: screenHeight } = this.bounds;
    switch (edge) {
      case "screenleft":
        return (numbers["x"] ?? 0) <= 0;
      case "screenright":
        return (numbers["x"] ?? 0) + (numbers["width"] ?? 0) >= fromInt(screenWidth);
      case "screentop":
        return (numbers["y"] ?? 0) <= 0;
      case "screenbottom":
        return (numbers["y"] ?? 0) + (numbers["height"] ?? 0) >= fromInt(screenHeight);
    }
  }

  private separateFromEdge(id: number, edge: Edge): void {
    const numbers = this.numbers[id] as Record<string, Fixed>;
    const { width: screenWidth, height: screenHeight } = this.bounds;
    switch (edge) {
      case "screenleft":
        numbers["x"] = 0;
        break;
      case "screenright":
        numbers["x"] = fromInt(screenWidth) - (numbers["width"] ?? 0);
        break;
      case "screentop":
        numbers["y"] = 0;
        break;
      case "screenbottom":
        numbers["y"] = fromInt(screenHeight) - (numbers["height"] ?? 0);
        break;
    }
  }

  private overlapping(a: number, b: number): boolean {
    const p = this.numbers[a] as Record<string, Fixed>;
    const q = this.numbers[b] as Record<string, Fixed>;
    return (
      (p["x"] ?? 0) < (q["x"] ?? 0) + (q["width"] ?? 0) &&
      (p["x"] ?? 0) + (p["width"] ?? 0) > (q["x"] ?? 0) &&
      (p["y"] ?? 0) < (q["y"] ?? 0) + (q["height"] ?? 0) &&
      (p["y"] ?? 0) + (p["height"] ?? 0) > (q["y"] ?? 0)
    );
  }

  /**
   * Push the subject clear of what it hit, along the axis of least penetration.
   * Without this the pair stays overlapping, and an object whose direction was
   * flipped but whose position was not corrected can re-enter and stick.
   */
  private separateFromEntity(subjectId: number, otherId: number): void {
    const p = this.numbers[subjectId] as Record<string, Fixed>;
    const { pushX, pushY } = this.contact(subjectId, otherId);
    if (pushX !== 0) p["x"] = clampFixed((p["x"] ?? 0) + pushX);
    else p["y"] = clampFixed((p["y"] ?? 0) + pushY);
  }

  /**
   * Which side of an overlap the subject sat on, and the push that follows.
   *
   * `contactOf`'s, not a second copy: a rule that asks `from above` and the
   * separation that then moves the subject up have to be the same decision, or a
   * game would take footing from a contact it was pushed sideways out of.
   */
  private contact(subjectId: number, otherId: number) {
    const p = this.numbers[subjectId] as Record<string, Fixed>;
    const q = this.numbers[otherId] as Record<string, Fixed>;
    return contactOf(
      p["x"] ?? 0,
      p["y"] ?? 0,
      p["width"] ?? 0,
      p["height"] ?? 0,
      q["x"] ?? 0,
      q["y"] ?? 0,
      q["width"] ?? 0,
      q["height"] ?? 0,
    );
  }

  /**
   * Fire tile rules, then push objects out of solid tiles.
   *
   * Tiles behave like objects on purpose, and the same two conditions apply:
   * something happens only where a rule named the pair, and separation happens
   * only where the tile is `solid`. So `when coin touches player` collects
   * without blocking, and `wall solid` blocks whether or not anything fired —
   * one model, not two.
   */
  private resolveTiles(): void {
    const level = this.level;
    if (!level) return;
    const current = new Set<string>();

    // Which tiles each subject can be stopped by. Built first so an object
    // named by three rules is still pushed out once, not three times.
    const blockers = new Map<number, Set<string>>();

    for (const rule of this.program.rules) {
      if (!this.ruleActive(rule)) continue;
      if (rule.event.kind !== "hits" || rule.event.tiles.length === 0) continue;

      for (const subjectId of rule.event.subjects) {
        if (!this.isActive(subjectId) || !this.isSolid(subjectId)) continue;
        const named = blockers.get(subjectId) ?? new Set<string>();
        for (const name of rule.event.tiles) named.add(name);
        blockers.set(subjectId, named);

        for (const hit of this.tilesUnderEntity(level, subjectId)) {
          if (!rule.event.tiles.includes(hit.name)) continue;
          if (rule.event.sides.length > 0) {
            const numbers = this.numbers[subjectId] as Record<string, Fixed>;
            const side = tileContactSide(
              hit,
              numbers["x"] ?? 0,
              numbers["y"] ?? 0,
              numbers["width"] ?? 0,
              numbers["height"] ?? 0,
            );
            if (!rule.event.sides.includes(side)) continue;
          }
          const key = `${rule.id}:${subjectId}:${hit.column},${hit.row}`;
          current.add(key);
          if (rule.event.level || !this.tileOverlaps.has(key)) {
            this.fire(rule, true, { subject: subjectId });
          }
        }
      }
    }

    // Separation re-reads positions, because a rule that just fired may have
    // moved its subject somewhere it is no longer in contact — the same reason
    // object separation re-tests before pushing.
    for (const [subjectId, named] of blockers) {
      if (!this.isActive(subjectId) || !this.isSolid(subjectId)) continue;
      for (const hit of this.tilesUnderEntity(level, subjectId)) {
        if (!hit.solid || !named.has(hit.name)) continue;
        const numbers = this.numbers[subjectId] as Record<string, Fixed>;
        const moved = separateFromTile(
          hit,
          numbers["x"] ?? 0,
          numbers["y"] ?? 0,
          numbers["width"] ?? 0,
          numbers["height"] ?? 0,
        );
        numbers["x"] = clampFixed(moved.x);
        numbers["y"] = clampFixed(moved.y);
      }
    }

    this.tileOverlaps = current;
  }

  private tilesUnderEntity(level: LevelFile, id: number): ReturnType<typeof tilesUnder> {
    const numbers = this.numbers[id] as Record<string, Fixed>;
    return tilesUnder(
      level,
      numbers["x"] ?? 0,
      numbers["y"] ?? 0,
      numbers["width"] ?? 0,
      numbers["height"] ?? 0,
    );
  }

  /** Centre the viewport on the scene's camera target, held inside the bounds. */
  private updateCamera(): void {
    const target = this.sceneDef().cameraTarget;
    if (target === undefined) {
      this.cameraAt = { x: 0, y: 0 };
      return;
    }
    this.cameraAt = follow(
      this.readProp(target, "centerx"),
      this.readProp(target, "centery"),
      this.bounds,
      this.program.profile,
    );
  }

  // --- assignment ------------------------------------------------------------

  /** Evaluate every value against the pre-rule state, then write them together. */
  private applyAssignments(assignments: readonly CAssignment[], context: RuleContext): void {
    const writes: PendingWrite[] = [];
    let scene: string | undefined;

    for (const assignment of assignments) {
      if (assignment.target.kind === "scene") {
        if (assignment.value.kind === "scene") scene = assignment.value.scene;
        continue;
      }
      const entityId = this.resolveEntity(assignment.target.entity, context);
      if (entityId === undefined) continue;

      const current = this.readProp(entityId, assignment.target.prop);
      const value =
        assignment.value.kind === "flip" ? -current : this.evaluate(assignment.value, context);
      writes.push({ entityId, prop: assignment.target.prop, value });
    }

    for (const write of writes) this.writeProp(write.entityId, write.prop, write.value);
    if (scene !== undefined) this.pendingScene = scene;
  }

  private resolveEntity(ref: EntityRef, context: RuleContext): number | undefined {
    switch (ref.kind) {
      case "instance":
        return ref.id;
      case "subject":
        return context.subject;
      case "other":
        return context.other;
    }
  }

  private readProp(id: number, prop: string): Fixed {
    const numbers = this.numbers[id] as Record<string, Fixed>;
    switch (prop) {
      case "centerx":
        return (numbers["x"] ?? 0) + Math.floor((numbers["width"] ?? 0) / 2);
      case "centery":
        return (numbers["y"] ?? 0) + Math.floor((numbers["height"] ?? 0) / 2);
      case "left":
        return numbers["x"] ?? 0;
      case "right":
        return (numbers["x"] ?? 0) + (numbers["width"] ?? 0);
      case "top":
        return numbers["y"] ?? 0;
      case "bottom":
        return (numbers["y"] ?? 0) + (numbers["height"] ?? 0);
      default:
        return numbers[prop] ?? 0;
    }
  }

  private writeProp(id: number, prop: string, value: Fixed): void {
    (this.numbers[id] as Record<string, Fixed>)[prop] = clampFixed(value);
  }

  // --- expression evaluation -------------------------------------------------

  private evaluate(expr: CExpr, context: RuleContext): Fixed {
    switch (expr.kind) {
      case "const":
        return expr.value;
      case "flip":
        // Only meaningful as an assignment value; elsewhere it is inert.
        return 0;
      case "scene":
        return 0;
      case "neg":
        return clampFixed(-this.evaluate(expr.operand, context));
      case "call": {
        const args = expr.args.map((arg) => this.evaluate(arg, context));
        if (expr.fn === "random") return this.nextRandom(args[0] ?? 0, args[1] ?? 0);
        return applyBuiltin(expr.fn, args);
      }
      case "binary":
        return applyBinary(
          expr.op,
          this.evaluate(expr.left, context),
          this.evaluate(expr.right, context),
        );
      case "camera":
        return expr.axis === "x" ? this.cameraAt.x : this.cameraAt.y;
      case "read": {
        const id = this.resolveEntity(expr.entity, context);
        return id === undefined ? 0 : this.readProp(id, expr.prop);
      }
    }
  }

  // --- scenes ----------------------------------------------------------------

  private resetScene(name: string): void {
    for (const id of this.bySceneName.get(name) ?? []) {
      this.numbers[id] = { ...(this.program.instances[id] as InstanceDef).numbers };
    }
  }

  private activeIds(): readonly number[] {
    return this.bySceneName.get(this.currentScene) ?? [];
  }

  private isActive(id: number): boolean {
    return (this.program.instances[id] as InstanceDef).scene === this.currentScene;
  }

  /**
   * An object with `visible 0` is inert: not drawn, and not collided with.
   *
   * This is how a thing is removed from play — a broken brick, a spent bullet —
   * without the language needing a lifecycle concept, and it is why `destroy`
   * does not exist. The pairing is deliberate: an object you cannot see but can
   * still hit is a bug in every game that has ever shipped one, and the two
   * genuine exceptions (trigger zones, invisible walls) are better served by a
   * separate property than by splitting this one.
   */
  private isSolid(id: number): boolean {
    return ((this.numbers[id] as Record<string, Fixed>)["visible"] ?? 0) !== 0;
  }

  // --- hardware pressure -----------------------------------------------------

  /**
   * Count sprite entries per scanline the way the video hardware does, and
   * remember the worst case. Exceeding the per-line limit is the single most
   * common way a game that looks fine in preview breaks on real hardware —
   * sprites past the limit simply do not draw — so the simulator watches for it
   * instead of leaving it to be discovered in an emulator.
   *
   * Approximation: an object `w` cells wide occupies `ceil(w)` hardware sprites
   * on every scanline it covers. Real hardware allows 8×16 sprites, which would
   * halve the count on some targets; the estimate is deliberately pessimistic.
   */
  private observeSpriteBudget(): void {
    const { cellSize, screenHeight } = this.program.profile;
    const lines = screenHeight * cellSize;
    const perLine = new Int32Array(lines);

    // A scrolling scene's HUD is drawn with sprites, because the background
    // layer cannot hold still while it moves — so those glyphs are counted too.
    const hudCostsSprites = this.sceneDef().cameraTarget !== undefined;

    for (const id of this.activeIds()) {
      const def = this.program.instances[id] as InstanceDef;
      const numbers = this.numbers[id] as Record<string, Fixed>;
      if ((numbers["visible"] ?? ONE) === 0) continue;

      if (!def.strings["sprite"]) {
        if (!hudCostsSprites) continue;
        const glyphs = hudGlyphs(def, numbers);
        if (glyphs === 0) continue;
        const row = Math.floor(toNumber(numbers["y"] ?? 0) * cellSize);
        for (let line = Math.max(0, row); line < Math.min(lines, row + cellSize); line += 1) {
          perLine[line] = (perLine[line] as number) + glyphs;
        }
        continue;
      }

      const columns = Math.max(1, Math.ceil(toNumber(numbers["width"] ?? ONE)));
      const top = Math.floor(toNumber(numbers["y"] ?? 0) * cellSize);
      const bottom = Math.ceil(toNumber((numbers["y"] ?? 0) + (numbers["height"] ?? 0)) * cellSize);

      for (let line = Math.max(0, top); line < Math.min(lines, bottom); line += 1) {
        perLine[line] = (perLine[line] as number) + columns;
      }
    }

    for (let line = 0; line < lines; line += 1) {
      const count = perLine[line] as number;
      if (count > this.budget.peakSpritesPerLine) {
        this.budget = {
          ...this.budget,
          peakSpritesPerLine: count,
          peakLine: line,
          peakTick: this.tickCount,
          exceeded: count > this.program.profile.sprites.perLine,
        };
      }
    }
  }
}

/**
 * One tick of movement: `direction × speed ÷ fps`, in that order.
 *
 * Speeds are authored in cells per second precisely so this division is the
 * only place the frame rate enters the simulation — a 50 Hz PAL build and a
 * 60 Hz NTSC build then play at the same *speed*, differing only in temporal
 * resolution, rather than the PAL build running 5/6 as fast.
 */
function perTick(direction: Fixed, speed: Fixed, fps: Fixed): Fixed {
  const velocity = Math.floor((direction * speed) / ONE);
  return Math.floor((velocity * ONE) / fps);
}

/** Cells a `number` or `text` object writes on screen; zero for anything else. */
function hudGlyphs(def: InstanceDef, numbers: Readonly<Record<string, Fixed>>): number {
  if (def.className === "text") return (def.strings["text"] ?? "").length;
  if (def.className !== "number") return 0;
  const value = Math.trunc(toNumber(numbers["value"] ?? 0));
  return String(Math.abs(value)).length + (value < 0 ? 1 : 0);
}
