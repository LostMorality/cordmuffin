package main

import (
	"archive/zip"
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	title          = "Cordmuffin Equicord Installer"
	pluginsFolder  = "Plugins Go Here"
	themesFolder   = "Themes Go Here"
	backupSuffix   = ".cordmuffin-backup"
	stubPackage    = `{"name":"discord","main":"index.js"}`
	equicordRepo   = "Equicord/Equicord"
	mbOK           = 0x0
	mbYesNoCancel  = 0x3
	mbIconError    = 0x10
	mbIconQuestion = 0x20
	mbIconInfo     = 0x40
	mbTopmost      = 0x40000
	idYes          = 6
	idNo           = 7
)

var (
	messageBox = syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	silent     bool
	logFile    *os.File
	httpClient = &http.Client{Timeout: 10 * time.Minute}
)

func message(text string, flags uintptr) int {
	if silent {
		fmt.Println(text)
		return idYes
	}
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(title)
	r, _, _ := messageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags|mbTopmost)
	return int(r)
}

func say(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	fmt.Println(line)
	if logFile != nil {
		fmt.Fprintln(logFile, line)
	}
}

func workDir() string      { return filepath.Join(os.Getenv("LOCALAPPDATA"), "Cordmuffin") }
func distDir() string      { return filepath.Join(workDir(), "dist") }
func equicordData() string { return filepath.Join(os.Getenv("APPDATA"), "Equicord") }

func kitDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(exe)
}

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return cmd
}

func download(url, dest string) error {
	resp, err := httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %s", url, resp.Status)
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, resp.Body)
	return err
}

func unzip(src, dest string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	root, _ := filepath.Abs(dest)
	for _, f := range r.File {
		target := filepath.Join(dest, f.Name)
		if abs, _ := filepath.Abs(target); !strings.HasPrefix(abs, root+string(os.PathSeparator)) && abs != root {
			return fmt.Errorf("unsafe path in zip: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			os.MkdirAll(target, 0o755)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		in, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(target)
		if err != nil {
			in.Close()
			return err
		}
		_, err = io.Copy(out, in)
		in.Close()
		out.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func singleSubdir(dir string) string {
	entries, _ := os.ReadDir(dir)
	if len(entries) == 1 && entries[0].IsDir() {
		return filepath.Join(dir, entries[0].Name())
	}
	return dir
}

func copyTree(src, dest string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

func ensureNode() (string, error) {
	nodeRoot := filepath.Join(workDir(), "node")
	if exe, err := filepath.Glob(filepath.Join(nodeRoot, "*", "node.exe")); err == nil && len(exe) > 0 {
		return filepath.Dir(exe[0]), nil
	}

	say("Downloading Node.js (needed to build Equicord)...")
	resp, err := httpClient.Get("https://nodejs.org/dist/index.json")
	if err != nil {
		return "", err
	}
	var releases []struct {
		Version string   `json:"version"`
		LTS     any      `json:"lts"`
		Files   []string `json:"files"`
	}
	err = json.NewDecoder(resp.Body).Decode(&releases)
	resp.Body.Close()
	if err != nil {
		return "", err
	}

	version := ""
	for _, r := range releases {
		major, _ := strconv.Atoi(strings.SplitN(strings.TrimPrefix(r.Version, "v"), ".", 2)[0])
		if lts, ok := r.LTS.(string); ok && lts != "" && major >= 22 && major <= 24 {
			version = r.Version
			break
		}
	}
	if version == "" {
		return "", errors.New("couldn't find a Node.js version to download")
	}

	zipPath := filepath.Join(workDir(), "node.zip")
	if err := download(fmt.Sprintf("https://nodejs.org/dist/%s/node-%s-win-x64.zip", version, version), zipPath); err != nil {
		return "", err
	}
	defer os.Remove(zipPath)
	os.RemoveAll(nodeRoot)
	if err := unzip(zipPath, nodeRoot); err != nil {
		return "", err
	}
	exe, _ := filepath.Glob(filepath.Join(nodeRoot, "*", "node.exe"))
	if len(exe) == 0 {
		return "", errors.New("Node.js download looks broken")
	}
	return filepath.Dir(exe[0]), nil
}

func latestEquicordCommit() (string, error) {
	req, _ := http.NewRequest("GET", "https://api.github.com/repos/"+equicordRepo+"/commits/main", nil)
	req.Header.Set("Accept", "application/vnd.github.sha")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	sha := strings.TrimSpace(string(body))
	if resp.StatusCode != http.StatusOK || len(sha) != 40 {
		return "", fmt.Errorf("GitHub didn't say which Equicord version is newest (%s)", resp.Status)
	}
	return sha, nil
}

func downloadEquicord(sha string) (string, error) {
	src := filepath.Join(workDir(), "equicord")
	marker := filepath.Join(src, ".commit")
	if data, err := os.ReadFile(marker); err == nil && strings.TrimSpace(string(data)) == sha {
		os.RemoveAll(filepath.Join(src, "src", "userplugins"))
		return src, nil
	}

	say("Downloading the newest Equicord...")
	zipPath := filepath.Join(workDir(), "equicord.zip")
	if err := download("https://codeload.github.com/"+equicordRepo+"/zip/"+sha, zipPath); err != nil {
		return "", err
	}
	defer os.Remove(zipPath)
	tmp := filepath.Join(workDir(), "equicord-new")
	os.RemoveAll(tmp)
	if err := unzip(zipPath, tmp); err != nil {
		return "", err
	}
	os.RemoveAll(src)
	if err := os.Rename(singleSubdir(tmp), src); err != nil {
		return "", err
	}
	os.RemoveAll(tmp)
	return src, os.WriteFile(marker, []byte(sha), 0o644)
}

func findPluginRoots(dir string, depth int) []string {
	for _, entry := range []string{"index.ts", "index.tsx"} {
		if _, err := os.Stat(filepath.Join(dir, entry)); err == nil {
			return []string{dir}
		}
	}
	if depth == 0 {
		return nil
	}
	var roots []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") && e.Name() != "node_modules" {
			roots = append(roots, findPluginRoots(filepath.Join(dir, e.Name()), depth-1)...)
		}
	}
	return roots
}

func pluginName(root string) string {
	name := strings.Map(func(r rune) rune {
		if r == '.' || r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' {
			return r
		}
		return -1
	}, filepath.Base(root))
	if name == "" {
		name = "plugin"
	}
	return name
}

func addPlugins(src string) ([]string, []string) {
	dest := filepath.Join(src, "src", "userplugins")
	os.MkdirAll(dest, 0o755)
	inbox := filepath.Join(kitDir(), pluginsFolder)
	os.MkdirAll(inbox, 0o755)
	tmp := filepath.Join(workDir(), "unzipped-plugins")
	os.RemoveAll(tmp)
	defer os.RemoveAll(tmp)

	var added, skipped []string
	entries, _ := os.ReadDir(inbox)
	for _, e := range entries {
		path := filepath.Join(inbox, e.Name())
		if !e.IsDir() && strings.EqualFold(filepath.Ext(e.Name()), ".zip") {
			out := filepath.Join(tmp, strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())))
			if err := unzip(path, out); err != nil {
				skipped = append(skipped, e.Name()+" (couldn't open the zip)")
				continue
			}
			path = out
		} else if !e.IsDir() {
			if !strings.EqualFold(e.Name(), "README.txt") {
				skipped = append(skipped, e.Name()+" (put each plugin in its own folder)")
			}
			continue
		}

		roots := findPluginRoots(path, 3)
		if len(roots) == 0 {
			skipped = append(skipped, e.Name()+" (no index.ts or index.tsx inside)")
			continue
		}
		for _, root := range roots {
			name := pluginName(root)
			if err := copyTree(root, filepath.Join(dest, name)); err != nil {
				skipped = append(skipped, name+" ("+err.Error()+")")
				continue
			}
			added = append(added, name)
		}
	}
	return added, skipped
}

func addThemes() ([]string, error) {
	inbox := filepath.Join(kitDir(), themesFolder)
	os.MkdirAll(inbox, 0o755)
	themesDir := filepath.Join(equicordData(), "themes")
	var added []string
	err := filepath.WalkDir(inbox, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".css") {
			return err
		}
		if err := os.MkdirAll(themesDir, 0o755); err != nil {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(themesDir, d.Name()), data, 0o644); err != nil {
			return err
		}
		added = append(added, d.Name())
		return nil
	})
	if err != nil || len(added) == 0 {
		return added, err
	}

	settingsPath := filepath.Join(equicordData(), "settings", "settings.json")
	settings := map[string]any{}
	if data, err := os.ReadFile(settingsPath); err == nil {
		if err := json.Unmarshal(data, &settings); err != nil {
			return added, errors.New("your Equicord settings file is damaged, so themes were copied but not turned on")
		}
	}
	enabled, _ := settings["enabledThemes"].([]any)
	for _, name := range added {
		found := false
		for _, existing := range enabled {
			if existing == name {
				found = true
			}
		}
		if !found {
			enabled = append(enabled, name)
		}
	}
	settings["enabledThemes"] = enabled
	data, _ := json.MarshalIndent(settings, "", "    ")
	os.MkdirAll(filepath.Dir(settingsPath), 0o755)
	return added, os.WriteFile(settingsPath, data, 0o644)
}

func runStep(dir, nodeDir, sha string, args ...string) error {
	corepack := filepath.Join(nodeDir, "node_modules", "corepack", "dist", "corepack.js")
	cmd := hidden(exec.Command(filepath.Join(nodeDir, "node.exe"), append([]string{corepack}, args...)...))
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"PATH="+nodeDir+";"+os.Getenv("PATH"),
		"COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
		"COREPACK_HOME="+filepath.Join(workDir(), "corepack"),
		"EQUICORD_HASH="+sha,
		"EQUICORD_REMOTE="+equicordRepo,
		"CI=true",
	)
	out, err := cmd.CombinedOutput()
	if logFile != nil {
		logFile.Write(out)
	}
	if err != nil {
		lines := strings.Split(strings.TrimSpace(string(out)), "\n")
		if len(lines) > 8 {
			lines = lines[len(lines)-8:]
		}
		return fmt.Errorf("%v\n%s", err, strings.Join(lines, "\n"))
	}
	return nil
}

func build() ([]string, []string, error) {
	nodeDir, err := ensureNode()
	if err != nil {
		return nil, nil, fmt.Errorf("couldn't get Node.js: %w", err)
	}
	sha, err := latestEquicordCommit()
	if err != nil {
		return nil, nil, err
	}
	src, err := downloadEquicord(sha)
	if err != nil {
		return nil, nil, fmt.Errorf("couldn't download Equicord: %w", err)
	}

	added, skipped := addPlugins(src)
	for _, p := range added {
		say("  Adding plugin: %s", p)
	}

	say("Installing Equicord's parts (the first time takes a few minutes)...")
	if err := runStep(src, nodeDir, sha, "pnpm", "install", "--frozen-lockfile"); err != nil {
		return added, skipped, fmt.Errorf("installing Equicord's parts failed: %w", err)
	}
	say("Building Equicord with your plugins...")
	if err := runStep(src, nodeDir, sha, "pnpm", "build", "--disable-updater"); err != nil {
		return added, skipped, fmt.Errorf("building failed (a plugin in %q may be broken): %w", pluginsFolder, err)
	}

	os.RemoveAll(distDir())
	if err := copyTree(filepath.Join(src, "dist", "desktop"), distDir()); err != nil {
		return added, skipped, err
	}
	return added, skipped, nil
}

type discordInstall struct {
	name     string
	root     string
	exe      string
	versions []string
}

func versionLess(a, b string) bool {
	pa := strings.Split(strings.TrimPrefix(filepath.Base(a), "app-"), ".")
	pb := strings.Split(strings.TrimPrefix(filepath.Base(b), "app-"), ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func findInstalls() []discordInstall {
	local := os.Getenv("LOCALAPPDATA")
	var installs []discordInstall
	for _, flavor := range [][3]string{{"Discord", "Discord", "Discord.exe"}, {"Discord PTB", "DiscordPTB", "DiscordPTB.exe"}, {"Discord Canary", "DiscordCanary", "DiscordCanary.exe"}} {
		root := filepath.Join(local, flavor[1])
		matches, _ := filepath.Glob(filepath.Join(root, "app-*"))
		var versions []string
		for _, m := range matches {
			if info, err := os.Stat(filepath.Join(m, "resources")); err == nil && info.IsDir() {
				versions = append(versions, m)
			}
		}
		if len(versions) == 0 {
			continue
		}
		sort.Slice(versions, func(i, j int) bool { return versionLess(versions[i], versions[j]) })
		installs = append(installs, discordInstall{name: flavor[0], root: root, exe: flavor[2], versions: versions})
	}
	return installs
}

func psQuote(s string) string { return strings.ReplaceAll(s, "'", "''") }

func discordRunning(root string) bool {
	out, _ := hidden(exec.Command("powershell", "-NoProfile", "-Command",
		fmt.Sprintf("@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('%s', 'OrdinalIgnoreCase') }).Count", psQuote(root)))).Output()
	return strings.TrimSpace(string(out)) != "0"
}

func closeDiscord(root string) error {
	if !discordRunning(root) {
		return nil
	}
	hidden(exec.Command("powershell", "-NoProfile", "-Command",
		fmt.Sprintf("Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('%s', 'OrdinalIgnoreCase') } | Stop-Process -Force", psQuote(root)))).Run()
	for i := 0; i < 40; i++ {
		time.Sleep(250 * time.Millisecond)
		if !discordRunning(root) {
			time.Sleep(500 * time.Millisecond)
			return nil
		}
	}
	return errors.New("Discord wouldn't close. Close it from the system tray and run this again")
}

func startDiscord(d discordInstall) {
	update := filepath.Join(d.root, "Update.exe")
	if _, err := os.Stat(update); err == nil {
		hidden(exec.Command(update, "--processStart", d.exe)).Start()
	}
}

func stubIndex() string {
	patcher, _ := json.Marshal(filepath.Join(distDir(), "patcher.js"))
	return fmt.Sprintf("require(%s);", patcher)
}

func isOurs(appDir string) bool {
	data, err := os.ReadFile(filepath.Join(appDir, "index.js"))
	return err == nil && strings.Contains(string(data), "Cordmuffin")
}

func patch(resources string) error {
	app := filepath.Join(resources, "app.asar")
	original := filepath.Join(resources, "_app.asar")
	info, err := os.Stat(app)
	if err != nil {
		return errors.New("its app.asar is missing, so reinstall Discord first")
	}

	if info.IsDir() {
		index := filepath.Join(app, "index.js")
		if !isOurs(app) {
			if _, err := os.Stat(index + backupSuffix); errors.Is(err, fs.ErrNotExist) {
				if data, err := os.ReadFile(index); err == nil {
					if err := os.WriteFile(index+backupSuffix, data, 0o644); err != nil {
						return err
					}
				}
			}
		}
		return os.WriteFile(index, []byte(stubIndex()), 0o644)
	}

	if _, err := os.Stat(original); err == nil {
		return errors.New("it looks half-patched by another mod, so reinstall Discord first")
	}
	if err := os.Rename(app, original); err != nil {
		return err
	}
	if err := os.Mkdir(app, 0o755); err != nil {
		os.Rename(original, app)
		return err
	}
	if err := os.WriteFile(filepath.Join(app, "package.json"), []byte(stubPackage), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(app, "index.js"), []byte(stubIndex()), 0o644)
}

func unpatch(resources string) error {
	app := filepath.Join(resources, "app.asar")
	original := filepath.Join(resources, "_app.asar")
	index := filepath.Join(app, "index.js")

	if data, err := os.ReadFile(index + backupSuffix); err == nil {
		if err := os.WriteFile(index, data, 0o644); err != nil {
			return err
		}
		return os.Remove(index + backupSuffix)
	}
	if !isOurs(app) {
		return nil
	}
	if err := os.RemoveAll(app); err != nil {
		return err
	}
	return os.Rename(original, app)
}

func install() {
	installs := findInstalls()
	if len(installs) == 0 {
		message("Couldn't find Discord on this PC. Install Discord from discord.com, open it once, then run this again.", mbOK|mbIconError)
		return
	}

	say("Step 1 of 3: Getting Equicord ready")
	added, skipped, err := build()
	if err != nil {
		say("Failed: %v", err)
		message(fmt.Sprintf("Something went wrong, so Discord wasn't changed.\n\n%v\n\nThe full log is at:\n%s", err, filepath.Join(workDir(), "install.log")), mbOK|mbIconError)
		return
	}

	say("Step 2 of 3: Adding themes")
	themes, themeErr := addThemes()

	say("Step 3 of 3: Putting Equicord into Discord")
	var done, failed []string
	for _, d := range installs {
		if err := closeDiscord(d.root); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v.", d.name, err))
			continue
		}
		if err := patch(filepath.Join(d.versions[len(d.versions)-1], "resources")); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v.", d.name, err))
		} else {
			done = append(done, d.name)
		}
		startDiscord(d)
	}

	var text strings.Builder
	if len(done) > 0 {
		fmt.Fprintf(&text, "Equicord is installed into %s and Discord is reopening.", strings.Join(done, ", "))
	}
	if len(added) > 0 {
		fmt.Fprintf(&text, "\n\nPlugins added: %s\nTurn them on in Discord: User Settings, then Plugins.", strings.Join(added, ", "))
	}
	if len(themes) > 0 {
		fmt.Fprintf(&text, "\n\nThemes added and turned on: %s", strings.Join(themes, ", "))
	}
	if len(skipped) > 0 {
		fmt.Fprintf(&text, "\n\nSkipped:\n%s", strings.Join(skipped, "\n"))
	}
	if themeErr != nil {
		fmt.Fprintf(&text, "\n\nThemes problem: %v", themeErr)
	}
	if len(failed) > 0 {
		fmt.Fprintf(&text, "\n\nSomething went wrong:\n%s", strings.Join(failed, "\n"))
	}
	flags := uintptr(mbIconInfo)
	if len(failed) > 0 {
		flags = mbIconError
	}
	say("Done.")
	message(strings.TrimSpace(text.String()), mbOK|flags)
}

func uninstall() {
	var done, failed []string
	for _, d := range findInstalls() {
		wasRunning := discordRunning(d.root)
		if err := closeDiscord(d.root); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v.", d.name, err))
			continue
		}
		var err error
		for _, v := range d.versions {
			if e := unpatch(filepath.Join(v, "resources")); e != nil {
				err = e
			}
		}
		if err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v.", d.name, err))
		} else {
			done = append(done, d.name)
		}
		if wasRunning {
			startDiscord(d)
		}
	}
	if len(failed) == 0 {
		if logFile != nil {
			logFile.Close()
			logFile = nil
		}
		os.RemoveAll(workDir())
		message("Equicord is removed. Discord is back to how it was before.\n\nYour Equicord settings and themes are kept in case you install it again.", mbOK|mbIconInfo)
		return
	}
	message("Something went wrong:\n"+strings.Join(failed, "\n"), mbOK|mbIconError)
}

func main() {
	os.MkdirAll(workDir(), 0o755)
	logFile, _ = os.Create(filepath.Join(workDir(), "install.log"))
	os.MkdirAll(filepath.Join(kitDir(), pluginsFolder), 0o755)
	os.MkdirAll(filepath.Join(kitDir(), themesFolder), 0o755)

	if len(os.Args) > 1 {
		silent = true
		switch strings.ToLower(os.Args[1]) {
		case "/install":
			install()
		case "/uninstall":
			uninstall()
		}
		return
	}

	switch message(fmt.Sprintf("Install Equicord into Discord?\n\nAny plugins in the %q folder and themes in the %q folder get added too.\n\nYes: install or update\nNo: remove Equicord\nCancel: do nothing\n\nDiscord will close and reopen by itself. The first install takes a few minutes.", pluginsFolder, themesFolder), mbYesNoCancel|mbIconQuestion) {
	case idYes:
		install()
	case idNo:
		uninstall()
	default:
		return
	}
	if !silent {
		fmt.Print("\nPress Enter to close this window.")
		bufio.NewReader(os.Stdin).ReadString('\n')
	}
}
