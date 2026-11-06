// Optional read-only live check. No account, login, or remote writes.
// Run: node --experimental-vm-modules tests/smoke.mjs
import { readFile } from "node:fs/promises";
import { SourceTextModule, createContext } from "node:vm";
import { createHash, createCipheriv } from "node:crypto";

const values = new Map();
const module = new SourceTextModule(await readFile(new URL("../index.js", import.meta.url), "utf8"), {
  context: createContext({ URL, AbortController, fetch, setTimeout, clearTimeout, console,
    host: {
      storage: { get: (key) => values.get(key), set: (key, value) => values.set(key, value), remove: (key) => values.delete(key) },
      setting: () => "",
      crypto: {
        md5: (text) => createHash("md5").update(text).digest("hex"),
        aesEcbEncrypt: (key, text) => {
          const cipher = createCipheriv("aes-128-ecb", key, null);
          return Buffer.concat([cipher.update(text), cipher.final()]).toString("hex");
        },
      },
    },
  }),
});
await module.link(() => { throw new Error("unexpected import"); });
await module.evaluate();
const api = module.namespace;
let failed = false;
async function check(name, run) {
  try { console.log("PASS", name, JSON.stringify(await run())); }
  catch (error) { failed = true; console.error("FAIL", name, error.code || "", error.message); }
}
let track, publicPlaylist, publicArtist, publicShow;
await check("guest account", () => api.account());
for (const kind of ["tracks", "albums", "artists", "playlists", "shows"]) {
  await check("search " + kind, async () => {
    const result = await api.search({ query: "晴天", kind, offset: 0 });
    if (!Array.isArray(result[kind]) || result[kind].length === 0) throw new Error("expected search results");
    if (kind === "tracks") track = result.tracks[0];
    if (kind === "artists") publicArtist = result.artists.find((a) => a.id);
    if (kind === "shows") publicShow = result.shows.find((s) => s.id);
    if (kind === "playlists") publicPlaylist = result.playlists.find((p) => p.trackCount > 0 && p.trackCount <= 100);
    return { count: result[kind].length, more: result.more };
  });
}
await check("suggest", async () => ({ count: (await api.suggest({ query: "晴天" })).length }));
await check("home", async () => ({ sections: (await api.home()).sections.length }));
await check("charts", async () => ({ playlists: (await api.browse({ page: "charts" })).sections[0].playlists.length }));
if (publicShow) await check("show", async () => {
  const result = await api.show({ id: publicShow.id, offset: 0 });
  if (!result.show.id) throw new Error("missing show identity");
  return { episodes: result.episodes.length, more: result.more };
});
if (publicPlaylist) await check("playlist", async () => {
  const result = await api.playlist({ id: publicPlaylist.id });
  if (result.tracks.length !== result.trackCount) throw new Error("playlist truncated");
  return { tracks: result.tracks.length, count: result.trackCount };
});
if (track) {
  await check("album", async () => ({ tracks: (await api.album({ id: track.album.id })).tracks.length }));
  if (publicArtist) await check("artist", async () => {
    const result = await api.artist({ id: publicArtist.id });
    return { tracks: result.tracks.length, albums: result.albums.length };
  });
  await check("lyrics", async () => {
    const result = await api.lyrics({ id: track.id });
    return { lrc: !!result.lrc, wordLines: result.lines?.length || 0 };
  });
  await check("comments", async () => {
    const result = await api.comments({ trackId: track.id, offset: 0 });
    return { total: result.total, count: result.comments.length };
  });
  await check("stream and audio", async () => {
    const result = await api.stream({ id: track.id, quality: "standard" });
    const response = await fetch(result.url, { headers: { ...result.headers, Range: "bytes=0-1023" }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("audio HTTP " + response.status);
    const reader = response.body.getReader();
    const first = await reader.read();
    await reader.cancel();
    if (!first.value?.length) throw new Error("empty audio");
    return { type: result.type, status: response.status, receivedBytes: first.value.length };
  });
}
if (failed) throw new Error("Some live checks failed; see above");
