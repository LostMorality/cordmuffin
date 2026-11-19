# PlatformSpoofer+

Pick what platform other people see you on: Phone, Console, VR headset, Web or Desktop.

PlatformSpoofer+ is a revival of the original PlatformSpoofer that Equicord removed on 2026-11-03. It's rebuilt from scratch and fixes the problems people had with the old one. If you used the old plugin, your picked platform carries over by itself.

> **Use at your own risk.** Changing what platform you report is against Discord's rules. Nobody has reported a ban for it, but nobody can promise there won't be one.

## What's new compared to the old one

- **No more random logouts.** People said the old one logged them out at random. That happened because Discord sometimes refuses a spoofed connection with an "authentication failed" code, and Discord's app treats that code as "log out now". This plugin catches it: instead of logging you out, it reconnects you on your real platform and tells you. You can pick a platform again whenever you like. If your login really is dead, Discord still logs you out like normal.
- **Switches live.** Pick a platform and Discord reconnects for a second. You don't have to restart. Turning the plugin on needs one restart, because its hooks into Discord only load at startup.
- **Asks before dropping a call.** A platform change needs a fresh connection, and that ends your voice call and any stream. If you're in a call, the plugin asks first. Pick "Later" and your choice applies the next time Discord fully reconnects.
- **Spoofed from the very first connect.** Discord's desktop app opens its connection early ("fast connect") before plugins load. The plugin skips that early connection while a spoof is on, so you never flash up as desktop first. Picking Desktop on the desktop app changes nothing, so fast connect stays on then.
- **Simple list, one entry per icon people can see.** Phone, Console, VR headset, Web and Desktop. Android vs iPhone or Xbox vs PlayStation look the same to everyone else, so they're one entry each. VR is back. Phone uses the Android app's name and device fields, Console the Xbox app's, and Web uses a real browser name instead of the made-up "Discord Web". Details only the real app knows (like its build number) can't be copied, so they stay as your client sends them.
- **Quick button next to mute and deafen.** Click it to flip between your real platform and the last one you spoofed. Right-click it to pick any platform. Its icon shows what you look like right now (monitor, globe, phone, controller or headset). You can hide it in the settings. If Discord refuses a platform, the button goes back to your real icon and says so. Click it to try again.
- **Right-click yourself → "Show me as"** to switch in one click.
- **`/platform`** command. Run it empty to see what Discord shows you as right now, or pick a platform.
- **Check panel** in the plugin's settings: shows every session on your account and what Discord thinks each one is, so you can see the spoof worked. It says so when the plugin is off.
- **Toast after each switch** saying what Discord now shows you as, or warning you if it didn't take.
- **Turning the plugin off puts your real platform back** right away (it asks first if you're in a call), and its button, menu and `/platform` go away. Equicord still shows its restart notice when you turn it off; you can ignore it.

## What people see

| You pick | Shows to others as |
|---|---|
| Phone | Phone icon |
| VR headset | VR headset icon |
| Console | Console (shown by plugins like PlatformIndicators) |
| Web | Web |
| Desktop | Desktop |

The phone icon only shows while your status is Online. That's how Discord works, not the plugin.

## Good to know

- By default only the live connection is changed. Normal web requests still say what you really are.
- **"Spoof web requests too"** (off by default) makes those requests match the spoofed platform as well. Turning it on shows a warning, and nothing changes until you click "Turn it on". It's riskier: Discord picks some features and tests from those requests, so parts of Discord can change or break, and Discord sees more of the spoof. Turn it off if anything acts weird. The browser's own User-Agent header can't be changed, so that one always stays real.
- Discord turns some features on per platform, so things like Quests or Orbs may hide while you show as something else. Switch back to desktop if something you need disappears.
- Other devices you're logged in on still show up as themselves.

## What this plugin loads and calls out to

**Nothing.** No downloads, no outside servers. It only talks to Discord through Discord's own connection.
