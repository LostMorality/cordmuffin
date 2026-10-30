# Changelog

What changed in cordmuffin's plugins and the installer, newest first. The Cordmuffin Updater page in Discord shows
the lines that are new for you. A line that starts with a plugin's name only shows for people who have that plugin.

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
