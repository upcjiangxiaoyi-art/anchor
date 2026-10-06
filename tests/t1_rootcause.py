"""
t1_rootcause.py — 不装小锚时复现丢楼根因。

酒馆 getChat() 读取失败会进 catch → getChatResult() → chat 已被清空 → 塞开场白 → saveChatConditional()
把原文件覆盖成只剩开场白。两条进入路径都试：
  场景 1  reloadCurrentChat：chat_metadata 不重置，带着旧 integrity
  场景 2  openCharacterChat：chat_metadata 被重置成 {}
预期：两种情况磁盘上的 301 楼都变成 1 楼，而且没有弹窗、没有报错提示。
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stlib as L  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

NAME = 'root-301'


def no_ui_noise(pg):
    return pg.evaluate('() => !document.querySelector("dialog[open]") && !document.querySelector("#toast-container .toast-error")')


def main():
    L.require_st()
    L.patch_settings(first_run=False, ext_enabled=False)
    L.clear_char_chats()
    C = L.Checks('T1 根因复现（不装小锚）')
    with sync_playwright() as p:
        b, c = L.launch(p)
        pg = c.new_page()
        con = L.Console(pg)
        L.goto_app(pg, ext=False)
        C.ok(pg.evaluate('() => typeof window.ChatAnchor') == 'undefined', '小锚确实没有加载')
        L.select_char(pg)
        L.write_chat(NAME, 301)
        L.open_chat(pg, NAME)
        C.ok(L.chat_len(pg) == 301 and L.floors(NAME) == 301, '301 楼的聊天正常打开')

        C.section('场景 1：reloadCurrentChat 时读取请求断网')
        f = L.Fault(pg, '**/api/chats/get', mode='abort')
        L.ev(pg, 'ctx.reloadCurrentChat().catch(() => {});')
        L.wait_js(pg, 'ctx.chat.length <= 1', timeout=20000)
        time.sleep(2.5)
        f.remove()
        C.ok(f.hits >= 1, '读取请求确实失败了', f'hits={f.hits}')
        C.ok(L.chat_len(pg) == 1, '页面上只剩开场白 1 楼', f'len={L.chat_len(pg)}')
        C.ok(L.floors(NAME) == 1, '磁盘上的 301 楼存档被覆盖成 1 楼', f'floors={L.floors(NAME)}')
        C.ok(no_ui_noise(pg), '没有弹窗，也没有错误提示')

        C.section('场景 2：openCharacterChat 时读取返回 502')
        L.write_chat(NAME, 301)
        L.open_chat(pg, NAME)
        C.ok(L.chat_len(pg) == 301, '重新写回 301 楼并打开')
        f = L.Fault(pg, '**/api/chats/get', mode=502, body='<html><body>502 Bad Gateway</body></html>')
        L.ev(pg, 'ctx.openCharacterChat(arg).catch(() => {});', NAME)
        L.wait_js(pg, 'ctx.chat.length <= 1', timeout=20000)
        time.sleep(2.5)
        f.remove()
        C.ok(L.chat_len(pg) == 1, '页面上只剩开场白 1 楼', f'len={L.chat_len(pg)}')
        C.ok(L.floors(NAME) == 1, '磁盘上的 301 楼存档又被覆盖成 1 楼', f'floors={L.floors(NAME)}')
        C.ok(no_ui_noise(pg), '没有弹窗，也没有错误提示')

        print('\n酒馆控制台里和聊天有关的报错：')
        for ty, t in con.lines:
            if ty == 'error' and ('Chat' in t or 'chat' in t):
                print('  ', t[:160])
        b.close()
    return C.done()


if __name__ == '__main__':
    sys.exit(main())
