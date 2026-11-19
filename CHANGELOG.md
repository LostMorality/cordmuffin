# Changelog

What changed in cordmuffin's plugins and the installer, newest first. The Cordmuffin Updater page in Discord shows
the lines that are new for you. A line that starts with a plugin's name only shows for people who have that plugin.

## 2026-11-18

- StreamTimeFarmer: Equicord loads again on a fresh install. The plugin read Equicord's plugin list before it existed,
  which stopped all of Equicord from starting for anyone whose NoTrack blocks analytics (the default).
- NoQuestsOnStartup: new plugin. Stops Discord's quest campaign from opening the Quests page every time Discord starts.
- BadgeTierViewer: works again after Discord's November badge window update. Clicking a tier, the lock, the eye button
  and the "Needs ..." line were all switched off by it. Picking a tier also works on a badge that just levelled up, and
  the lock circle is see-through again.
- BadgeTierViewer: badges you don't own look like Discord's own until you click a tier, instead of showing the tier
  name, rarity and a lock straight away. Picking a tier no longer scrolls the big preview flush against the top. A long
  locked-tier status no longer leaves a stray • at the start of the wrapped line.
- CordmuffinUpdater: clicking the "updated" notification now asks before restarting Discord. A failed automatic update
  tries again an hour later, and a half-finished update is rebuilt on the next check even with Equicord updates off.
  Shorter labels on the settings page and real plugin names in notifications.
- CustomRPCShare: presets without an application name are skipped instead of blanking your presence when loaded. Export
  and import notices now tell privacy removals apart from fields that failed CustomRPC's checks. Code boxes use
  Discord's own styling, long preset names fit on one chip line, hidden text-direction characters are stripped from
  names, and **Replace Same Names** looks different from **Keep Both**. **Copy Code** uses the plugin's toast fallback
  and reports copy errors, and oversized files are rejected before they are read.
- CustomRPCShare: **Replace Same Names** is now a solid red button so it can't be mistaken for Cancel. Export and import
  no longer list the left-out fields of a preset that was skipped entirely.
- Dictation: the right-click menu checkboxes now update when clicked. A stuck speech engine no longer leaves the mic
  stuck on working, and switching speech model mid-dictation no longer drops text. The live text respects **Add
  Punctuation** and moves with the chat box. The shortcut needs Ctrl, Alt or Meta (Shift can be added on top) or an F
  key, and its button stays short. Grammar fixing keeps number ranges like 5–10 and fixes short sentences better.
  Downloads check free disk space first, and notices are shorter so they no longer cover the chat bar.
- Dictation: switching the speech model back and forth while it's still starting no longer fails; the last pick wins. A
  speech engine that stops taking connections shows a plain message and is restarted on the next try. The Speech Model
  description is the same grey as the others.
- DiscrubLoader: with the plugin off, its settings buttons are greyed out. Before, Open Discrub kept asking to reload,
  and Check now could load Discrub while the plugin was off.
- DiscrubLoader: **Ask each time** really asks every time. Discrub's start screen no longer counts down into your last
  pick.
- DiscrubLoader: **Stay on this version** no longer checks the Chrome Web Store in the background.
- DiscrubLoader: **Not now** on an update is remembered. That version isn't offered again on every start (Check now
  still offers it).
- DiscrubLoader: the reason for an automatic roll-back stays in settings instead of vanishing after the next update
  check, and it's only shown once.
- DiscrubLoader: shorter setting names, settings text sized like the rest of the page, and turning the plugin off puts
  the Inbox button area back the way it was.
- DiscrubLoader: while the plugin is off, Open Discrub and the status buttons turn grey and show a not-allowed cursor
  instead of looking clickable. Installing or updating to a version you'd skipped with **Not now** clears that skip.
- GameTimeSpoof: **Stop** on a game now also turns rotation off. Before, rotation brought a game back at its next
  switch. Random rotation picks from every detectable game, like Add Random Games, and starts right away when no game is
  set. Picking favorites rotation with no favorites now says so. If Discord's game list won't load, you get one notice
  instead of one every minute. The Game Browser no longer jumps around while you search, and the Add Time switch is now
  called **Only unplayed games**.
- GameTimeSpoof: clicking a game cover shows an error if Discord's game page fails to load, where before nothing
  happened. A slow first load shows "Loading the game page…".
- GreetStickerPicker+: right-click opens the sticker picker straight away after Discord starts. Before, it only worked
  once you had opened the sticker tab in the chat bar. The message menu no longer pops up on top of the picker.
- GreetStickerPicker+: only the wave button reacts now, not the empty space next to it, so clicking beside it no longer
  sends your default sticker.
- GreetStickerPicker+: sticker lists use Discord's own rules, so Nitro Basic shows other servers' stickers, and channels
  that block outside stickers no longer list ones that would fail. A default sticker that can't be sent here shows a
  message instead.
- GreetStickerPicker+: Lottie welcome stickers (Wumpus, Nelly, Clyde, Doggo, Peach) get thumbnails. The picker window no
  longer gets a second scrollbar, search tells you when it hides results, and Greet mode now also applies to a welcome
  default sticker. Rate limits show a message.
- GreetStickerPicker+: the picker no longer reopens with your last sticker search.
- HideClientBadges: **Hide Nitro Boost** now also works in the badge window you get when you click someone's badge.
  Turning **Block Donor Lists** on while Equicord is downloading the lists no longer lets them back in for 30 minutes,
  and the block also catches the list addresses with extra bits on the end. The profile patch holds up better against
  Discord updates.
- HideClientBadges: the badge window hides Nitro and boost badges whatever form Discord sends their id in, and **Hide
  All** also hides plugin badges that have no picture of their own.
- Muffinshelf: BetterDiscord store cards show their pictures again. Discord was blocking them; images that still can't
  load are hidden instead of leaving an empty box.
- Muffinshelf: BetterDiscord plugins that use BdApi's Text component no longer crash. Plugin settings windows with sized
  modals open at the size the plugin asked for.
- Muffinshelf: a BetterDiscord plugin's slash command whose name is already taken no longer stops the plugin and hides
  it as broken. The command gets the plugin's name in front instead. Command results only ever show as a local bot
  message, never as a message sent from your account.
- Muffinshelf: turning off a BetterDiscord plugin, turning off **Run BD plugins** or pressing **Reload all** now removes
  everything the plugin changed, including old-style monkeyPatch patches and injectCSS styles, and puts Discord's own
  modules back the way they were.
- Muffinshelf: Equicord plugins from a GitHub repo only offer an update when their own folder changed, not after any
  commit to the repo. Plugins installed before this may offer one update first.
- Muffinshelf: the parts of Discord that BetterDiscord plugins ask for are remembered in a way that survives Discord
  updates better, and old entries Discord dropped are cleared after two weeks.
- Muffinshelf: rebuilds back up only the Equicord build Discord loads, not the whole dist folder, so they start sooner.
- Muffinshelf: the BetterDiscord switches, Remove and Reload all are locked while an install or rebuild runs. Switches
  in the Installed and Sources tabs line up with their buttons, and shorter labels fit their boxes (**Run BD plugins**,
  **Won't work here**).
- Muffinshelf: errors that used to vanish silently (a plugin's settings panel failing to open, folders that can't be
  read) now show a message.
- Muffinshelf: BDFDB settings windows (the library's own and those of BDFDB plugins like SpellCheck) get their left
  padding back, and their buttons no longer wrap. Discord removed the window styles BDFDB still looks for. Their buttons
  widen to fit the label, and text and number boxes look like Discord's. Number arrows sit inside their box, and each
  row shows its full label on the left with the switch on the right. Notes under a label are smaller, muted and no
  longer cut off, and rows have a small gap between them.
- Muffinshelf: the list of turned-on BetterDiscord plugins keeps the plugin folder's order, so turning one off and on no
  longer moves it. BD slash commands named after Discord's own (shrug, me, tts, spoiler...) get the plugin's name in
  front instead of showing twice. The "Won't work" note has proper punctuation. When Equicord turns a command down for
  another reason, the real reason is logged. A BD plugin only gets ZeresPluginLibrary, BDFDB or XenoLib when its code
  really uses one; a changelog that just mentions it no longer pulls it in. A library that's turned off or removed is
  hidden from other plugins until it's back on, removing one names the plugins that use it, and installing a plugin
  turns its library back on if needed.
- OfficialCustomTypingIndicator: **Show Others** off now really gives plain dots everywhere, also where Discord draws
  styles itself. The word ("is yapping…") now shows in your Discord language. In the typing bar inside the channel, the
  emoji now line up with the message avatars like Discord's own.
- OfficialCustomTypingIndicator: turning **Show Others** on or off updates a typing bar that's already showing right
  away. The editor's word buttons use Discord's own translated text.
- PlatformSpoofer+: asks before switching platform while you're in a call, since the reconnect drops the call and any
  stream. Picking Desktop on the desktop app no longer reconnects or skips fast connect, and turning the plugin off only
  reconnects when you were spoofed. /platform now goes away when you turn the plugin off, the warning's Turn it on
  button is red again, and the check panel says when the plugin is off instead of showing a red mismatch. The quick
  button's icon follows the platform Discord really shows, Desktop on the desktop app counts as your real platform,
  **Reconnect now** only shows when it would change something, and Console no longer sends the desktop app's browser
  details.
- PluginPresets: the export and import code boxes keep Discord's dark textarea look again, and rows and chips use the
  current theme colours. The BetterDiscord list is ignored while Muffinshelf is off (no longer saved, exported or
  rewritten, and no pointless restart). Renaming to a name another preset already uses is blocked. Applying a preset now
  skips any setting the plugin's own settings page would refuse (out of range, no longer a choice, fails the plugin's
  check) and lists these in Preview. Number IDs (BIGINT settings) are restored as numbers. Big .json files are no longer
  cut short in the import box, a damaged or cut-off code gets its own error, and the import labels now say "has on" and
  "never turned on".
- ProfileImages: the square View Avatar and View Banner buttons next to Message on the full profile are back after
  Discord's update. If they ever break again, the full profile keeps its Avatar button on the banner instead of losing
  it.
- ProfileImages: the Icon and Banner buttons on server banners can be clicked again. Before, the channel list sat on top
  of them. They now hide while the channel list is scrolled.
- ProfileImages: the copied banner colour now matches the profile you are looking at (server or main), and is no longer
  the grey shown while a banner loads.
- ProfileImages: an equipped profile effect (smoke, crows and so on) no longer draws over the Avatar and Banner pills.
  The colour pill shows the hex in lower case, the same as the tooltip and what gets copied.
- QuestRunner: **Accept and finish** no longer hangs on "Accepting..." when Discord refuses the quest (for example, a
  closed captcha). You get a warning, and pressing again really tries again.
- QuestRunner: skipping the video player now only says the video is being watched once Discord has accepted the quest.
  If Discord doesn't accept it, you're told to press Accept again.
- QuestRunner: Complete on a play quest that has no game to run no longer switches to direct heartbeats behind your back
  while that setting is off.
- QuestRunner: direct-heartbeat quests stop and try again later when Discord keeps refusing the heartbeats, instead of
  beating until the quest expires.
- QuestRunner: **Clear Recent activity** now also covers quests done with direct heartbeats. It never touches a game you
  were already playing, and it handles two quests for the same game.
- QuestRunner: Questify's finisher only counts as on while Questify isn't paused or fully disabled.
- QuestRunner: tidier settings page. Kept games sit on one line with their button, and the explanation has space between
  paragraphs.
- QuestRunner: when Discord cancels the accept on a video quest whose player was skipped, the "Discord didn't accept"
  warning shows right away instead of after 2 minutes.
- Ransom: the "paid" sound downloads again (the DOORS wiki moved the file), and the DOORS files and your EasterEgg files
  are read from your own Discord's folder again (PTB and Canary were using the stable one).
- Ransom: **Reset scores** asks first and no longer takes your gold. **Forget all finds** asks first too. The Scores tab
  updates while it's open.
- Ransom: while Discord is encrypted or broken only the message box is locked, settings and windows stay readable, and
  the broken state is much lighter on your PC.
- Ransom: **Calm Effects** also slows the static on the caught and time's-up screens. Hidden items no longer get
  scrambled.
- Ransom: **Drop some gold** says why when it can't drop one, and gold you drop by hand stays when Loose Gold is off.
  Turning Hidden items or Loose Gold off now clears them right away.
- Ransom: items are never hidden in forums or other chats without messages, and **Hide an item here** says so.
- Ransom: changing how often challenges happen takes effect at once, within the range you picked. Ransom's face and
  loose gold no longer draw over Discord's windows. Discord stays light while it's wrecked: the scrambled text only
  looks at parts of the page that changed, and the falling-apart effect re-measures the screen every few seconds instead
  of every tick.
- ShrinkUploads: turning it off now stops it right away. Animated pictures and code .ts files are left alone. Cover-art
  videos shrink properly. A full message no longer loses a shrunk file (press **Add**). Files keep their place in the
  list. The progress panel sits above the message box. The Shrink button is gone on tiny files. Shorter setting names,
  and the ffmpeg path no longer shows your user folder.
- ShrinkUploads: the progress box no longer covers StreamTimeFarmer's boxes. Your own ffmpeg only counts if the file is
  named exactly ffmpeg (ffmpeg.exe on Windows), and that is checked before anything runs. The panel also stops at the
  top of the chat instead of growing over the channel header. Shrunk files go back to their own spot in the message,
  even when several shrink at once, one fails or the plugin is turned off mid-shrink. The Shrink window no longer says
  "1024 MB is left" in an almost empty message, and it shows your real per-file limit when only small files are there.
- StreamTimeFarmer: the farm window now starts from a script file instead of a command line antivirus programs flag. Its
  game cover loads in the background, so a slow download can no longer freeze its clock.
- StreamTimeFarmer: where the farm window can't run, a DM call streams your screen and a server channel streams nothing.
  It no longer picks a random open window.
- StreamTimeFarmer: pop-up messages that can't show as a toast now come up as a notification instead of disappearing.
- StreamTimeFarmer: the Add Streaming Time box no longer covers the channel header's buttons, and the call widget moves
  out from under Discord's stream preview. Turning Quiet Second Account off now works right away. Disabling the plugin
  no longer removes other plugins' sound hooks.
- StreamTimeFarmer: turning **Quiet Second Account** off brings the second account's desktop notifications back straight
  away. The Add Streaming Time box sits at the bottom of the member list or DM profile, so it no longer covers messages
  or the profile banner; with no side column it starts small, below Discord's unread bar. It also stays above Discord's
  picture-in-picture stream preview.
- TranslateItAll: Translate now works on forwarded messages, component (v2) bot messages and search results. It shows
  "Translating..." and ignores double clicks, and errors no longer say "translated from English". Long Chinese,
  Japanese, Korean or Cyrillic messages no longer fail on Google. Yandex falls back to Google for languages it lacks
  (Traditional Chinese stayed Simplified before). The Toki Pona, Sitelen Pona and Shavian switches no longer ask for a
  restart, short Toki Pona is caught better, Shavian keeps line breaks and its dictionary is downloaded once per
  session. Translations hide after the message is edited, and Dismiss clears every copy.
- TranslateItAll: no more crash on forwarded messages without a copy of the original. Long messages translated with
  Google keep the space where they were split. Yandex errors only suggest restarting Discord when Yandex couldn't be
  reached at all.

## 2026-11-17
 A translated forward shows its translation once, inside the forward box.
- StreamTimeFarmer: works with NoTrack's **Allow Badge Tracking** (on by default), which lets stream reports through
  while the rest of Discord's tracking stays blocked. The badge warning no longer goes red for NoTrack's defaults, and
  **Fix these for me** turns that switch on instead of turning off NoTrack's whole analytics block.
- QuestRunner: new **Clear Recent activity**, off by default. When a play quest finishes, the game comes off Recent
  activity on your profile. It only takes the session the quest made: if Discord's entry starts before the quest did,
  it stays, because Discord deletes a whole entry or nothing and that one holds time you really played.
- QuestRunner: new list of games to keep on your profile, under that setting. **Add Board games** fills it in one press
  with every game already on your Board, and each game on your Recent activity has a Keep button next to it. Games on
  the list are never touched.
- QuestRunner: quests with a **Launch Quest** button no longer make you open the activity to accept them. Our Complete
  button only appeared once a quest was accepted, and for those quests Discord's Launch Quest was the only way to
  accept, which opened the activity for nothing. The card now offers **Accept and finish** straight away.
- QuestRunner: Quest Home tiles show the QuestRunner button again after Discord's latest update.
- QuestRunner: when Discord rate-limits quest progress you now get a warning, also for quests run with direct
  heartbeats. Before, it never showed. While Discord has quest accepting on hold, QuestRunner waits for
  the hold to end instead of checking again every second.
- OfficialCustomTypingIndicator: fixed for Discord's latest update. Discord desktop has started drawing custom typing
  styles itself for some people. Where it does, the plugin steps aside so the emoji and the word never show twice.
  Where Discord still shows the plain dots and "is typing", the plugin draws other people's styles as before.
- GameTimeSpoof: spoofed games are counted once, whatever NoTrack is set to. Discord's own game heartbeat counted them
  too while its reports got through, so spoofed time could count twice. GameTimeSpoof now needs a restart to turn on
  or off.
- GameTimeSpoof: **Report real games** now only sends anything when NoTrack really blocks Discord's game reports:
  **Disable Analytics** on and **Allow Badge Tracking** off.
  With NoTrack's defaults Discord counts real games itself, so they're no longer counted twice. A change to either
  NoTrack switch counts after a restart, same as NoTrack.
- StreamTimeFarmer: the stream report watch no longer pushes other plugins' network hooks aside when it starts, or
  wipes them out when it stops (HideClientBadges, or the farm's own Add Streaming Time).
- Dictation: two downloads can no longer cross. Asking for the grammar model while a speech model is downloading now
  waits its turn and then really downloads it, instead of saying "done" with nothing downloaded. A download you
  confirm after you've started dictating, or after another download started, is skipped.
- CordmuffinUpdater: lines here about BadgeTierViewer, CustomRPCShare, GreetStickerPicker+,
  OfficialCustomTypingIndicator, PlatformSpoofer+ and ShrinkUploads now only show for people who have that plugin.
  Lines that announce a new plugin still show for everyone. Its list of places it connects to now includes
  release-assets.githubusercontent.com, where GitHub sends installer downloads.

## 2026-11-13

- CustomRPCShare: new plugin. Adds Export Presets and Import Presets to CustomRPC's settings, so you can share your
  Rich Presence presets as a code or a .json file. Exports leave out anything about your account, imports are checked
  field by field, and a preset with a name you already have is only overwritten if you say so.
- StreamTimeFarmer: new **Add Streaming Time**. Type how many hours you want and it adds up to 12 hours of Streaming
  badge time every hour while the farm streams, instead of one hour per hour. Find it in StreamTimeFarmer's settings
  or Equicord's toolbox. It sends made-up stream reports, which Discord bans for, so only use it on an account you're
  fine risking.
- QuestRunner: play quests for some games never moved off zero. Discord ignores certain program names outright
  (launcher.exe, start_protected_game.exe and 23 more) and skips anything its game list marks as a launcher, so the
  stand-in was running for a name Discord was never going to count. Fortnite, VRChat, Dead by Daylight, Space Marine II
  and four others now pick a name Discord does count, and a game with no usable name says so instead of sitting at
  zero for two minutes.
- QuestRunner: direct heartbeats no longer send a closing report when a quest finishes. Discord's own client doesn't
  send one there, only when you stop early, so now ours matches it.

## 2026-11-12

- New plugin: OfficialCustomTypingIndicator. Set Discord's own Nitro custom typing indicator (3 emoji, an animation and a
  word like "is yapping…") from desktop. People on Discord's phone app see it without any plugin, and the plugin draws
  other people's on desktop too.

## 2026-11-11

- GameTimeSpoof: **Add Random Games** now picks from every game Discord can detect. Games without a cover picture
  used to be skipped, even though the list already shows them with their icon instead.
- StreamTimeFarmer: both accounts now stay muted and deafened in the farm's call, so joining a real call on top of it
  can't feed sound back. Discord clears both whenever a stream starts, and the farm now sets them again instead of
  assuming they stuck. The viewer-only **deafen** setting became one for both accounts and keeps your answer.
- StreamTimeFarmer: the "your badge may not count" warning now stands down once Discord has actually accepted a
  report, instead of going by NoTrack's switch alone. Discord's own two privacy settings still warn, since a report
  it accepts can still be ignored.

## 2026-11-10

- StreamTimeFarmer: a second account that isn't your friend yet no longer leaves the farm stuck in setup. It opens the
  DM itself, or tells you to add it as a friend.
- StreamTimeFarmer: it waits for the call to connect before going live, rejoins faster when the second account is still
  in the call, and waits longer between tries when Discord keeps refusing the stream. Waits show the real time
  ("in 4m") instead of "soon".
- StreamTimeFarmer: a picked window that's minimized is no longer restarted over and over, and the status tells you to
  open it. After falling back to your screen, the farm tries its own window again each time it reports the time.
- StreamTimeFarmer: the second account's window reloads itself when its page fails to load, retries a failed download
  within a couple of minutes, and no longer takes your keyboard when it needs a login.
- StreamTimeFarmer: the **Try again** button on the download card no longer gets stuck, the minimized widget shows a
  yellow "may not count" for settings that only might block the badge, it remembers being minimized, and several
  messages are shorter and plainer.

## 2026-11-09

- Pop-up messages in Dictation, Discrub Loader, GameTimeSpoof, GreetStickerPicker+, Muffinshelf, PlatformSpoofer+,
  PluginPresets, ProfileImages, QuestRunner and Ransom work again after Discord's November update, and a failed pop-up
  can no longer stop what the plugin was doing.
- New plugin: BadgeTierViewer. In the badge window, click any tier of a badge to see it in the big preview. Tiers you
  haven't unlocked show locked, and an eye button next to the preview shows how they look once unlocked.
- BadgeTierViewer: locked tiers now say what they take and how far off you are ("Needs 300 hours (141 to go)"), and
  Nitro and Server Boosting tiers show a rough unlock date. Locked tiers also show their rarity, their art no longer
  animates until you reveal it, and a short line under the progress box says the tiers can be clicked.
- BadgeTierViewer: the eye button dims on tiers you already have, and its tooltip is shorter. If a Discord update breaks
  part of the plugin, it now switches off cleanly instead of half working.
- StreamTimeFarmer: when Discord drops you from the farm's call (alone too long, or moved to the AFK channel), the farm
  joins again by itself and tells you, with a notice to click if you really meant to hang up.
- StreamTimeFarmer: if no time has counted for a while, the status says for how long, and after 15 minutes a notice pops
  up. It also says plainly when you're offline or what's wrong with the second account, instead of "waiting for them
  to watch".
- StreamTimeFarmer: a **Turn it on** button for DisableCallIdle, which stops Discord ending the call, and the second
  account gets it turned on by itself.
- StreamTimeFarmer: a broken second account rebuilds itself about every 15 minutes, a failed Equicord download is
  retried a few minutes later instead of every few seconds, and if the farm's own window can't open, a DM call shows
  your screen instead so time keeps counting.
- StreamTimeFarmer: Sign out asks first, the farm's panel comes first in its settings, and the AFK screen is easier to
  read and has a **Leave AFK** button.
- StreamTimeFarmer: pop-up messages no longer break after Discord's November update.

## 2026-11-08

- New plugin: ShrinkUploads. Files over your upload limit get shrunk on your own computer to just fit, instead of
  Discord's "file too big" error. Works for videos, pictures, GIFs and audio, even multi-GB recordings, and reads your
  real limit from Discord (Nitro, Basic, free and server boosts). A Shrink button on any waiting file lets you pick
  your own size. Phone HDR videos keep normal colours and screenshots stay sharp. If you already have ffmpeg
  (scoop, winget, Chocolatey or anywhere on PATH) it's used instead of downloading one, or you can pick your own.

## 2026-11-07

- New plugin: PlatformSpoofer+. Pick what platform people see you on (Phone, Console, VR headset, Web or Desktop)
  from a button next to mute and deafen, and switch live. A revival of Equicord's removed PlatformSpoofer that keeps you
  logged in when Discord refuses a spoof. Settings from the old plugin carry over.
- StreamTimeFarmer: the second account no longer shows "watching" while its picture is actually stuck. Discord reuses
  the same error 2012 for the whole session, so the farm only noticed it the first time; it now notices it every time.
- StreamTimeFarmer: if the second account keeps getting the stream but can't show a single frame, the farm reopens it,
  and if that's because Discord lost your graphics card (it happens after a GPU driver update, until Discord restarts)
  the status says so and tells you to fully quit Discord from the tray and open it again. Time stops counting until
  then instead of being counted for a stream nobody could see.
- StreamTimeFarmer: a call whose voice connection died while Discord still showed it as joined no longer leaves the
  farm failing to go live over and over. After 30 seconds without a working connection it leaves the call and joins
  it again by itself (waiting longer each time if that doesn't help), on both accounts.

## 2026-11-04

- QuestRunner: the Completing button is back on play quests in Quest Home. Discord's new quest tiles only showed the
  game's "Play Now" link once you accepted a play quest, so it looked like nothing was happening even while the quest
  ran. It works next to Questify too.
- QuestRunner: starting a video quest no longer opens Discord's video player again. A Discord update had broken the
  skip, so the player opened even with "Don't open Discord's video player" on.
- StreamTimeFarmer: warns you when your Streaming badge can't count. Equicord's NoTrack plugin blocks the report
  Discord counts streaming time from (its "Block Discord's tracking analytics" switch is on by default), and so does
  Discord's "Use data to improve Discord" setting when it's off, and Discord's own article also asks for "Use data to
  personalize my Discord experience". The settings and the corner call widget now check all of them,
  for your account and your second account, in green and red, and "Fix these for me" changes them after a confirm box
  that lists every change.
- StreamTimeFarmer: a Go Live that Discord lists but never actually sends (its error 2012) is now restarted instead of
  leaving the farm on "reconnecting" all night, a failed stream is no longer started again before its own wait is over,
  and after a few failures in a row the status says Discord keeps refusing the stream rather than looking like a hiccup.
- StreamTimeFarmer: the missing-report warning no longer blames an ad blocker outright. It says no report was seen and
  names a failed Go Live as the likelier cause.
- StreamTimeFarmer: the second account no longer needs anything built or copied. Its window now downloads Equicord's
  own released build straight from Equicord the first time it opens, keeps it for six hours and fetches it again after
  that, so it is always a current Equicord and the plugin doesn't need to be in it. The viewer half of the farm is sent
  into the window by the plugin instead. If the download ever fails, the card says so and offers a "Try again" button.
- StreamTimeFarmer: new "Quiet Second Account" setting, on by default. The second account's window shares one program
  with your Discord, so its unread count used to add to your taskbar badge (a call it was invited to every hour, never
  read, and the badge just climbed) and it could raise desktop notifications of its own. With this on it does neither.
  The account still receives everything; open its window to read it.
- StreamTimeFarmer: new "Keep Computer Awake" setting, off by default. While the farm runs or AFK mode is on, your computer
  won't go to sleep by itself, even when no call is live. Needs one full Discord restart after updating.
- StreamTimeFarmer: new "Mute Call Sounds" setting, on by default. While the farm runs, Discord's call, ring, Go Live,
  join, leave, mute and deafen sounds stay silent on your PC. Message sounds stay on.
- StreamTimeFarmer: quitting or reloading Discord now sends the stream's time so far instead of losing it. Putting the PC
  to sleep no longer counts as hanging up, so the farm carries on after it wakes.
- StreamTimeFarmer: wording is more honest. "Farmed" is now "Streamed", the plugin's own total says it isn't Discord's
  count, the confirm box says what Discord can see once tracking is allowed, and settings whose effect on the badge isn't
  proven say so. It no longer claims the badge updates once a day.
- StreamTimeFarmer: keeps the last 200 stream reports on your PC, says when an account has no Streaming badge yet, asks
  before resetting the total, and suggests DisableCallIdle when it's off.
- StreamTimeFarmer: the widget and settings now show when Discord last accepted a stream report, when the next one goes
  out, and Discord's own count for the badge, and warn when a report never arrived or another plugin may be blocking it.
- StreamTimeFarmer: sends Discord the streaming time every hour now instead of only when the call ends. Discord only
  counts a stream's time when the stream ends, so a stream that ran for days counted nothing until hang-up, and a crash
  lost all of it. The farm now ends and restarts its Go Live every hour (the call and your second account stay), so a
  crash only loses the time since the last restart. Change it with the "Report Every" setting.

## 2026-11-03

- StreamTimeFarmer: streams its own small window now instead of a random open one. It sits in a screen corner behind
  everything, see-through and click-through, with no taskbar button, and shows only its name (or the game's cover), a
  ticking clock and a moving bar, so nothing private can end up in the stream, the picture never freezes, and it can't
  break by being minimized or closed. Everyone who was on "a random open window" moves to it; a window you picked
  yourself stays.
- StreamTimeFarmer: new "Show it as a game" option. Pick a game and the stream shows as "Streaming <game>", with the
  farm window showing its cover art. It steps aside while gameSessionSpoofer shows a game.
- StreamTimeFarmer: a broken stream fixes itself. When it fails (like "Stream failed, error 2012"), gets stuck paused,
  or stops getting a picture through, the second account reopens it and your account restarts Go Live. Time doesn't
  count while it's broken.
- StreamTimeFarmer: Log in to second account works with the plugin off too and turns it on. When the button can't work
  yet, the settings now say why: Discord needs a full quit and reopen after the update, or the installer needs to run
  again.
- StreamTimeFarmer: Log in to second account now asks first, with a warning that explains what it does: it turns the
  plugin on and runs a hidden second Discord with your other account.
- StreamTimeFarmer: new setting for your second account's online status (Online, Idle, Do Not Disturb or Invisible).
  The dot on its picture now shows its real online status, with the name next to it, instead of always looking online.
- Installer: when it closes Discord to install or remove Equicord, it now closes only Discord itself. Before, it also
  force-closed Discord System Helper (Discord's keybinds helper), which could leave the helper stuck and make Discord's
  own "Uninstall" button for it fail with an "Overlapped I/O" error.
- CordmuffinUpdater: when Windows or an antivirus won't let the updater start, it now says so and names the file to
  allow, instead of "The updater stopped without saying why (code -1)".

## 2026-11-02

- New plugin: StreamTimeFarmer, for the Streaming badge. Log a second account of yours in from its settings (it runs
  hidden inside the same Discord), then press Call: your account calls it, goes live with a random window at the lowest
  quality, and the second account joins, mutes, deafens and watches. Time only counts while it watches, which is how
  Discord counts it. A small call widget in the corner has Call, Hang up and Open; hanging up closes the second
  account's window but keeps it logged in. AFK mode hides Discord behind a black screen with your streaming time,
  which cuts Discord's CPU use about in half while it runs for hours; press Esc twice to come back.
- GameTimeSpoof: the stream farm added to it earlier today is its own plugin now, StreamTimeFarmer. If you used it, the
  update adds StreamTimeFarmer and turns it on, with your settings and your second account's login kept.
- GameTimeSpoof: new "Report real games" setting, so reporting games you really play while analytics are blocked can be
  turned off.
- Installer: also builds Equicord's web version, which StreamTimeFarmer's second account runs on, and adds
  StreamTimeFarmer once for everyone who has GameTimeSpoof, so the stream farm isn't lost when it moves out.
- New plugin: GreetStickerPicker+. A bigger GreetStickerPicker: works on DM wave buttons too, right-click opens Discord's
  real sticker picker, left-click sends your default sticker, and any server sticker can be a greet.
- QuestRunner: activity quests like How To Rob A Bank finish now. Some activities refused the Complete button with
  "didn't accept the achievement". When one still refuses, the message says why.
- QuestRunner, Muffinshelf, Updater: their pages work on the newest Equicord again. It removed some heading parts they
  used, which made those pages show an error. Older Equicord versions keep working too.

## 2026-10-30 (installer v1.2.2)

- Installer: if cordmuffin can't be downloaded during an install, CordmuffinUpdater is kept from the last install so
  updates keep working, and leftover half-copied Muffinshelf folders are no longer built in as plugins.

## 2026-10-30

- Muffinshelf: builds again with the newest Equicord, which removed a text component Muffinshelf used. Older Equicord
  versions keep working too.
- Updater: changelog lines about one plugin now only show for people who have that plugin, for every cordmuffin plugin.
- Updater: an update that doesn't need a restart no longer hides that an earlier one still does.
- Dictation: the speech and grammar engines are no longer shut down by the idle timer while they're still working.
- Dictation: turning on Fix Grammar while dictating now tells you to finish first instead of silently switching itself
  back off.
- Dictation: turning the plugin off mid-transcription no longer shows an error or types the text anyway.
- Dictation: Dictation's items no longer show up in Discord's own mic menu after its menu is closed by clicking away.
- DiscrubLoader: turning the plugin off right after a Discrub update can no longer roll it back or reload it.
- DiscrubLoader: a failed "use the new version now" shows an error instead of doing nothing.
- TranslateItAll: ordinary Spanish or English messages are no longer mistaken for Toki Pona and sent to the Toki Pona
  translator.
- TranslateItAll: the Toki Pona and Sitelen Pona switches now work on their own, a failed translation shows an error,
  and Google translations with several sentences stay on one line.
- HideClientBadges: switching donor list blocking off and on quickly no longer lets donor lists back in.
- ProfileImages: the profile buttons keep their styling if a Discord update moves its button styles.
- Muffinshelf: closing an Install or Remove confirm with Escape or a click outside no longer locks every button.
- Muffinshelf: the "A rebuild is still running" banner now goes away when the build finishes.
- Muffinshelf: updating a BetterDiscord plugin you turned off keeps it off.
- Muffinshelf: BetterDiscord plugins can no longer open (run) files in their folder. Files are shown in Explorer instead.
- Muffinshelf: a backup left over from a crashed rebuild is replaced, so a later failed build restores the right version.
- Muffinshelf: BetterDiscord notices, notifications and floating windows close properly, unpatching twice no longer
  breaks another plugin's patches, fs.exists gives the right answer, and a plugin that fails to start no longer
  leaves its slash commands behind.
- PluginPresets: importing a preset with the same name as one you saved keeps both ("Name (2)").
- PluginPresets: presets only save and restore settings you can change yourself, so applying an older preset no longer
  rolls back plugins' own data (like Muffinshelf install records or GameTimeSpoof's tracking).
- PluginPresets: BetterDiscord files with unusual names stay in saved presets, deleted ones are skipped without asking
  for a restart (while Muffinshelf is running; when it's off, presets leave its list alone), and a failed save, rename or delete shows an error.
- QuestRunner: turning on direct heartbeats now retries play quests that failed for lack of a PC game, and turning it
  off stops the ones already using them.
- QuestRunner: activity achievement quests are no longer re-authorized every 5 minutes while waiting for Discord.
- Ransom: the gold owed no longer jumps back to an older number when a coin lands right after a spam fine.
- Ransom: the test buttons in its settings say "Turn Ransom on first." while the plugin is off, instead of starting a
  ransom that can't be cleaned up.

## 2026-10-29

- New plugin: PluginPresets. Save which plugins are on, with their settings, as named presets and switch between them.
  Share presets as a code or .json file with private settings (keys, tokens, IDs, paths) left out. Imports only ever
  turn on official Equicord and Vencord plugins, and turn everything else off.
- New plugin: Ransom. Ransom from DOORS wanders around your Discord and holds up its stop sign now and then. Move
  while it's up and it encrypts your Discord until you pay it in gold you find around the window. Run out of time and
  you revive or get the DOORS death screen.
- QuestRunner: video quests no longer open Discord's video player. QuestRunner watches them in the background and the
  quest card counts down the time left.
- QuestRunner: quest cards and the quest bar get a Complete button, including quests with a Launch Quest button (find
  things inside an activity). Press it to finish that quest now, press it again to stop. Mobile-only video quests and
  Xbox / PlayStation quests are supported too. Achievement quests no longer take away an activity you authorized yourself.
- New plugin: HideClientBadges. Hides client mod badges (Vencord and Equicord donor, custom and contributor
  badges, other mods' badges and plugin badges) so profiles only show Discord's own badges.
- New plugin: Discrub Loader. Opens Discrub (message export and cleanup by Prather Bytecraft) from a broom button in
  Discord's top bar, New or Classic. It loads Discrub's official build, checked against what Discrub publishes on GitHub.
- New plugin: ProfileImages. Adds View Avatar and View Banner buttons right on profiles (full profile, popout and DM
  side panel), opening the full-size or animated image in Discord's viewer.
- ProfileImages: Icon and Banner buttons on server banners, at the top of the channel list.

## 2026-10-28

- GameTimeSpoof: fixed Add Time failing with "Discord didn't accept the play time" every time after the first run or
  two. The badge tracker saved its list in a way that broke saving settings until Discord restarted.
- GameTimeSpoof: when a run ends, the corner box now shows the whole result instead of a toast that cut it off.
- GameTimeSpoof: spoofed games now report their play sessions to Discord properly. Discord was rejecting them.
- GameTimeSpoof: works alongside tracking blockers. Turning Equicord's NoTrack analytics switch on or off no longer
  makes real games count twice or not at all before the restart it needs. The Game Browser and Add Time window warn when
  a blocker such as DoNotTrack is on, or when Discord's activity sharing is off, and a blocked send now says so right
  away instead of retrying for a minute.
- GameTimeSpoof: the badge update time is no longer a guess of "24 hours from now". The plugin learns when Discord's
  daily update runs for your account and shows that time, or says it doesn't know it yet.
- Dictation, GameTimeSpoof, Muffinshelf, QuestRunner: messages too long for a toast now show as a notification with all of
  the text.
- GameTimeSpoof: Add Time now runs in the background. The window closes and a small progress box in the corner shows
  how far along it is, with a Stop button, so you can keep using Discord.
- Dictation: the mic button now shows in forum posts and threads opened in the side panel, and types into the box you
  clicked it in.

## 2026-10-28 (installer v1.2.1)

- Updater: Equicord is no longer updated unless you turn on **Also update Equicord** on the Cordmuffin Updater page.
  Automatic installs stay on by default and can be turned off there too.
- Updater: the page now shows what's new in an update, when it last checked and when Cordmuffin was last updated.
- Updater: a failed check tries again after an hour instead of six.
- Installer: running a new download from a different folder keeps the plugins from your last install.
- Installer: an antivirus scan that blocks the new installer no longer makes it skip that version for good.
- Dictation: closing a question with Esc now counts as No.

## 2026-10-28 (installer v1.2.0)

- Updater: new. Keeps cordmuffin's plugins, your Muffinshelf plugins and the installer up to date in the background,
  with its own page under User Settings.
- Installer: old copies of replaced plugins are kept in %LOCALAPPDATA%\Cordmuffin\plugin-backups.
- Dictation: the microphone no longer opens twice when you start talking quickly.
