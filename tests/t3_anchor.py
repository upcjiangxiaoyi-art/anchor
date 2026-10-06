"""
t3_anchor.py — 装上小锚后的端到端检查（iPhone 视口 390×844）。

A 自动快照   B 去重和跳过   C 断网读取失败   D 502 读取失败   I 第三方读取失败不误拦
E 保存失败补存   F 掉楼检测和覆盖恢复   G 恢复成新聊天   H 面板
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stlib as L  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

NAME = 'anchor-301'
OUT = Path(__file__).parent / 'out'
LOAD_FAIL_DIALOG = '() => [...document.querySelectorAll("dialog[open]")].some(d => d.innerText.includes("没有读取成功"))'


def slash(pg, cmd):
    return L.ev(pg, 'const r = await ctx.executeSlashCommandsWithOptions(arg, { handleParserErrors: false, handleExecutionErrors: false }); return r?.pipe ?? null;', cmd)


def toasts(pg):
    return pg.evaluate('() => [...document.querySelectorAll("#toast-container .toast")].map(t => t.innerText)')


def wait_log(pg, pred, timeout=12.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        lg = L.ca_log(pg)
        if any(pred(r) for r in lg):
            return lg
        time.sleep(0.3)
    return L.ca_log(pg)


def close_panel(pg):
    pg.keyboard.press('Escape')
    pg.wait_for_function('() => !document.querySelector(".ca-panel")', timeout=5000)


def main():
    L.require_st()
    L.patch_settings(first_run=False, ext_enabled=True)
    L.clear_char_chats()
    OUT.mkdir(exist_ok=True)
    C = L.Checks('T3 小锚端到端')
    with sync_playwright() as p:
        b, c = L.launch(p)
        pg = c.new_page()
        con = L.Console(pg)
        L.goto_app(pg, ext=True)
        L.select_char(pg)
        L.write_chat(NAME, 301)
        L.open_chat(pg, NAME)
        key = L.current_key(pg)

        # ───────── A 自动快照 ─────────
        C.section('A 自动快照')
        s = L.wait_snaps(pg, lambda s: any(x['count'] == 301 for x in s))
        C.ok(any(x['count'] == 301 and x['reason'] == 'load' for x in s), 'A1 打开 301 楼的聊天后自动存了一份 load 快照', str(s)[:200])
        slash(pg, '/send 这是第 302 条消息')
        s = L.wait_snaps(pg, lambda s: s and s[0]['count'] == 302)
        C.ok(s and s[0]['count'] == 302, 'A2 /send 发消息后存了 302 楼的快照', str(s[:1]))
        time.sleep(0.5)
        C.ok(L.floors(NAME) == 302, 'A3 酒馆自己也把 302 楼存到了磁盘（守门没有误拦）', f'floors={L.floors(NAME)}')
        slash(pg, '/sendas name=Seraphina 这是第 303 条消息')
        s = L.wait_snaps(pg, lambda s: s and s[0]['count'] == 303)
        C.ok(s and s[0]['count'] == 303, 'A4 角色回复后存了 303 楼的快照')
        sig_before = s[0]['sig']
        L.ev(pg, 'ctx.chat[ctx.chat.length - 1].mes = "编辑过的内容"; await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_EDITED, ctx.chat.length - 1); await ctx.saveChat();')
        s = L.wait_snaps(pg, lambda s: s and s[0]['sig'] != sig_before)
        C.ok(s and s[0]['count'] == 303 and s[0]['sig'] != sig_before, 'A5 编辑楼层后存了一份新快照（楼数相同、签名不同）')
        slash(pg, '/cut 302')
        s = L.wait_snaps(pg, lambda s: s and s[0]['count'] == 302)
        C.ok(s and s[0]['count'] == 302, 'A6 删除楼层后存了 302 楼的快照')
        n_a = len(s)

        # ───────── B 去重和跳过 ─────────
        C.section('B 去重和跳过')
        r = pg.evaluate('async () => await ChatAnchor.snapshot("auto")')
        C.ok(r is None and len(L.snaps(pg)) == n_a, 'B1 内容没变时再存会跳过（返回 null，份数不变）', f'r={r} n={len(L.snaps(pg))}')
        st = L.ca_stats(pg)
        C.ok(st['blobs'] <= 301 + 10, f'B2 {n_a} 份快照共用 {st["blobs"]} 个楼层 blob（不去重会有 {n_a * 302} 个）', str(st))
        r = pg.evaluate('async () => await ChatAnchor.snapshot("manual", { force: true, lock: true })')
        s = L.snaps(pg)
        C.ok(r and s[0]['locked'] and s[0]['lockReason'] == 'manual' and len(s) == n_a + 1, 'B3 强制手动快照会新建一份并锁定')

        # ───────── C 断网读取失败 ─────────
        C.section('C 断网时读取失败（reloadCurrentChat 路径，带旧 integrity）')
        n_disk = L.floors(NAME)
        f = L.Fault(pg, '**/api/chats/get', mode='abort')
        L.ev(pg, 'ctx.reloadCurrentChat().catch(() => {});')
        try:
            pg.wait_for_function(LOAD_FAIL_DIALOG, timeout=20000)
            C.ok(True, 'C1 弹出「这个聊天没有读取成功」')
        except Exception as e:
            C.ok(False, 'C1 弹出「这个聊天没有读取成功」', str(e)[:120])
        time.sleep(2.5)
        C.ok(L.floors(NAME) == n_disk, f'C2 磁盘存档仍是 {n_disk} 楼，没有被开场白覆盖', f'floors={L.floors(NAME)}')
        C.ok(L.chat_len(pg) == 1, 'C3 页面上此刻只有开场白（酒馆的行为）', f'len={L.chat_len(pg)}')
        pz = L.poison(pg, key)
        C.ok(pz and pz['confirmed'] and not pz['okSeen'] and not pz['released'], 'C4 守门标记已确认', str(pz))
        lg = L.ca_log(pg)
        C.ok(any(r['type'] == '读取失败' for r in lg) and any(r['type'] == '守门' and '拦下' in r['msg'] for r in lg), 'C5 记录里有「读取失败」和「守门：拦下一次保存」', str(lg[-3:]))
        C.ok(all(x['count'] > 1 for x in L.snaps(pg)), 'C6 没有把只剩开场白的状态存成快照')
        spy = L.Spy(pg, '**/api/chats/save')
        L.ev(pg, 'await ctx.saveChat();')
        time.sleep(0.5)
        C.ok(len(spy.calls) == 0, 'C7 确认后的保存请求根本没发到服务器')
        spy.remove()
        f.remove()
        L.click_dialog_button(pg, '重新读取')
        L.wait_js(pg, f'ctx.chat.length === {n_disk}', timeout=20000)
        time.sleep(1)
        C.ok(L.chat_len(pg) == n_disk, f'C8 点「重新读取」后回到 {n_disk} 楼')
        C.ok(L.poison(pg, key) is None, 'C9 读取成功后守门标记清除', str(L.poison(pg, key)))
        slash(pg, '/send 断网恢复后的消息')
        L.wait_snaps(pg, lambda s: s and s[0]['count'] == n_disk + 1)
        time.sleep(0.5)
        C.ok(L.floors(NAME) == n_disk + 1, 'C10 之后的保存恢复正常，磁盘 +1 楼', f'floors={L.floors(NAME)}')

        # ───────── D 502 读取失败 ─────────
        C.section('D 读取返回 502（openCharacterChat 路径，元数据被重置）')
        n_disk = L.floors(NAME)
        f = L.Fault(pg, '**/api/chats/get', mode=502, body='<html><body>502 Bad Gateway</body></html>')
        L.ev(pg, 'ctx.openCharacterChat(arg).catch(() => {});', NAME)
        try:
            pg.wait_for_function(LOAD_FAIL_DIALOG, timeout=20000)
            C.ok(True, 'D1 弹出「这个聊天没有读取成功」')
        except Exception as e:
            C.ok(False, 'D1 弹出「这个聊天没有读取成功」', str(e)[:120])
        time.sleep(2.5)
        C.ok(L.floors(NAME) == n_disk, f'D2 磁盘存档仍是 {n_disk} 楼', f'floors={L.floors(NAME)}')
        C.ok(any('HTTP 502' in r['msg'] for r in L.ca_log(pg) if r['type'] == '读取失败'), 'D3 记录里写明了 HTTP 502')
        f.remove()
        L.click_dialog_button(pg, '重新读取')
        L.wait_js(pg, f'ctx.chat.length === {n_disk}', timeout=20000)
        time.sleep(1)
        C.ok(L.chat_len(pg) == n_disk and L.poison(pg, key) is None, f'D4 重新读取后回到 {n_disk} 楼，标记清除')

        # ───────── I 第三方读取失败不误拦 ─────────
        C.section('I 别的插件读取失败，不误拦正常保存')
        n_disk = L.floors(NAME)
        f = L.Fault(pg, '**/api/chats/get', mode='abort', times=1)
        L.ev(pg, '''const ch = ctx.characters[ctx.characterId];
            try { await fetch('/api/chats/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ ch_name: ch.name, file_name: ch.chat, avatar_url: ch.avatar }) }); } catch {}''')
        pz = L.poison(pg, key)
        C.ok(pz and not pz['confirmed'], 'I1 读取失败后有一个未确认的标记', str(pz))
        spy = L.Spy(pg, '**/api/chats/save')
        slash(pg, '/send 第三方读取失败后的正常消息')
        time.sleep(1.5)
        C.ok(len(spy.calls) >= 1, 'I2 楼数大于 1 的保存没有被拦，请求到达了服务器', f'calls={len(spy.calls)}')
        C.ok(L.floors(NAME) == n_disk + 1, 'I3 磁盘上多了 1 楼', f'floors={L.floors(NAME)}')
        C.ok(not pg.evaluate(LOAD_FAIL_DIALOG), 'I4 没有弹窗')
        spy.remove()
        f.remove()
        print('    （等 21 秒看标记是否自动作废）', flush=True)
        time.sleep(21)
        C.ok(L.poison(pg, key) is None, 'I5 20 秒内没等到 CHAT_CHANGED，标记自动作废', str(L.poison(pg, key)))

        # ───────── E 保存失败补存 ─────────
        C.section('E 保存失败自动补存')
        n_disk = L.floors(NAME)
        f = L.Fault(pg, '**/api/chats/save', mode=500, times=1, body='Internal Server Error')
        slash(pg, '/send 这条保存会失败一次')
        lg = wait_log(pg, lambda r: r['type'] == '补存' and '成功' in r['msg'], timeout=15)
        C.ok(any(r['type'] == '保存失败' and 'HTTP 500' in r['msg'] for r in lg), 'E1 记录了保存失败和状态码', str([r for r in lg if r['type'] == '保存失败'][-1:]))
        C.ok(any(r['type'] == '补存' and '成功' in r['msg'] for r in lg), 'E2 3 秒后自动补存成功', str(lg[-3:]))
        C.ok(f.hits == 1 and f.passed >= 1, 'E3 失败一次后重试的请求到达了服务器', f'hits={f.hits} passed={f.passed}')
        C.ok(L.floors(NAME) == n_disk + 1, 'E4 补存后磁盘 +1 楼', f'floors={L.floors(NAME)}')
        C.ok(L.snaps(pg)[0]['count'] == n_disk + 1, 'E5 保存失败时本地已先存了快照')
        tx = toasts(pg)
        C.ok(any('没能存到服务器' in t or '补存' in t for t in tx), 'E6 弹了「没能存到服务器 / 已补存」的提示', str(tx))
        f.remove()

        # ───────── F 掉楼检测和覆盖恢复 ─────────
        C.section('F 掉楼检测和覆盖恢复')
        n_disk = L.floors(NAME)
        rows_full = L.read_chat(NAME)
        top = L.snaps(pg)[0]
        L.write_chat(NAME, 1, meta=rows_full[0].get('chat_metadata'), msgs=[rows_full[1]])  # 模拟存档被覆盖成只剩开场白
        L.ev(pg, 'await ctx.reloadCurrentChat();')
        L.wait_js(pg, 'ctx.chat.length === 1')
        s = L.wait_snaps(pg, lambda s: any(x['lockReason'] == 'drop' for x in s))
        drop = next((x for x in s if x['lockReason'] == 'drop'), None)
        C.ok(drop and drop['id'] == top['id'] and drop['count'] == n_disk, 'F1 掉楼前的最新快照被自动锁定（lockReason=drop）', str(drop))
        C.ok(any(r['type'] == '掉楼' for r in L.ca_log(pg)), 'F2 记录里有「掉楼」')
        tx = toasts(pg)
        C.ok(any('少了' in t for t in tx), 'F3 弹出掉楼提醒', str(tx))
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel .ca-banner')
        banner = pg.inner_text('.ca-panel .ca-banner')
        C.ok('少了' in banner and f'{n_disk} → 1' in banner, 'F4 面板里显示掉楼横幅和「恢复那一份」', banner[:120])
        pg.screenshot(path=str(OUT / 't3_drop_banner.png'))
        close_panel(pg)
        saved = pg.evaluate('async (id) => await ChatAnchor.restoreInPlace(id)', drop['id'])
        C.ok(saved is True, 'F5 restoreInPlace 返回保存成功', str(saved))
        L.wait_js(pg, f'ctx.chat.length === {n_disk}')
        C.ok(L.floors(NAME) == n_disk, f'F6 磁盘存档恢复到 {n_disk} 楼', f'floors={L.floors(NAME)}')
        rows_restored = L.read_chat(NAME)
        C.ok([r['mes'] for r in rows_restored[1:]] == [r['mes'] for r in rows_full[1:]], 'F7 恢复后的内容和掉楼前逐楼一致')
        C.ok(rows_restored[0]['chat_metadata'].get('integrity') == rows_full[0]['chat_metadata'].get('integrity'), 'F8 恢复后的文件沿用了原来的 integrity')
        s = L.snaps(pg)
        pre = next((x for x in s if x['lockReason'] == 'pre-restore'), None)
        C.ok(pre and pre['count'] == 1 and pre['locked'], 'F9 覆盖前的状态另存成了锁定的「恢复前」快照', str(pre))
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel .ca-snap')
        C.ok(pg.locator('.ca-panel .ca-banner').count() == 0, 'F10 恢复后掉楼横幅消失')
        close_panel(pg)

        # ───────── G 恢复成新聊天 ─────────
        C.section('G 恢复成新聊天')
        files_before = set(L.chat_files())
        new_name = pg.evaluate('async (id) => await ChatAnchor.restoreAsNew(id)', drop['id'])
        C.ok(isinstance(new_name, str) and new_name and new_name not in files_before, 'G1 restoreAsNew 返回了新聊天名', str(new_name))
        L.wait_js(pg, 'ctx.chatId === arg', arg=new_name)
        C.ok(L.chat_len(pg) == n_disk, f'G2 已切到新聊天，页面上 {n_disk} 楼', f'len={L.chat_len(pg)}')
        C.ok(L.floors(new_name) == n_disk, f'G3 新文件在磁盘上有 {n_disk} 楼', f'floors={L.floors(new_name)}')
        C.ok(L.floors(NAME) == n_disk, 'G4 原聊天文件没动')
        new_rows = L.read_chat(new_name)
        C.ok([r['mes'] for r in new_rows[1:]] == [r['mes'] for r in rows_full[1:]], 'G5 新聊天内容与快照逐楼一致')
        s2 = L.wait_snaps(pg, lambda s: any(x['count'] == n_disk for x in s))
        C.ok(any(x['reason'] == 'load' and x['count'] == n_disk for x in s2), 'G6 新聊天自己也开始有快照了')
        slash(pg, '/send 新聊天里继续聊')
        time.sleep(1.5)
        C.ok(L.floors(new_name) == n_disk + 1, 'G7 新聊天可以正常保存')

        # ───────── H 面板 ─────────
        C.section('H 面板（390px 宽）')
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel .ca-snap')
        n_items = pg.locator('.ca-panel .ca-snap').count()
        C.ok(n_items == len(L.snaps(pg)), '当前聊天页列出了全部快照', f'items={n_items} snaps={len(L.snaps(pg))}')
        pg.screenshot(path=str(OUT / 't3_panel_cur.png'))
        pg.click('.ca-panel .ca-tab[data-tab="all"]')
        pg.wait_for_selector('.ca-panel .ca-chat')
        C.ok(pg.locator('.ca-panel .ca-chat').count() >= 2, '全部聊天页列出 ≥2 个聊天', f'{pg.locator(".ca-panel .ca-chat").count()}')
        pg.click('.ca-panel .ca-tab[data-tab="log"]')
        pg.wait_for_selector('.ca-panel .ca-log li')
        C.ok(pg.locator('.ca-panel .ca-log li').count() >= 5, '记录页有记录')
        pg.screenshot(path=str(OUT / 't3_panel_log.png'))
        pg.click('.ca-panel .ca-tab[data-tab="set"]')
        pg.wait_for_selector('.ca-panel input[data-set="recent"]')
        C.ok(pg.input_value('.ca-panel input[data-set="recent"]') == '12', '设置页显示默认值')
        pg.click('.ca-panel .ca-tab[data-tab="cur"]')
        pg.wait_for_selector('.ca-panel .ca-snap')
        before = len(L.snaps(pg))
        pg.click('.ca-panel [data-act="snap-now"]')
        s = L.wait_snaps(pg, lambda s: len(s) == before + 1)
        C.ok(len(s) == before + 1 and s[0]['locked'] and s[0]['lockReason'] == 'manual', '「立即快照」新建并锁定一份')
        C.ok(pg.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth + 1'), '390px 宽度下没有横向溢出')
        close_panel(pg)

        warns = [t for ty, t in con.lines if ty == 'warning' and '[小锚]' in t]
        C.ok(not warns, '小锚全程没有输出过警告', str(warns[:3]))
        C.ok(not [e for e in con.errors if 'Internal S' not in e], '页面没有未捕获的异常（horde 的 500 除外）', str(con.errors[:3]))
        b.close()
    return C.done()


if __name__ == '__main__':
    sys.exit(main())
