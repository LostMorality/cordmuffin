package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	title         = "Cordmuffin Equicord Installer"
	pluginsFolder = "Plugins Go Here"
	themesFolder  = "Themes Go Here"
	backupSuffix  = ".cordmuffin-backup"
	stubMarker    = "/* cordmuffin */"
	stubPackage   = `{"name":"discord","main":"index.js"}`
	equicordRepo  = "Equicord/Equicord"

	mbOK           = 0x0
	mbYesNoCancel  = 0x3
	mbYesNo        = 0x4
	mbIconError    = 0x10
	mbIconQuestion = 0x20
	mbIconWarning  = 0x30
	mbIconInfo     = 0x40
	mbTopmost      = 0x40000
	idYes          = 6
	idNo           = 7

	processTerminate     = 0x0001
	processQueryLimited  = 0x1000
	errorAlreadyExists   = 183
	idleDownloadTimeout  = 60 * time.Second
	stepProgressInterval = 5 * time.Second
)

var (
	user32                    = syscall.NewLazyDLL("user32.dll")
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	messageBox                = user32.NewProc("MessageBoxW")
	createMutex               = kernel32.NewProc("CreateMutexW")
	queryFullProcessImageName = kernel32.NewProc("QueryFullProcessImageNameW")

	silent    bool
	runFailed bool
	logFile   *os.File

	httpClient = &http.Client{Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}}
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

func fail(text string) {
	runFailed = true
	message(text, mbOK|mbIconError)
}

func say(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	fmt.Println(line)
	if logFile != nil {
		fmt.Fprintln(logFile, line)
	}
}

func workDir() string          { return filepath.Join(os.Getenv("LOCALAPPDATA"), "Cordmuffin") }
func distDir() string          { return filepath.Join(workDir(), "dist") }
func equicordData() string     { return filepath.Join(os.Getenv("APPDATA"), "Equicord") }
func muffinshelfSaved() string { return filepath.Join(equicordData(), "muffinshelf", "userplugins") }

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

// Antivirus scanners and exiting Discord processes hold files for a moment, so file moves retry briefly.
func retry(op func() error) error {
	var err error
	for i := 0; i < 10; i++ {
		if err = op(); err == nil {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return err
}

func rename(from, to string) error { return retry(func() error { return os.Rename(from, to) }) }
func removeAll(path string) error  { return retry(func() error { return os.RemoveAll(path) }) }
func exists(path string) bool      { _, err := os.Stat(path); return err == nil }
func isFile(path string) bool      { info, err := os.Stat(path); return err == nil && !info.IsDir() }
func isDir(path string) bool       { info, err := os.Stat(path); return err == nil && info.IsDir() }
func lockedHint(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, fs.ErrPermission) || strings.Contains(strings.ToLower(err.Error()), "being used by another process") {
		return fmt.Errorf("%w. Close Discord from the system tray, or pause your antivirus for a minute, and run this again", err)
	}
	return err
}

func friendlyNetError(target string, err error) error {
	host := target
	if u, perr := url.Parse(target); perr == nil {
		host = u.Host
	}
	return fmt.Errorf("couldn't download from %s. Check your internet connection and try again (%v)", host, err)
}

type progressReader struct {
	r    io.Reader
	last *atomic.Int64
}

func (p progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.last.Store(time.Now().UnixNano())
	}
	return n, err
}

// Downloads to a .part file and only renames it into place once complete. A stalled download is cut off
// after a minute without data, but a slow one is allowed to take as long as it needs.
func download(target, dest string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "cordmuffin-installer")
	resp, err := httpClient.Do(req)
	if err != nil {
		return friendlyNetError(target, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return friendlyNetError(target, errors.New(resp.Status))
	}

	part := dest + ".part"
	out, err := os.Create(part)
	if err != nil {
		return err
	}
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				if time.Since(time.Unix(0, last.Load())) > idleDownloadTimeout {
					cancel()
					return
				}
			}
		}
	}()
	_, err = io.Copy(out, progressReader{resp.Body, &last})
	close(done)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(part)
		return friendlyNetError(target, err)
	}
	os.Remove(dest)
	return rename(part, dest)
}

func getJSON(target string, into any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "cordmuffin-installer")
	resp, err := httpClient.Do(req)
	if err != nil {
		return friendlyNetError(target, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return friendlyNetError(target, errors.New(resp.Status))
	}
	if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
		return friendlyNetError(target, err)
	}
	return nil
}

func unzip(src, dest string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	for _, f := range r.File {
		name := filepath.FromSlash(strings.ReplaceAll(f.Name, `\`, "/"))
		if !filepath.IsLocal(name) {
			return fmt.Errorf("unsafe path in zip: %s", f.Name)
		}
		target := filepath.Join(dest, name)
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
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
		if cerr := out.Close(); err == nil {
			err = cerr
		}
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
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
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

func nodeReady(dir string) bool {
	return isFile(filepath.Join(dir, "node.exe")) && isFile(filepath.Join(dir, "node_modules", "corepack", "dist", "corepack.js"))
}

func ensureNode() (string, error) {
	nodeRoot := filepath.Join(workDir(), "node")
	if dirs, _ := filepath.Glob(filepath.Join(nodeRoot, "*")); len(dirs) > 0 {
		for _, dir := range dirs {
			if nodeReady(dir) {
				return dir, nil
			}
		}
	}

	say("Downloading Node.js (needed to build Equicord)...")
	var releases []struct {
		Version string `json:"version"`
		LTS     any    `json:"lts"`
	}
	if err := getJSON("https://nodejs.org/dist/index.json", &releases); err != nil {
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
	tmp := nodeRoot + ".tmp"
	removeAll(tmp)
	if err := unzip(zipPath, tmp); err != nil {
		removeAll(tmp)
		return "", err
	}
	removeAll(nodeRoot)
	if err := rename(tmp, nodeRoot); err != nil {
		return "", err
	}
	dirs, _ := filepath.Glob(filepath.Join(nodeRoot, "*"))
	for _, dir := range dirs {
		if nodeReady(dir) {
			return dir, nil
		}
	}
	return "", errors.New("the Node.js download looks broken. Run this again to download it fresh")
}

func latestEquicordCommit() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+equicordRepo+"/commits/main", nil)
	req.Header.Set("Accept", "application/vnd.github.sha")
	req.Header.Set("User-Agent", "cordmuffin-installer")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", friendlyNetError("https://api.github.com", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	sha := strings.TrimSpace(string(body))
	if resp.StatusCode != http.StatusOK || len(sha) != 40 {
		return "", fmt.Errorf("GitHub didn't say which Equicord version is newest (%s). Try again in a few minutes", resp.Status)
	}
	return sha, nil
}

func cachedCommit() string {
	data, err := os.ReadFile(filepath.Join(workDir(), "equicord", ".commit"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func downloadEquicord(sha string) (string, error) {
	src := filepath.Join(workDir(), "equicord")
	if cachedCommit() == sha && isDir(src) {
		return src, removeAll(filepath.Join(src, "src", "userplugins"))
	}

	say("Downloading the newest Equicord...")
	zipPath := filepath.Join(workDir(), "equicord.zip")
	if err := download("https://codeload.github.com/"+equicordRepo+"/zip/"+sha, zipPath); err != nil {
		return "", err
	}
	defer os.Remove(zipPath)
	tmp := filepath.Join(workDir(), "equicord-new")
	removeAll(tmp)
	if err := unzip(zipPath, tmp); err != nil {
		removeAll(tmp)
		return "", err
	}
	if err := removeAll(src); err != nil {
		return "", lockedHint(err)
	}
	if err := rename(singleSubdir(tmp), src); err != nil {
		return "", lockedHint(err)
	}
	removeAll(tmp)
	return src, os.WriteFile(filepath.Join(src, ".commit"), []byte(sha), 0o644)
}

func findPluginRoots(dir string, depth int) []string {
	for _, entry := range []string{"index.ts", "index.tsx"} {
		if isFile(filepath.Join(dir, entry)) {
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

func cleanName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r == '.' || r == '_' || r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' {
			return r
		}
		return -1
	}, name)
	name = strings.TrimLeft(name, ".-")
	if name == "" {
		name = "plugin"
	}
	return name
}

func uniqueName(dest, name, ext string) string {
	candidate := name
	for i := 2; exists(filepath.Join(dest, candidate+ext)); i++ {
		candidate = fmt.Sprintf("%s-%d", name, i)
	}
	return candidate
}

func addPlugins(src string) (added, kept, skipped []string, err error) {
	dest := filepath.Join(src, "src", "userplugins")
	if err = os.MkdirAll(dest, 0o755); err != nil {
		return
	}
	inbox := filepath.Join(kitDir(), pluginsFolder)
	os.MkdirAll(inbox, 0o755)
	tmp := filepath.Join(workDir(), "unzipped-plugins")
	removeAll(tmp)
	defer removeAll(tmp)

	entries, _ := os.ReadDir(inbox)
	for _, e := range entries {
		path := filepath.Join(inbox, e.Name())
		ext := strings.ToLower(filepath.Ext(e.Name()))
		switch {
		case e.IsDir():
		case ext == ".zip":
			out := filepath.Join(tmp, strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())))
			if uerr := unzip(path, out); uerr != nil {
				skipped = append(skipped, e.Name()+" (couldn't open the zip)")
				continue
			}
			path = out
		case ext == ".ts" || ext == ".tsx":
			name := uniqueName(dest, cleanName(strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))), ext)
			data, rerr := os.ReadFile(path)
			if rerr == nil {
				rerr = os.WriteFile(filepath.Join(dest, name+ext), data, 0o644)
			}
			if rerr != nil {
				skipped = append(skipped, e.Name()+" ("+rerr.Error()+")")
				continue
			}
			added = append(added, name)
			continue
		case strings.HasSuffix(strings.ToLower(e.Name()), ".plugin.js"):
			skipped = append(skipped, e.Name()+" (that's a BetterDiscord plugin. Install it from Muffinshelf inside Discord instead)")
			continue
		default:
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
			base := filepath.Base(root)
			if root == path || strings.EqualFold(base, "src") {
				base = strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
			}
			name := uniqueName(dest, cleanName(base), "")
			if cerr := copyTree(root, filepath.Join(dest, name)); cerr != nil {
				skipped = append(skipped, name+" ("+cerr.Error()+")")
				continue
			}
			added = append(added, name)
		}
	}

	saved, _ := os.ReadDir(muffinshelfSaved())
	for _, e := range saved {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || exists(filepath.Join(dest, e.Name())) {
			continue
		}
		if cerr := copyTree(filepath.Join(muffinshelfSaved(), e.Name()), filepath.Join(dest, e.Name())); cerr == nil {
			kept = append(kept, e.Name())
		}
	}
	return
}

func addThemes() ([]string, []string, error) {
	inbox := filepath.Join(kitDir(), themesFolder)
	os.MkdirAll(inbox, 0o755)
	themesDir := filepath.Join(equicordData(), "themes")
	var added, skipped []string
	seen := map[string]bool{}
	err := filepath.WalkDir(inbox, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(path), ".css") {
			return err
		}
		key := strings.ToLower(d.Name())
		if seen[key] {
			skipped = append(skipped, d.Name()+" (another theme already has this file name)")
			return nil
		}
		seen[key] = true
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
		return added, skipped, err
	}

	settingsPath := filepath.Join(equicordData(), "settings", "settings.json")
	settings := map[string]any{}
	if data, rerr := os.ReadFile(settingsPath); rerr == nil {
		data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
		dec := json.NewDecoder(bytes.NewReader(data))
		dec.UseNumber()
		if len(bytes.TrimSpace(data)) > 0 {
			if derr := dec.Decode(&settings); derr != nil {
				return added, skipped, errors.New("your Equicord settings file is damaged, so themes were copied but not turned on. Turn them on in Discord: User Settings, then Themes")
			}
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
	data, err := json.MarshalIndent(settings, "", "    ")
	if err != nil {
		return added, skipped, err
	}
	if err := os.MkdirAll(filepath.Dir(settingsPath), 0o755); err != nil {
		return added, skipped, err
	}
	return added, skipped, os.WriteFile(settingsPath, data, 0o644)
}

type tailBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > 64*1024 {
		t.buf = t.buf[len(t.buf)-32*1024:]
	}
	return len(p), nil
}

func (t *tailBuffer) lastLines(n int) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(string(t.buf)), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func runStep(dir, nodeDir, sha string, args ...string) error {
	corepack := filepath.Join(nodeDir, "node_modules", "corepack", "dist", "corepack.js")
	cmd := hidden(exec.Command(filepath.Join(nodeDir, "node.exe"), append([]string{corepack}, args...)...))
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"PATH="+nodeDir+";"+os.Getenv("PATH"),
		"COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
		"COREPACK_HOME="+filepath.Join(workDir(), "corepack"),
		"LOCALAPPDATA="+filepath.Join(workDir(), "pnpm-home"),
		"PNPM_HOME="+filepath.Join(workDir(), "pnpm-home"),
		"pnpm_config_store_dir="+filepath.Join(workDir(), "pnpm-home", "store"),
		"pnpm_config_cache_dir="+filepath.Join(workDir(), "pnpm-home", "cache"),
		"EQUICORD_HASH="+sha,
		"EQUICORD_REMOTE="+equicordRepo,
		"CI=true",
	)
	tail := &tailBuffer{}
	var out io.Writer = tail
	if logFile != nil {
		out = io.MultiWriter(logFile, tail)
	}
	cmd.Stdout = out
	cmd.Stderr = out

	if err := cmd.Start(); err != nil {
		return err
	}
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	ticker := time.NewTicker(stepProgressInterval)
	defer ticker.Stop()
	for {
		select {
		case err := <-finished:
			if err != nil {
				return fmt.Errorf("%v\n%s", err, tail.lastLines(8))
			}
			return nil
		case <-ticker.C:
			fmt.Print(".")
		}
	}
}

type buildResult struct {
	added, kept, skipped []string
	staged               string
}

func build() (buildResult, error) {
	var res buildResult
	nodeDir, err := ensureNode()
	if err != nil {
		return res, fmt.Errorf("couldn't get Node.js: %w", err)
	}
	sha, err := latestEquicordCommit()
	if err != nil {
		cached := cachedCommit()
		if cached == "" {
			return res, err
		}
		say("Couldn't check for a newer Equicord (%v), so the one already downloaded is used.", err)
		sha = cached
	}
	src, err := downloadEquicord(sha)
	if err != nil {
		return res, fmt.Errorf("couldn't download Equicord: %w", err)
	}

	res.added, res.kept, res.skipped, err = addPlugins(src)
	if err != nil {
		return res, err
	}
	for _, p := range res.added {
		say("  Adding plugin: %s", p)
	}
	for _, p := range res.kept {
		say("  Keeping Muffinshelf plugin: %s", p)
	}

	say("Installing Equicord's parts (the first time takes a few minutes)...")
	if err := runStep(src, nodeDir, sha, "pnpm", "install", "--frozen-lockfile"); err != nil {
		return res, fmt.Errorf("installing Equicord's parts failed: %w", err)
	}
	fmt.Println()
	say("Building Equicord...")
	if err := runStep(src, nodeDir, sha, "pnpm", "build", "--disable-updater"); err != nil {
		if len(res.added)+len(res.kept) > 0 {
			return res, fmt.Errorf("building failed. One of your plugins is probably broken, so try again without it: %w", err)
		}
		return res, fmt.Errorf("building failed: %w", err)
	}
	fmt.Println()

	res.staged = distDir() + ".new"
	removeAll(res.staged)
	if err := copyTree(filepath.Join(src, "dist", "desktop"), res.staged); err != nil {
		removeAll(res.staged)
		return res, err
	}
	return res, nil
}

// Swaps the freshly built files in so Discord never sees a half-copied dist folder.
func swapDist(staged string) error {
	old := distDir() + ".old"
	removeAll(old)
	if exists(distDir()) {
		if err := rename(distDir(), old); err != nil {
			return lockedHint(err)
		}
	}
	if err := rename(staged, distDir()); err != nil {
		if exists(old) {
			rename(old, distDir())
		}
		return lockedHint(err)
	}
	removeAll(old)
	return nil
}

type discordInstall struct {
	name     string
	root     string
	exe      string
	versions []string
}

func (d discordInstall) latest() string { return d.versions[len(d.versions)-1] }

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
			if isDir(filepath.Join(m, "resources")) {
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

func processPath(pid uint32) string {
	h, err := syscall.OpenProcess(processQueryLimited, false, pid)
	if err != nil {
		return ""
	}
	defer syscall.CloseHandle(h)
	buf := make([]uint16, 1024)
	size := uint32(len(buf))
	r, _, _ := queryFullProcessImageName.Call(uintptr(h), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	if r == 0 {
		return ""
	}
	return syscall.UTF16ToString(buf[:size])
}

func discordProcesses(root string) []uint32 {
	snap, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer syscall.CloseHandle(snap)
	prefix := strings.ToLower(root + `\`)
	var pids []uint32
	var entry syscall.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = syscall.Process32First(snap, &entry); err == nil; err = syscall.Process32Next(snap, &entry) {
		if !strings.HasPrefix(strings.ToLower(syscall.UTF16ToString(entry.ExeFile[:])), "discord") {
			continue
		}
		if path := processPath(entry.ProcessID); path != "" && strings.HasPrefix(strings.ToLower(path), prefix) {
			pids = append(pids, entry.ProcessID)
		}
	}
	return pids
}

func discordRunning(root string) bool { return len(discordProcesses(root)) > 0 }

func closeDiscord(root string) error {
	for attempt := 0; attempt < 40; attempt++ {
		pids := discordProcesses(root)
		if len(pids) == 0 {
			if attempt > 0 {
				time.Sleep(500 * time.Millisecond)
			}
			return nil
		}
		for _, pid := range pids {
			if h, err := syscall.OpenProcess(processTerminate, false, pid); err == nil {
				syscall.TerminateProcess(h, 0)
				syscall.CloseHandle(h)
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return errors.New("Discord wouldn't close. Close it from the system tray and run this again")
}

func startDiscord(d discordInstall) {
	update := filepath.Join(d.root, "Update.exe")
	if isFile(update) {
		hidden(exec.Command(update, "--processStart", d.exe)).Start()
	}
}

// If Equicord's files ever go missing, the shim falls back to plain Discord instead of crashing on start.
func stubIndex() string {
	patcher, _ := json.Marshal(filepath.Join(distDir(), "patcher.js"))
	return stubMarker + `
const { existsSync } = require("fs");
const { join } = require("path");
const patcher = ` + string(patcher) + `;
if (existsSync(patcher)) {
    require(patcher);
} else {
    const asar = join(__dirname, "..", "_app.asar");
    const pkg = require(join(asar, "package.json"));
    require.main.filename = join(asar, pkg.main);
    require("electron").app.setAppPath(asar);
    require(require.main.filename);
}
`
}

func isOurs(appDir string) bool {
	data, err := os.ReadFile(filepath.Join(appDir, "index.js"))
	if err != nil {
		return false
	}
	s := string(data)
	return strings.Contains(s, stubMarker) || strings.Contains(strings.ToLower(s), "cordmuffin")
}

// A run that was cut off between renaming app.asar and creating the shim leaves only _app.asar behind.
func repairInterrupted(resources string) error {
	app := filepath.Join(resources, "app.asar")
	original := filepath.Join(resources, "_app.asar")
	if !exists(app) && isFile(original) {
		return rename(original, app)
	}
	return nil
}

func writeShim(app string) error {
	if err := os.WriteFile(filepath.Join(app, "package.json"), []byte(stubPackage), 0o644); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(app, "index.js"), []byte(stubIndex()), 0o644)
}

func patch(resources string) error {
	if err := repairInterrupted(resources); err != nil {
		return lockedHint(err)
	}
	app := filepath.Join(resources, "app.asar")
	original := filepath.Join(resources, "_app.asar")
	info, err := os.Stat(app)
	if err != nil {
		return errors.New("its app.asar is missing, so reinstall Discord first")
	}

	if info.IsDir() {
		index := filepath.Join(app, "index.js")
		if !isOurs(app) && !exists(index+backupSuffix) {
			if data, rerr := os.ReadFile(index); rerr == nil {
				if werr := os.WriteFile(index+backupSuffix, data, 0o644); werr != nil {
					return werr
				}
			}
		}
		return writeShim(app)
	}

	if exists(original) {
		return errors.New("it looks half-patched by another mod, so reinstall Discord first")
	}
	if err := rename(app, original); err != nil {
		return lockedHint(err)
	}
	undo := func(cause error) error {
		removeAll(app)
		rename(original, app)
		return lockedHint(cause)
	}
	if err := os.Mkdir(app, 0o755); err != nil {
		return undo(err)
	}
	if err := writeShim(app); err != nil {
		return undo(err)
	}
	return nil
}

func unpatch(resources string) error {
	if err := repairInterrupted(resources); err != nil {
		return lockedHint(err)
	}
	app := filepath.Join(resources, "app.asar")
	original := filepath.Join(resources, "_app.asar")
	index := filepath.Join(app, "index.js")

	if data, err := os.ReadFile(index + backupSuffix); err == nil {
		if err := os.WriteFile(index, data, 0o644); err != nil {
			return lockedHint(err)
		}
		return os.Remove(index + backupSuffix)
	}
	if !isOurs(app) {
		return nil
	}
	if !isFile(original) {
		return errors.New("Discord's original files are missing, so reinstall Discord from discord.com")
	}
	old := app + ".cordmuffin-old"
	removeAll(old)
	if err := rename(app, old); err != nil {
		return lockedHint(err)
	}
	if err := rename(original, app); err != nil {
		rename(old, app)
		return lockedHint(err)
	}
	removeAll(old)
	return nil
}

func joinNames(names []string) string {
	switch len(names) {
	case 0:
		return ""
	case 1:
		return names[0]
	default:
		return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
	}
}

func install() {
	if len(findInstalls()) == 0 {
		fail("Couldn't find Discord on this PC. Install Discord from discord.com, open it once, then run this again.")
		return
	}

	say("Step 1 of 3: Getting Equicord ready")
	res, err := build()
	if err != nil {
		say("Failed: %v", err)
		if res.staged != "" {
			removeAll(res.staged)
		}
		fail(fmt.Sprintf("Something went wrong, so Discord wasn't changed.\n\n%v\n\nThe full log is at:\n%s", err, filepath.Join(workDir(), "install.log")))
		return
	}

	say("Step 2 of 3: Closing Discord")
	installs := findInstalls()
	running := map[string]bool{}
	var closed []discordInstall
	var failed []string
	for _, d := range installs {
		running[d.root] = discordRunning(d.root)
		if err := closeDiscord(d.root); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v.", d.name, err))
			continue
		}
		closed = append(closed, d)
	}
	if err := swapDist(res.staged); err != nil {
		removeAll(res.staged)
		for _, d := range closed {
			if running[d.root] {
				startDiscord(d)
			}
		}
		fail(fmt.Sprintf("Equicord was built but couldn't be put in place, so Discord wasn't changed.\n\n%v", err))
		return
	}
	themes, themeSkipped, themeErr := addThemes()

	say("Step 3 of 3: Putting Equicord into Discord")
	var done []string
	var patched []discordInstall
	for _, d := range closed {
		if err := patch(filepath.Join(d.latest(), "resources")); err != nil {
			failed = append(failed, fmt.Sprintf("%s: %v.", d.name, err))
			continue
		}
		done = append(done, d.name)
		patched = append(patched, d)
	}

	reopened := false
	for _, d := range closed {
		if running[d.root] {
			startDiscord(d)
			reopened = true
		}
	}
	if !reopened && len(patched) > 0 {
		startDiscord(patched[0])
		reopened = true
	}

	var text strings.Builder
	if len(done) > 0 {
		fmt.Fprintf(&text, "Equicord is installed into %s.", joinNames(done))
		if reopened {
			text.WriteString(" Discord is opening now.")
		}
	}
	if len(res.added) > 0 {
		fmt.Fprintf(&text, "\n\nPlugins added: %s\nTurn them on in Discord: User Settings, then Plugins.", strings.Join(res.added, ", "))
	}
	if len(res.kept) > 0 {
		fmt.Fprintf(&text, "\n\nKept the plugins you installed with Muffinshelf: %s", strings.Join(res.kept, ", "))
	}
	if len(themes) > 0 {
		fmt.Fprintf(&text, "\n\nThemes added and turned on: %s", strings.Join(themes, ", "))
	}
	if skipped := append(res.skipped, themeSkipped...); len(skipped) > 0 {
		fmt.Fprintf(&text, "\n\nSkipped:\n%s", strings.Join(skipped, "\n"))
	}
	if themeErr != nil {
		fmt.Fprintf(&text, "\n\nThemes problem: %v", themeErr)
	}
	if len(failed) > 0 {
		runFailed = true
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
	if len(failed) > 0 {
		fail("Something went wrong:\n" + strings.Join(failed, "\n"))
		return
	}
	if logFile != nil {
		logFile.Close()
		logFile = nil
	}
	removeAll(workDir())
	message("Equicord is removed and Discord is back to normal.\n\nYour Equicord settings and themes are kept in case you install it again.", mbOK|mbIconInfo)
}

func isInstalled() bool {
	if exists(distDir()) {
		return true
	}
	for _, d := range findInstalls() {
		if isOurs(filepath.Join(d.latest(), "resources", "app.asar")) {
			return true
		}
	}
	return false
}

func singleInstance() bool {
	name, _ := syscall.UTF16PtrFromString(`Local\CordmuffinEquicordInstaller`)
	h, _, err := createMutex.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return true
	}
	return err != syscall.Errno(errorAlreadyExists)
}

func main() {
	if !singleInstance() {
		message("The installer is already running. Wait for it to finish first.", mbOK|mbIconWarning)
		return
	}
	if err := os.MkdirAll(workDir(), 0o755); err != nil {
		message(fmt.Sprintf("Couldn't create %s: %v", workDir(), err), mbOK|mbIconError)
		os.Exit(1)
	}
	logFile, _ = os.Create(filepath.Join(workDir(), "install.log"))
	os.MkdirAll(filepath.Join(kitDir(), pluginsFolder), 0o755)
	os.MkdirAll(filepath.Join(kitDir(), themesFolder), 0o755)

	if len(os.Args) > 1 {
		switch strings.ToLower(os.Args[1]) {
		case "/install":
			silent = true
			install()
		case "/uninstall":
			silent = true
			uninstall()
		}
		if silent {
			if runFailed {
				os.Exit(1)
			}
			return
		}
	}

	extras := fmt.Sprintf("Plugins in the %q folder and themes in the %q folder get added too.", pluginsFolder, themesFolder)
	if isInstalled() {
		switch message("Equicord is already installed.\n\nYes: update it, and add any new plugins and themes\nNo: remove Equicord\nCancel: do nothing\n\n"+extras+"\n\nDiscord closes and reopens by itself.", mbYesNoCancel|mbIconQuestion) {
		case idYes:
			install()
		case idNo:
			if message("Remove Equicord and put Discord back to normal?", mbYesNo|mbIconWarning) == idYes {
				uninstall()
			} else {
				return
			}
		default:
			return
		}
	} else {
		if message("Install Equicord into Discord?\n\n"+extras+"\n\nDiscord closes and reopens by itself. The first install takes a few minutes.", mbYesNo|mbIconQuestion) != idYes {
			return
		}
		install()
	}

	fmt.Print("\nPress Enter to close this window.")
	bufio.NewReader(os.Stdin).ReadString('\n')
}
