# 小锚（st-chat-anchor）交接

SillyTavern 第三方扩展，防丢楼。v1.2.0 在 claude.ai 里写完，在原版 ST 1.19.0（release 分支）上跑通 41 项端到端检查。现在转到 Claude Code 继续。

用户：江。用中文沟通，主要在 iPhone 上用酒馆。她和她的用户长期丢楼，旧插件「聊天记录快速恢复」（作者已弃坑）救不回来。

## 已确认的事实

**丢楼根因（已在原版 1.19.0 复现）**
`public/script.js` 的 `getChat()`：读取 `/api/chats/get` 失败（网络错误或非 2xx）会进 catch，调 `getChatResult()`。此时 `chat` 已被清空，于是塞入开场白并立刻 `saveChatConditional()`，把原文件覆盖成只剩开场白。没有弹窗和报错。
- 从 `openCharacterChat` / `selectCharacterById` 进来时 `chat_metadata` 被重置为 `{}`，没有 integrity，服务器跳过校验。
- 从 `reloadCurrentChatUnsafe` 进来时 `chat_metadata` 没重置，带着有效的旧 integrity，校验照样通过。所以不能用"有没有 integrity"判断是否处于坏状态。
- 群聊同理：`group-chats.js` 的 `loadGroupChat` 遇到非 2xx 返回 `[]`，`getGroupChat` 当成新聊天并 `saveGroupChat`。

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

**补存**：保存请求失败 → 记录状态码和响应体 → 3 / 8 / 20 秒后调 `ctx.saveChat()`。integrity 错误不重试，酒馆自己会弹窗。

**恢复**
- 新聊天：`/api/chats/import`（multipart，文件字段名必须是 `avatar`），再 `openCharacterChat`
- 覆盖当前：先存一份锁定的"恢复前"快照 → `chat.splice` → `updateChatMetadata(meta, true)` 并沿用当前 integrity → `ctx.saveChat()` → 确认保存成功才 `reloadCurrentChat()`

**服务器备份**（v1.2.0，「服务器」页）：`/api/backups/chat/get` 列出、`/api/backups/chat/download` 下载，再走 `importToCharacter()`。文件名 `chat_<key>_<YYYYMMDD-HHMMSS>.jsonl`，`backupKeyOf()` 复刻了服务器的 `getBackupKey`（非 ASCII 名字带 sha256 前 8 位），用来把备份对回角色卡。SHA-256 是纯 JS 实现，因为云酒馆常用 http，浏览器不给 `crypto.subtle`。文件名里的时间是服务器本地时间，只用来排序和原样显示。

**旧插件备份救援**（v1.1.0）：只读打开旧插件的 IndexedDB `ST_ChatBackup`（`backups_meta` / `backups_content`，键 `[chatKey, timestamp]`，内容是整份 jsonl 字符串），在「全部聊天」页顶部列出，可预览、导出、导入成新聊天。库不存在时不会顺手建空库；每次读完就关连接。

`importToCharacter()`：先切到目标角色再导入。酒馆第一次打开角色时才建聊天目录，目录不存在时 `/api/chats/import` 返回 200 + `{error:true}`。

**调试入口**：`window.ChatAnchor`（`open / snapshot / list / stats / log / restoreInPlace / restoreAsNew / legacy / server / state`）

## 不要破坏的约定

- 不 import 酒馆内部文件。
- 所有写库操作走 `enqueue()` 排队，否则 `prune` 会和正在写的快照打架。
- 守门的任何异常都必须放行原请求。误拦一次正常保存比漏拦更糟。
- 未确认的标记不能拦楼数大于 1 的保存。测试 I 就是防这个。
- 每次调用 `ctx()` 重新取，`chatMetadata` 的引用会被 `updateChatMetadata` 换掉。
- 界面颜色只用酒馆主题变量。文案用大白话，按钮写清楚点了会发生什么。

## 测试

`tests/` 是从沙盒原样拷出来的，路径写死了 `/home/claude/st` 和端口 8123，要先改成可配置。
- `run.sh`：起 ST → 跑脚本 → 关 ST
- `t1_rootcause.py`：不装插件时复现根因（301 楼 → 1 楼）
- `t5_server.py`：服务器备份页，7 项检查。跑之前要把 `default_Seraphina.png` 复制一份叫 `韩川央.png` 放进 characters，跑完删掉
- `t4_legacy.py`：旧插件备份救援，7 项检查
- `t3_anchor.py`：27 项检查。A 自动快照，B 去重和跳过，C 断网读取失败，D 502 读取失败，I 第三方读取失败不误拦，E 保存失败补存，F 掉楼检测和覆盖恢复，G 恢复成新聊天，H 面板

环境：克隆 ST release 分支，`npm install --omit=dev`，把本仓库放进 `public/scripts/extensions/third-party/`，Python Playwright + Chromium，视口 390×844。每次跑之前清掉 `data/default-user/chats/default_Seraphina`。

## 没做和没验证的

1. 群聊：守门和两种恢复的代码都写了，一次都没跑过。
2. iOS Safari / App 壳：没实测。重点看导出时的 `navigator.share`、切后台时的快照、IndexedDB 会不会被系统清掉。
3. 400 的来源：等用户从面板「记录」页复制日志回来。
4. 开了 `requestCompression` 的配置跑过一遍全过，但没确认请求体当时真的被压缩了。压缩后守门拿不到文件名，会退回到"当前聊天"。
5. 只测过约 300 楼、每楼几百字的聊天。几千楼或带大量 swipe 的没测性能。
6. 根因是酒馆本体的 bug，还没向上游报告。
