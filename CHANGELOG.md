# Changelog

Newest changes come first, grouped under each date by plugin. The Cordmuffin Updater page in Discord shows the lines that are new for you. Lines under a plugin's heading only show for people who have that plugin.

## 2026-11-21

### New plugins
- Autocorrect brings phone-style autocorrect to the chat box: suggestions above the word you type, typos fixed when you press space, and Backspace to undo a fix.

## 2026-11-18

### New plugins
- NoQuestsOnStartup stops Discord's quest campaign from opening the Quests page every time Discord starts.

### BadgeTierViewer
- Works again after Discord's November badge window update, which had switched off clicking a tier, the lock, the eye button and the "Needs ..." line.
- Picking a tier also works on a badge that just levelled up.
- The lock circle is see-through again.
- Badges you don't own look like Discord's own until you click a tier, instead of showing the tier name, rarity and a lock straight away.
- Picking a tier no longer scrolls the big preview flush against the top.
- A long locked-tier status no longer leaves a stray • at the start of the wrapped line.

### CordmuffinUpdater
- Clicking the "updated" notification now asks before restarting Discord.
- A failed automatic update tries again an hour later.
- A half-finished update is rebuilt on the next check, even with Equicord updates off.
- Shorter labels on the settings page, and notifications show real plugin names.

### CustomRPCShare
- Presets without an application name are skipped instead of blanking your presence when loaded.
- Export and import notices now tell privacy removals apart from fields that failed CustomRPC's checks.
- Export and import no longer list the left-out fields of a preset that was skipped entirely.
- **Replace Same Names** is now a solid red button, so it looks different from **Keep Both** and can't be mistaken for Cancel.
- Code boxes use Discord's own styling, and long preset names fit on one chip line.
- Hidden text-direction characters are stripped from preset names.
- **Copy Code** uses the plugin's toast fallback and reports copy errors.
- Oversized files are rejected before they are read.

### Dictation
- The right-click menu checkboxes now update when clicked.
- A stuck speech engine no longer leaves the mic stuck on working.
- A speech engine that stops taking connections shows a plain message and is restarted on the next try.
- Switching speech model mid-dictation no longer drops text.
- Switching the speech model back and forth while it's still starting no longer fails; the last pick wins.
- The live text respects **Add Punctuation** and moves with the chat box.
- The shortcut needs Ctrl, Alt or Meta (Shift can be added on top) or an F key, and its button stays short.
- Grammar fixing keeps number ranges like 5–10 and fixes short sentences better.
- Downloads check free disk space first.
- Notices are shorter, so they no longer cover the chat bar.
- The Speech Model description is the same grey as the others.

### Discrub Loader
- With the plugin off, Open Discrub and the settings and status buttons turn grey with a not-allowed cursor. Before, Open Discrub kept asking to reload and Check now could load Discrub.
- **Ask each time** really asks every time; Discrub's start screen no longer counts down into your last pick.
- **Stay on this version** no longer checks the Chrome Web Store in the background.
- **Not now** on an update is remembered, so that version isn't offered again on every start (Check now still offers it).
- Installing or updating to a version you'd skipped with **Not now** clears that skip.
- The reason for an automatic roll-back stays in settings instead of vanishing after the next update check, and it's only shown once.
- Shorter setting names, and settings text is sized like the rest of the page.
- Turning the plugin off puts the Inbox button area back the way it was.

### Game Browser
- **Stop** on a game now also turns rotation off. Before, rotation brought the game back at its next switch.
- Random rotation picks from every detectable game, like Add Random Games, and starts right away when no game is set.
- Picking favorites rotation with no favorites now says so.
- If Discord's game list won't load, you get one notice instead of one every minute.
- The Game Browser no longer jumps around while you search.
- The Add Time switch is now called **Only unplayed games**.
- Clicking a game cover shows an error if Discord's game page fails to load, where before nothing happened.
- A slow first load of the game page shows "Loading the game page…".

### GreetStickerPicker+
- Right-click opens the sticker picker straight away after Discord starts, not only after you've opened the sticker tab in the chat bar.
- The message menu no longer pops up on top of the picker.
- Only the wave button reacts now, so clicking the empty space beside it no longer sends your default sticker.
- Sticker lists follow Discord's own rules, so Nitro Basic shows other servers' stickers.
- Channels that block outside stickers no longer list ones that would fail.
- A default sticker that can't be sent here shows a message instead.
- Lottie welcome stickers (Wumpus, Nelly, Clyde, Doggo, Peach) get thumbnails.
- Greet mode now also applies to a welcome default sticker.
- The picker window no longer gets a second scrollbar.
- Search tells you when it hides results.
- The picker no longer reopens with your last sticker search.
- Rate limits show a message.

### HideClientBadges
- **Hide Nitro Boost** now also works in the badge window you get when you click someone's badge.
- The badge window hides Nitro and boost badges whatever form Discord sends their id in.
- **Hide All** also hides plugin badges that have no picture of their own.
- Turning **Block Donor Lists** on while Equicord is downloading the lists no longer lets them back in for 30 minutes.
- **Block Donor Lists** also catches the list addresses with extra bits on the end.
- The profile patch holds up better against Discord updates.

### Muffinshelf
- BetterDiscord store cards show their pictures again; Discord was blocking them. Images that still can't load are hidden instead of leaving an empty box.
- BetterDiscord plugins that use BdApi's Text component no longer crash.
- Plugin settings windows with sized modals open at the size the plugin asked for.
- A BD plugin's slash command whose name is already taken no longer stops the plugin and hides it as broken; the command gets the plugin's name in front instead.
- BD slash commands named after Discord's own (shrug, me, tts, spoiler...) get the plugin's name in front instead of showing twice.
- BD command results only ever show as a local bot message, never as a message sent from your account.
- When Equicord turns a command down for another reason, the real reason is logged.
- Turning off a BD plugin, turning off **Run BD plugins** or pressing **Reload all** removes everything the plugin changed and puts Discord's own modules back.
- That cleanup includes old-style monkeyPatch patches and injectCSS styles.
- The list of turned-on BD plugins keeps the plugin folder's order, so turning one off and on no longer moves it.
- A BD plugin only gets ZeresPluginLibrary, BDFDB or XenoLib when its code really uses one; a changelog that just mentions it no longer pulls it in.
- A library that's turned off or removed is hidden from other plugins until it's back on.
- Removing a library names the plugins that use it, and installing a plugin turns its library back on if needed.
- Equicord plugins from a GitHub repo only offer an update when their own folder changed, not after any commit to the repo. Plugins installed before this may offer one update first.
- The parts of Discord that BD plugins ask for are remembered in a way that survives Discord updates better.
- Old remembered entries Discord dropped are cleared after two weeks.
- Rebuilds back up only the Equicord build Discord loads, not the whole dist folder, so they start sooner.
- The BD switches, Remove and Reload all are locked while an install or rebuild runs.
- Switches in the Installed and Sources tabs line up with their buttons.
- Shorter labels fit their boxes (**Run BD plugins**, **Won't work here**), and the "Won't work" note has proper punctuation.
- Errors that used to vanish silently (a plugin's settings panel failing to open, folders that can't be read) now show a message.
- BDFDB settings windows (the library's own and those of BDFDB plugins like SpellCheck) get their left padding back, since Discord removed the window styles BDFDB looks for.
- BDFDB window buttons no longer wrap and widen to fit their label.
- BDFDB text and number boxes look like Discord's, with number arrows inside their box.
- BDFDB rows show their full label on the left with the switch on the right, with a small gap between rows.
- Notes under a BDFDB label are smaller, muted and no longer cut off.

### OfficialCustomTypingIndicator
- **Show Others** off now really gives plain dots everywhere, also where Discord draws styles itself.
- Turning **Show Others** on or off updates a typing bar that's already showing right away.
- The word ("is yapping…") now shows in your Discord language.
- The editor's word buttons use Discord's own translated text.
- In the typing bar inside the channel, the emoji now line up with the message avatars like Discord's own.

### PlatformSpoofer+
- Asks before switching platform while you're in a call, since the reconnect drops the call and any stream.
- Picking Desktop on the desktop app no longer reconnects or skips fast connect, and counts as your real platform.
- Turning the plugin off only reconnects when you were spoofed.
- /platform now goes away when you turn the plugin off.
- The warning's Turn it on button is red again.
- The check panel says when the plugin is off instead of showing a red mismatch.
- The quick button's icon follows the platform Discord really shows.
- **Reconnect now** only shows when it would change something.
- Console no longer sends the desktop app's browser details.

### PluginPresets
- The export and import code boxes keep Discord's dark textarea look again.
- Rows and chips use the current theme colours.
- The BetterDiscord list is ignored while Muffinshelf is off (no longer saved, exported or rewritten, and no pointless restart).
- Renaming to a name another preset already uses is blocked.
- Applying a preset skips any setting the plugin's own settings page would refuse (out of range, no longer a choice, fails the plugin's check) and lists these in Preview.
- Number IDs (BIGINT settings) are restored as numbers.
- Big .json files are no longer cut short in the import box.
- A damaged or cut-off code gets its own error.
- The import labels now say "has on" and "never turned on".

### ProfileImages
- The square View Avatar and View Banner buttons next to Message on the full profile are back after Discord's update.
- If those buttons ever break again, the full profile keeps its Avatar button on the banner instead of losing it.
- The Icon and Banner buttons on server banners can be clicked again; the channel list used to sit on top of them.
- The server banner buttons now hide while the channel list is scrolled.
- The copied banner colour matches the profile you are looking at (server or main), not the grey shown while a banner loads.
- An equipped profile effect (smoke, crows and so on) no longer draws over the Avatar and Banner pills.
- The colour pill shows the hex in lower case, the same as the tooltip and what gets copied.

### QuestRunner
- **Accept and finish** no longer hangs on "Accepting..." when Discord refuses the quest (for example, a closed captcha). You get a warning, and pressing again really tries again.
- Skipping the video player only says the video is being watched once Discord has accepted the quest. If it doesn't, you're told to press Accept again.
- When Discord cancels the accept on a video quest whose player was skipped, the "Discord didn't accept" warning shows right away instead of after 2 minutes.
- Complete on a play quest with no game to run no longer switches to direct heartbeats behind your back while that setting is off.
- Direct-heartbeat quests stop and try again later when Discord keeps refusing the heartbeats, instead of beating until the quest expires.
- **Clear Recent activity** now also covers quests done with direct heartbeats.
- **Clear Recent activity** never touches a game you were already playing, and handles two quests for the same game.
- Questify's finisher only counts as on while Questify isn't paused or fully disabled.
- Tidier settings page, with kept games on one line with their button and space between explanation paragraphs.

### Ransom
- The "paid" sound downloads again (the DOORS wiki moved the file).
- The DOORS files and your EasterEgg files are read from your own Discord's folder again (PTB and Canary were using the stable one).
- **Reset scores** asks first and no longer takes your gold.
- **Forget all finds** asks first too.
- The Scores tab updates while it's open.
- While Discord is encrypted or broken only the message box is locked, and settings and windows stay readable.
- Discord stays much lighter on your PC while it's broken or wrecked.
- The scrambled text only looks at parts of the page that changed.
- The falling-apart effect re-measures the screen every few seconds instead of every tick.
- **Calm Effects** also slows the static on the caught and time's-up screens.
- Hidden items no longer get scrambled.
- Items are never hidden in forums or other chats without messages, and **Hide an item here** says so.
- **Drop some gold** says why when it can't drop one.
- Gold you drop by hand stays when Loose Gold is off.
- Turning Hidden items or Loose Gold off now clears them right away.
- Changing how often challenges happen takes effect at once, within the range you picked.
- Ransom's face and loose gold no longer draw over Discord's windows.

### ShrinkUploads
- Turning it off now stops it right away.
- Animated pictures and code .ts files are left alone.
- Cover-art videos shrink properly.
- A full message no longer loses a shrunk file (press **Add**).
- Files keep their place in the list, and shrunk files go back to their own spot in the message.
- Shrunk files stay in their spot even when several shrink at once, one fails or the plugin is turned off mid-shrink.
- The progress panel sits above the message box and no longer covers StreamTimeFarmer's boxes.
- The progress panel stops at the top of the chat instead of growing over the channel header.
- The Shrink button is gone on tiny files.
- The Shrink window no longer says "1024 MB is left" in an almost empty message.
- The Shrink window shows your real per-file limit when only small files are there.
- Your own ffmpeg only counts if the file is named exactly ffmpeg (ffmpeg.exe on Windows), checked before anything runs.
- Shorter setting names, and the ffmpeg path no longer shows your user folder.

### StreamTimeFarmer
- The Add Streaming Time progress box no longer jumps around when you open a DM or a side panel. It stays top-right, you can drag it anywhere by its title, and it remembers the spot and size.
- Equicord loads again on a fresh install. The plugin read Equicord's plugin list before it existed, which stopped all of Equicord from starting for anyone whose NoTrack blocks analytics (the default).
- The farm window now starts from a script file instead of a command line that antivirus programs flag.
- The farm window's game cover loads in the background, so a slow download can no longer freeze its clock.
- Where the farm window can't run, a DM call streams your screen and a server channel streams nothing; it no longer picks a random open window.
- Pop-up messages that can't show as a toast now come up as a notification instead of disappearing.
- Turning **Quiet Second Account** off now works right away and brings the second account's desktop notifications back.
- The Add Streaming Time box sits at the bottom of the member list or DM profile, so it no longer covers messages or the profile banner.
- The Add Streaming Time box no longer covers the channel header's buttons.
- With no side column, the Add Streaming Time box starts small, below Discord's unread bar.
- The Add Streaming Time box stays above Discord's picture-in-picture stream preview.
- The call widget moves out from under Discord's stream preview.
- Disabling the plugin no longer removes other plugins' sound hooks.

### TranslateItAll
- Translate now works on forwarded messages, component (v2) bot messages and search results.
- No more crash on forwarded messages without a copy of the original.
- Translate shows "Translating..." and ignores double clicks.
- Errors no longer say "translated from English".
- Long Chinese, Japanese, Korean or Cyrillic messages no longer fail on Google.
- Long messages translated with Google keep the space where they were split.
- Yandex falls back to Google for languages it lacks (Traditional Chinese stayed Simplified before).
- Yandex errors only suggest restarting Discord when Yandex couldn't be reached at all.
- The Toki Pona, Sitelen Pona and Shavian switches no longer ask for a restart.
- Short Toki Pona is caught better.
- Shavian keeps line breaks, and its dictionary is downloaded once per session.
- Translations hide after the message is edited, and Dismiss clears every copy.

## 2026-11-17

### CordmuffinUpdater
- Lines here about BadgeTierViewer, CustomRPCShare, GreetStickerPicker+, OfficialCustomTypingIndicator, PlatformSpoofer+ and ShrinkUploads now only show for people who have that plugin.
- Lines that announce a new plugin still show for everyone.
- The list of places it connects to now includes release-assets.githubusercontent.com, where GitHub sends installer downloads.

### Dictation
- Two downloads can no longer cross. Asking for the grammar model while a speech model downloads now waits its turn and really downloads it, instead of saying "done" with nothing downloaded.
- A download you confirm after you've started dictating, or after another download started, is skipped.

### Game Browser
- Spoofed games are counted once, whatever NoTrack is set to. Discord's own game heartbeat also counted them while its reports got through, so spoofed time could count twice.
- Turning GameTimeSpoof on or off now needs a restart.
- **Report real games** now only sends anything when NoTrack really blocks Discord's game reports, meaning **Disable Analytics** on and **Allow Badge Tracking** off.
- With NoTrack's defaults Discord counts real games itself, so they're no longer counted twice. A change to either NoTrack switch counts after a restart, same as NoTrack.

### OfficialCustomTypingIndicator
- Fixed for Discord's latest update. Discord desktop now draws custom typing styles itself for some people, and there the plugin steps aside so the emoji and word never show twice.
- Where Discord still shows the plain dots and "is typing", the plugin draws other people's styles as before.

### QuestRunner
- New **Clear Recent activity** setting, off by default. When a play quest finishes, the game comes off Recent activity on your profile.
- **Clear Recent activity** only takes the session the quest made. If Discord's entry started before the quest, it stays, since Discord deletes a whole entry or nothing and that one holds real playtime.
- New list of games to keep on your profile, under that setting. Games on the list are never touched.
- **Add Board games** fills the keep list in one press with every game already on your Board, and each game on your Recent activity has a Keep button.
- Quests with a **Launch Quest** button no longer make you open the activity to accept them. The card now offers **Accept and finish** straight away.
- Before, our Complete button only appeared once a quest was accepted, and Discord's Launch Quest was the only way to accept those quests, which opened the activity for nothing.
- Quest Home tiles show the QuestRunner button again after Discord's latest update.
- You now get a warning when Discord rate-limits quest progress, also for quests run with direct heartbeats. Before, it never showed.
- While Discord has quest accepting on hold, it waits for the hold to end instead of checking again every second.

### StreamTimeFarmer
- Works with NoTrack's **Allow Badge Tracking** (on by default), which lets stream reports through while the rest of Discord's tracking stays blocked.
- The badge warning no longer goes red for NoTrack's defaults.
- **Fix these for me** now turns on **Allow Badge Tracking** instead of turning off NoTrack's whole analytics block.
- The stream report watch no longer pushes other plugins' network hooks aside when it starts, or wipes them out when it stops (HideClientBadges, or the farm's own Add Streaming Time).

### TranslateItAll
- A translated forward shows its translation once, inside the forward box.

## 2026-11-13

### New plugins
- Added **CustomRPCShare**, which lets you share your CustomRPC Rich Presence presets as a code or a .json file.

### CustomRPCShare
- Adds **Export Presets** and **Import Presets** to CustomRPC's settings.
- Exports leave out anything about your account.
- Imports are checked field by field.
- A preset with a name you already have is only overwritten if you say so.

### QuestRunner
- Fixed play quests for some games never moving off zero, because the stand-in was running under a name Discord was never going to count.
- Discord ignores certain program names outright (launcher.exe, start_protected_game.exe and 23 more) and skips anything its game list marks as a launcher.
- Fortnite, VRChat, Dead by Daylight, Space Marine II and four other games now pick a name Discord does count.
- A game with no usable name now says so instead of sitting at zero for two minutes.
- Direct heartbeats no longer send a closing report when a quest finishes, matching Discord's own client, which only sends one when you stop early.

### StreamTimeFarmer
- New **Add Streaming Time** lets you type how many hours you want, and it adds up to 12 hours of Streaming badge time every hour while the farm streams, instead of one hour per hour.
- Find **Add Streaming Time** in StreamTimeFarmer's settings or Equicord's toolbox.
- It sends made-up stream reports, which Discord bans for, so only use it on an account you're fine risking.

## 2026-11-12

### New plugins

- OfficialCustomTypingIndicator lets you set Discord's own Nitro custom typing indicator from desktop: 3 emoji, an animation and a word like "is yapping…".

### OfficialCustomTypingIndicator

- People on Discord's phone app see your indicator without any plugin.
- Draws other people's custom typing indicators on desktop too.

## 2026-11-11

### Game Browser
- **Add Random Games** now picks from every game Discord can detect, including games without a cover picture (the list already shows those with their icon instead).

### StreamTimeFarmer
- Both accounts now stay muted and deafened in the farm's call, so joining a real call on top of it can't feed sound back.
- Discord clears mute and deafen whenever a stream starts, so the farm now sets them again instead of assuming they stuck.
- The viewer-only **deafen** setting now covers both accounts and keeps your saved answer.
- The "your badge may not count" warning now goes away once Discord has actually accepted a report, instead of going by NoTrack's switch alone.
- Discord's own two privacy settings still trigger the warning, since Discord can ignore a report even after accepting it.

## 2026-11-10

### StreamTimeFarmer
- A second account that isn't your friend yet no longer leaves the farm stuck in setup. It opens the DM itself, or tells you to add it as a friend.
- Waits for the call to connect before going live.
- Rejoins faster when the second account is still in the call.
- Waits longer between tries when Discord keeps refusing the stream.
- Waits now show the real time ("in 4m") instead of "soon".
- A picked window that's minimized is no longer restarted over and over, and the status tells you to open it.
- After falling back to your screen, the farm tries its own window again each time it reports the time.
- The second account's window reloads itself when its page fails to load.
- A failed download is retried within a couple of minutes.
- The second account's window no longer takes your keyboard when it needs a login.
- The **Try again** button on the download card no longer gets stuck.
- The minimized widget shows a yellow "may not count" for settings that only might block the badge.
- The widget remembers being minimized.
- Several messages are shorter and plainer.

## 2026-11-09

### New plugins
- BadgeTierViewer is new. In the badge window, click any tier of a badge to see it in the big preview.

### BadgeTierViewer
- Tiers you haven't unlocked show locked, and an eye button next to the preview shows how they look once unlocked.
- Locked tiers say what they take and how far off you are ("Needs 300 hours (141 to go)").
- Nitro and Server Boosting tiers show a rough unlock date.
- Locked tiers show their rarity, and their art no longer animates until you reveal it.
- A short line under the progress box says the tiers can be clicked.
- The eye button dims on tiers you already have, and its tooltip is shorter.
- If a Discord update breaks part of the plugin, it now switches off cleanly instead of half working.

### Dictation
- Pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what the plugin was doing.

### Discrub Loader
- Pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what the plugin was doing.

### GreetStickerPicker+
- Pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what the plugin was doing.

### Muffinshelf
- Pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what the plugin was doing.

### PlatformSpoofer+
- Pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what the plugin was doing.

### PluginPresets
- Pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what the plugin was doing.

### ProfileImages
- Pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what the plugin was doing.

### QuestRunner
- Pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what the plugin was doing.

### Ransom
- Pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what the plugin was doing.

### StreamTimeFarmer
- When Discord drops you from the farm's call (alone too long, or moved to the AFK channel), the farm joins again by itself and tells you.
- After an auto rejoin, a notice lets you click if you really meant to hang up.
- If no time has counted for a while, the status says for how long, and after 15 minutes a notice pops up.
- The status now says plainly when you're offline or what's wrong with the second account, instead of "waiting for them to watch".
- New **Turn it on** button for DisableCallIdle, which stops Discord ending the call. The second account gets it turned on by itself.
- A broken second account rebuilds itself about every 15 minutes.
- A failed Equicord download is retried a few minutes later instead of every few seconds.
- If the farm's own window can't open, a DM call shows your screen instead so time keeps counting.
- Sign out asks first before signing you out.
- The farm's panel comes first in its settings.
- The AFK screen is easier to read and has a **Leave AFK** button.
- Pop-up messages no longer break after Discord's November update.

### General
- GameTimeSpoof's pop-up messages work again after Discord's November update, and a failed pop-up can no longer stop what it was doing.

## 2026-11-08

### New plugins

- **ShrinkUploads** shrinks files over your upload limit on your own computer so they just fit, instead of Discord's "file too big" error.

### ShrinkUploads

- Works for videos, pictures, GIFs and audio, even multi-GB recordings.
- Reads your real upload limit from Discord, covering Nitro, Basic, free and server boosts.
- A **Shrink** button on any waiting file lets you pick your own size.
- Phone HDR videos keep normal colours and screenshots stay sharp.
- If you already have ffmpeg (scoop, winget, Chocolatey or anywhere on PATH) it's used instead of downloading one, or you can pick your own.

## 2026-11-07

### New plugins
- PlatformSpoofer+ lets you pick what platform people see you on (Phone, Console, VR headset, Web or Desktop) from a button next to mute and deafen, and switch live.
- PlatformSpoofer+ brings back Equicord's removed PlatformSpoofer and keeps you logged in when Discord refuses a spoof.
- Settings from the old PlatformSpoofer carry over to PlatformSpoofer+.

### StreamTimeFarmer
- The second account no longer shows "watching" while its picture is actually stuck.
- Discord reuses the same error 2012 for the whole session, so the farm only noticed it the first time; now it notices it every time.
- If the second account keeps getting the stream but can't show a single frame, the farm reopens it.
- If that's because Discord lost your graphics card (it happens after a GPU driver update, until Discord restarts), the status says so.
- In that case the status tells you to fully quit Discord from the tray and open it again.
- Time stops counting until Discord restarts, instead of being counted for a stream nobody could see.
- A call whose voice connection died while Discord still showed it as joined no longer leaves the farm failing to go live over and over.
- After 30 seconds without a working connection, both accounts leave the call and join it again by themselves, waiting longer each time if that doesn't help.

## 2026-11-04

### QuestRunner
- The **Completing** button is back on play quests in Quest Home, and it works next to Questify too.
- Before this, Discord's new quest tiles only showed the game's "Play Now" link once you accepted a play quest, so it looked like nothing was happening even while the quest ran.
- Starting a video quest no longer opens Discord's video player again. A Discord update had broken the skip, so the player opened even with **Don't open Discord's video player** on.

### StreamTimeFarmer
- Sends Discord the streaming time every hour now instead of only when the call ends. Change how often with the **Report Every** setting.
- Discord only counts a stream's time when the stream ends, so a stream that ran for days counted nothing until hang-up, and a crash lost all of it.
- The farm now ends and restarts its Go Live every hour (the call and your second account stay), so a crash only loses the time since the last restart.
- Quitting or reloading Discord now sends the stream's time so far instead of losing it.
- Putting the PC to sleep no longer counts as hanging up, so the farm carries on after it wakes.
- Warns you when your Streaming badge can't count because something blocks the report Discord counts streaming time from.
- Equicord's NoTrack plugin blocks that report (its **Block Discord's tracking analytics** switch is on by default), and so does Discord's **Use data to improve Discord** setting when it's off.
- Discord's own article also asks for **Use data to personalize my Discord experience**, so that is checked too.
- The settings and the corner call widget check all of these for your account and your second account, shown in green and red.
- **Fix these for me** changes them after a confirm box that lists every change.
- The missing-report warning no longer blames an ad blocker outright. It says no report was seen and names a failed Go Live as the likelier cause.
- The widget and settings now show when Discord last accepted a stream report, when the next one goes out, and Discord's own count for the badge.
- Warns when a report never arrived or another plugin may be blocking it.
- A Go Live that Discord lists but never actually sends (its error 2012) is now restarted instead of leaving the farm on "reconnecting" all night.
- A failed stream is no longer started again before its own wait is over.
- After a few failures in a row, the status says Discord keeps refusing the stream instead of looking like a hiccup.
- The second account no longer needs anything built or copied. Its window downloads Equicord's own released build straight from Equicord the first time it opens.
- That build is kept for six hours and fetched again after that, so it's always a current Equicord and the plugin doesn't need to be in it.
- The viewer half of the farm is now sent into the second account's window by the plugin.
- If the download ever fails, the card says so and offers a **Try again** button.
- New **Quiet Second Account** setting, on by default. The second account's window no longer adds to your taskbar badge or raises desktop notifications of its own.
- That window shares one program with your Discord, so its unread count used to add to your taskbar badge (a call it was invited to every hour, never read, and the badge just climbed). The account still receives everything; open its window to read it.
- New **Keep Computer Awake** setting, off by default. While the farm runs or AFK mode is on, your computer won't go to sleep by itself, even when no call is live.
- **Keep Computer Awake** needs one full Discord restart after updating.
- New **Mute Call Sounds** setting, on by default. While the farm runs, Discord's call, ring, Go Live, join, leave, mute and deafen sounds stay silent on your PC; message sounds stay on.
- "Farmed" is now "Streamed", and the plugin's own total says it isn't Discord's count.
- The confirm box says what Discord can see once tracking is allowed, and settings whose effect on the badge isn't proven say so.
- No longer claims the badge updates once a day.
- Keeps the last 200 stream reports on your PC.
- Says when an account has no Streaming badge yet.
- Asks before resetting the total.
- Suggests DisableCallIdle when it's off.

## 2026-11-03

### CordmuffinUpdater
- When Windows or an antivirus blocks the updater from starting, it now says so and names the file to allow, instead of "The updater stopped without saying why (code -1)".

### StreamTimeFarmer
- Streams its own small window now instead of a random open one, so nothing private can end up in the stream.
- The farm window sits in a screen corner behind everything, see-through and click-through, with no taskbar button.
- The farm window shows only its name (or the game's cover), a ticking clock and a moving bar, so the picture never freezes.
- The farm window can't break by being minimized or closed.
- Everyone who was on "a random open window" moves to the farm window; a window you picked yourself stays.
- New **Show it as a game** option lets you pick a game, and the stream then shows as "Streaming <game>", with the farm window showing its cover art.
- **Show it as a game** steps aside while gameSessionSpoofer shows a game.
- A broken stream now fixes itself. When it fails (like "Stream failed, error 2012"), gets stuck paused, or stops getting a picture through, the second account reopens it and your account restarts Go Live.
- Time doesn't count while the stream is broken.
- **Log in to second account** works with the plugin off too, and turns it on.
- When **Log in to second account** can't work yet, the settings say why: Discord needs a full quit and reopen after the update, or the installer needs to run again.
- **Log in to second account** now asks first, with a warning that it turns the plugin on and runs a hidden second Discord with your other account.
- New setting for your second account's online status (Online, Idle, Do Not Disturb or Invisible).
- The dot on the second account's picture now shows its real online status, with the name next to it, instead of always looking online.

### Installer
- When it closes Discord to install or remove Equicord, it now closes only Discord itself.
- It no longer force-closes Discord System Helper (Discord's keybinds helper), which could leave the helper stuck and make Discord's own "Uninstall" button for it fail with an "Overlapped I/O" error.

## 2026-11-02

### New plugins
- StreamTimeFarmer, for the Streaming badge: a second account of yours calls in, watches your stream and builds up your streaming time.
- GreetStickerPicker+, a bigger GreetStickerPicker.

### CordmuffinUpdater
- Its page works on the newest Equicord again. Equicord removed some heading parts it used, which made the page show an error. Older Equicord versions keep working too.

### GreetStickerPicker+
- Works on DM wave buttons too.
- Right-click opens Discord's real sticker picker; left-click sends your default sticker.
- Any server sticker can be a greet.

### Muffinshelf
- Its page works on the newest Equicord again. Equicord removed some heading parts it used, which made the page show an error. Older Equicord versions keep working too.

### QuestRunner
- Activity quests like How To Rob A Bank finish now. Some activities refused the Complete button with "didn't accept the achievement".
- When an activity still refuses, the message says why.
- Its page works on the newest Equicord again. Equicord removed some heading parts it used, which made the page show an error. Older Equicord versions keep working too.

### StreamTimeFarmer
- Log a second account of yours in from its settings; it runs hidden inside the same Discord.
- Press **Call**: your account calls the second one and goes live with a random window at the lowest quality.
- The second account joins, mutes, deafens and watches. Time only counts while it watches, which is how Discord counts it.
- A small call widget in the corner has **Call**, **Hang up** and **Open**.
- Hanging up closes the second account's window but keeps it logged in.
- **AFK mode** hides Discord behind a black screen showing your streaming time, cutting Discord's CPU use about in half while it runs for hours.
- Press Esc twice to leave AFK mode.

### Installer
- Also builds Equicord's web version, which StreamTimeFarmer's second account runs on.
- Adds StreamTimeFarmer once for everyone who has GameTimeSpoof, so the stream farm isn't lost when it moves out.

### General
- The stream farm added to GameTimeSpoof earlier today moved out into its own plugin, StreamTimeFarmer.
- If you used GameTimeSpoof's stream farm, the update adds StreamTimeFarmer and turns it on, keeping your settings and your second account's login.
- GameTimeSpoof has a new **Report real games** setting, so reporting games you really play while analytics are blocked can be turned off.

## 2026-10-30 (installer v1.2.2)

### Installer
- If cordmuffin can't be downloaded during an install, CordmuffinUpdater from the last install is kept so updates keep working.
- Leftover half-copied Muffinshelf folders are no longer built in as plugins.

## 2026-10-30

### CordmuffinUpdater
- Changelog lines about one plugin now only show for people who have that plugin, for every cordmuffin plugin.
- An update that doesn't need a restart no longer hides that an earlier one still does.

### Dictation
- The speech and grammar engines are no longer shut down by the idle timer while they're still working.
- Turning on Fix Grammar while dictating now tells you to finish first instead of silently switching itself back off.
- Turning the plugin off mid-transcription no longer shows an error or types the text anyway.
- Its items no longer show up in Discord's own mic menu after its menu is closed by clicking away.

### Discrub Loader
- Turning the plugin off right after a Discrub update can no longer roll it back or reload it.
- A failed "use the new version now" shows an error instead of doing nothing.

### HideClientBadges
- Switching donor list blocking off and on quickly no longer lets donor lists back in.

### Muffinshelf
- Builds again with the newest Equicord, which removed a text component it used. Older Equicord versions keep working too.
- Closing an Install or Remove confirm with Escape or a click outside no longer locks every button.
- The "A rebuild is still running" banner now goes away when the build finishes.
- Updating a BetterDiscord plugin you turned off keeps it off.
- BetterDiscord plugins can no longer open (run) files in their folder. Files are shown in Explorer instead.
- A backup left over from a crashed rebuild is replaced, so a later failed build restores the right version.
- BetterDiscord notices, notifications and floating windows close properly.
- Unpatching twice no longer breaks another plugin's patches.
- fs.exists gives the right answer for BetterDiscord plugins.
- A BetterDiscord plugin that fails to start no longer leaves its slash commands behind.

### PluginPresets
- Importing a preset with the same name as one you saved keeps both ("Name (2)").
- Presets only save and restore settings you can change yourself, so applying an older preset no longer rolls back plugins' own data (like Muffinshelf install records or GameTimeSpoof's tracking).
- BetterDiscord files with unusual names stay in saved presets.
- Deleted BetterDiscord files are skipped without asking for a restart while Muffinshelf is running; when it's off, presets leave its list alone.
- A failed save, rename or delete shows an error.

### ProfileImages
- The profile buttons keep their styling if a Discord update moves its button styles.

### QuestRunner
- Turning on direct heartbeats now retries play quests that failed for lack of a PC game, and turning it off stops the ones already using them.
- Activity achievement quests are no longer re-authorized every 5 minutes while waiting for Discord.

### Ransom
- The gold owed no longer jumps back to an older number when a coin lands right after a spam fine.
- The test buttons in its settings say "Turn Ransom on first." while the plugin is off, instead of starting a ransom that can't be cleaned up.

### TranslateItAll
- Ordinary Spanish or English messages are no longer mistaken for Toki Pona and sent to the Toki Pona translator.
- The Toki Pona and Sitelen Pona switches now work on their own.
- A failed translation shows an error.
- Google translations with several sentences stay on one line.

## 2026-10-29

### New plugins
- PluginPresets saves which plugins are on, with their settings, as named presets you can switch between.
- PluginPresets shares presets as a code or .json file, leaving out private settings (keys, tokens, IDs, paths).
- PluginPresets imports only ever turn on official Equicord and Vencord plugins, and turn everything else off.
- Ransom from DOORS wanders around your Discord and holds up its stop sign now and then.
- Move while Ransom's sign is up and it encrypts your Discord until you pay it in gold you find around the window.
- Run out of time against Ransom and you revive or get the DOORS death screen.
- HideClientBadges hides client mod badges (Vencord and Equicord donor, custom and contributor badges, other mods' badges and plugin badges) so profiles only show Discord's own badges.
- Discrub Loader opens Discrub (message export and cleanup by Prather Bytecraft) from a broom button in Discord's top bar, New or Classic.
- Discrub Loader loads Discrub's official build, checked against what Discrub publishes on GitHub.
- ProfileImages adds View Avatar and View Banner buttons right on profiles (full profile, popout and DM side panel), opening the full-size or animated image in Discord's viewer.

### ProfileImages
- Adds **Icon** and **Banner** buttons on server banners, at the top of the channel list.

### QuestRunner
- Video quests no longer open Discord's video player; they are watched in the background and the quest card counts down the time left.
- Quest cards and the quest bar get a **Complete** button. Press it to finish that quest now, press it again to stop.
- **Complete** also works on quests with a **Launch Quest** button (find things inside an activity).
- Mobile-only video quests and Xbox / PlayStation quests are supported too.
- Achievement quests no longer take away an activity you authorized yourself.

## 2026-10-28

### Dictation
- The mic button now shows in forum posts and in threads opened in the side panel, and types into the box you clicked it in.
- Messages too long for a toast now show as a notification with all of the text.

### Game Browser
- Fixed **Add Time** failing with "Discord didn't accept the play time" every time after the first run or two.
- This happened because the badge tracker saved its list in a way that broke saving settings until Discord restarted.
- **Add Time** now runs in the background. The window closes and a small progress box in the corner shows how far along it is, with a **Stop** button, so you can keep using Discord.
- When a run ends, the corner box now shows the whole result instead of a toast that cut it off.
- Spoofed games now report their play sessions to Discord properly. Discord was rejecting them.
- Works alongside tracking blockers.
- Turning Equicord's NoTrack analytics switch on or off no longer makes real games count twice or not at all before the restart it needs.
- The Game Browser and **Add Time** window warn when a tracking blocker such as DoNotTrack is on, or when Discord's activity sharing is off.
- A blocked send now says so right away instead of retrying for a minute.
- The badge update time is no longer a guess of "24 hours from now". It learns when Discord's daily update runs for your account and shows that time.
- If it doesn't know the badge update time yet, it says so.
- Messages too long for a toast now show as a notification with all of the text.

### Muffinshelf
- Messages too long for a toast now show as a notification with all of the text.

### QuestRunner
- Messages too long for a toast now show as a notification with all of the text.

## 2026-10-28 (installer v1.2.1)

### CordmuffinUpdater
- Equicord is no longer updated unless you turn on **Also update Equicord** on the Cordmuffin Updater page.
- Automatic installs stay on by default and can be turned off on the same page.
- The page now shows what's new in an update, when it last checked, and when Cordmuffin was last updated.
- A failed check now tries again after an hour instead of six.

### Dictation
- Closing a question with Esc now counts as No.

### Installer
- Running a new download from a different folder keeps the plugins from your last install.
- An antivirus scan that blocks the new installer no longer makes it skip that version for good.

## 2026-10-28 (installer v1.2.0)

### New plugins
- Added CordmuffinUpdater, which keeps cordmuffin's plugins, your Muffinshelf plugins and the installer up to date in the background.

### CordmuffinUpdater
- Has its own page under User Settings.

### Dictation
- The microphone no longer opens twice when you start talking quickly.

### Installer
- Old copies of replaced plugins are now kept in %LOCALAPPDATA%\Cordmuffin\plugin-backups.
