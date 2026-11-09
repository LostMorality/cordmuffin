# Changelog

What changed in cordmuffin's plugins and the installer, newest first. The Cordmuffin Updater page in Discord shows
the lines that are new for you. A line that starts with a plugin's name only shows for people who have that plugin.

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
- Dictation: turning on Fix Grammar while dictating now tells you to finish first instead of switching itself back off.
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
  for a restart, and a failed save, rename or delete shows an error.
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
