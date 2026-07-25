<!-- Generated from packages/demotic/src/lang/spec.ts. Do not edit by hand;
     run `pnpm gen:demotic-docs` after changing the registry. -->

# Statements

Case-insensitive throughout. `--` begins a comment. **One statement per line, no nesting**, and declaration order does not matter.

## `loop`

Names the scene the game starts on. Exactly one per program.

```
loop <scene>
```

```
loop title
```

## `scene`

Declares a scene. Objects and rules belong to one.

```
scene <name>
```

```
scene play
```

## `create object`

Declares a class and its default properties.

```
create object <class> ( <properties> )
```

```
create object ball (width 1 cell, height 1 cell, speed 40vmin, sprite ball.svg)
```

## `create`

Creates one object, overriding its class defaults.

```
create <class> <name> [in <scene>] ( <properties> )
```

```
create ball ball1 in play (x centerx, y centery, direction southwest)
```

## `control`

Binds a button to property changes on one object.

```
control <object> <button> ( <assignments> ) on hold|press|release
```

```
control paddle1 left (xdirection -1) on hold
```

`on hold` restores the previous value when the button comes up, so releasing leaves the object stopped. Snapshots are per binding, which is what makes overlapping presses unwind in reverse order.

## `when`

Fires assignments when something happens, or while something holds.

```
when <trigger> [in <scene>] ( <assignments> )
```

```
when ball hits screenleft, screenright (xdirection) as flip
```
