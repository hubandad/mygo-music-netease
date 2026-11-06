# 网易云音乐 · MyGo Music 插件

适配 [egoist/mygo-music](https://github.com/egoist/mygo-music) 的独立音乐源插件。研究基准为 2026-11-06 的提交 [`9c7f629`](https://github.com/egoist/mygo-music/commit/9c7f629ef202d66ee064ee9128c34b169b5e7215)（v0.1.6）。直接连接网易云接口；安装使用不需要 Node.js、Go、npm 或额外 API 服务。

## 安装

推荐从 GitHub 安装：在 MyGo Music → **设置 → 插件 → + → GitHub** 中填写 `hubandad/mygo-music-netease`。宿主会下载最新发布的通用插件包，后续版本也可在插件设置中检查更新。

也可以从 [Releases](https://github.com/hubandad/mygo-music-netease/releases/latest) 下载 ZIP 后安装：

1. 打开 MyGo Music → **设置 → 插件 → +**。
2. 选择从本机 ZIP 安装，打开 `mygo-music-netease-1.0.0.zip`。也可以直接选择本插件文件夹。
3. 确认网络权限，切换到“网易云音乐”音乐源。
4. 搜索和浏览公开内容可以不登录；点击登录后，用网易云音乐 App 扫描二维码并在手机上确认。

也可通过“显示插件文件夹”，将整个插件目录复制进去，再重启 MyGo Music。确保 `plugin.json` 与 `index.js` 位于该目录的同一层。

扫码无法完成时，在插件设置的“登录方式”填写 `web`，再点击登录。宿主会打开独立的网易云网页登录窗口；登录后自动取得 Cookie。留空或填写 `qr` 恢复扫码模式。

## 功能

| 范围 | 已实现 |
| --- | --- |
| 账号 | 扫码登录、网页登录、状态验证、本地退出、过期状态清理 |
| 发现 | 推荐歌单、每日推荐歌曲和歌单、排行榜、私人 FM |
| 搜索 | 单曲、专辑、歌手、歌单、播客；搜索建议和分页 |
| 播放 | 标准、极高、无损请求；MP3 / FLAC / OGG；响度信息 |
| 歌词 | LRC、翻译、YRC 逐字时间；没有逐字歌词时回退到 LRC |
| 音乐库 | 喜欢/取消喜欢、最近播放、我的歌单、专辑收藏、歌手关注 |
| 歌单编辑 | 新建、改名、删除、添加/移除歌曲、移动歌曲顺序 |
| 播客 | 搜索、订阅列表、节目详情、分页、订阅/取消订阅、节目播放 |
| 评论 | 歌曲评论读取、点赞/取消点赞 |

音质对应：宿主 `standard` → 网易云 `standard`；`high` → `exhigh`；`lossless` → `lossless`。实际音质和播放权限由网易云及当前账号决定。接口返回试听片段时，插件提示不可完整播放。每次播放重新请求地址，避免使用过期链接。

歌单使用完整 `trackIds` 补齐详情，每批 500 首、最多并发 4 个请求；保留原顺序和下架歌曲的位置。喜欢列表每页 50 首。歌手页展示热门歌曲及最多 100 张专辑。

## 当前边界

- 没有导出 `savePlaylist`、`postComment`：收藏他人歌单、发表评论需要另外的反滥用验证，本版不宣称支持。宿主会按导出函数隐藏这些操作。
- 没有导出 `likeEpisode` 或远程播放函数。播客节目不混入歌曲红心列表，音频由 MyGo Music 播放。
- 最近播放读取网易云已有记录；不上传新的听歌打点。
- 单次网络请求最多 15 秒。宿主普通调用总期限为 30 秒，极大的歌单在网络较慢时仍可能超时。
- 本版未使用真实账号验证收藏、关注和歌单写操作；这些流程经过模拟接口检查。首次实际登录及账号写入仍需在你的账号下验证。
- 部分专辑详情不返回收藏状态，因此单独打开专辑时可能先显示未收藏；“收藏专辑”列表返回的项目标记为已收藏。

## 权限和数据

仅声明 `music.163.com`、`interface.music.163.com` 两个网络域名，不请求进程权限。音频及封面地址交给宿主自己的播放器和图片加载器处理。

登录 Cookie 和账号信息保存在宿主的插件数据目录中。当前仓库通过权限为 `0600` 的 `storage.json` 保存它们，并非系统钥匙串。插件不会记录 Cookie、密码或播放链接到控制台。退出登录会清除该插件保存的登录状态，不注销其他网易云客户端。

## 源码与验证

- `plugin.json`：清单、权限、登录方式设置、侧边栏入口。
- `index.js`：完整可安装实现，无外部运行依赖。
- `PLUGIN_API.md`：仓库插件定义、调用方式和适配设计。
- `tests/plugin.test.js`：18 项本地行为测试，无网络、无账号。
- `tests/host_test.go`：原仓库真实运行时的模拟测试，以及可选只读联网检查。
- `tests/smoke.mjs`：游客模式的真实接口检查，只读取公开数据和一个音频片段。
- `VALIDATION.md`：交付前检查结果和未验证范围。

本地测试需要 Node.js 22 或以上版本；插件安装运行不需要它：

```sh
npm test
node --experimental-vm-modules tests/smoke.mjs
```

宿主兼容性检查：将 `tests/host_test.go` 复制到原仓库 `internal/plugin/netease_test.go`，在原仓库中运行：

```sh
NETEASE_PLUGIN_DIR=/absolute/path/to/mygo-music-netease go test ./internal/plugin -run TestNetEasePluginRuntime -v
NETEASE_LIVE=1 NETEASE_PLUGIN_DIR=/absolute/path/to/mygo-music-netease go test ./internal/plugin -run TestNetEasePluginLiveReadOnly -v
go test ./internal/...
```

## 发布

本仓库为 [hubandad/mygo-music-netease](https://github.com/hubandad/mygo-music-netease)。清单位于根目录，通用 ZIP 在 [Releases](https://github.com/hubandad/mygo-music-netease/releases) 发布；宿主通过 GitHub 安装入口安装和检查更新。

安装协议地址为 `mygo-music://install-plugin?repo=hubandad/mygo-music-netease`。也可直接在宿主中填写上述仓库名。

本实现使用 MIT 许可证；协议与参数参考来源及其许可见 `NOTICE`。本插件与网易云音乐官方无关联。
