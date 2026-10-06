"""
t5_server.py — 「服务器」页：读酒馆自带的服务器备份（data/<用户>/backups/）。

前 7 项照搬 1.2.0 沙盒里的检查（中文文件名的角色卡、备份对回角色、标出掉楼前、一键恢复）。
后面是 1.2.1 修卡死加的：服务器很慢时面板不卡、只发一个请求、超时有提示并保留上次结果。
需要酒馆 1.17 或更新（有 /api/backups/chat/get）。
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stlib as L  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CARD = '韩川央'
OUT = Path(__file__).parent / 'out'


def panel_text(pg):
    return pg.inner_text('.ca-panel .ca-body')


def main():
    L.require_st()
    L.patch_settings(first_run=False, ext_enabled=True)
    L.clear_char_chats()
    L.clear_backups()
    L.remove_card(CARD)
    L.clone_card(CARD)
    OUT.mkdir(exist_ok=True)
    C = L.Checks('T5 服务器备份页')
    try:
        with sync_playwright() as p:
            b, c = L.launch(p)
            pg = c.new_page()
            con = L.Console(pg)
            L.goto_app(pg, ext=True)
            idx = L.ev(pg, 'return ctx.characters.findIndex(ch => ch.avatar === arg);', f'{CARD}.png')
            C.ok(idx >= 0, 'S1 中文文件名的角色卡已加载', f'idx={idx}')
            L.ev(pg, 'await ctx.selectCharacterById(arg);', idx)
            L.wait_js(pg, 'String(ctx.characterId) === String(arg) && ctx.chat.length >= 1', arg=idx)
            time.sleep(1)
            L.ev(pg, '''for (let i = 0; i < 30; i++) ctx.chat.push({ name: i % 2 ? ctx.name2 : ctx.name1, is_user: i % 2 === 0, is_system: false, send_date: new Date().toISOString(), mes: '第' + (i + 1) + '楼 漠北的风沙尚未褪尽。', extra: {} });
                await ctx.saveChat();''')
            print('    （等 12.5 秒，让服务器的 10 秒节流把 31 楼那份备份写出来）', flush=True)
            time.sleep(12.5)
            L.ev(pg, 'ctx.chat.length = 1; await ctx.saveChat();')  # 模拟被盖成只剩开场白
            time.sleep(1.5)
            # 别的角色的节流备份可能在清空目录后才落盘（最多晚 10 秒），所以只看这张卡的
            key = pg.evaluate(f'() => ChatAnchor.server.keyOf("{CARD}")')
            files = L.backup_files()
            print('    磁盘上的备份:', files)
            mine_on_disk = [f for f in files if f.startswith(f'chat_{key}_')]
            rows = pg.evaluate('async () => (await ChatAnchor.server.list(true)).map(r => [r.file, r.key, r.count])')
            mine = [r for r in rows if r[1] == key]
            C.ok(len(mine) == 3, 'S2 读到这张卡的服务器备份 3 份', str(rows))
            C.ok(len(mine_on_disk) == 3 and sorted(r[0] for r in mine) == mine_on_disk, 'S3 文件名里的角色段算得和服务器一致（中文名带 sha256 前 8 位）', f'key={key} disk={mine_on_disk}')
            C.ok([r[2] for r in mine] == [1, 31, 1], 'S4 楼数依次为 1 / 31 / 1', str([r[2] for r in mine]))
            pg.evaluate('() => ChatAnchor.open("srv")')
            pg.wait_for_selector('.ca-panel .ca-snap')
            pg.screenshot(path=str(OUT / 't5_server_list.png'))
            C.ok(pg.locator('.ca-snap.is-drop').count() == 1 and pg.inner_text('.ca-snap.is-drop .ca-floors') == '31 楼', 'S5 面板默认打开当前角色并标出掉楼前的那份（31 楼）')
            pg.click('.ca-snap.is-drop [data-act="srv-restore"]')
            L.wait_js(pg, 'ctx.chat.length === 31', timeout=20000)
            time.sleep(1)
            chats_dir = L.USER_DIR / 'chats' / CARD
            new_name = L.chat_id(pg) or ''
            C.ok('imported' in new_name and L.floors(new_name, chats_dir) == 31, 'S6 一键恢复成新聊天（磁盘上 31 楼）', f'{new_name} floors={L.floors(new_name, chats_dir)}')
            C.ok(L.chat_len(pg) == 31, 'S7 已打开恢复出来的聊天', f'len={L.chat_len(pg)}')
            pg.wait_for_function('() => !document.querySelector(".ca-panel")', timeout=5000)

            # ───────── 1.2.1：服务器慢的时候 ─────────
            C.section('服务器很慢时')
            pg.evaluate('() => { ChatAnchor.state.srv = null; ChatAnchor.state.srvLast = null; }')
            L.slow_fetch(pg, '/api/backups/chat/get', 6000)
            pg.evaluate('() => ChatAnchor.open("cur")')
            pg.wait_for_selector('.ca-panel .ca-tab')
            pg.evaluate('() => { try { toastr.remove(); } catch {} }')  # 上一步的 toast 会盖住页签，Playwright 会等它消失
            t0 = time.time()
            pg.evaluate('() => document.querySelector(".ca-panel .ca-tab[data-tab=srv]").click()')
            pg.wait_for_function('() => (document.querySelector(".ca-panel .ca-body")?.innerText || "").includes("正在读取服务器上的备份")', timeout=3000)
            C.ok(time.time() - t0 < 1.5, 'S8 点「服务器」立刻出现「正在读取…」，不等服务器', f'{time.time() - t0:.1f}s')
            t0 = time.time()
            pg.click('.ca-panel .ca-tab[data-tab="log"]')
            pg.wait_for_selector('.ca-panel .ca-log, .ca-panel .ca-empty', timeout=3000)
            C.ok(time.time() - t0 < 2 and '正在读取服务器' not in panel_text(pg), 'S9 读取期间切到「记录」页马上有响应（面板没被卡住）', f'{time.time() - t0:.1f}s')
            pg.click('.ca-panel .ca-tab[data-tab="srv"]')
            pg.wait_for_function('() => (document.querySelector(".ca-panel .ca-body")?.innerText || "").includes("正在读取服务器上的备份")', timeout=3000)
            time.sleep(2.2)
            C.ok('已等' in panel_text(pg), 'S10 占位里显示已等待的秒数', panel_text(pg)[:120])
            pg.click('.ca-panel [data-act="srv-refresh"]')  # 读取中再点刷新
            time.sleep(0.5)
            pg.wait_for_selector('.ca-panel .ca-snap, .ca-panel .ca-chat', timeout=15000)
            C.ok(L.slow_hits(pg) == 1, 'S11 期间反复切页、点刷新，只发出了 1 个请求', f'hits={L.slow_hits(pg)}')
            C.ok(pg.locator('.ca-panel .ca-snap').count() == 3, 'S12 服务器返回后列表自动出现（3 份）', f'{pg.locator(".ca-panel .ca-snap").count()}')

            C.section('服务器超时')
            pg.evaluate('() => { ChatAnchor.state.srvTimeoutMs = 2000; }')
            L.slow_fetch(pg, '/api/backups/chat/get', 5000)
            pg.click('.ca-panel [data-act="srv-refresh"]')
            pg.wait_for_function('() => (document.querySelector(".ca-panel .ca-body")?.innerText || "").includes("正在重新读取")', timeout=3000)
            C.ok(pg.locator('.ca-panel .ca-snap').count() == 3, 'S13 刷新期间旧列表还在，只多一行「正在重新读取…」')
            pg.wait_for_function('() => (document.querySelector(".ca-panel .ca-body")?.innerText || "").includes("刚才没刷新成功")', timeout=8000)
            txt = panel_text(pg)
            C.ok('还没把备份列表给出来' in txt and pg.locator('.ca-panel .ca-snap').count() == 3, 'S14 超时后提示原因，并保留上一次读到的列表', txt[:160])
            err = pg.evaluate('async () => { try { await ChatAnchor.server.list(true); return "ok"; } catch (e) { return e.message; } }')
            C.ok('秒' in err, 'S15 ChatAnchor.server.list(true) 超时时抛出带原因的错误', err)
            C.ok(any(r['type'] == '服务器备份' for r in L.ca_log(pg)), 'S16 超时记进了「记录」')
            L.unslow_fetch(pg, '/api/backups/chat/get')
            pg.evaluate('() => { ChatAnchor.state.srvTimeoutMs = 90000; }')
            pg.screenshot(path=str(OUT / 't5_server_timeout.png'))

            warns = [t for ty, t in con.lines if ty == 'warning' and '[小锚]' in t]
            C.ok(not warns, '小锚全程没有输出过警告', str(warns[:3]))
            C.ok(not [e for e in con.errors if 'Internal S' not in e], '页面没有未捕获的异常', str(con.errors[:3]))
            b.close()
    finally:
        L.remove_card(CARD)
    return C.done()


if __name__ == '__main__':
    sys.exit(main())
