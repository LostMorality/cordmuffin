# cordmuffin

Discord stuff in one place: an easy Equicord installer, and plugins I made, including a store for plugins Equicord doesn't ship.

> [!WARNING]
> Client mods like Equicord break [Discord's Terms of Service](https://discord.com/terms). Nobody is known to have been banned just for using one, but if losing your account would be a disaster, don't use mods.

> [!IMPORTANT]
> This is not an official Equicord project. Equicord doesn't help with custom plugins or self-built installs, so please don't ask in their support channels. Open an issue here instead.

## Downloads

Grab **Cordmuffin Equicord Installer.zip** from the [Releases](../../releases) page. It installs Equicord with any plugins and themes you drop in.

Windows might say "Windows protected your PC" because the installer isn't signed. Click **More info**, then **Run anyway**.

## Equicord Installer

1. Unzip **Cordmuffin Equicord Installer.zip** anywhere.
2. Drop plugins into **Plugins Go Here**. A plugin is a folder with an `index.ts` or `index.tsx` inside, or a single `.ts`/`.tsx` file. Zip files work too.
3. Drop themes (`.css` files) into **Themes Go Here**.
4. Run **Cordmuffin Equicord Installer.exe** and click **Yes**.

It downloads Equicord, adds your plugins, builds it, puts it into Discord, and turns your themes on. The first run takes a few minutes. After that it's faster.

- **Add or update plugins:** change the folders and run it again. Plugins you installed with Muffinshelf are kept too.
- **Update Equicord:** run it again and click **Yes**. It always grabs the newest Equicord.
- **Remove it:** run it, click **No**, then confirm. Discord goes back to normal, and if you had another Discord mod before, it puts that back.

It finds Discord, Discord PTB and Discord Canary on its own, and doesn't need admin rights. If something goes wrong partway, Discord is left as it was, and if Equicord's files ever go missing, Discord simply starts without it.

### What it downloads and changes

**It downloads from these places:**
- **nodejs.org**: Node.js, which is needed to build Equicord. It's kept in `%LOCALAPPDATA%\Cordmuffin` and isn't installed on your PC.
- **api.github.com and codeload.github.com**: the newest Equicord source code, from [Equicord/Equicord](https://github.com/Equicord/Equicord).
- **registry.npmjs.org**: pnpm and the packages Equicord needs to build (Equicord's own `pnpm-lock.yaml` decides which).

**It changes these on your PC:**
- **Discord's `resources` folder**: it renames `app.asar` to `_app.asar` and adds a small `app.asar` folder that loads Equicord. This is the same way Equicord's own installer does it.
- **`%LOCALAPPDATA%\Cordmuffin`**: Node.js, Equicord's source, pnpm's download cache, the built files and `install.log`. Removing Equicord deletes this folder.
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

It starts turned off. Turn on **GameTimeSpoof** in Discord (User Settings, then Plugins), then pick a game with the controller button.

Badges can take a day or two to update. For anything to count, **Use data to improve Discord** has to be on (User Settings, then Data & Privacy). Add Time works in chunks of up to 365 days and 100 games at a time.

The Streaming badge can't be done this way. Discord only counts stream time when someone is really watching.

**What it talks to:**
- **discord.com** (Discord's own API): the list of detectable games, game pages, and the play-time reports that badges are counted from.
- **cdn.discordapp.com**: game cover art and icons.

It talks to nothing else, and it doesn't use any loadstring or remote code.

**Heads up:** play-time reports are made-up analytics sent to Discord. That's against Discord's rules, so use it on an account you're fine risking.

**To install it:** copy the `custom-creations/gameTimeSpoof` folder into **Plugins Go Here**, then run the Equicord installer. If you build Equicord yourself, it goes in `src/userplugins` like any other user plugin.

### Muffinshelf (`muffinshelf`)

A plugin store inside Discord for plugins Equicord doesn't ship. Open it from the muffin button in Discord's top bar.

- **Equicord plugins** from community GitHub repos and venpm `plugins.json` indexes. Muffinshelf downloads the plugin's folder, rebuilds Equicord, turns the plugin on and asks you to restart Discord. If anything goes wrong, your plugins are put back the way they were and Discord keeps working.
- **BetterDiscord plugins** from the official BetterDiscord store. These run through Muffinshelf's own BetterDiscord layer, with no rebuild or restart. Plugins that need ZeresPluginLibrary, BDFDB or XenoLib get that library installed with them. They get the same Node.js modules BetterDiscord gives them, and can use files inside their own plugins folder.
- **Tested against the whole BetterDiscord store:** every store plugin was run in Muffinshelf, and 205 of the 207 tested work. The 2 that don't were made for an older Discord; they're hidden, with the reason shown. Some plugins (BetterAnimations, for example) are fixed up for today's Discord, and a few need one Discord restart after they're installed; Muffinshelf asks when that happens. A plugin that fails for you is hidden the same way, until a new version comes out.
- **shelter, Moonlight, Replugged and Evi** plugins are listed too, with links, so you can find them. They're built for other mods and can't run on Equicord.
- **Already in Equicord:** plugins Equicord already has (like InvisibleTyping, which is Equicord's SilentTyping) are marked and hidden by default.
- **Your own sources:** paste a GitHub repo link, a `plugins.json` link or a single `.plugin.js` link in the Sources tab.
- **How it works** tab explains all of this and shows every source and folder it uses.

It works with Equicord built by the Cordmuffin installer or from your own source folder. Equicord from the official installer can't be rebuilt, so there only BetterDiscord plugins work.

**What it talks to:**
- **api.betterdiscord.app** and **raw.githubusercontent.com**: the BetterDiscord store list and plugin files.
- **codeload.github.com** and **raw.githubusercontent.com**: GitHub repos and `plugins.json` indexes, including any you add yourself.
- **shindex.uwu.network**, **moonlight-mod.github.io** and **replugged.dev**: the shelter, Moonlight and Replugged plugin lists.
- Whatever an installed BetterDiscord plugin itself connects to. Those requests go out from Discord's main process.

**Heads up:** every plugin you install is someone else's code, and it runs inside your Discord with full access to your account. BetterDiscord plugins are downloaded and run as code at runtime. Only install plugins from people you trust, and use the Source button if you're unsure.

**Where files go:** Equicord plugins go in Equicord's `src/userplugins` folder, with a backup copy in `%APPDATA%\Equicord\muffinshelf\userplugins` so a Cordmuffin update can't lose them. BetterDiscord plugins and their settings go in `%APPDATA%\Equicord\muffinshelf\bd`.

**To install it:** copy the `custom-creations/muffinshelf` folder into **Plugins Go Here**, then run the Equicord installer. If you build Equicord yourself, it goes in `src/userplugins`.

### QuestRunner (`questRunner`)

Does your Discord quests for you. Press Accept on a quest and QuestRunner finishes it on its own. You only come back to claim the reward and solve the captcha Discord shows when you claim.

- **Video quests** play in the background in real time, reporting progress every few seconds like a real viewer. One video at a time by default.
- **Play quests** run a tiny, invisible stand-in program named after the game, so Discord's own game detection sees a process for it. Several can run at once. Each takes its real time, because Discord's servers time play quests.
- **Optional, off by default:** accept new quests automatically, finish activity and console-only quests by telling Discord directly (the Questify way, riskier), and activity achievement quests.
- The settings page shows what's running, what's waiting and why, and has a button to delete the stand-in files.

**How it compares to Questify:** Questify is mostly a better quest page (sorting, hiding, alerts). Its finisher just tells Discord a game is running when none is, and Discord has started suspending quest access for that. Keep Questify for its quest page if you like it, but turn its finisher off; QuestRunner offers a button for that. Quests you hid in Questify are skipped.

**Things to know:**
- While a stand-in runs, your friends see you "Playing" that game, and Discord may add it to your Registered Games.
- Game detection has to be on in Discord (User Settings, then Activity Privacy).
- Antivirus software sometimes blocks the stand-in, since it's a brand-new unsigned file. Allow it if that happens. Its source is in `questRunner/stub/stub.c`, and `stub/build.cmd` rebuilds it. Stand-ins close when Discord closes.
- Stand-ins only work on Windows.

**What it talks to:** only **discord.com** (Discord's own quest API). Activity achievement quests, if you turn them on, also talk to that activity's `discordsays.com` page.

**Where files go:** stand-ins are kept in `%APPDATA%\QuestRunner\games`, each under 300 KB.

**Heads up:** automating quests breaks Discord's Terms of Service. Discord can suspend quest access, or worse, on accounts it catches. Use it on an account you're fine risking.

**To install it:** copy the `custom-creations/questRunner` folder into **Plugins Go Here**, then run the Equicord installer. If you build Equicord yourself, it goes in `src/userplugins`.

### Dictation (`dictation`)

Talk instead of typing. Click the mic in the chat bar (or hold **Alt+D**), talk, and your words show up in the message box with commas, periods and capitals already in place.

- **Free and private.** Everything runs on your own computer. No account, no API key, and your voice never leaves your PC.
- **Picks the right setup for your computer.** On first use it downloads a speech engine and model that suit your PC: [Cohere Transcribe](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026), the most accurate free English model on Hugging Face's Open ASR leaderboard, on stronger PCs, or the lighter [Parakeet TDT 0.6B v2](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2) on older ones. You can choose either one yourself.
- **Fix Grammar (optional):** turns on a small AI model that cleans up grammar as well. It uses Qwen3 4B (or Qwen2.5 1.5B on PCs with under 8 GB of memory), and runs on your graphics card when it has room, or on the processor otherwise. Each fix takes well under a second on a graphics card and about a second on a modern processor.
- **Uses your Discord mic settings:** the same input device, input profile and input volume as your voice calls.
- **Right-click the mic** for Discord's own mic menu, plus Add Punctuation, Fix Grammar and Speech Model.
- **Hold-to-talk shortcut:** Alt+D by default. Change it in the plugin's settings. It works while Discord is focused.

Works on Windows, Linux and macOS.

**What it talks to:** only **github.com** and **huggingface.co**, once, to download the engines and models ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and [llama.cpp](https://github.com/ggml-org/llama.cpp)). After that it works offline.

**Where files go:** `%APPDATA%\Equicord\dictation` (about 1.7 GB, plus about 2.5 GB if you turn on Fix Grammar). While in use, the speech engine takes around 3.5 GB of memory, and it unloads itself after 15 minutes without use.

**To install it:** copy the `custom-creations/dictation` folder into **Plugins Go Here**, then run the Equicord installer. If you build Equicord yourself, it goes in `src/userplugins`.

## Building it yourself

You need [Go](https://go.dev).

```bash
cd equicord-installer
go build -trimpath -ldflags "-s -w" -o "Cordmuffin Equicord Installer.exe" .
```

To make the release zip, run `equicord-installer/build-release.ps1` in PowerShell. It only packs the installer and the empty **Plugins Go Here** and **Themes Go Here** folders, and stops if anything else would end up in the zip.

## License

GPL-3.0. See [LICENSE](LICENSE).
