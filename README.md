# cordmuffin

Discord stuff in one place: an easy Equicord installer, and plugins I made.

> [!WARNING]
> Client mods like Equicord break [Discord's Terms of Service](https://discord.com/terms). Nobody is known to have been banned just for using one, but if losing your account would be a disaster, don't use mods.

> [!IMPORTANT]
> This is not an official Equicord project. Equicord doesn't help with custom plugins or self-built installs, so please don't ask in their support channels. Open an issue here instead.

## Downloads

Grab **Cordmuffin Equicord Installer.zip** from the [Releases](../../releases) page. It installs Equicord with any plugins and themes you drop in.

Windows might say "Windows protected your PC" because the installer isn't signed. Click **More info**, then **Run anyway**.

## Equicord Installer

1. Unzip **Cordmuffin Equicord Installer.zip** anywhere.
2. Drop plugins into **Plugins Go Here**. Each plugin is a folder with an `index.ts` or `index.tsx` inside. Zip files work too.
3. Drop themes (`.css` files) into **Themes Go Here**.
4. Run **Cordmuffin Equicord Installer.exe** and click **Yes**.

It downloads Equicord, adds your plugins, builds it, puts it into Discord, and turns your themes on. The first run takes a few minutes. After that it's faster.

- **Add or update plugins:** change the folders and run it again.
- **Update Equicord:** run it again. It always grabs the newest Equicord.
- **Remove it:** run it and click **No**. If you had another Discord mod before, it puts that back.

It finds Discord, Discord PTB and Discord Canary on its own, and doesn't need admin rights.

### What it downloads and changes

**It downloads from these places:**
- **nodejs.org**: Node.js, which is needed to build Equicord. It's kept in `%LOCALAPPDATA%\Cordmuffin` and isn't installed on your PC.
- **api.github.com and codeload.github.com**: the newest Equicord source code, from [Equicord/Equicord](https://github.com/Equicord/Equicord).
- **registry.npmjs.org**: pnpm and the packages Equicord needs to build (Equicord's own `pnpm-lock.yaml` decides which).

**It changes these on your PC:**
- **Discord's `resources` folder**: it renames `app.asar` to `_app.asar` and adds a small `app.asar` folder that loads Equicord. This is the same way Equicord's own installer does it.
- **`%LOCALAPPDATA%\Cordmuffin`**: Node.js, Equicord's source, the built files and `install.log`.
- **`%APPDATA%\Equicord\themes`** and the `enabledThemes` list in `%APPDATA%\Equicord\settings\settings.json`, only if you added themes.

Nothing is uploaded anywhere.

## Custom Creations

### Game Browser (`gameTimeSpoof`)

Makes Discord think you're playing any game Discord can detect, so your Game Time and Game Variety profile badges keep counting.

![The Game Browser](docs/game-browser.png)

- **Game Browser:** the controller button in Discord's top bar. It lists all of Discord's detectable games with cover art, search, genre filter, favorites and a Detected tab.
- **Click a cover** to open that game's real Discord page.
- **Spoof** switches to that game right away. The game you're spoofing always stays at the top.
- **Rotation:** cycles through your favorites or random games on a timer.
- **Add Time** and **Add Random Games:** add play time to one game, all your favorites, or a set number of random games.
- **Real games count too.** If you use NoTrack, the games you actually play also get reported.

Badges can take a day or two to update. For anything to count, **Use data to improve Discord** has to be on (User Settings, then Data & Privacy).

The Streaming badge can't be done this way. Discord only counts stream time when someone is really watching.

**What it talks to:**
- **discord.com** (Discord's own API): the list of detectable games, game pages, and the play-time reports that badges are counted from.
- **cdn.discordapp.com**: game cover art and icons.

It talks to nothing else, and it doesn't use any loadstring or remote code.

**Heads up:** play-time reports are made-up analytics sent to Discord. That's against Discord's rules, so use it on an account you're fine risking.

**To install it:** copy the `custom-creations/gameTimeSpoof` folder into **Plugins Go Here**, then run the Equicord installer. If you build Equicord yourself, it goes in `src/userplugins` like any other user plugin.

## Building it yourself

You need [Go](https://go.dev).

```bash
cd equicord-installer
go build -trimpath -ldflags "-s -w" -o "Cordmuffin Equicord Installer.exe" .
```

## License

GPL-3.0. See [LICENSE](LICENSE).
