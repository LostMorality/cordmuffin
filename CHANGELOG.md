# Changelog

What changed in cordmuffin's plugins and the installer, newest first. The Cordmuffin Updater page in Discord shows
the lines that are new for you. A line that starts with a plugin's name only shows for people who have that plugin.

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
