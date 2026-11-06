# mygo-music 插件定义与本实现的对应关系

研究基准：[`egoist/mygo-music@9c7f629ef202d66ee064ee9128c34b169b5e7215`](https://github.com/egoist/mygo-music/tree/9c7f629ef202d66ee064ee9128c34b169b5e7215)，2026-11-06。

## 1. 插件的单位是目录

目录根部必须有 `plugin.json`，以及 `main` 指定的一个 ES 模块。默认入口是 `index.js`，`.ts` 则交给宿主的 TypeScript 编译器。不需要二进制插件、Go 包注册或前端 UI。

清单中音乐源字段来自 `music.Info`，另外增加入口和权限。本插件的 `playback` 为 `stream`；`settings` 提供登录方式，`navigation` 组合内置页面与自定义 `daily`、`charts` 页面。

依据：[README 的 Plugins 部分](https://github.com/egoist/mygo-music/blob/9c7f629ef202d66ee064ee9128c34b169b5e7215/README.md)、[清单加载及运行时](https://github.com/egoist/mygo-music/blob/9c7f629ef202d66ee064ee9128c34b169b5e7215/internal/plugin/plugin.go)。

## 2. 导出函数本身就是能力声明

宿主在加载时编译入口，读取导出函数列表。`Can(name)` 查这个列表，不调用插件探测功能。每个函数接收一个对象，允许返回普通值或 Promise；宿主再将 JSON 解码为统一音乐对象。

因此不能为了“接口齐全”导出空实现。本版只导出实际实现的 33 个函数。未实现的发评论、收藏他人歌单、节目红心和远程播放均不导出。

对应入口包括：

| 类别 | 参数与输出示例 |
| --- | --- |
| 搜索 | `search({query, kind, offset})` → `{tracks/albums/artists/playlists/shows, more}` |
| 页面 | `home()`、`browse({page})` → `{title, sections}` |
| 歌单 | `playlist({id})` → `{id, name, tracks, ...}` |
| 播放 | `stream({id, quality})` → `{url, type, quality, headers, ...}` |
| 歌词 | `lyrics({id})` → `{lrc, translation}` 或含有 `lines[].words` |
| 登录 | `signIn()` → `{id, name, imageUrl}`；未登录的 `account()` → `null` |

依据：[Source 调用桥接](https://github.com/egoist/mygo-music/blob/9c7f629ef202d66ee064ee9128c34b169b5e7215/internal/plugin/source.go)、[完整示例插件](https://github.com/egoist/mygo-music/blob/9c7f629ef202d66ee064ee9128c34b169b5e7215/examples/demo-plugin/index.js)。

## 3. 数据必须转换成宿主约定

ID 统一使用字符串；曲目时长、歌词时间和评论时间使用毫秒。网易云 `ar/artists`、`al/album`、`dt/duration` 都在映射层归一化。网易云的歌手/专辑占位 ID `0` 转为空字符串，宿主就不会生成无效详情链接。

无需自己填写曲目的 `source`，宿主会标上插件 ID。播客曲目使用 `mainSong.id` 获取音频，`showId` 指向电台，分享链接使用节目 ID。这三种 ID 不能混用。

依据：[统一数据结构](https://github.com/egoist/mygo-music/blob/9c7f629ef202d66ee064ee9128c34b169b5e7215/internal/music/music.go)、[来源标记](https://github.com/egoist/mygo-music/blob/9c7f629ef202d66ee064ee9128c34b169b5e7215/internal/plugin/source.go)。

## 4. 运行环境由宿主提供

宿主使用 moejs，为插件提供标准 JavaScript、定时器、fetch、URL 与 `host`。本版不依赖 Node.js、npm 模块或子进程。

`host.crypto.md5` 和 `host.crypto.aesEcbEncrypt` 足以构造网易云 EAPI 请求：按 API 路径与 JSON 计算摘要，使用 AES-ECB 加密，然后向网易云提交表单。`e_r: false` 请求普通 JSON 响应，避免要求宿主提供解密能力。

扫码期间通过 `host.signInPrompt({qr, text})` 更新宿主登录窗口；网页登录则调用 `host.webSignIn`。登录 Cookie 通过 `host.storage` 持久化。额外的会话代数检查防止退出登录后的旧请求把凭据写回来。

网络权限约束插件自己的请求；音频和图片由宿主拿到返回地址后分别加载。本插件不需要 `process` 权限。

依据：[host 的实现](https://github.com/egoist/mygo-music/blob/9c7f629ef202d66ee064ee9128c34b169b5e7215/internal/plugin/host.go)。网易云协议和路径参考：[API Enhanced 的 crypto 实现](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/4a7d557326d16d2f1e5172ee69c9471eb3a50173/util/crypto.js)、[接口模块](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/tree/4a7d557326d16d2f1e5172ee69c9471eb3a50173/module)。

## 5. 异常必须有语义

抛出的 Error 可以带 `code`：`signIn` 触发登录，`setup` 引导设置，`unavailable` 表示不可播放或资源不存在，`unsupported` 表示能力不支持。其他错误显示消息。

插件区分登录过期、二维码失效、服务错误、网络超时、空播放地址、试听权限和不支持的音频格式。写操作不自动重试，因为超时不代表服务端没有执行。

宿主普通调用限时 30 秒，登录限时 5 分钟，运行时内存限额 256 MiB；这也是本实现限制批量请求并发、对喜欢列表分页、对扫码轮询设置总期限的原因。

## 6. 安装与更新不需要改主程序

宿主支持目录、ZIP 和 GitHub 仓库安装；GitHub 安装优先选择最新 Release 的平台 ZIP 或通用 ZIP，没有 Release 时取默认分支。清单需要放在解包后的根目录或唯一的一层目录中。

本交付采用独立插件目录和通用 ZIP，主仓库无运行代码变更。

依据：[安装器](https://github.com/egoist/mygo-music/blob/9c7f629ef202d66ee064ee9128c34b169b5e7215/internal/plugin/install.go)。
