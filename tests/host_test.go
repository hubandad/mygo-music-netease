// Copy this file to mygo-music/internal/plugin/netease_test.go, then set
// NETEASE_PLUGIN_DIR to this plugin's directory and run go test ./internal/plugin.
package plugin

import (
	"crypto/aes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"

	"mygo-music/internal/music"
)

type neteaseTransport func(*http.Request) (*http.Response, error)

func (f neteaseTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// The actual plugin runs in moejs with real host crypto, storage and fetch;
// only NetEase's HTTP replies and its sign-in window are replaced by fixtures.
func TestNetEasePluginRuntime(t *testing.T) {
	dir := os.Getenv("NETEASE_PLUGIN_DIR")
	if dir == "" {
		t.Skip("set NETEASE_PLUGIN_DIR to test the NetEase plugin")
	}
	previousTransport, previousSignIn := http.DefaultTransport, webSignIn
	t.Cleanup(func() { http.DefaultTransport, webSignIn = previousTransport, previousSignIn })
	webSignIn = func(o WebSignIn) (string, error) {
		if o.CookiesOf != "https://music.163.com/" || len(o.Until) != 1 || o.Until[0] != "MUSIC_U" {
			return "", fmt.Errorf("unexpected sign-in options: %+v", o)
		}
		return "MUSIC_U=fixture-token; __csrf=fixture-csrf", nil
	}
	const song = `{"id":1,"name":"Fixture song","ar":[{"id":4,"name":"Artist"}],"al":{"id":7,"name":"Album"},"dt":123000}`
	http.DefaultTransport = neteaseTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "interface.music.163.com" {
			return nil, fmt.Errorf("unexpected host: %s", r.URL.Host)
		}
		if err := r.ParseForm(); err != nil {
			return nil, err
		}
		raw, err := hex.DecodeString(r.Form.Get("params"))
		if err != nil || len(raw) == 0 || len(raw)%aes.BlockSize != 0 {
			return nil, fmt.Errorf("invalid ciphertext: %v", err)
		}
		block, _ := aes.NewCipher([]byte("e82ckenh8dichen8"))
		for at := 0; at < len(raw); at += aes.BlockSize {
			block.Decrypt(raw[at:at+aes.BlockSize], raw[at:at+aes.BlockSize])
		}
		padding := int(raw[len(raw)-1])
		if padding < 1 || padding > aes.BlockSize {
			return nil, fmt.Errorf("bad padding")
		}
		parts := strings.Split(string(raw[:len(raw)-padding]), "-36cd479b6b5-")
		if len(parts) != 3 {
			return nil, fmt.Errorf("invalid EAPI request")
		}
		sum := md5.Sum([]byte("nobody" + parts[0] + "use" + parts[1] + "md5forencrypt"))
		if parts[2] != hex.EncodeToString(sum[:]) || r.URL.Path != "/eapi/"+strings.TrimPrefix(parts[0], "/api/") {
			return nil, fmt.Errorf("incorrect EAPI signature or path")
		}
		var params map[string]any
		if err := json.Unmarshal([]byte(parts[1]), &params); err != nil {
			return nil, err
		}
		body := `{"code":200}`
		switch parts[0] {
		case "/api/w/nuser/account/get":
			body = `{"code":200,"profile":{"userId":9,"nickname":"Fixture listener"}}`
		case "/api/search/get":
			body = `{"code":200,"result":{"songs":[` + song + `],"songCount":1}}`
		case "/api/search/suggest/keyword":
			body = `{"code":200,"result":{"allMatch":[{"keyword":"Fixture"}]}}`
		case "/api/v6/playlist/detail":
			body = `{"code":200,"playlist":{"id":2,"name":"List","creator":{"userId":9},"trackIds":[{"id":1}],"trackCount":1}}`
		case "/api/v3/song/detail":
			body = `{"code":200,"songs":[` + song + `]}`
		case "/api/song/like/get":
			body = `{"code":200,"ids":[1]}`
		case "/api/song/lyric/v1":
			body = `{"code":200,"yrc":{"lyric":"[1000,500](1000,500,0)Hello"},"tlyric":{"lyric":"[00:01.000]你好"}}`
		case "/api/song/enhance/player/url/v1":
			body = `{"code":200,"data":[{"id":1,"code":200,"url":"https://m.music.126.net/test.mp3","type":"mp3","level":"standard"}]}`
		case "/api/personalized/playlist":
			body = `{"code":200,"result":[{"id":2,"name":"List"}]}`
		case "/api/toplist":
			body = `{"code":200,"list":[{"id":2,"name":"Chart"}]}`
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})
	p, err := Load(dir, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	if a, err := p.Account(); err != nil || a != nil {
		t.Fatalf("guest account: %+v, %v", a, err)
	}
	if err := p.SetSetting("loginMethod", "web"); err != nil {
		t.Fatal(err)
	}
	if a, err := p.SignIn(); err != nil || a.ID != "9" {
		t.Fatalf("fixture sign-in: %+v, %v", a, err)
	}
	if result, err := p.Search("Fixture", music.SearchTracks, 0); err != nil || len(result.Tracks) != 1 || result.Tracks[0].Source != "netease" {
		t.Fatalf("search: %+v, %v", result, err)
	}
	if suggestions, err := p.Suggest("F"); err != nil || len(suggestions) != 1 {
		t.Fatalf("suggest: %+v, %v", suggestions, err)
	}
	if pl, err := p.Playlist("2"); err != nil || len(pl.Tracks) != 1 || !pl.Mine || pl.Tracks[0].Source != "netease" {
		t.Fatalf("playlist: %+v, %v", pl, err)
	}
	if page, err := p.Liked(0); err != nil || len(page.Tracks) != 1 {
		t.Fatalf("liked: %+v, %v", page, err)
	}
	if likes, err := p.IsLiked([]string{"1", "2"}); err != nil || !likes["1"] || likes["2"] {
		t.Fatalf("isLiked: %+v, %v", likes, err)
	}
	if lyrics, err := p.Lyrics("1"); err != nil || len(lyrics.Lines) != 1 || lyrics.Lines[0].Translation != "你好" {
		t.Fatalf("lyrics: %+v, %v", lyrics, err)
	}
	if st, err := p.Stream("1", "standard"); err != nil || st.Type != "mp3" {
		t.Fatalf("stream: %+v, %v", st, err)
	}
	if home, err := p.Home(); err != nil || len(home.Sections) != 2 {
		t.Fatalf("home: %+v, %v", home, err)
	}
	if chart, err := p.Browse("charts"); err != nil || len(chart.Sections[0].Playlists) != 1 {
		t.Fatalf("charts: %+v, %v", chart, err)
	}
	if err := p.SignOut(); err != nil {
		t.Fatal(err)
	}
	if a, err := p.Account(); err != nil || a != nil {
		t.Fatalf("signed out: %+v, %v", a, err)
	}
}

// This opt-in test uses the host's real fetch against public NetEase content;
// it never signs in, persists credentials, or performs remote mutations.
func TestNetEasePluginLiveReadOnly(t *testing.T) {
	if os.Getenv("NETEASE_LIVE") != "1" || os.Getenv("NETEASE_PLUGIN_DIR") == "" {
		t.Skip("set NETEASE_LIVE=1 and NETEASE_PLUGIN_DIR for the read-only live test")
	}
	p, err := Load(os.Getenv("NETEASE_PLUGIN_DIR"), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	result, err := p.Search("晴天", music.SearchTracks, 0)
	if err != nil || len(result.Tracks) == 0 {
		t.Fatalf("live search: %+v, %v", result, err)
	}
	id := result.Tracks[0].ID
	if lyrics, err := p.Lyrics(id); err != nil || lyrics == nil {
		t.Fatalf("live lyrics: %+v, %v", lyrics, err)
	}
	if st, err := p.Stream(id, "standard"); err != nil || st.URL == "" {
		t.Fatalf("live stream: %+v, %v", st, err)
	}
	if home, err := p.Home(); err != nil || len(home.Sections) == 0 {
		t.Fatalf("live home: %+v, %v", home, err)
	}
}
