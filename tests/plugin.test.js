import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SourceTextModule, createContext } from "node:vm";
import { createHash, createCipheriv, createDecipheriv } from "node:crypto";

const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));
const me = { id: "9", name: "Listener" };
const loggedIn = () => ({ cookie: "MUSIC_U=test-token; __csrf=csrf", account: me });
const song = (id) => ({ id: Number(id), name: "Song " + id, ar: [{ id: 4, name: "Artist" }], al: { id: 7, name: "Album", picUrl: "http://p1.music.126.net/cover.jpg" }, dt: 123456 });
const md5 = (text) => createHash("md5").update(text).digest("hex");
function encrypt(key, text) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(text), cipher.final()]).toString("hex");
}
function decode(params) {
  const cipher = createDecipheriv("aes-128-ecb", "e82ckenh8dichen8", null);
  const text = Buffer.concat([cipher.update(Buffer.from(params, "hex")), cipher.final()]).toString();
  const [path, json, hash] = text.split("-36cd479b6b5-");
  assert.equal(hash, md5("nobody" + path + "use" + json + "md5forencrypt"));
  return { path, data: JSON.parse(json) };
}
async function plugin(handler, { session, settings = {}, webSignIn } = {}) {
  const storage = new Map(session ? [["session", session]] : []);
  const calls = [], prompts = [];
  const context = createContext({
    URL, AbortController, console,
    setTimeout: (fn, ms) => ms === 2000 ? (queueMicrotask(fn), 0) : setTimeout(fn, ms),
    clearTimeout,
    host: {
      storage: { get: (key) => storage.get(key), set: (key, value) => storage.set(key, plain(value)), remove: (key) => storage.delete(key) },
      setting: (key) => settings[key] || "", crypto: { md5, aesEcbEncrypt: encrypt },
      signInPrompt: (prompt) => prompts.push(plain(prompt)),
      webSignIn: webSignIn || (() => { throw new Error("unexpected web sign-in"); }),
    },
    fetch: async (url, options) => {
      const request = { ...decode(new URLSearchParams(options.body).get("params")), headers: options.headers, signal: options.signal };
      assert.equal(url, "https://interface.music.163.com/eapi/" + request.path.slice(5));
      assert.equal(request.data.e_r, false);
      calls.push(request);
      const result = await handler(request);
      return result instanceof Response ? result : new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    },
  });
  const mod = new SourceTextModule(source, { context });
  await mod.link(() => { throw new Error("plugins must not import dependencies"); });
  await mod.evaluate();
  return { api: mod.namespace, storage, calls, prompts };
}

// Every search kind maps actual NetEase fields to the host's JSON contract.
test("search maps all five result kinds and pagination", async () => {
  const fixtures = {
    1: { songs: [song(1)], songCount: 51 },
    10: { albums: [{ id: 7, name: "Album" }], albumCount: 1 },
    100: { artists: [{ id: 4, name: "Artist" }], artistCount: 1 },
    1000: { playlists: [{ id: 2, name: "List", creator: { userId: 9 } }], playlistCount: 1 },
    1009: { djRadios: [{ id: 8, name: "Show", programCount: 2 }], djRadiosCount: 1 },
  };
  const p = await plugin(({ data }) => ({ code: 200, result: fixtures[data.type] }), { session: loggedIn() });
  for (const kind of ["tracks", "albums", "artists", "playlists", "shows"]) {
    const result = plain(await p.api.search({ query: "test", kind, offset: 0 }));
    assert.equal(result[kind].length, 1);
    assert.equal(typeof result[kind][0].id, "string");
    assert.equal(result.more, kind === "tracks");
  }
  const result = await p.api.search({ query: "test", kind: "tracks", offset: 50 });
  assert.equal(result.more, false);
  assert.equal(result.tracks[0].duration, 123456);
  assert.match(result.tracks[0].album.imageUrl, /^https:/);
  assert.equal(p.calls[0].data.header.MUSIC_U, "test-token");
  assert.match(p.calls[0].headers.cookie, /__csrf=csrf/);
});

// Empty and invalid user input must not make malformed service requests.
test("empty search, unsupported kind and invalid IDs fail before fetching", async () => {
  const p = await plugin(() => { throw new Error("unexpected request"); });
  assert.deepEqual(plain(await p.api.search({ query: " " })), { tracks: [], more: false });
  await assert.rejects(p.api.search({ query: "a", kind: "users" }), { code: "unsupported" });
  await assert.rejects(p.api.stream({ id: "1&ids=2" }), { code: "unavailable" });
  await assert.rejects(p.api.search({ query: "a", offset: -1 }));
  assert.equal(p.calls.length, 0);
});

// NetEase uses ID 0 for an unlinked performer, not a real artist page.
test("unknown performers and albums retain names without broken resource links", async () => {
  const p = await plugin(() => ({ code: 200, result: { songs: [{ id: 1, name: "Song", artists: [{ id: 0, name: "Uploader" }], album: { id: 0, name: "Unknown" } }], songCount: 1 } }));
  const result = await p.api.search({ query: "a" });
  assert.equal(result.tracks[0].artists[0].id, "");
  assert.equal(result.tracks[0].artists[0].name, "Uploader");
  assert.equal(result.tracks[0].album.id, "");
});

// resourceState describes the remote resource; it is not an album subscription.
test("album availability is not mistaken for a saved album", async () => {
  const p = await plugin(() => ({ code: 200, resourceState: true, album: { id: 7, name: "Album" }, songs: [song(1)] }));
  const result = await p.api.album({ id: "7" });
  assert.equal(result.album.saved, false);
});

// Playlist details may contain only an initial subset; the ID list is complete.
test("long playlists fetch missing details in batches and retain order and removed songs", async () => {
  const ids = Array.from({ length: 1103 }, (_, i) => String(i + 1));
  const p = await plugin(({ path, data }) => {
    if (path.includes("playlist/detail")) return { code: 200, playlist: { id: 2, name: "Large", trackCount: ids.length, trackIds: ids.map((id) => ({ id })), tracks: [song(1)] } };
    const batch = JSON.parse(data.c);
    assert.ok(batch.length <= 500);
    return { code: 200, songs: batch.filter((s) => s.id !== "300").reverse().map((s) => song(s.id)) };
  });
  const result = plain(await p.api.playlist({ id: "2" }));
  assert.equal(result.tracks.length, ids.length);
  assert.deepEqual(result.tracks.map((s) => s.id), ids);
  assert.equal(result.tracks[299].unavailable, true);
  assert.equal(result.tracks[300].name, "Song 301");
  assert.equal(p.calls.length, 4);
});

// A NetEase trial must not be returned as if it were a full-length song.
test("stream maps quality and rejects trial, unavailable and unsupported audio", async () => {
  let response = { id: 1, code: 200, url: "https://m.music.126.net/a.flac", type: "flac", level: "lossless", br: 900000, size: 123, gain: -4.2, peak: 0.9 };
  const p = await plugin(() => ({ code: 200, data: [response] }));
  const result = plain(await p.api.stream({ id: "1", quality: "lossless" }));
  assert.equal(p.calls[0].data.level, "lossless");
  assert.equal(result.type, "flac");
  assert.equal(result.gain, -4.2);
  assert.equal(result.headers.Cookie, undefined);
  await p.api.stream({ id: "1", quality: "high" });
  assert.equal(p.calls[1].data.level, "exhigh");
  for (const changes of [{ url: null }, { freeTrialInfo: { start: 0, end: 30 } }, { type: "aac" }, { url: "file:///tmp/audio.mp3" }]) {
    response = { id: 1, code: 200, url: "https://m.music.126.net/a.mp3", type: "mp3", ...changes };
    await assert.rejects(p.api.stream({ id: "1" }), { code: "unavailable" });
  }
});

// QR state codes and Set-Cookie must produce a verified, persistent session.
test("QR login polls until confirmation and saves cookies only after account verification", async () => {
  let poll = 0;
  const p = await plugin(({ path, data }) => {
    if (path.endsWith("unikey")) return { code: 200, unikey: "key+value" };
    if (path.endsWith("client/login")) {
      poll++;
      if (poll < 3) return { code: poll === 1 ? 801 : 802 };
      const headers = new Headers();
      headers.append("set-cookie", "MUSIC_U=token%2Babc; Path=/; HttpOnly");
      headers.append("set-cookie", "__csrf=new-csrf; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/");
      return new Response('{"code":803}', { headers });
    }
    assert.equal(data.header.MUSIC_U, "token+abc");
    assert.equal(p.storage.has("session"), false);
    return { code: 200, profile: { userId: 9, nickname: "Listener" } };
  });
  const account = plain(await p.api.signIn());
  assert.equal(account.id, "9");
  assert.match(p.storage.get("session").cookie, /MUSIC_U=token%2Babc/);
  assert.equal(p.prompts.length, 3);
  assert.match(p.prompts[0].qr, /key%2Bvalue/);
  assert.match(p.prompts.at(-1).text, /确认/);
});

// Expired QR codes must not create a partial login state.
test("expired QR returns signIn error without saving credentials", async () => {
  const p = await plugin(({ path }) => path.endsWith("unikey") ? { code: 200, unikey: "x" } : { code: 800 });
  await assert.rejects(p.api.signIn(), { code: "signIn" });
  assert.equal(p.storage.has("session"), false);
});

// Web login uses the host's isolated sign-in window and verifies its result.
test("web sign-in requests only NetEase cookies and verifies the account", async () => {
  const p = await plugin(() => ({ code: 200, profile: { userId: 9, nickname: "Listener" } }), {
    settings: { loginMethod: "web" }, webSignIn: async (options) => {
      assert.equal(options.cookiesOf, "https://music.163.com/");
      assert.deepEqual(plain(options.until), ["MUSIC_U"]);
      return { cookie: "MUSIC_U=web-token" };
    },
  });
  assert.equal((await p.api.signIn()).id, "9");
  assert.match(p.storage.get("session").cookie, /web-token/);
});

// A response from an old login must not resurrect credentials after sign-out.
test("sign-out during an in-flight account request cannot restore the session", async () => {
  let finish;
  const p = await plugin(() => new Promise((resolve) => { finish = resolve; }), { session: loggedIn() });
  const pending = p.api.account();
  p.api.signOut();
  finish({ code: 200, profile: { userId: 9, nickname: "Old user" } });
  assert.equal(await pending, null);
  assert.equal(p.storage.has("session"), false);
});

// Session expiry clears both credentials and the cached set of liked songs.
test("expired credentials clear session and authenticated operations prompt sign-in", async () => {
  const p = await plugin(() => ({ code: 301 }), { session: loggedIn() });
  assert.equal(await p.api.account(), null);
  await assert.rejects(p.api.like({ id: "1", on: true }), { code: "signIn" });
  assert.equal(p.calls.length, 1);
  assert.deepEqual(plain(await p.api.isLiked({ ids: ["1"] })), { 1: false });
});

// A confirmed heart change invalidates cached likes so the next view is fresh.
test("liked songs paginate, cache by account and invalidate after mutations", async () => {
  let liked = ["1", "2"];
  const p = await plugin(({ path, data }) => {
    if (path.endsWith("like/get")) return { code: 200, ids: liked };
    if (path.endsWith("radio/like")) { liked = data.like ? [...liked, data.trackId] : liked.filter((id) => id !== data.trackId); return { code: 200 }; }
    return { code: 200, songs: JSON.parse(data.c).map((s) => song(s.id)) };
  }, { session: loggedIn() });
  assert.deepEqual(plain(await p.api.isLiked({ ids: ["1", "3"] })), { 1: true, 3: false });
  const page = await p.api.liked({ offset: 0 });
  assert.equal(page.tracks.length, 2);
  assert.equal(p.calls.filter((c) => c.path.endsWith("like/get")).length, 1);
  await p.api.like({ id: "3", on: true });
  assert.equal((await p.api.isLiked({ ids: ["3"] }))["3"], true);
  assert.equal(p.calls.filter((c) => c.path.endsWith("like/get")).length, 2);
});

// Moving a song must use the full source order, including unavailable entries.
test("playlist reordering moves a single ID without dropping the others", async () => {
  const p = await plugin(({ path }) => path.includes("playlist/detail")
    ? { code: 200, playlist: { id: 2, trackIds: [1, 2, 3].map((id) => ({ id })) } }
    : { code: 200 }, { session: loggedIn() });
  await p.api.movePlaylistTrack({ id: "2", from: 0, to: 2 });
  assert.deepEqual(JSON.parse(p.calls[1].data.trackIds), ["2", "3", "1"]);
  assert.equal(p.calls[1].data.op, "update");
  await assert.rejects(p.api.movePlaylistTrack({ id: "2", from: 0, to: 3 }));
  assert.equal(p.calls.filter((c) => c.data.op === "update").length, 1);
});

// YRC timestamps are already absolute milliseconds; parentheses are lyric text.
test("word lyrics preserve timing and punctuation and attach translation", async () => {
  const p = await plugin(() => ({ code: 200,
    yrc: { lyric: '{"metadata":1}\n[1000,1500](1000,500,0)Hello (1500,1000,0)(world)' },
    lrc: { lyric: "[00:01.00]Hello (world)" }, ytlyric: { lyric: "[00:01.000]你好，世界" },
  }));
  const result = plain(await p.api.lyrics({ id: "1" }));
  assert.equal(result.lines[0].text, "Hello (world)");
  assert.equal(result.lines[0].translation, "你好，世界");
  assert.deepEqual(result.lines[0].words[1], { start: 1500, end: 2500, text: "(world)" });
  assert.equal(result.lines[0].end, 2500);
});

// Plain LRC and instrumentals remain valid when no word-level lyrics exist.
test("lyrics fall back to LRC or an empty instrumental response", async () => {
  let body = { code: 200, lrc: { lyric: "[00:01]Hello" }, tlyric: { lyric: "[00:01]你好" } };
  const p = await plugin(() => body);
  assert.deepEqual(plain(await p.api.lyrics({ id: "1" })), { lrc: "[00:01]Hello", translation: "[00:01]你好" });
  body = { code: 200, nolyric: true };
  assert.deepEqual(plain(await p.api.lyrics({ id: "1" })), { lrc: "", translation: "" });
});

// Episodes play by mainSong ID while their share links use program ID.
test("podcasts keep show identity, playback IDs and episode pagination separate", async () => {
  const p = await plugin(({ path }) => path.endsWith("v2/get")
    ? { code: 200, data: { id: 8, name: "Show", programCount: 51 } }
    : { code: 200, count: 51, programs: [{ id: 200, name: "Episode", mainSong: song(100), radio: { id: 8, name: "Show" }, dj: { userId: 9, nickname: "Host" } }] });
  const result = plain(await p.api.show({ id: "8", offset: 0 }));
  assert.equal(result.episodes[0].id, "100");
  assert.equal(result.episodes[0].showId, "8");
  assert.equal(result.episodes[0].artists[0].id, "");
  assert.equal(result.episodes[0].album.id, "");
  assert.match(result.episodes[0].url, /program\?id=200$/);
  assert.equal(result.more, true);
});

// Transport and service failures must not be mistaken for valid empty results.
test("HTTP, malformed JSON and service errors surface without automatic retry", async () => {
  for (const response of [new Response("blocked", { status: 403 }), new Response("not json"), { code: -462, message: "请完成验证" }]) {
    const p = await plugin(() => response);
    await assert.rejects(p.api.search({ query: "a" }));
    assert.equal(p.calls.length, 1);
  }
});

// Capabilities absent from this implementation must stay hidden in the host.
test("unsupported or remote capabilities are not advertised", async () => {
  const p = await plugin(() => ({ code: 200 }));
  for (const name of ["remotePlay", "savePlaylist", "postComment", "likeEpisode", "played"]) assert.equal(p.api[name], undefined);
});
