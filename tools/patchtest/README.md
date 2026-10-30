# patchtest

Checks whether an Equicord plugin's patches still fit the Discord you have open right now, without rebuilding Equicord, reloading Discord or turning the plugin on.

For each patch it tells you:

- how many Discord modules contain the `find` (it has to be exactly 1)
- how many times the `match` hits inside that module
- whether the module still parses after the `replace`

## It's read-only

patchtest connects to Discord's debug port and asks for one thing: the source text of Discord's modules. Patching and checking happen on your side in Node. The patched code is only parsed (`new Function`) to see if it's still valid JavaScript. It never runs. Nothing in Discord changes: no settings, no messages, no patches applied, no reload.

## What you need

- **Node.js 22 or newer** ([nodejs.org](https://nodejs.org))
- **An Equicord source folder** with its packages installed (`pnpm install`). patchtest borrows Equicord's own patch code from it, so `\i`, `#{intl::…}` and `$self` work exactly like in the real thing. It finds the folder by itself when your plugin is in `Equicord/src/userplugins/<name>`. Otherwise pass `--equicord <folder>` or set `EQUICORD_DIR`.
- **Discord running with a debug port**, see below.

patchtest has no packages of its own, so there's nothing else to install.

## Start Discord with the debug port

Close Discord completely first (right-click the tray icon → Quit Discord), then start it with the port turned on.

Windows (Stable; use `DiscordPTB` or `DiscordCanary` in the path for those):

```bat
"%LOCALAPPDATA%\Discord\Update.exe" --processStart Discord.exe --process-start-args "--remote-debugging-port=9222"
```

macOS:

```sh
open -a Discord --args --remote-debugging-port=9222
```

Linux:

```sh
discord --remote-debugging-port=9222
```

patchtest finds the port on its own. It reads the port Discord saves in its data folder, then falls back to 9222. Pass `--port <n>` or set `CDP_PORT` for anything else.

Keep the port local and close Discord when you're done testing. Anything on your PC that can reach that port can control Discord.

## Run it

Windows, from a terminal (`run.bat` checks for Node first; double-clicking it shows the help):

```bat
run.bat C:\path\to\Equicord\src\userplugins\myPlugin
```

Any system:

```sh
node patchtest.mjs path/to/Equicord/src/userplugins/myPlugin
```

You can give it a plugin folder, its `index.ts(x)`, or a JSON file of patches.

| option | does |
|---|---|
| `--show` | prints the code around each match, before and after the replace |
| `--context <n>` | characters `--show` prints on each side (default 120) |
| `--verbose` | lists the module ids each find hit |
| `--equicord <dir>` | Equicord source folder, if it isn't found on its own |
| `--port <n>` | Discord's debug port |
| `--keys <NAME or hash> ...` | turns a Discord text-key name like `DEAFEN` into the hash Discord uses. Turning a hash back into a name needs a key map, see below |
| `--keymap <file>` | JSON of `{"hash": "NAME"}` for `--keys` (default: `key_map.json` next to the script) |

The exit code is 0 when everything passes and 1 when something fails, so it fits in scripts.

## Reading the table

```
#  find                             modules  rep  hits  result  note
-  -------------------------------  -------  ---  ----  ------  ----
1  "\"UserProfileModalV2Buttons\""  1        1    1     PASS
```

- `PASS`: the replace changed the code and the module still parses.
- `WARN`: it works, but have a look. Either the match hits more than once and only the first is replaced (no `g` flag), or a `noWarn` patch failed.
- `FAIL`: the find hits 0 modules or several, the match finds nothing, or the patched module doesn't parse any more.
- `SKIP`: an earlier replacement in a `group: true` patch failed, so Equicord would undo the whole group.

**"find hits no module" doesn't always mean the find is broken.** Discord loads a lot of its code only when you first open that part of the app (a full profile, settings, a modal). Open that screen once and run patchtest again before you trust a 0.

## Testing a regex without a plugin

Put patches in a JSON file. Write a regex as a `"/source/flags"` string. Any other string is matched as plain text. JSON needs every backslash doubled (`\\i`, `\\(`). See [`examples/sample.json`](examples/sample.json).

```json
{
  "name": "MyPlugin",
  "patches": [
    { "find": "\"UserProfileModalV2Buttons\"", "match": "/(className:\\i\\.profileButtons,children:)/", "replace": "$1" }
  ]
}
```

`name` is the plugin name `$self` points to (default `PatchTest`). Each patch can use `match`/`replace` directly, or a `replacement` object or array, plus `all`, `group` and `noWarn` like in a plugin.

## Limits

- To read `patches`, the plugin is bundled with everything from outside its folder swapped for dummies. Patches built at runtime from settings come back empty, and the tool says so.
- `predicate`s aren't run, so every patch gets tested. `fromBuild`/`toBuild` aren't checked. Both show up as tags in the note column.
- Replace *functions* run in Node on the module text. That's fine for normal string-building replacers.
- The parse check uses Node's JavaScript engine, which can be a little newer than Discord's.
