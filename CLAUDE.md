# 小锚（st-chat-anchor）交接

SillyTavern 第三方扩展，防丢楼。v1.0–1.2.0 在 claude.ai 里写完；v1.2.1 起在 Claude Code 里继续。测试在原版 ST 1.19.0（release 分支，提交 06bde93）上跑，`tests/run.sh` 一键起酒馆、跑全部脚本（见下面「测试」）。

用户：江。用中文沟通，主要在 iPhone 上用酒馆。她和她的用户长期丢楼，旧插件「聊天记录快速恢复」（作者已弃坑）救不回来。

## 已确认的事实

**丢楼根因（已在原版 1.19.0 复现）**
`public/script.js` 的 `getChat()`：读取 `/api/chats/get` 失败（网络错误或非 2xx）会进 catch，调 `getChatResult()`。此时 `chat` 已被清空，于是塞入开场白并立刻 `saveChatConditional()`，把原文件覆盖成只剩开场白。没有弹窗和报错。
- 从 `openCharacterChat` / `selectCharacterById` 进来时 `chat_metadata` 被重置为 `{}`，没有 integrity，服务器跳过校验。
- 从 `reloadCurrentChatUnsafe` 进来时 `chat_metadata` 没重置，带着有效的旧 integrity，校验照样通过。所以不能用"有没有 integrity"判断是否处于坏状态。
- 群聊同理：`group-chats.js` 的 `loadGroupChat` 遇到非 2xx 返回 `[]`，`getGroupChat` 当成新聊天并 `saveGroupChat`。
- 群聊遇到**网络错误**（fetch 抛异常）则不同：`loadGroupChat` 没有 try/catch，`getGroupChat` 整个中断，不保存、不发 `CHAT_CHANGED`，屏幕留空（0 楼）。这时用户再发一句话就会把空聊天存回去盖掉原文件。

**截图里的 400**（`The request's body.chat is not an array.`）
旧插件的恢复请求在原版 1.19 上返回 200。只有请求体到达服务器时是空的才会出这句。谁弄丢了请求体，未知。酒馆自己的保存走同一个接口，如果也被这样弄丢会同样失败，这点是猜测，没证实。

**酒馆自带的服务器备份**
`src/endpoints/chats.js` 的 `backupChat`：按角色卡名分组，每个角色留 50 份，10 秒节流。恢复走 `/api/chats/import`。

## 架构

单文件 `index.js`，不 import 任何酒馆内部模块，只用 `SillyTavern.getContext()`。这是刻意的：旧插件 import 了一堆内部导出，任何一个改名整个插件就加载不了。

**存储**：IndexedDB `ST_ChatAnchor` v1
- `snaps`：一份快照 = 楼层哈希数组 + 元数据哈希，键 `chatKey#ts`
- `blobs`：`[chatKey, hash]` → 该楼的 JSON 字符串。内容寻址，跨快照去重
- `chats`：每个聊天一条，含 `lastCount`（掉楼检测用）和 `alert`
- `log`：事件记录，最多 300 条

**chatKey**：角色聊天 `c|<avatar>|<chat文件名>`，群聊 `g|<chat_id>`。用 avatar 不用角色下标，下标会变。

**快照**：直接序列化内存里的 `ctx.chat`，不从服务器取。逐楼 `JSON.stringify` + cyrb53，每 10ms 让出一次主线程。签名没变就跳过。

**保留**：锁定的 + 最近 N 份 + 24 小时内每小时 1 份 + N 天内每天 1 份。`prune()` 顺带回收无引用的 blob。

**守门**（`installFetchGuard`，包 `window.fetch`）
1. 读取聊天的请求失败 → 给该 chatKey 记一个未确认的标记
2. 未确认期间只拦"当前聊天且 `chat.length <= 1`"的保存
3. 20 秒内等到 `CHAT_CHANGED` → 确认，之后拦这个聊天的所有保存，弹窗让用户重新读取
4. 该聊天再次读取成功 + 下一次 `CHAT_CHANGED` → 清除
5. 20 秒没等到 `CHAT_CHANGED` → 标记作废（说明是别的插件在读，不是酒馆）
6. 例外：读取失败 1 秒后如果当前聊天就是这个 key 且 `chat.length === 0`，直接确认并弹窗（针对上面群聊网络错误那条；别的插件读取失败不会把屏幕清空，不会误伤）

**补存**：保存请求失败 → 记录状态码和响应体 → 3 / 8 / 20 秒后调 `ctx.saveChat()`。integrity 错误不重试，酒馆自己会弹窗。

**恢复**
- 新聊天：`/api/chats/import`（multipart，文件字段名必须是 `avatar`），再 `openCharacterChat`
- 覆盖当前：先存一份锁定的"恢复前"快照 → `chat.splice` → `updateChatMetadata(meta, true)` 并沿用当前 integrity → `ctx.saveChat()` → 确认保存成功才 `reloadCurrentChat()`

**服务器备份**（v1.2.0，「服务器」页）：`/api/backups/chat/get` 列出、`/api/backups/chat/download` 下载，再走 `importToCharacter()`。文件名 `chat_<key>_<YYYYMMDD-HHMMSS>.jsonl`，`backupKeyOf()` 复刻了服务器的 `getBackupKey`（非 ASCII 名字带 sha256 前 8 位），用来把备份对回角色卡。SHA-256 是纯 JS 实现，因为云酒馆常用 http，浏览器不给 `crypto.subtle`。文件名里的时间是服务器本地时间，只用来排序和原样显示。

`/api/backups/chat/get` 在**服务器端**把 backups 目录里每一份文件都用 readline 串行读一遍（`src/endpoints/backups.js` → `getChatInfo`），本机实测约 100MB/s：200 份 182MB 要 1.9 秒，几 GB 就是几十秒到几分钟，直接走 http://ip:端口 又没有反代超时。1.2.0 的面板 `await` 死等这个接口，期间 `P.busy` 为 true，点别的页签都排队，用户越点「刷新」越叠加扫描——这就是 1.2.0「服务器页一直卡死」的原因。1.2.1 改成：`serverBackups()` 是后台任务，`S.srvJob` 保证同一时刻只有一个请求（刷新、切页都不会再发），`S.srvTimeoutMs`（默认 90 秒）用 AbortController 超时，读到缓存 10 分钟（`S.srv`），失败记在 `S.srvLast` 并保留上一次的列表，面板从不 await 它：没结果时返回「正在读取…已等 N 秒」占位（`tickServerWait` 每秒只改那个 span），读完 `finally` 里 `refreshPanel()` 自动显示。

**旧插件备份救援**（v1.1.0）：只读打开旧插件的 IndexedDB `ST_ChatBackup`（`backups_meta` / `backups_content`，键 `[chatKey, timestamp]`，内容是整份 jsonl 字符串），在「全部聊天」页顶部列出，可预览、导出、导入成新聊天。库不存在时不会顺手建空库；每次读完就关连接。

`importToCharacter()`：先切到目标角色再导入。酒馆第一次打开角色时才建聊天目录，目录不存在时 `/api/chats/import` 返回 200 + `{error:true}`。

**调试入口**：`window.ChatAnchor`（`open / snapshot / list / stats / log / restoreInPlace / restoreAsNew / legacy / server / state`）。`state.srvTimeoutMs` 可以改超时（测试用）。

## 不要破坏的约定

- 不 import 酒馆内部文件。
- 所有写库操作走 `enqueue()` 排队，否则 `prune` 会和正在写的快照打架。
- 守门的任何异常都必须放行原请求。误拦一次正常保存比漏拦更糟。
- 未确认的标记不能拦楼数大于 1 的保存。测试 I 就是防这个。
- 每次调用 `ctx()` 重新取，`chatMetadata` 的引用会被 `updateChatMetadata` 换掉。
- 界面颜色只用酒馆主题变量。文案用大白话，按钮写清楚点了会发生什么。

## 测试

`tests/` 全部走环境变量，没有写死的路径：

```bash
# 准备一次：克隆 ST release 分支并装依赖
git clone --depth 1 --branch release https://github.com/SillyTavern/SillyTavern.git ~/st && (cd ~/st && npm install --omit=dev)
pip install playwright   # Chromium 用 Playwright 自带的，或设 CHROMIUM_PATH 指向现成的

# 跑全部（起酒馆 → t1 t3 t4 t5 t6 → 关酒馆）
ST_DIR=~/st tests/run.sh
# 只跑一个；KEEP_ST=1 跑完不关酒馆；ST_PORT / ST_DATA / ST_USER 也可改
ST_DIR=~/st KEEP_ST=1 tests/run.sh t5
```

`run.sh` 会把本仓库符号链接进 `$ST_DIR/public/scripts/extensions/third-party/st-chat-anchor`，端口上已有酒馆就直接用。每个脚本自己改 `settings.json`（跳过首次向导、决定小锚启不启用）、清掉 `data/<用户>/chats/default_Seraphina`。截图和日志在 `tests/out/`（已 gitignore）。

- `stlib.py`：公共库。iPhone 视口 390×844 + 触摸；`Fault` 用 Playwright 路由让某个接口断网 / 返回指定状态码（回调里不能 sleep，会卡住同步 API）；`slow_fetch` 在页面里给 fetch 加延迟模拟慢服务器；磁盘聊天文件读写；`Checks` 计数。
- `t1_rootcause.py`：不装小锚复现根因，两条路径（断网 reload / 502 openCharacterChat），10 项。
- `t3_anchor.py`：A 自动快照，B 去重和跳过，C 断网读取失败，D 502 读取失败，I 第三方读取失败不误拦（含 21 秒等标记作废），E 保存失败补存，F 掉楼检测和覆盖恢复，G 恢复成新聊天，H 面板，59 项。
- `t4_legacy.py`：旧插件备份救援，8 项。
- `t5_server.py`：服务器备份页。前 7 项是 1.2.0 的（中文文件名角色卡 `韩川央.png` 自动复制、跑完删掉），后面是 1.2.1 的慢服务器不卡面板 / 只发一个请求 / 超时提示保留旧列表，18 项。
- `t6_group.py`：群聊根因复现 + 守门（断网、502 两条路径）+ 掉楼 + 两种恢复，33 项，约 3 分钟。用户说群聊优先级低，但代码已经验证过能跑。
- `t7_compression.py`：酒馆开了 `requestCompression` 时的守门、补存、覆盖恢复，13 项。要另起一个实例：`ST_COMPRESS=1 ST_PORT=8124 ST_DATA=/tmp/st-data2 ST_DIR=~/st tests/run.sh t7`（run.sh 会从 default/config.yaml 生成开了压缩、minPayloadSize 2kb 的配置）。
- `t8_perf.py`：几千楼的性能基线，只打印数字，阈值很宽。`FLOORS=5000 tests/run.sh t8`。

注意事项：`/send`、`/sendas`、`/cut` 用来模拟发消息、回复、删楼（走 `ctx.executeSlashCommandsWithOptions`）。角色卡 PNG 里记着「当前聊天名」，酒馆打开角色时按它建聊天，所以导入类检查要按 `ctx.chatId` 核对文件，不能数目录里的文件。toast 会盖住面板顶部的页签，计时的点击要先 `toastr.remove()`。路由回调里不能对 gzip 请求体读 `post_data`（会抛 UnicodeDecodeError，请求就永远不放行）。

## 没做和没验证的

1. 「服务器」页只用 200 份 / 182MB 的备份目录测过（1.9 秒）。用户真实环境里几 GB 的目录没实测，超时 90 秒够不够、酒馆会不会被扫描拖慢，要看她反馈。接口本身没有分页，这是酒馆的限制。
2. 群聊：守门和两种恢复在 1.19.0 上跑通了（t6）；`openGroupById` 路径只试了 502。用户说群聊没几个人玩，先不花力气。
3. iOS Safari / App 壳：没实测。重点看导出时的 `navigator.share`、切后台时的快照、IndexedDB 会不会被系统清掉。
4. 400 的来源（`The request's body.chat is not an array.`）：等用户从面板「记录」页复制日志回来。
5. `requestCompression` 已验证（`tests/t7_compression.py`，13 项）：请求体确实是 gzip（看到 Content-Encoding 和 1f8b 魔数），守门退回"当前聊天"后不误拦、断网仍拦、覆盖恢复能确认保存成功、补存正常。
6. 性能基线（`tests/t8_perf.py`，3000 楼、角色楼带 2 个 swipe、7.8MB 文件，本机 Chromium 141）：酒馆打开 1.4 秒；小锚首次快照把全部楼层写进 IndexedDB 再花 1.7 秒（期间最长的长任务 360ms，含酒馆自己的渲染）；之后内容没变的重算 127ms、改一楼 114ms（含整理），都没有 >50ms 的长任务；连续 15 份快照平均 132ms/份，13 份快照共 3012 个 blob、约 8.3MB；恢复成新聊天 3.1 秒、覆盖恢复 3.2 秒；面板打开 226ms。手机上没量过，预计慢 3–5 倍。
7. 上游报告：草稿在 `docs/upstream-bug-report.md`，还没发到 SillyTavern 的 issues。
