package main

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
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
	title             = "Cordmuffin Equicord Installer"
	pluginsFolder     = "Plugins Go Here"
	themesFolder      = "Themes Go Here"
	backupSuffix      = ".cordmuffin-backup"
	stubMarker        = "/* cordmuffin */"
	stubPackage       = `{"name":"discord","main":"index.js"}`
	equicordRepo      = "Equicord/Equicord"
	cordmuffinRepo    = "LostMorality/cordmuffin"
	updaterPlugin     = "cordmuffinUpdater"
	muffinshelfMarker = ".muffinshelf.json"
	exeName           = "Cordmuffin Equicord Installer.exe"

	exitUpdated = 0
	exitFailed  = 1
	// Not 2: that's what Go itself exits with when it crashes.
	exitBusy     = 10
	exitUpToDate = 11

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

	// Set at build time with -ldflags "-X main.version=..."; the background updater compares it with the newest release.
	version = "1.1.0"

	silent    bool
	runFailed bool
	logFile   *os.File
	mutex     uintptr

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
func mirrorDir() string        { return filepath.Join(workDir(), "plugins") }
func backupDir() string        { return filepath.Join(workDir(), "plugin-backups") }
func installerExe() string     { return filepath.Join(workDir(), "installer", exeName) }
func statePath() string        { return filepath.Join(workDir(), "state.json") }
func resultPath() string       { return filepath.Join(workDir(), "update-result.json") }

// Both can be pointed at a test server; normal installs always use GitHub.
func githubAPI() string { return baseURL("CORDMUFFIN_GITHUB_API", "https://api.github.com") }
func codeload() string  { return baseURL("CORDMUFFIN_CODELOAD", "https://codeload.github.com") }
func baseURL(env, fallback string) string {
	if v := strings.TrimRight(os.Getenv(env), "/"); v != "" {
		return v
	}
	return fallback
}

// What the last successful build contains. The CordmuffinUpdater plugin reads it to know what to check.
type installState struct {
	Version    string   `json:"version"`
	Equicord   string   `json:"equicord"`
	Cordmuffin string   `json:"cordmuffin"`
	Plugins    []string `json:"plugins"`
	KitDir     string   `json:"kitDir"`
	Updater    string   `json:"updater"`
	BuiltAt    string   `json:"builtAt"`
	// A release whose installer turned out not to be the version its tag says; it isn't downloaded again.
	SkippedRelease string `json:"skippedRelease,omitempty"`
}

func loadState() *installState {
	data, err := os.ReadFile(statePath())
	if err != nil {
		return nil
	}
	var st installState
	if json.Unmarshal(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}), &st) != nil {
		return nil
	}
	return &st
}

func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path+".tmp", data, 0o644); err != nil {
		return err
	}
	return rename(path+".tmp", path)
}

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
	if strings.HasPrefix(target, githubAPI()) && (resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests) {
		return errRateLimited
	}
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

func latestCommit(repo string) (string, error) { return latestRef(repo, "main") }

// The commit a branch (or "HEAD", the repo's default branch) points to right now.
func latestRef(repo, ref string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", githubAPI()+"/repos/"+repo+"/commits/"+url.PathEscape(ref), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github.sha")
	req.Header.Set("User-Agent", "cordmuffin-installer")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", friendlyNetError(githubAPI(), err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	sha := strings.TrimSpace(string(body))
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		// Everyone sharing an internet connection shares GitHub's 60 lookups an hour; git's own endpoint isn't counted.
		if sha, err := gitRef(repo, ref); err == nil {
			return sha, nil
		}
		return "", errRateLimited
	}
	if resp.StatusCode != http.StatusOK || len(sha) != 40 {
		return "", fmt.Errorf("GitHub didn't say which version of %s is newest (%s). Try again in a few minutes", repo, resp.Status)
	}
	return sha, nil
}

var errBuildFailed = errors.New("building failed")

var errRateLimited = errors.New("GitHub's hourly limit for lookups from your internet connection was reached. Try again in a few minutes")

// The commit a branch (or HEAD) points to, from the endpoint git clone uses.
func gitRef(repo, ref string) (string, error) {
	if os.Getenv("CORDMUFFIN_GITHUB_API") != "" {
		return "", errors.New("not used with a stand-in server")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", "https://github.com/"+repo+".git/info/refs?service=git-upload-pack", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "git/2.45 cordmuffin-installer")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", errors.New(resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return "", err
	}
	want := "refs/heads/" + ref
	if ref == "HEAD" {
		want = "HEAD"
	}
	// pkt-lines: 4 hex digits of length, then "<sha> <ref>", with capabilities after a NUL on the first one.
	for _, line := range strings.Split(string(body), "\n") {
		// The first ref follows the "0000" that ends the service announcement.
		line = strings.TrimPrefix(line, "0000")
		if len(line) < 4+41 {
			continue
		}
		fields := strings.SplitN(strings.SplitN(line[4:], "\x00", 2)[0], " ", 2)
		if len(fields) == 2 && fields[1] == want && len(fields[0]) == 40 {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("%s has no %s", repo, ref)
}

// Whether anything under path changed between two commits of a repo. A plugin from a repo with many plugins
// shouldn't count as updated whenever another one changes. sameBranch: from must be an older commit of the same
// branch, which keeps installs from before branches were recorded on the branch they came from.
func pathChanged(repo, from, to, path string, sameBranch bool) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", githubAPI()+"/repos/"+repo+"/compare/"+from+"..."+to, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", "cordmuffin-installer")
	resp, err := httpClient.Do(req)
	if err != nil {
		return false, friendlyNetError(githubAPI(), err)
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		// The installed commit is gone (history rewritten); only the files can tell.
		return !sameBranch, nil
	case http.StatusForbidden, http.StatusTooManyRequests:
		return false, errRateLimited
	default:
		return false, errors.New(resp.Status)
	}
	var cmp struct {
		Status string `json:"status"`
		Files  []struct {
			Name     string `json:"filename"`
			Previous string `json:"previous_filename"`
		} `json:"files"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&cmp); err != nil {
		return false, err
	}
	if sameBranch && cmp.Status != "ahead" {
		return false, nil
	}
	// GitHub lists at most 300 files; past that, assume the plugin is among them.
	if len(cmp.Files) >= 300 {
		return true, nil
	}
	prefix := strings.ToLower(strings.Trim(path, "/"))
	for _, f := range cmp.Files {
		for _, name := range []string{f.Name, f.Previous} {
			if name != "" && (prefix == "" || strings.HasPrefix(strings.ToLower(name), prefix+"/")) {
				return true, nil
			}
		}
	}
	return false, nil
}

func equicordSrc() string   { return filepath.Join(workDir(), "equicord") }
func cordmuffinSrc() string { return filepath.Join(workDir(), "cordmuffin") }

func cachedCommit(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, ".commit"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// Newest commit of a repo, or the one already downloaded when GitHub can't be reached.
func pickCommit(repo, dir string) (string, error) {
	sha, err := latestCommit(repo)
	if err == nil {
		return sha, nil
	}
	if cached := cachedCommit(dir); cached != "" {
		say("Couldn't check for a newer %s (%v), so the one already downloaded is used.", repo, err)
		return cached, nil
	}
	return "", err
}

func downloadRepo(repo, sha, dest string) error {
	if cachedCommit(dest) == sha && isDir(dest) {
		return nil
	}
	say("Downloading %s...", repo)
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	zipPath := dest + ".zip"
	if err := download(codeload()+"/"+repo+"/zip/"+sha, zipPath); err != nil {
		return err
	}
	defer os.Remove(zipPath)
	tmp := dest + "-new"
	removeAll(tmp)
	if err := unzip(zipPath, tmp); err != nil {
		removeAll(tmp)
		return err
	}
	if err := removeAll(dest); err != nil {
		return lockedHint(err)
	}
	if err := rename(singleSubdir(tmp), dest); err != nil {
		return lockedHint(err)
	}
	removeAll(tmp)
	return os.WriteFile(filepath.Join(dest, ".commit"), []byte(sha), 0o644)
}

func downloadEquicord(sha string) (string, error) {
	src := equicordSrc()
	if err := downloadRepo(equicordRepo, sha, src); err != nil {
		return "", err
	}
	return src, removeAll(filepath.Join(src, "src", "userplugins"))
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

func addPlugins(src, inbox string) (added, kept, skipped []string, err error) {
	dest := filepath.Join(src, "src", "userplugins")
	if err = os.MkdirAll(dest, 0o755); err != nil {
		return
	}
	os.MkdirAll(inbox, 0o755)
	tmp := filepath.Join(workDir(), "unzipped-plugins")
	removeAll(tmp)
	defer removeAll(tmp)

	entries, _ := os.ReadDir(inbox)
	for _, e := range entries {
		if isTempCopy(e.Name()) {
			continue
		}
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
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || isTempCopy(e.Name()) || exists(filepath.Join(dest, e.Name())) {
			continue
		}
		if cerr := copyTree(filepath.Join(muffinshelfSaved(), e.Name()), filepath.Join(dest, e.Name())); cerr == nil {
			kept = append(kept, e.Name())
		}
	}
	return
}

// A plugin is a folder with an index file, or a single .ts/.tsx file next to the others.
func pluginPath(dir, name string) string {
	for _, candidate := range []string{name, name + ".tsx", name + ".ts"} {
		if path := filepath.Join(dir, candidate); exists(path) {
			return path
		}
	}
	return ""
}

func containsFold(list []string, s string) bool {
	for _, v := range list {
		if strings.EqualFold(v, s) {
			return true
		}
	}
	return false
}

// Plugin folders published in cordmuffin's custom-creations folder, keyed by lower-case name.
func repoPlugins(repoDir string) map[string]string {
	plugins := map[string]string{}
	root := filepath.Join(repoDir, "custom-creations")
	entries, _ := os.ReadDir(root)
	for _, e := range entries {
		dir := filepath.Join(root, e.Name())
		if e.IsDir() && len(findPluginRoots(dir, 0)) == 1 {
			plugins[strings.ToLower(e.Name())] = dir
		}
	}
	return plugins
}

func treeFiles(dir string) (map[string][]byte, error) {
	files := map[string][]byte{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		// Muffinshelf's install record and the download's commit note aren't part of a plugin.
		if rel == muffinshelfMarker || rel == ".commit" {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[strings.ToLower(filepath.ToSlash(rel))] = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
		return nil
	})
	return files, err
}

// Line endings are ignored, so a copy that git checked out with Windows line endings still counts as the same version.
func sameTree(a, b string) bool {
	fa, err := treeFiles(a)
	if err != nil {
		return false
	}
	fb, err := treeFiles(b)
	if err != nil || len(fa) != len(fb) {
		return false
	}
	for name, data := range fa {
		if other, ok := fb[name]; !ok || !bytes.Equal(data, other) {
			return false
		}
	}
	return true
}

func replaceTree(dir, from string) error {
	tmp, old := dir+tempSuffixNew, dir+tempSuffixOld
	removeAll(tmp)
	removeAll(old)
	if err := copyTree(from, tmp); err != nil {
		removeAll(tmp)
		return err
	}
	// The old copy is only deleted once the new one is in place, so a failed rename can't leave neither.
	if exists(dir) {
		if err := rename(dir, old); err != nil {
			removeAll(tmp)
			return lockedHint(err)
		}
	}
	if err := rename(tmp, dir); err != nil {
		if exists(old) {
			rename(old, dir)
		}
		removeAll(tmp)
		return lockedHint(err)
	}
	removeAll(old)
	return nil
}

const tempSuffixNew, tempSuffixOld = ".cordmuffin-new", ".cordmuffin-old"

// Half-replaced copies left by a crash in the middle of replaceTree; they're never plugins of their own.
func isTempCopy(name string) bool {
	return strings.HasSuffix(name, tempSuffixNew) || strings.HasSuffix(name, tempSuffixOld)
}

// The replaced copy goes to plugin-backups first, so an update never loses changes someone made to a plugin.
// Each plugin (and kind of copy) has its own folder there, and only its three newest backups are kept.
func replaceWithBackup(dir, from, label string) error {
	folder := filepath.Join(backupDir(), filepath.Base(dir)+label)
	stamp := time.Now().Format("20060102-150405")
	backup := filepath.Join(folder, stamp)
	for n := 2; exists(backup); n++ {
		backup = filepath.Join(folder, fmt.Sprintf("%s-%d", stamp, n))
	}
	if err := copyTree(dir, backup); err != nil {
		return err
	}
	if old, _ := os.ReadDir(folder); len(old) > 3 {
		names := make([]string, 0, len(old))
		for _, e := range old {
			names = append(names, e.Name())
		}
		sort.Slice(names, func(i, j int) bool { return backupOrder(names[i]) < backupOrder(names[j]) })
		for _, name := range names[:len(names)-3] {
			removeAll(filepath.Join(folder, name))
		}
	}
	return replaceTree(dir, from)
}

// Sorts "20261027-222647-10" after "20261027-222647-9".
func backupOrder(name string) string {
	i := min(len(name), 15)
	return name[:i] + fmt.Sprintf("%6s", strings.TrimPrefix(name[i:], "-"))
}

// Swaps cordmuffin's own plugins for their newest published version and adds the CordmuffinUpdater plugin.
// Plugins are matched by folder name; anything that isn't one of cordmuffin's plugins is never touched.
// The copy in the kit's plugins folder is refreshed too, so running an old kit again doesn't undo an update.
func syncCordmuffin(src, repoDir, kitPlugins string, added []string, fromMirror bool) (tracked, updated, extra []string) {
	dest := filepath.Join(src, "src", "userplugins")
	published := repoPlugins(repoDir)
	names := append([]string{}, added...)
	if !containsFold(names, updaterPlugin) {
		from := filepath.Join(mirrorDir(), updaterPlugin)
		if !isDir(from) {
			from = published[strings.ToLower(updaterPlugin)]
		}
		if from != "" && copyTree(from, filepath.Join(dest, updaterPlugin)) == nil {
			names = append(names, updaterPlugin)
			extra = append(extra, updaterPlugin)
		}
	}

	for _, name := range names {
		repo, ok := published[strings.ToLower(name)]
		target := filepath.Join(dest, name)
		if !ok || !isDir(target) {
			continue
		}
		tracked = append(tracked, name)
		if kitPlugins != "" {
			kitCopy := filepath.Join(kitPlugins, name)
			if len(findPluginRoots(kitCopy, 0)) == 1 && !sameTree(kitCopy, repo) {
				if err := replaceWithBackup(kitCopy, repo, "-kit"); err != nil {
					say("  Couldn't update %s in %s: %v", name, kitPlugins, err)
				}
			}
		}
		if sameTree(target, repo) {
			continue
		}
		var err error
		if fromMirror {
			err = replaceWithBackup(target, repo, "")
		} else {
			err = replaceTree(target, repo)
		}
		if err != nil {
			say("  Couldn't update %s: %v", name, err)
			continue
		}
		updated = append(updated, name)
	}
	return
}

// When cordmuffin couldn't be downloaded, the updater still goes in from the last build or an older download,
// so one failed download doesn't drop it from the build and the saved plugin copy for good.
func keepUpdater(src string, added []string) (extra []string) {
	if containsFold(added, updaterPlugin) {
		return nil
	}
	dest := filepath.Join(src, "src", "userplugins", updaterPlugin)
	for _, from := range []string{
		filepath.Join(mirrorDir(), updaterPlugin),
		filepath.Join(cordmuffinSrc(), "custom-creations", updaterPlugin),
	} {
		if len(findPluginRoots(from, 0)) != 1 {
			continue
		}
		if copyTree(from, dest) == nil {
			return []string{updaterPlugin}
		}
		removeAll(dest)
	}
	return nil
}

// Whether any of cordmuffin's plugins in the last build differ from the newest published ones.
func mirrorOutdated(repoDir string) bool {
	published := repoPlugins(repoDir)
	if _, ok := published[strings.ToLower(updaterPlugin)]; ok && !isDir(filepath.Join(mirrorDir(), updaterPlugin)) {
		return true
	}
	entries, _ := os.ReadDir(mirrorDir())
	for _, e := range entries {
		if repo, ok := published[strings.ToLower(e.Name())]; ok && e.IsDir() && !sameTree(filepath.Join(mirrorDir(), e.Name()), repo) {
			return true
		}
	}
	return false
}

type muffinshelfUpdate struct {
	folder, name, staged string
	// Records the new commit as skipped, so a version that doesn't build isn't tried again on every check.
	skip func()
}

func validGitHubName(s string) bool {
	if s == "" || len(s) > 100 || s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		if !(r == '.' || r == '_' || r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return true
}

func hasIndex(dir string) bool {
	for _, name := range []string{"index.ts", "index.tsx", "index.js", "index.jsx"} {
		if isFile(filepath.Join(dir, name)) {
			return true
		}
	}
	return false
}

// Plugins installed with Muffinshelf from someone's GitHub repo: looks up the newest commit of the branch each
// came from (its marker file says which) and stages the ones whose files changed. Their saved copies are only
// replaced after a build with them worked.
func muffinshelfUpdates() []muffinshelfUpdate {
	stage := filepath.Join(workDir(), "muffinshelf-updates")
	removeAll(stage)
	var updates []muffinshelfUpdate
	latest := map[string]string{}
	entries, _ := os.ReadDir(muffinshelfSaved())
	for _, e := range entries {
		saved := filepath.Join(muffinshelfSaved(), e.Name())
		data, err := os.ReadFile(filepath.Join(saved, muffinshelfMarker))
		if !e.IsDir() || err != nil || isTempCopy(e.Name()) {
			continue
		}
		marker := map[string]any{}
		if json.Unmarshal(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}), &marker) != nil {
			continue
		}
		owner, _ := marker["owner"].(string)
		repo, _ := marker["repo"].(string)
		installed, _ := marker["ref"].(string)
		path, _ := marker["path"].(string)
		track, _ := marker["track"].(string)
		recorded := track != ""
		if !recorded {
			track = "HEAD"
		}
		name := e.Name()
		if n, _ := marker["pluginName"].(string); n != "" {
			name = n
		}
		if !validGitHubName(owner) || !validGitHubName(repo) {
			continue
		}

		key := owner + "/" + repo + "@" + track
		sha, checked := latest[key]
		if !checked {
			if sha, err = latestRef(owner+"/"+repo, track); err != nil {
				say("  Couldn't check %s for updates (%v).", name, err)
				sha = ""
			}
			latest[key] = sha
		}
		// A plugin that left its folder in the repo stays on its copy; skippedRef keeps it from being downloaded again
		// on every check, and later commits are compared from there.
		skipped, _ := marker["skippedRef"].(string)
		if sha == "" || sha == installed || sha == skipped {
			continue
		}
		markerFile := filepath.Join(saved, muffinshelfMarker)
		original := maps.Clone(marker)
		skip := func() {
			original["skippedRef"] = sha
			if data, err := json.MarshalIndent(original, "", "    "); err == nil {
				os.WriteFile(markerFile, data, 0o644)
			}
		}
		from := installed
		if len(skipped) == 40 {
			from = skipped
		}
		marker["ref"] = sha
		marker["updatedAt"] = time.Now().UnixMilli()
		// The store's version number belonged to the old copy; leaving it would make Muffinshelf offer a stale update.
		delete(marker, "version")
		delete(marker, "skippedRef")
		newMarker, _ := json.MarshalIndent(marker, "", "    ")
		if len(from) == 40 {
			changed, err := pathChanged(owner+"/"+repo, from, sha, path, !recorded && from == installed)
			if errors.Is(err, errRateLimited) && recorded {
				// Downloads aren't counted, so the files themselves are compared instead.
				changed, err = true, nil
			}
			if err != nil {
				say("  Couldn't check %s for updates (%v).", name, err)
				continue
			}
			if !changed {
				if skipped != "" {
					skip()
				} else if recorded {
					os.WriteFile(markerFile, newMarker, 0o644)
				}
				continue
			}
		}

		repoDir := filepath.Join(stage, "repos", cleanName(owner+"-"+repo+"-"+sha[:12]))
		if err := downloadRepo(owner+"/"+repo, sha, repoDir); err != nil {
			say("  Couldn't download the new version of %s (%v).", name, err)
			continue
		}
		src := filepath.Join(repoDir, filepath.FromSlash(path))
		if rel, err := filepath.Rel(repoDir, src); err != nil || (rel != "." && !filepath.IsLocal(rel)) || !hasIndex(src) {
			say("  The new version of %s isn't where Muffinshelf installed it from anymore, so it stays on the one you have.", name)
			skip()
			continue
		}
		if sameTree(src, saved) {
			os.WriteFile(markerFile, newMarker, 0o644)
			continue
		}
		staged := filepath.Join(stage, "plugins", e.Name())
		if err := copyTree(src, staged); err != nil {
			say("  Couldn't prepare the new version of %s (%v).", name, err)
			continue
		}
		os.Remove(filepath.Join(staged, ".commit"))
		if err := os.WriteFile(filepath.Join(staged, muffinshelfMarker), newMarker, 0o644); err != nil {
			continue
		}
		updates = append(updates, muffinshelfUpdate{folder: e.Name(), name: name, staged: staged, skip: skip})
	}
	return updates
}

func updateNames(updates []muffinshelfUpdate) []string {
	var names []string
	for _, u := range updates {
		names = append(names, u.name)
	}
	return names
}

// Keeps a copy of the plugins that went into the build, so background updates can rebuild
// even after the kit folder was moved or deleted.
func saveMirror(src string, names []string) error {
	dest := filepath.Join(src, "src", "userplugins")
	tmp := mirrorDir() + ".new"
	removeAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	for _, name := range names {
		from := pluginPath(dest, name)
		if from == "" {
			continue
		}
		if err := copyTree(from, filepath.Join(tmp, filepath.Base(from))); err != nil {
			removeAll(tmp)
			return err
		}
	}
	old := mirrorDir() + ".old"
	removeAll(old)
	if exists(mirrorDir()) {
		if err := rename(mirrorDir(), old); err != nil {
			removeAll(tmp)
			return err
		}
	}
	if err := rename(tmp, mirrorDir()); err != nil {
		rename(old, mirrorDir())
		return err
	}
	removeAll(old)
	return nil
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

type buildOptions struct {
	inbox         string // where the plugins come from: the kit folder, or the copy of the last build
	kitPlugins    string // kit folder whose cordmuffin plugins get refreshed, if it still exists
	fromMirror    bool
	equicordSha   string // already checked by the caller; looked up when empty
	cordmuffinSha string
	muffinshelf   []muffinshelfUpdate // new versions of Muffinshelf plugins to build with
}

type buildResult struct {
	added, kept, skipped    []string
	tracked, updated, extra []string
	staged                  string
	equicordSha             string
	cordmuffinSha           string
}

func build(opts buildOptions) (buildResult, error) {
	var res buildResult
	nodeDir, err := ensureNode()
	if err != nil {
		return res, fmt.Errorf("couldn't get Node.js: %w", err)
	}
	sha := opts.equicordSha
	if sha == "" {
		if sha, err = pickCommit(equicordRepo, equicordSrc()); err != nil {
			return res, err
		}
	}
	res.equicordSha = sha
	src, err := downloadEquicord(sha)
	if err != nil {
		return res, fmt.Errorf("couldn't download Equicord: %w", err)
	}

	res.added, res.kept, res.skipped, err = addPlugins(src, opts.inbox)
	if err != nil {
		return res, err
	}
	for _, p := range res.added {
		say("  Adding plugin: %s", p)
	}
	for _, p := range res.kept {
		say("  Keeping Muffinshelf plugin: %s", p)
	}
	for _, u := range opts.muffinshelf {
		target := filepath.Join(src, "src", "userplugins", u.folder)
		if err := replaceTree(target, u.staged); err != nil {
			return res, fmt.Errorf("couldn't add the new version of %s: %w", u.name, err)
		}
		say("  Updating Muffinshelf plugin: %s", u.name)
	}

	cm := opts.cordmuffinSha
	var cmErr error
	if cm == "" {
		cm, cmErr = pickCommit(cordmuffinRepo, cordmuffinSrc())
	}
	if cmErr == nil {
		cmErr = downloadRepo(cordmuffinRepo, cm, cordmuffinSrc())
	}
	if cmErr != nil {
		say("Couldn't get cordmuffin's newest plugins, so they aren't updated this time (%v).", cmErr)
		res.extra = keepUpdater(src, res.added)
		if len(res.extra) == 0 && !containsFold(res.added, updaterPlugin) {
			say("No copy of the CordmuffinUpdater plugin was found, so automatic updates aren't set up. Run this installer again later.")
		}
	} else {
		res.cordmuffinSha = cm
		res.tracked, res.updated, res.extra = syncCordmuffin(src, cordmuffinSrc(), opts.kitPlugins, res.added, opts.fromMirror)
		for _, p := range res.updated {
			say("  Updating plugin to its newest version: %s", p)
		}
	}

	say("Installing Equicord's parts (the first time takes a few minutes)...")
	if err := runStep(src, nodeDir, sha, "pnpm", "install", "--frozen-lockfile"); err != nil {
		return res, fmt.Errorf("installing Equicord's parts failed: %w", err)
	}
	fmt.Println()
	say("Building Equicord...")
	if err := runStep(src, nodeDir, sha, "pnpm", "build", "--disable-updater"); err != nil {
		if len(res.added)+len(res.kept) > 0 {
			return res, fmt.Errorf("%w. One of your plugins is probably broken, so try again without it: %w", errBuildFailed, err)
		}
		return res, fmt.Errorf("%w: %w", errBuildFailed, err)
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
	prev := loadState()
	kitPlugins := filepath.Join(kitDir(), pluginsFolder)
	carried := carryOverPlugins(prev, kitPlugins)
	res, err := build(buildOptions{inbox: kitPlugins, kitPlugins: kitPlugins})
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
	saveBuild(res, kitDir(), prev)
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
	var added []string
	for _, p := range res.added {
		if !containsFold(carried, p) {
			added = append(added, p)
		}
	}
	if len(added) > 0 {
		fmt.Fprintf(&text, "\n\nPlugins added: %s\nTurn them on in Discord: User Settings, then Plugins.", strings.Join(added, ", "))
	}
	if len(carried) > 0 {
		fmt.Fprintf(&text, "\n\nKept the plugins from your last install and copied them into the %q folder here: %s", pluginsFolder, strings.Join(carried, ", "))
	}
	if len(res.updated) > 0 {
		fmt.Fprintf(&text, "\n\nUpdated to the newest version: %s", strings.Join(res.updated, ", "))
	}
	if len(res.kept) > 0 {
		fmt.Fprintf(&text, "\n\nKept the plugins you installed with Muffinshelf: %s", strings.Join(res.kept, ", "))
	}
	if containsFold(res.tracked, updaterPlugin) || containsFold(res.extra, updaterPlugin) {
		text.WriteString("\n\nCordmuffin's plugins now update by themselves while Discord is open. You can turn that off, or turn on Equicord updates, in Discord: User Settings, then Cordmuffin Updater.")
	} else if res.cordmuffinSha == "" && !containsFold(res.added, updaterPlugin) {
		text.WriteString("\n\nCouldn't download cordmuffin, so automatic updates aren't set up yet. Run this installer again later to turn them on.")
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

// Running a new download from another folder starts with an empty plugins folder, so the plugins of the last
// install are copied into it first. They come from the old kit folder, else the copy of the last build, else
// (installers before 1.2.0 kept no record) the last build's Equicord source. Muffinshelf plugins and the updater
// are left out, since every build adds those by itself.
func carryOverPlugins(prev *installState, kitPlugins string) []string {
	var from string
	switch {
	case prev != nil && prev.KitDir != "":
		old := filepath.Join(prev.KitDir, pluginsFolder)
		if strings.EqualFold(filepath.Clean(old), filepath.Clean(kitPlugins)) {
			return nil
		}
		if isDir(old) {
			from = old
		} else if isDir(mirrorDir()) {
			from = mirrorDir()
		}
	case prev != nil && isDir(mirrorDir()):
		from = mirrorDir()
	default:
		from = filepath.Join(equicordSrc(), "src", "userplugins")
	}
	entries, err := os.ReadDir(from)
	if from == "" || err != nil {
		return nil
	}

	pluginName := func(name string) string {
		for _, ext := range []string{".zip", ".tsx", ".ts"} {
			if strings.HasSuffix(strings.ToLower(name), ext) {
				return strings.ToLower(name[:len(name)-len(ext)])
			}
		}
		return strings.ToLower(name)
	}
	have := map[string]bool{strings.ToLower(updaterPlugin): true}
	for _, dir := range []string{kitPlugins, muffinshelfSaved()} {
		existing, _ := os.ReadDir(dir)
		for _, e := range existing {
			have[pluginName(e.Name())] = true
		}
	}

	var carried []string
	for _, e := range entries {
		name := e.Name()
		ext := strings.ToLower(filepath.Ext(name))
		if strings.HasPrefix(name, ".") || isTempCopy(name) || have[pluginName(name)] ||
			!e.IsDir() && ext != ".zip" && ext != ".ts" && ext != ".tsx" {
			continue
		}
		if err := os.MkdirAll(kitPlugins, 0o755); err != nil {
			say("Couldn't bring over the plugins from your last install: %v", err)
			return carried
		}
		target := filepath.Join(kitPlugins, name)
		if err := copyTree(filepath.Join(from, name), target); err != nil {
			removeAll(target)
			say("Couldn't bring over %s from your last install: %v", name, err)
			continue
		}
		have[pluginName(name)] = true
		carried = append(carried, strings.TrimSuffix(name, filepath.Ext(name)))
		say("  Bringing over plugin from your last install: %s", name)
	}
	return carried
}

// Keeps a copy of the installer where the CordmuffinUpdater plugin can run it, unless a newer one is already
// there, and returns the version of that copy.
func copySelf(prev *installState) string {
	target := installerExe()
	if prev != nil && isFile(target) && versionLess(version, prev.Version) {
		return prev.Version
	}
	cur, err := os.Executable()
	if err == nil && strings.EqualFold(filepath.Clean(cur), filepath.Clean(target)) {
		return version
	}
	if err == nil {
		var data []byte
		if data, err = os.ReadFile(cur); err == nil {
			if err = os.MkdirAll(filepath.Dir(target), 0o755); err == nil {
				if err = os.WriteFile(target+".tmp", data, 0o755); err == nil {
					err = rename(target+".tmp", target)
				}
			}
		}
	}
	if err != nil {
		say("Couldn't save a copy of the installer for background updates: %v", err)
		if prev != nil {
			return prev.Version
		}
		return ""
	}
	return version
}

// Records what the new build contains, after it's in place.
func saveBuild(res buildResult, kit string, prev *installState) {
	if err := saveMirror(equicordSrc(), append(append([]string{}, res.added...), res.extra...)); err != nil {
		say("Couldn't save a copy of the plugins for background updates: %v", err)
	}
	st := installState{
		Version:    copySelf(prev),
		Equicord:   res.equicordSha,
		Cordmuffin: res.cordmuffinSha,
		Plugins:    res.tracked,
		KitDir:     kit,
		Updater:    installerExe(),
		BuiltAt:    time.Now().UTC().Format(time.RFC3339),
	}
	if prev != nil {
		st.SkippedRelease = prev.SkippedRelease
	}
	if res.cordmuffinSha == "" && prev != nil {
		st.Cordmuffin, st.Plugins = prev.Cordmuffin, prev.Plugins
	}
	if st.Plugins == nil {
		st.Plugins = []string{}
	}
	if err := writeJSON(statePath(), st); err != nil {
		say("Couldn't save %s: %v", statePath(), err)
	}
}

type updateResult struct {
	OK           bool     `json:"ok"`
	UpToDate     bool     `json:"upToDate"`
	NeedsRestart bool     `json:"needsRestart"`
	Updated      []string `json:"updated"`
	Skipped      []string `json:"skipped,omitempty"`
	Error        string   `json:"error,omitempty"`
	Partial      bool     `json:"partial,omitempty"`
	At           string   `json:"at"`
}

func finishUpdate(r updateResult) int {
	r.At = time.Now().UTC().Format(time.RFC3339)
	if r.Updated == nil {
		r.Updated = []string{}
	}
	if err := writeJSON(resultPath(), r); err != nil {
		say("Couldn't save %s: %v", resultPath(), err)
	}
	switch {
	case !r.OK:
		say("Failed: %s", r.Error)
		return exitFailed
	case r.UpToDate:
		say("Everything is up to date.")
		return exitUpToDate
	}
	say("Updated: %s", strings.Join(r.Updated, ", "))
	return exitUpdated
}

// Background update, started by the CordmuffinUpdater plugin while Discord is open. It never closes Discord:
// the new build is swapped in and used from the next Discord start.
func update() int {
	prev := loadState()
	if !isDir(distDir()) && isDir(distDir()+".old") {
		// A swap that was cut off halfway (power loss, killed process) leaves the last good build here.
		say("Putting back the last build, which an interrupted update left behind.")
		rename(distDir()+".old", distDir())
	}
	if prev == nil || !isDir(distDir()) {
		return finishUpdate(updateResult{Error: "Cordmuffin isn't installed. Run Cordmuffin Equicord Installer first."})
	}
	from := os.Getenv("CORDMUFFIN_UPDATED_FROM")
	if from == "" {
		if code, ran := selfUpdate(prev); ran {
			return code
		}
	}

	var updated []string
	if from != "" {
		updated = append(updated, "the installer (v"+version+")")
		// The saved installer is this version now, even if the rest of the update fails.
		prev.Version = version
		writeJSON(statePath(), prev)
	}
	// With /no-equicord the build stays on the Equicord it has; only a build with no recorded Equicord takes the newest.
	eq := prev.Equicord
	if !hasArg("/no-equicord") || len(eq) != 40 {
		var err error
		if eq, err = latestCommit(equicordRepo); err != nil {
			return finishUpdate(updateResult{Error: err.Error()})
		}
	}
	cm, err := pickCommit(cordmuffinRepo, cordmuffinSrc())
	if err == nil {
		err = downloadRepo(cordmuffinRepo, cm, cordmuffinSrc())
	}
	pluginsChanged := false
	if err != nil {
		say("Couldn't check cordmuffin's plugins (%v).", err)
		cm = ""
	} else {
		pluginsChanged = mirrorOutdated(cordmuffinSrc())
	}
	var ms []muffinshelfUpdate
	if !hasArg("/no-muffinshelf") {
		ms = muffinshelfUpdates()
	}

	if eq == prev.Equicord && !pluginsChanged && len(ms) == 0 {
		if cm != "" {
			prev.Cordmuffin = cm
		}
		if from != "" {
			prev.Version = version
		}
		writeJSON(statePath(), prev)
		return finishUpdate(updateResult{OK: true, UpToDate: from == "", Updated: updated})
	}
	if eq != prev.Equicord {
		updated = append(updated, "Equicord")
	}

	// Background builds take your plugins from this copy; building without it would drop them.
	if !isDir(mirrorDir()) {
		return finishUpdate(updateResult{Error: "Cordmuffin's copy of your plugins is missing. Run Cordmuffin Equicord Installer once to fix it."})
	}
	kitPlugins := ""
	if prev.KitDir != "" && isDir(filepath.Join(prev.KitDir, pluginsFolder)) {
		kitPlugins = filepath.Join(prev.KitDir, pluginsFolder)
	}
	opts := buildOptions{inbox: mirrorDir(), kitPlugins: kitPlugins, fromMirror: true, equicordSha: eq, cordmuffinSha: cm, muffinshelf: ms}
	res, err := build(opts)
	var skipped []string
	if errors.Is(err, errBuildFailed) && len(ms) > 0 {
		// Someone else's new plugin version can break the build; that mustn't hold back every other update.
		say("The build failed with the new Muffinshelf plugin versions (%v), so it's tried again without them.", err)
		if res.staged != "" {
			removeAll(res.staged)
		}
		skipped = updateNames(ms)
		for _, u := range ms {
			u.skip()
		}
		opts.muffinshelf, ms = nil, nil
		removeAll(filepath.Join(workDir(), "muffinshelf-updates"))
		if eq == prev.Equicord && !pluginsChanged {
			// Nothing else was new, so the build that's in place stays.
			if cm != "" {
				prev.Cordmuffin = cm
			}
			if from != "" {
				prev.Version = version
			}
			writeJSON(statePath(), prev)
			return finishUpdate(updateResult{OK: true, UpToDate: from == "", Updated: updated, Skipped: skipped})
		}
		res, err = build(opts)
	}
	if err != nil {
		if res.staged != "" {
			removeAll(res.staged)
		}
		return finishUpdate(updateResult{Error: err.Error()})
	}
	if err := swapDist(res.staged); err != nil {
		// Something in Discord still has a file of the old build open; copying over it works all the same.
		say("Couldn't swap the new files in (%v), so they're copied over the old ones instead.", err)
		// Until the copy is done the build is a mix of old and new; if this run is cut off, the next one rebuilds.
		eqBefore := prev.Equicord
		prev.Equicord = ""
		writeJSON(statePath(), prev)
		prev.Equicord = eqBefore
		cerr := copyTree(res.staged, distDir())
		removeAll(res.staged)
		if cerr != nil {
			// Part of the new version may be in place now, so the next update has to rebuild whatever happens.
			prev.Equicord = ""
			writeJSON(statePath(), prev)
			return finishUpdate(updateResult{Partial: true, Error: fmt.Sprintf("the new version was built but only partly put in place (%v). Restart your PC and run Cordmuffin Equicord Installer to finish it", cerr)})
		}
	}
	for _, u := range ms {
		if err := replaceWithBackup(filepath.Join(muffinshelfSaved(), u.folder), u.staged, "-muffinshelf"); err != nil {
			say("Couldn't save the new version of %s for later builds (%v).", u.name, err)
		}
	}
	removeAll(filepath.Join(workDir(), "muffinshelf-updates"))
	saveBuild(res, prev.KitDir, prev)
	updated = append(append(updated, res.updated...), updateNames(ms)...)
	return finishUpdate(updateResult{OK: true, NeedsRestart: true, Updated: updated, Skipped: skipped})
}

func hasArg(flag string) bool {
	for _, a := range os.Args[1:] {
		if strings.EqualFold(a, flag) {
			return true
		}
	}
	return false
}

func extractExe(zipPath, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer r.Close()
	for _, f := range r.File {
		if f.FileInfo().IsDir() || !strings.EqualFold(filepath.Ext(f.Name), ".exe") {
			continue
		}
		in, err := f.Open()
		if err != nil {
			return err
		}
		data, err := io.ReadAll(in)
		in.Close()
		if err != nil {
			return err
		}
		if !bytes.HasPrefix(data, []byte("MZ")) {
			return errors.New("the installer in the release isn't a Windows program")
		}
		return os.WriteFile(dest, data, 0o755)
	}
	return errors.New("the release has no installer in it")
}

// Replaces the saved installer copy with the newest release and lets the new one do the update.
// Returns ran=false when there's nothing newer or it couldn't be fetched, so the current one carries on.
func selfUpdate(prev *installState) (int, bool) {
	var rel struct {
		Tag    string `json:"tag_name"`
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := getJSON(githubAPI()+"/repos/"+cordmuffinRepo+"/releases/latest", &rel); err != nil {
		say("Couldn't check for a newer installer (%v).", err)
		return 0, false
	}
	newest := strings.TrimPrefix(rel.Tag, "v")
	if !versionLess(version, newest) || newest == prev.SkippedRelease {
		return 0, false
	}
	asset, sumURL := "", ""
	for _, a := range rel.Assets {
		switch strings.ToLower(filepath.Ext(a.Name)) {
		case ".zip":
			if asset == "" {
				asset = a.URL
			}
		case ".sha256":
			sumURL = a.URL
		}
	}
	if asset == "" {
		return 0, false
	}

	say("Updating the installer from v%s to v%s...", version, newest)
	target := installerExe()
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return 0, false
	}
	zipPath := filepath.Join(filepath.Dir(target), "release.zip")
	defer os.Remove(zipPath)
	fresh, old := target+".new", target+".old"
	if err := download(asset, zipPath); err == nil {
		// Releases from build-release.ps1 come with a checksum; older ones without one are still accepted.
		if sumURL != "" {
			if err := checkSum(zipPath, sumURL); err != nil {
				say("The v%s release didn't pass its checksum (%v), so it isn't used.", newest, err)
				return 0, false
			}
		}
		err = extractExe(zipPath, fresh)
		if err != nil {
			say("Couldn't use the new installer (%v).", err)
			os.Remove(fresh)
			return 0, false
		}
		// A release built without its version number would otherwise be downloaded again on every check.
		got := exeVersion(fresh)
		if got == "" {
			say("Couldn't start the v%s installer to check it (an antivirus scan can do this), so it's tried again next time.", newest)
			os.Remove(fresh)
			return 0, false
		}
		if got != newest {
			say("The v%s release's installer says it's v%s, so it isn't used.", newest, got)
			os.Remove(fresh)
			prev.SkippedRelease = newest
			writeJSON(statePath(), prev)
			return 0, false
		}
	} else {
		say("Couldn't download the new installer (%v).", err)
		return 0, false
	}
	os.Remove(old)
	if isFile(target) {
		// A running exe can't be overwritten, but it can be renamed out of the way.
		if err := rename(target, old); err != nil {
			os.Remove(fresh)
			return 0, false
		}
	}
	if err := rename(fresh, target); err != nil {
		rename(old, target)
		return 0, false
	}

	releaseMutex()
	if logFile != nil {
		logFile.Close()
		logFile = nil
	}
	dropLock()
	os.Remove(resultPath())
	cmd := hidden(exec.Command(target, os.Args[1:]...))
	cmd.Env = append(os.Environ(), "CORDMUFFIN_UPDATED_FROM="+version)
	err := cmd.Run()
	var exit *exec.ExitError
	if (err == nil || errors.As(err, &exit)) && (isFile(resultPath()) || cmd.ProcessState.ExitCode() == exitBusy) {
		return cmd.ProcessState.ExitCode(), true
	}
	if err == nil || errors.As(err, &exit) {
		err = fmt.Errorf("it stopped with code %d without finishing", cmd.ProcessState.ExitCode())
	}

	// The new installer didn't start or crashed, so the old one goes back and finishes the job.
	logFile, _ = os.OpenFile(filepath.Join(workDir(), "update.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	say("The new installer didn't work (%v), so the old one is put back.", err)
	prev.SkippedRelease = newest
	writeJSON(statePath(), prev)
	os.Remove(target)
	rename(old, target)
	if !singleInstance() {
		return exitBusy, true
	}
	holdLock()
	return 0, false
}

// Compares a file with a sha256sum-style checksum file ("<hex>  <name>").
func checkSum(file, sumURL string) error {
	sumPath := file + ".sha256"
	defer os.Remove(sumPath)
	if err := download(sumURL, sumPath); err != nil {
		return err
	}
	data, err := os.ReadFile(sumPath)
	if err != nil {
		return err
	}
	fields := strings.Fields(string(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})))
	if len(fields) == 0 || len(fields[0]) != 64 {
		return errors.New("the checksum file is empty or malformed")
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, fields[0]) {
		return errors.New("the download doesn't match")
	}
	return nil
}

// The version an installer exe was built as, from its /version switch.
func exeVersion(exe string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := hidden(exec.CommandContext(ctx, exe, "/version")).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
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
	text := "Equicord is removed and Discord is back to normal.\n\nYour Equicord settings and themes are kept in case you install it again."
	// Backups can hold the only copy of someone's own changes to a plugin, so they stay unless the folder is empty.
	backups, _ := os.ReadDir(backupDir())
	if len(backups) == 0 {
		removeAll(workDir())
	} else {
		entries, _ := os.ReadDir(workDir())
		for _, e := range entries {
			if !strings.EqualFold(e.Name(), filepath.Base(backupDir())) {
				removeAll(filepath.Join(workDir(), e.Name()))
			}
		}
		text += "\n\nThe old plugin copies saved by updates are kept in " + backupDir() + ". Delete that folder if you don't need them."
	}
	message(text, mbOK|mbIconInfo)
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
	if err == syscall.Errno(errorAlreadyExists) {
		syscall.CloseHandle(syscall.Handle(h))
		return false
	}
	mutex = h
	return true
}

// Muffinshelf builds in the same folder, so each side checks the other's marker before building.
func lockPath() string { return filepath.Join(workDir(), "update.lock") }

var lockStop chan struct{}

// Muffinshelf treats a lock older than 30 minutes as left over from a crash, so it's touched while held.
func holdLock() {
	os.WriteFile(lockPath(), []byte(strconv.Itoa(os.Getpid())), 0o644)
	if lockStop != nil {
		return
	}
	stop := make(chan struct{})
	lockStop = stop
	go func() {
		tick := time.NewTicker(5 * time.Minute)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-tick.C:
				os.Chtimes(lockPath(), now, now)
			}
		}
	}()
}

func dropLock() {
	if lockStop != nil {
		close(lockStop)
		lockStop = nil
	}
	os.Remove(lockPath())
}

func muffinshelfBusy() bool {
	for _, name := range []string{".muffinshelf-building", ".muffinshelf-work"} {
		if info, err := os.Stat(filepath.Join(equicordSrc(), name)); err == nil && time.Since(info.ModTime()) < 30*time.Minute {
			return true
		}
	}
	return false
}

func releaseMutex() {
	if mutex != 0 {
		syscall.CloseHandle(syscall.Handle(mutex))
		mutex = 0
	}
}

func main() {
	arg := ""
	if len(os.Args) > 1 {
		arg = strings.ToLower(os.Args[1])
	}
	if arg == "/version" {
		fmt.Print(version)
		return
	}
	if arg == "/update" {
		// Started in the background by the CordmuffinUpdater plugin: no windows, no questions.
		silent = true
		if !singleInstance() || muffinshelfBusy() {
			os.Exit(exitBusy)
		}
		if err := os.MkdirAll(workDir(), 0o755); err != nil {
			os.Exit(exitFailed)
		}
		flags := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
		if os.Getenv("CORDMUFFIN_UPDATED_FROM") != "" {
			flags = os.O_CREATE | os.O_WRONLY | os.O_APPEND
		}
		logFile, _ = os.OpenFile(filepath.Join(workDir(), "update.log"), flags, 0o644)
		say("Cordmuffin background update, installer v%s, %s", version, time.Now().Format(time.RFC1123))
		os.Remove(installerExe() + ".old")
		holdLock()
		code := update()
		dropLock()
		if logFile != nil {
			logFile.Close()
		}
		os.Exit(code)
	}

	if !singleInstance() {
		message("The installer is already running, or Cordmuffin is updating in the background. Wait a minute for it to finish first.", mbOK|mbIconWarning)
		return
	}
	if err := os.MkdirAll(workDir(), 0o755); err != nil {
		message(fmt.Sprintf("Couldn't create %s: %v", workDir(), err), mbOK|mbIconError)
		os.Exit(1)
	}
	if muffinshelfBusy() {
		message("Muffinshelf is installing or removing a plugin right now. Wait for it to finish, then run this again.", mbOK|mbIconWarning)
		return
	}
	holdLock()
	defer dropLock()
	logFile, _ = os.Create(filepath.Join(workDir(), "install.log"))
	os.MkdirAll(filepath.Join(kitDir(), pluginsFolder), 0o755)
	os.MkdirAll(filepath.Join(kitDir(), themesFolder), 0o755)

	if arg != "" {
		switch arg {
		case "/install":
			silent = true
			install()
		case "/uninstall":
			silent = true
			uninstall()
		}
		if silent {
			if runFailed {
				dropLock()
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

	// Finished: background updates and Muffinshelf may build again while this window stays open.
	dropLock()
	releaseMutex()
	fmt.Print("\nPress Enter to close this window.")
	bufio.NewReader(os.Stdin).ReadString('\n')
}
