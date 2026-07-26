<!-- Generated from packages/demotic/src/lang/spec.ts. Do not edit by hand;
     run `pnpm gen:demotic-docs` after changing the registry. -->

# Diagnostics

Every one of these is a mistake the cell-and-tick model makes easy to write and hard to see, caught from the numbers rather than left to be found in an emulator. All are per-console, because all of them are properties of the target rather than of the source: a 30-cell wall is fine on a NES and impossible on a Game Boy.

## Errors

| Code | Meaning |
|---|---|
| `E_NO_ENTRY` | No `start` statement, so the game has no entry point. |
| `E_UNKNOWN_SCENE` | A scene was named that is never declared. |
| `E_DUPLICATE_SCENE` | Two scenes share a name. |
| `E_DUPLICATE_START` | More than one `start` statement. |
| `E_ELSE_NOT_ALLOWED` | `else` on a bare edge trigger, where "did not fire" would mean every other tick. |
| `E_UNKNOWN_LEVEL` | A level file that was never loaded, or could not be found. |
| `E_LEVEL_SYNTAX` | A `.dmtl` line that is neither a `tile` legend entry nor `map`. |
| `E_LEVEL_NO_MAP` | A `.dmtl` file with no `map` grid. |
| `E_UNKNOWN_TILE` | A grid character with no legend entry. |
| `E_DUPLICATE_TILE` | A legend reusing a character or a name. |
| `E_UNKNOWN_BACKDROP` | A backdrop image that was never supplied, or could not be found. |
| `E_DUPLICATE_BACKDROP` | More than one backdrop in a scene; a scene has one background. |
| `E_BACKDROP_WITH_LEVEL` | A scene with both a level and a backdrop; the level is the background. |
| `E_BACKDROP_TILES` | A backdrop needs more tiles than the console has left after the game's own art. |
| `E_DUPLICATE_LEVEL` | More than one level in a scene; a scene has one playfield. |
| `E_LEVEL_TOO_SMALL` | A level smaller than the screen on some console, so part of the view has nothing in it. |
| `E_STREAM_MISMATCH` | Stream chunks that disagree on the dimension they are not laid along. |
| `E_STREAM_LEGEND` | Stream chunks giving one character two different meanings. |
| `E_DUPLICATE_SEED` | More than one `seed` statement. |
| `E_AMBIGUOUS_CLASS` | A level rule naming more than one class has no single object to bind as its subject. |
| `E_UNKNOWN_CLASS` | An object was created from a class that is never declared. |
| `E_DUPLICATE_CLASS` | Two classes share a name. |
| `E_RESERVED_CLASS` | A builtin class name (`number`, `text`) was redeclared. |
| `E_DUPLICATE_INSTANCE` | Two objects share a name. |
| `E_AMBIGUOUS_SCENE` | An object could belong to more than one scene; add `in <scene>`. |
| `E_UNKNOWN_PROP` | No such property, or a derived one was assigned. |
| `E_UNKNOWN_NAME` | A bare name that is not a constant. |
| `E_UNKNOWN_INSTANCE` | No object of that name. |
| `E_UNKNOWN_ENTITY` | Not an object, a class or a screen edge. |
| `E_NO_INSTANCES` | A class with no objects cannot collide with anything. |
| `E_UNKNOWN_ACTION` | Not one of the portable buttons. |
| `E_UNQUALIFIED_TARGET` | A rule with no subject needs `<object>.<property>`. |
| `E_READONLY_PROP` | A create-only property was assigned at run time. |
| `E_NOT_CONSTANT` | An initial value that is not a constant; they are baked in at build time. |
| `E_BAD_DIRECTION` | `direction` takes a compass name. |
| `E_BAD_VALUE` | A value of the wrong kind for its slot. |
| `E_ARITY` | Wrong number of arguments or values. |
| `E_SYNTAX` | The statement could not be parsed. |
| `E_UNKNOWN_STATEMENT` | Not a statement keyword. |
| `E_SPRITE_BUDGET` | A scene needs more hardware sprites than the console has. |
| `E_OBJECT_TOO_WIDE` | An object is wider than the playfield. |
| `E_OBJECT_TOO_TALL` | An object is taller than the playfield. |

## Warnings

| Code | Meaning |
|---|---|
| `W_SPRITE_BUDGET` | A scene is past three quarters of the sprite budget. |
| `W_OFFSCREEN_START` | An object starts partly outside the playfield. |
| `W_TUNNELLING` | A mover's per-tick step exceeds the thickness of what it collides with, so it can pass straight through. |
| `W_SUBTICK_SPEED` | A speed whose per-tick step floors to zero, leaving the object frozen. |
| `W_SIZE_ROUNDING` | The cell grid moved a relative size by more than a quarter. |
| `W_ASPECT_MISMATCH` | Width and height sized against different screen axes cannot stay square. |
| `W_TEXT_TOO_WIDE` | Text runs past the edge of a narrow playfield. |
| `W_START_MAPPING` | `start` is not a face button on this console. |
| `W_EMPTY_RULE` | A rule that triggers but assigns nothing. |
