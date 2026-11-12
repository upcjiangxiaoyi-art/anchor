# 给 SillyTavern 上游的 bug 报告（草稿，还没发）

发到 https://github.com/SillyTavern/SillyTavern/issues 之前请再看一遍。复现步骤和代码行号对应 release 分支 1.19.0（提交 06bde93）。
下面是英文正文，可以直接贴。

---

**Title:** A failed `/api/chats/get` silently overwrites the chat file with only the greeting (data loss)

### Environment
- SillyTavern 1.19.0 (release branch, commit 06bde93), default config
- Reproduced with Chromium 141 (mobile viewport) using Playwright; also reproduced manually

### Summary
When the request that loads a chat fails (network error, or any non‑2xx response such as a 502 from a reverse proxy), the client treats the chat as new, inserts the character's greeting and **immediately saves it to the server under the same file name**, overwriting the real chat. No error is shown. For a user on a flaky connection (mobile data, tunnels, proxies) this means a 300‑message chat can turn into a 1‑message chat with no warning.

### Where it happens
`public/script.js`, `getChat()`:

```js
export async function getChat() {
    try {
        ...
        const response = await fetch('/api/chats/get', { ... });
        if (!response.ok) {
            throw new Error('Chat could not be loaded');
        }
        ...
    } catch (error) {
        await getChatResult();      // <-- runs with an empty `chat`
        console.log(error);
    }
}
```

`getChatResult()`:

```js
if (chat.length === 0) {
    const message = getFirstMessage();
    if (message.mes) {
        chat.push(message);
        freshChat = true;
    }
    // Make sure the chat appears on the server
    await saveChatConditional();    // <-- writes the greeting over the existing file
}
```

Because `chat` was cleared before the fetch (`clearChat`), a load failure is indistinguishable from a brand‑new chat, and the save goes out with the real file name.

The integrity check does not help:
- Coming from `openCharacterChat()` / `selectCharacterById()`, `chat_metadata` was reset to `{}`, so the save carries no integrity slug and the server skips the check.
- Coming from `reloadCurrentChatUnsafe()`, `chat_metadata` still holds the *valid* slug of the file being overwritten, so the check passes.

Group chats have the same problem for non‑2xx responses: `loadGroupChat()` in `public/scripts/group-chats.js` returns `[]` when `!response.ok`, and `getGroupChat()` then treats it as a fresh chat (`freshChat = true`), pushes the members' greetings and calls `saveGroupChat()`. (For a *network* error the group path throws instead, which leaves the chat empty on screen but does not save.)

### The same thing happens when the request "succeeds" (HTTP 200)
Two more ways to reach the same overwrite, both reproduced on 1.19.0 (scenarios 3 and 4 in the test script below):

1. **The server answers 200 with `{}`.** `/api/chats/get` in `src/endpoints/chats.js` wraps everything in `try { ... } catch (error) { console.error(error); return response.send({}); }`, and `getChatData()` returns `[]` when the file cannot be read. So any server-side exception while reading the chat (I/O error, out of memory on a large file, ...) is reported to the client as a successful empty chat. The client then takes the "An empty/corrupted chat file" branch, clears `chat`, calls `getChatResult()`, pushes the greeting and saves it over the real file.
2. **The response body is cut off.** With chat files of tens of MB on a mobile connection the body can fail after the headers arrived. `response.json()` rejects, control goes to the same `catch`, and the greeting is saved over the real file.

In both cases the request looks fine in the network tab, which makes this very hard to diagnose for users.

### Steps to reproduce
1. Open a character chat with a few hundred messages. Note the message count and the file on disk.
2. Make the next `/api/chats/get` fail. Any of these work:
   - DevTools → Network → block the request URL `/api/chats/get`, or
   - DevTools → Network → "Offline" for a moment while the chat reloads, or
   - put a proxy in front that returns 502 for that path.
3. Reload the chat (e.g. open it again from the chat list, or trigger `reloadCurrentChat()`).
4. Observe: the UI shows only the greeting; `data/<user>/chats/<char>/<chat>.jsonl` now contains only the greeting. No popup, no toast.

Automated reproduction (Python Playwright, blocks only `/api/chats/get` and lets the save through):
https://github.com/upcjiangxiaoyi-art/anchor/blob/main/tests/t1_rootcause.py

### Expected
A failed load should never result in a save. The user should see an error and the file on disk should stay untouched.

### Suggested fix
Do not fall through to `getChatResult()` on failure, or at least do not save there when the load failed:

```js
} catch (error) {
    console.error(error);
    toastr.error(t`Chat could not be loaded. Check the connection and try again.`);
    chat.splice(0, chat.length);
    await printMessages();
    await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
    return;   // no saveChatConditional()
}
```

On the server, `/api/chats/get` should answer with a 5xx status when reading the file throws, instead of `200 {}`, so the client can tell "this chat does not exist yet" from "this chat could not be read".

and in `getGroupChat()` distinguish "file is empty/new" from "request failed" (e.g. have `loadGroupChat()` throw on `!response.ok` and handle it the same way) so that `saveGroupChat()` is only called for a genuinely new chat.

The server‑side chat backups (`backups/chat_*.jsonl`) do soften the blow, but they are throttled to one per 10 s per character and most users do not know they exist.
