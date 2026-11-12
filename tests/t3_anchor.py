"""
t3_anchor.py — 装上小锚后的端到端检查（iPhone 视口 390×844）。

A 自动快照   B 去重和跳过   C 断网读取失败   D 502 读取失败   I 第三方读取失败不误拦
E 保存失败补存（含一直存不上时的横幅、慢速补存）   N 读取期间的空保存   O 读取返回 200 但内容是空的 / 没读完
F 掉楼检测和覆盖恢复   G 恢复成新聊天
H 面板   J 增量重算   K 大请求体压缩   L 体检   M 瘦身（含标签段落预览、一步瘦身）
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

        # 一直存不上（1.2.12）。413 这类要人处理的：快速重试用完就不再自动试，挂一条不消失的提示，面板顶部有横幅说人话
        pg.evaluate('() => { ChatAnchor.state.retryQuick = [400, 400, 400]; ChatAnchor.state.retrySlow = [1500]; toastr.remove(); }')
        n_disk = L.floors(NAME)
        f = L.Fault(pg, '**/api/chats/save', mode=413, body='<html><body><h1>413 Request Entity Too Large</h1></body></html>')
        slash(pg, '/send 这条一直存不上')
        L.wait_js(pg, 'ChatAnchor.state.lastSave.get(arg)?.fails >= 4', timeout=20000, arg=key)
        get_ls = '(k) => { const x = ChatAnchor.state.lastSave.get(k); return { ok: x.ok, status: x.status, fails: x.fails, since: x.since }; }'
        ls1 = pg.evaluate(get_ls, key)
        pg.wait_for_timeout(3000)  # 不能用 time.sleep：路由回调只在 Playwright 调用期间执行
        ls = pg.evaluate(get_ls, key)
        C.ok(ls['ok'] is False and ls['status'] == 413 and ls['fails'] == ls1['fails'] == f.hits >= 4 and ls['since'] > 0, 'E7 413 存不上：快速重试用完就不再自动重试（试多少次都一样），记下了从几点起、试了几次', f'{ls1} -> {ls} hits={f.hits}')
        tx = toasts(pg)
        C.ok(any('一直没能存到服务器' in t and '反代' in t for t in tx), 'E8 快速重试用完后挂出一条不消失的提示，原因是大白话', str(tx))
        pg.evaluate('() => ChatAnchor.open("log")')
        pg.wait_for_selector('.ca-panel [data-save-banner]')
        bt = pg.inner_text('.ca-panel [data-save-banner]')
        C.ok('没能存到服务器' in bt and 'HTTP 413' in bt and '体检' in bt and f"试了 {ls['fails']} 次" in bt and '现在再存一次' in bt and '没有丢' in bt, 'E9 面板顶部（哪一页都有）挂着横幅：从几点起、试了几次、原因、怎么办', bt.replace(chr(10), ' ')[:220])
        pg.evaluate('() => { document.getElementById("toast-container").style.visibility = "hidden"; }')
        pg.screenshot(path=str(OUT / 't3_save_banner.png'))
        pg.evaluate('() => { document.getElementById("toast-container").style.visibility = ""; }')
        f.remove()
        pg.evaluate('() => document.querySelector(".ca-panel [data-act=save-now]").click()')
        L.wait_js(pg, 'ChatAnchor.state.lastSave.get(arg)?.ok === true', timeout=15000, arg=key)
        pg.wait_for_function('() => !document.querySelector(".ca-panel [data-save-banner]") && ![...document.querySelectorAll("#toast-container .toast")].some(t => t.innerText.includes("一直没能存到服务器"))', timeout=8000)
        lg = L.ca_log(pg)
        C.ok(L.floors(NAME) == n_disk + 1 and any(r['type'] == '补存' and f"之前 {ls['fails']} 次没存上" in r['msg'] for r in lg), 'E10 点「现在再存一次」存上后：横幅和那条提示自动消失，记录里写了之前几次没存上', str([r['msg'] for r in lg if r['type'] == '补存'][-2:]))
        close_panel(pg)

        # 临时故障（502）：快速重试用完后隔一会儿再试，每次先探路；服务器没回来就不上传，回来了自动补存
        pg.evaluate('() => toastr.remove()')
        n_disk = L.floors(NAME)
        f = L.Fault(pg, '**/api/chats/save', mode=502)
        fp = L.Fault(pg, '**/csrf-token', mode=502)
        slash(pg, '/send 服务器暂时没响应')
        L.wait_js(pg, 'ChatAnchor.state.lastSave.get(arg)?.fails >= 4', timeout=20000, arg=key)
        pg.wait_for_timeout(500)
        hits0 = f.hits
        pg.wait_for_timeout(4500)
        C.ok(f.hits == hits0 and fp.hits >= 2, 'E11 服务器没回来时只探路，不把整份聊天白传一遍', f'save {hits0} -> {f.hits}，探路 {fp.hits} 次')
        fp.remove()
        f.remove()
        L.wait_js(pg, 'ChatAnchor.state.lastSave.get(arg)?.ok === true', timeout=15000, arg=key)
        time.sleep(0.5)
        lg = L.ca_log(pg)
        C.ok(L.floors(NAME) == n_disk + 1 and any(r['type'] == '补存' and '之后隔几分钟再试' in r['msg'] for r in lg), 'E12 服务器恢复后不用任何操作，自动补存成功', str([r['msg'] for r in lg if r['type'] == '补存'][-2:]))
        n_disk = L.floors(NAME)
        f = L.Fault(pg, '**/api/chats/save', mode=413)
        slash(pg, '/send 断网回来以后要马上补上')
        L.wait_js(pg, 'ChatAnchor.state.lastSave.get(arg)?.fails >= 4', timeout=20000, arg=key)
        pg.wait_for_timeout(1500)
        f.remove()
        hits_before = pg.evaluate('(k) => ChatAnchor.state.lastSave.get(k).fails', key)
        pg.evaluate('() => window.dispatchEvent(new Event("online"))')
        L.wait_js(pg, 'ChatAnchor.state.lastSave.get(arg)?.ok === true', timeout=15000, arg=key)
        time.sleep(0.5)
        C.ok(L.floors(NAME) == n_disk + 1 and hits_before >= 4, 'E14 网络恢复（online 事件）时不等下一轮，马上补存', f'floors={L.floors(NAME)} want={n_disk + 1}')
        pg.evaluate('() => { ChatAnchor.state.retryQuick = [3000, 8000, 20000]; ChatAnchor.state.retrySlow = [60000, 120000, 300000]; toastr.remove(); }')
        ex = pg.evaluate('''() => Object.fromEntries([[0, '网络错误 Failed to fetch'], [401, 'HTTP 401'], [403, 'HTTP 403 Invalid CSRF token. Please refresh the page and try again.'], [500, 'HTTP 500 x'], [504, 'HTTP 504 x'], [400, 'HTTP 400 {"error":"integrity"}']]
            .map(([status, detail]) => [status, ChatAnchor.explainSave({ status, detail })]))''')
        C.ok('连不上服务器' in ex['0']['why'] and '重新登录' in ex['401']['why'] and ex['403'].get('refresh') is True and '刷新' in ex['403']['todo'] and '磁盘' in ex['500']['why'] and '没有响应' in ex['504']['why'] and '别的设备' in ex['400']['why'],
             'E13 断网、要重新登录、凭证失效、服务器出错、没响应、被别处改过：各有各的大白话', str({k: v['why'][:14] for k, v in ex.items()}))

        # ───────── N 读取期间的空保存（1.2.12） ─────────
        C.section('N 聊天正在读取时不许存')
        n_disk = L.floors(NAME)
        hold = L.Hold(pg, '**/api/chats/get')
        pg.evaluate('() => { window.__caReload = SillyTavern.getContext().reloadCurrentChat(); }')
        for _ in range(60):
            if hold.held:
                break
            pg.wait_for_timeout(100)
        st0 = L.ev(pg, 'return [ctx.chat.length, ChatAnchor.state.loading.get(arg) || 0, ChatAnchor.canSaveNow(arg)]', key)
        L.ev(pg, 'await ctx.saveChat(); return true')
        time.sleep(0.5)
        lg = L.ca_log(pg)
        C.ok(st0[:2] == [0, 1] and L.floors(NAME) == n_disk and any(r['type'] == '守门' and '正在读取' in r['msg'] for r in lg), 'N1 聊天正在读取、内存里还是空的时候有人调保存：拦下，磁盘上的存档原样', f'st={st0} floors={L.floors(NAME)} want={n_disk}')
        C.ok(st0[2] is False, 'N2 这种时候小锚自己的补存也不会发起')
        hold.remove()
        pg.evaluate('async () => { await window.__caReload; }')
        L.wait_js(pg, f'ctx.chat.length === {n_disk}', timeout=15000)
        time.sleep(1.5)
        L.ev(pg, 'await ctx.saveChat(); return true')
        time.sleep(0.5)
        st1 = L.ev(pg, 'return [ChatAnchor.state.lastSave.get(arg)?.ok, ChatAnchor.state.loading.size, ChatAnchor.canSaveNow(arg)]', key)
        C.ok(st1 == [True, 0, True] and L.floors(NAME) == n_disk, 'N3 读完以后保存恢复正常，读取计数清零', str(st1))
        pg.evaluate('() => toastr.remove()')

        # ───────── O 读取「成功」了，内容却是空的或不完整（1.2.12） ─────────
        # 酒馆服务器读文件时出任何异常都返回 200 + 空对象；手机上几十 MB 的响应体也可能下到一半断掉。
        # 这两种酒馆都当成"空聊天"，塞进开场白存回去（t1 的场景 3、4）。原来的守门只看请求失败和非 2xx，拦不住。
        C.section('O 读取返回 200，但内容是空的 / 没读完')

        def gutted_load(body):
            n0 = L.floors(NAME)
            mark = pg.evaluate('() => Date.now()')
            flt = L.Fault(pg, '**/api/chats/get', mode=200, body=body)
            L.ev(pg, 'ctx.reloadCurrentChat().catch(() => {});')
            shown = True
            try:
                pg.wait_for_function(LOAD_FAIL_DIALOG, timeout=20000)
            except Exception:
                shown = False
            pg.wait_for_timeout(2000)
            flt.remove()
            return n0, shown, [r for r in L.ca_log(pg) if r['ts'] >= mark], L.dialog_text(pg)

        n0, shown, lg, dt = gutted_load('{}')
        C.ok(shown and L.floors(NAME) == n0 and any(r['type'] == '读取失败' and '内容是空的' in r['msg'] for r in lg) and any(r['type'] == '守门' and '拦下' in r['msg'] for r in lg),
             'O1 服务器返回 200 + 空对象：当作读取失败，开场白没能盖掉存档', f'shown={shown} floors={L.floors(NAME)} want={n0} log={[r["msg"][:50] for r in lg]}')
        C.ok('没有读出来' in dt and f'小锚上次存的是 {n0} 楼' in dt and '解除暂停' in dt and '在别的设备上清空过' in dt, 'O2 弹窗说清楚了：读出来是空的、小锚记得有几楼、真清空过该怎么办', dt.replace(chr(10), ' ')[:240])
        pg.screenshot(path=str(OUT / 't3_load_empty.png'))
        L.click_dialog_button(pg, '重新读取')
        L.wait_js(pg, f'ctx.chat.length === {n0}', timeout=20000)
        time.sleep(1)
        C.ok(L.chat_len(pg) == n0 and L.poison(pg, key) is None, f'O3 重新读取后回到 {n0} 楼，暂停解除')

        n0, shown, lg, dt = gutted_load('[{"chat_metadata":{}},{"name":"Seraphina","is_user":false,"mes":"下到一半就断')
        C.ok(shown and L.floors(NAME) == n0 and any(r['type'] == '读取失败' and '内容没读完' in r['msg'] for r in lg), 'O4 内容下到一半断了（JSON 不完整）：同样当作读取失败，存档原样', f'shown={shown} floors={L.floors(NAME)} log={[r["msg"][:60] for r in lg]}')
        L.click_dialog_button(pg, '重新读取')
        L.wait_js(pg, f'ctx.chat.length === {n0}', timeout=20000)
        time.sleep(1)
        slash(pg, '/send 读回来以后照常保存')
        L.wait_snaps(pg, lambda s_: s_ and s_[0]['count'] == n0 + 1)
        time.sleep(0.5)
        C.ok(L.poison(pg, key) is None and L.floors(NAME) == n0 + 1, 'O5 重新读取成功后保存恢复正常，磁盘 +1 楼', f'floors={L.floors(NAME)}')

        # 不能误伤：真的是新聊天（小锚没见过）照常建；用户自己把楼删光以后再读取，也不算读取失败
        mark = pg.evaluate('() => Date.now()')
        fresh = 'anchor-fresh-chat'
        L.ev(pg, 'await ctx.openCharacterChat(arg);', fresh)
        L.wait_js(pg, 'ctx.chatId === arg && ctx.chat.length === 1', arg=fresh, timeout=20000)
        pg.wait_for_timeout(1500)
        lg = [r for r in L.ca_log(pg) if r['ts'] >= mark]
        C.ok(L.floors(fresh) == 1 and not any(r['type'] in ('读取失败', '守门') for r in lg) and not pg.evaluate(LOAD_FAIL_DIALOG), 'O6 小锚没见过的新聊天：服务器返回空是正常的，开场白照常存下去', f'floors={L.floors(fresh)} log={[r["msg"][:40] for r in lg]}')
        slash(pg, '/send 第一句')
        slash(pg, '/send 第二句')
        L.wait_snaps(pg, lambda s_: s_ and s_[0]['count'] == 3)
        slash(pg, '/cut 0-2')
        L.wait_js(pg, 'ctx.chat.length === 0', timeout=10000)
        pg.wait_for_timeout(2500)
        mark = pg.evaluate('() => Date.now()')
        L.ev(pg, 'await ctx.reloadCurrentChat();')
        L.wait_js(pg, 'ctx.chat.length === 1', timeout=20000)
        pg.wait_for_timeout(1500)
        lg = [r for r in L.ca_log(pg) if r['ts'] >= mark]
        C.ok(L.floors(fresh) == 1 and not any(r['type'] in ('读取失败', '守门', '掉楼') for r in lg) and not pg.evaluate(LOAD_FAIL_DIALOG), 'O7 用户自己把楼删光以后再读取：不算读取失败，也不误报掉楼', f'floors={L.floors(fresh)} log={[r["type"] + ":" + r["msg"][:40] for r in lg]}')
        L.open_chat(pg, NAME)
        L.wait_js(pg, f'ctx.chat.length === {n0 + 1}', timeout=20000)
        time.sleep(1.5)
        pg.evaluate('() => toastr.remove()')

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
        import json as _json
        manifest_ver = _json.load(open(Path(__file__).parent.parent / 'manifest.json', encoding='utf-8'))['version']
        shown = pg.get_attribute('.ca-panel .ca-foot', 'data-version')
        C.ok(shown == manifest_ver and 'Claude' in pg.inner_text('.ca-panel .ca-foot') and 'Claude' in pg.inner_text('.ca-panel .ca-title'), '设置页版本号和 manifest 一致，署名在标题和页脚', f'shown={shown} manifest={manifest_ver}')
        pg.click('.ca-panel .ca-tab[data-tab="cur"]')
        pg.wait_for_selector('.ca-panel .ca-snap')
        before = len(L.snaps(pg))
        pg.click('.ca-panel [data-act="snap-now"]')
        s = L.wait_snaps(pg, lambda s: len(s) == before + 1)
        C.ok(len(s) == before + 1 and s[0]['locked'] and s[0]['lockReason'] == 'manual', '「立即快照」新建并锁定一份')
        C.ok(pg.evaluate('() => document.documentElement.scrollWidth <= window.innerWidth + 1'), '390px 宽度下没有横向溢出')
        # 同楼数的快照写明改了什么（1.2.3）
        L.ev(pg, 'ctx.chat[ctx.chat.length - 1].mes += " 再改一下"; await ChatAnchor.snapshot("auto", { force: true });')
        L.ev(pg, 'ctx.updateChatMetadata({ ca_test_var: Date.now() }, false); await ChatAnchor.snapshot("auto", { force: true });')
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel .ca-snap')
        labels = pg.locator('.ca-panel .ca-snap .ca-why').all_inner_texts()
        n_now = L.chat_len(pg)
        C.ok(labels[:2] == ['只有聊天设置变了', f'改了第 {n_now} 楼'], '同楼数的快照旁写明「只有聊天设置变了」「改了第 N 楼」', str(labels[:4]))
        pg.locator('.ca-panel .ca-snap .ca-why').nth(1).click()
        pg.wait_for_selector('dialog[open] .ca-dialog')
        why = L.dialog_text(pg)
        pg.screenshot(path=str(OUT / 't3_panel_why.png'))
        C.ok(f'第 {n_now} 楼 修改：正文（mes）' in why, '点开能看到改了哪一楼的哪个字段', why[:160])
        pg.keyboard.press('Escape')
        time.sleep(0.4)
        pg.locator('.ca-panel .ca-snap .ca-why').nth(0).click()
        pg.wait_for_selector('dialog[open] .ca-dialog')
        why = L.dialog_text(pg)
        C.ok('聊天设置：ca_test_var' in why, '元数据的变化列出改了的键', why[:160])
        pg.keyboard.press('Escape')
        time.sleep(0.4)
        d = pg.evaluate('async () => { const s = await ChatAnchor.list(); return await ChatAnchor.diff(s[1].id, s[2].id); }')
        C.ok(d['floors'] and d['floors'][0]['fields'] == ['mes'] and not d['metaKeys'], 'ChatAnchor.diff 返回逐楼字段差异', str(d)[:160])
        close_panel(pg)
        # 忽略字段（1.2.4）：别的扩展写的记账字段单独变了不存快照
        pg.evaluate('() => { SillyTavern.getContext().extensionSettings.chat_anchor.ignore = ["extra.ca_noise", "meta.ca_meta_noise"]; }')
        n_before = len(L.snaps(pg))
        r = L.ev(pg, 'const m = ctx.chat[ctx.chat.length - 1]; m.extra = { ...(m.extra || {}), ca_noise: Date.now() }; ctx.updateChatMetadata({ ca_meta_noise: Date.now() }, false); return await ChatAnchor.snapshot("auto");')
        C.ok(r is None and len(L.snaps(pg)) == n_before, '忽略列表里的字段（消息里的和元数据里的）单独变化时不存快照', f'r={r} n={len(L.snaps(pg))}')
        r = L.ev(pg, 'ctx.chat[ctx.chat.length - 1].mes += " 正文又改了"; return await ChatAnchor.snapshot("auto");')
        C.ok(r and len(L.snaps(pg)) == n_before + 1, '正文变了照常存', f'n={len(L.snaps(pg))}')
        L.ev(pg, 'const m = ctx.chat[ctx.chat.length - 1]; m.extra.ca_noise2 = 1; await ChatAnchor.snapshot("auto");')
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel .ca-snap .ca-why')
        pg.locator('.ca-panel .ca-snap .ca-why').nth(0).click()
        pg.wait_for_selector('dialog[open] .ca-dialog')
        L.click_dialog_button(pg, '以后忽略')
        time.sleep(0.6)
        ign = pg.evaluate('() => SillyTavern.getContext().extensionSettings.chat_anchor.ignore')
        C.ok('extra.ca_noise2' in ign, '弹窗里点「以后忽略」会把字段加进设置', str(ign))
        pg.click('.ca-panel .ca-tab[data-tab="set"]')
        pg.wait_for_selector('.ca-panel input[data-set="ignore"]')
        C.ok('extra.ca_noise2' in pg.input_value('.ca-panel input[data-set="ignore"]'), '设置页能看到忽略列表')
        pg.screenshot(path=str(OUT / 't3_panel_set.png'))
        pg.fill('.ca-panel input[data-set="ignore"]', '')
        pg.locator('.ca-panel input[data-set="ignore"]').dispatch_event('change')
        C.ok(pg.evaluate('() => SillyTavern.getContext().extensionSettings.chat_anchor.ignore') == [], '设置页清空后列表为空')
        close_panel(pg)

        # ───────── J 增量重算（大聊天只算变过的楼，1.2.5） ─────────
        C.section('J 增量重算')
        n_now = L.chat_len(pg)
        r = L.ev(pg, 'ctx.chat[5].mes += " 静默改动"; return await ChatAnchor.snapshot("auto");')
        C.ok(r and r['count'] == n_now and r['full'] is False and r['reused'] >= n_now - 31, 'J1 老楼没有事件但长度变了：指纹抓到，增量模式只重算了尾部和这一楼', str(r and (r['full'], r['reused'], r['count'])))
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel .ca-snap .ca-why')
        label = pg.locator('.ca-panel .ca-snap .ca-why').first.inner_text()
        C.ok(label == '改了第 6 楼', 'J2 列表标出改的是第 6 楼', label)
        close_panel(pg)
        r = pg.evaluate('async () => await ChatAnchor.snapshot("auto", { full: true })')
        C.ok(r is None, 'J3 紧接着全量重算判定内容没变（增量算出的签名和全量一致）', str(r))
        r = L.ev(pg, 'const m = ctx.chat[7]; m.mes = m.mes.slice(0, -1) + (m.mes.endsWith("x") ? "y" : "x"); return await ChatAnchor.snapshot("auto");')
        C.ok(r is None, 'J4 同长度的静默改动增量模式先看不到（性能护栏：auto 快照没有偷偷全量）', str(r))
        r = L.ev(pg, 'await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_EDITED, 7); return await ChatAnchor.snapshot("auto");')
        C.ok(r and r['full'] is False, 'J5 酒馆报了编辑事件后立刻重算那一楼并存快照', str(r and (r['full'], r['reused'])))
        time.sleep(1.5)
        slash(pg, '/cut 3')
        s = L.wait_snaps(pg, lambda s: s and s[0]['count'] == n_now - 1)
        r = pg.evaluate('async () => await ChatAnchor.snapshot("auto", { full: true })')
        C.ok(s and s[0]['count'] == n_now - 1 and r is None, 'J6 删楼后下一次是全量，之后再全量核对也判定没变', f'count={s and s[0]["count"]} r={r}')
        full_flag = pg.evaluate('async () => (await ChatAnchor.list())[0].full')
        C.ok(full_flag is True, 'J7 删楼后的那份快照记为全量', str(full_flag))

        # ───────── K 大请求体自动压缩（1.2.7；这个实例酒馆自己的压缩是关的，请求体是字符串） ─────────
        C.section('K 大请求体自动压缩')
        n_disk = L.floors(L.chat_id(pg))
        cur_name = L.chat_id(pg)
        pg.evaluate('() => { ChatAnchor.state.gzipAbove = 50 * 1024; }')  # 把阈值降到 50 KB，让 300 楼的聊天也触发
        spy = L.Spy(pg, '**/api/chats/save')
        slash(pg, '/send 这条保存会被小锚压缩')
        time.sleep(1.5)
        call = spy.calls[-1] if spy.calls else None
        C.ok(call and call['gzip'] and call['encoding'] == 'gzip', 'K1 超过阈值的保存请求被小锚 gzip 后发出（Content-Encoding: gzip，魔数 1f8b）', str(call and (call['encoding'], call['len'])))
        C.ok(L.floors(cur_name) == n_disk + 1, 'K2 服务器解压后正常落盘', f'floors={L.floors(cur_name)}')
        C.ok(any(r['type'] == '压缩' and '由小锚压缩后发送' in r['msg'] for r in L.ca_log(pg)), 'K3 记录里写了压缩前后的大小')
        spy.remove()
        # 服务器不认压缩：一个路由既记录每个请求、又对带 gzip 的回 400（route.continue_ 直接发网络，不会再交给别的路由，所以不能分成两个）
        seen = []
        def reject_gzip(route, request):
            buf = request.post_data_buffer or b''
            gz = buf[:2] == b'\x1f\x8b'
            seen.append(gz)
            if gz:
                route.fulfill(status=400, content_type='application/json', body='{"error":"bad"}')
            else:
                route.continue_()
        pg.route('**/api/chats/save', reject_gzip)
        slash(pg, '/send 这条压缩会被拒，小锚要改回原样重发')
        time.sleep(2)
        pg.unroute('**/api/chats/save', reject_gzip)
        C.ok(seen == [True, False] and L.floors(cur_name) == n_disk + 2, 'K4 压缩被服务器拒绝后，立刻原样重发并成功落盘', f'calls={seen} floors={L.floors(cur_name)}')
        C.ok(pg.evaluate('() => ChatAnchor.state.gzipBroken') is True and any(r['type'] == '压缩' and '不接受' in r['msg'] for r in L.ca_log(pg)), 'K5 之后这个会话不再压缩，并记进「记录」')
        spy = L.Spy(pg, '**/api/chats/save')
        slash(pg, '/send 之后的保存不再压缩')
        time.sleep(1.5)
        C.ok(spy.calls and not spy.calls[-1]['gzip'] and L.floors(cur_name) == n_disk + 3, 'K6 后续保存直接原样发', f'gzip={spy.calls and spy.calls[-1]["gzip"]}')
        spy.remove()
        pg.evaluate('() => { ChatAnchor.state.gzipBroken = false; ChatAnchor.state.gzipAbove = 4 * 1048576; }')

        # ───────── L 体检（1.2.8） ─────────
        C.section('L 体检')
        L.ev(pg, 'for (const i of [3, 4, 5]) { const m = ctx.chat[i]; m.extra = { ...(m.extra || {}), fake_ext: "x".repeat(200000) }; }')
        d = pg.evaluate('async () => await ChatAnchor.checkup()')
        C.ok(d['count'] == L.chat_len(pg) and d['fields'][0]['key'] == 'extra.fake_ext' and 550000 < d['fields'][0]['bytes'] < 650000 and d['fields'][0]['own'] is False, 'L1 按字段称重：塞进去的扩展字段排第一、约 600 KB、标为非酒馆字段', str(d['fields'][:2]))
        C.ok(d['heavy'][0]['index'] in (3, 4, 5) and d['heavy'][0]['top'] == 'extra.fake_ext', 'L2 最重的楼和它最重的字段找对了', str(d['heavy'][:1]))
        C.ok(d['extBytes'] > d['bytes'] * 0.2 and '让那个扩展把数据存到自己的文件里' in pg.evaluate('(d) => ChatAnchor.checkupText(d)', d), 'L3 扩展数据占比高时报告里给出建议')
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel [data-act="checkup"]')
        pg.click('.ca-panel [data-act="checkup"]')
        pg.wait_for_selector('dialog[open] .ca-check', timeout=15000)
        txt = L.dialog_text(pg)
        C.ok('体检' in txt and 'extra.fake_ext' in txt and '最重的楼' in txt, 'L4 面板里点「体检」弹出报告', txt[:160])
        pg.screenshot(path=str(OUT / 't3_checkup.png'))
        pg.keyboard.press('Escape')
        time.sleep(0.4)
        close_panel(pg)

        # ───────── M 瘦身（1.2.9） ─────────
        C.section('M 瘦身')
        cur_name = L.chat_id(pg)
        n_all = L.chat_len(pg)
        # 造数据：前 100 楼每楼一份重复 swipe 副本；100–110 楼带备选；前 50 楼和最后一楼带思维链
        L.ev(pg, '''const n = ctx.chat.length;
            for (let i = 0; i < 100; i++) { const m = ctx.chat[i]; m.swipe_id = 0; m.swipes = [m.mes]; m.swipe_info = [{ send_date: m.send_date, extra: {} }]; }
            for (let i = 100; i <= 110; i++) { const m = ctx.chat[i]; m.swipe_id = 0; m.swipes = [m.mes, '备选 ' + i]; m.swipe_info = [{}, {}]; }
            for (let i = 0; i < 50; i++) { ctx.chat[i].extra = { ...(ctx.chat[i].extra || {}), reasoning: '想了想 ' + i, reasoning_duration: 1200 }; }
            ctx.chat[n - 1].extra = { ...(ctx.chat[n - 1].extra || {}), reasoning: '最后一楼的思考' };
            await ctx.saveChat();''')
        time.sleep(0.5)
        # 前面的测试步骤（/sendas、恢复等）已经给一些楼留了 swipes，所以期望值按页面里实际的数来
        # 酒馆读取聊天后会给它显示出来的那些楼（默认最近 100 楼）重新补上副本，所以副本只算、只清更早的楼（from 以前）
        exp = L.ev(pg, '''const n = ctx.chat.length, end = n - 50, tr = ctx.powerUserSettings.chat_truncation, from = Math.min(end, tr > 0 ? Math.max(0, n - tr) : 0);
            const old = ctx.chat.slice(0, end), single = m => Array.isArray(m.swipes) && m.swipes.length <= 1, rs = m => m.extra && (m.extra.reasoning || m.extra.reasoning_duration != null);
            return { from, dup: old.filter((m, i) => single(m) && i < from).length, skipped: old.filter((m, i) => single(m) && i >= from).length, alt: old.filter(m => Array.isArray(m.swipes) && m.swipes.length > 1).length,
                     reasoning: old.filter(rs).length, targets: old.filter((m, i) => (single(m) && i < from) || rs(m)).length };''')
        plan = pg.evaluate('async () => await ChatAnchor.slim({ dryRun: true })')
        C.ok(plan['dup']['floors'] == exp['dup'] >= 100 and plan['alt']['floors'] == exp['alt'] == 11 and plan['alt']['count'] == 11 and plan['reasoning']['floors'] == exp['reasoning'] == 50 and plan['applied'] == 0, 'M1 只算不改：副本、备选、思维链各几楼都数对，最后一楼不在范围内', str({k: plan[k] for k in ('dup', 'alt', 'reasoning', 'end')}) + ' exp=' + str(exp))
        C.ok(plan['shown'] == exp['from'] > 0 and plan['dup']['skipped'] == exp['skipped'] > 0, 'M1b 酒馆显示出来的那些楼（它会自己把副本补回去）不算进副本、也不去动', f"shown={plan['shown']} skipped={plan['dup']['skipped']} exp={exp}")
        pg.evaluate('() => { ChatAnchor.state.slimHintMin = 1; ChatAnchor.state.slimHint = null; ChatAnchor.open("cur"); }')
        pg.wait_for_selector('.ca-panel [data-act="slim-quick"]', timeout=10000)
        ht = pg.inner_text('.ca-panel [data-slim-hint]')
        C.ok('可以清' in ht and f"重复的 swipe 副本 {exp['dup']} 楼" in ht and '思维链 50 楼' in ht and '瘦身…' in ht and '按上次' not in ht, 'M10 「当前」页直接写出老楼里攒了多少可清；还没用过瘦身时按钮是「瘦身…」', ht.replace(chr(10), ' '))
        pg.screenshot(path=str(OUT / 't3_slim_hint.png'))
        pg.evaluate('() => { toastr.remove(); document.querySelector(".ca-panel [data-act=slim-quick]").click(); }')
        pg.wait_for_selector('dialog[open] input[data-slim-tags]', timeout=15000)
        txt = L.dialog_text(pg)
        C.ok('瘦身' in txt and '一共约可清掉' in txt and pg.is_checked('dialog[open] input[data-slim="dup"]') and pg.is_checked('dialog[open] input[data-slim="reasoning"]') and not pg.is_checked('dialog[open] input[data-slim="alt"]'),
             'M10b 点「瘦身…」不用先体检，直接开瘦身对话框：副本、思维链默认勾，备选默认不勾', txt.replace(chr(10), ' ')[:160])
        L.click_dialog_button(pg, '取消')
        time.sleep(0.5)
        close_panel(pg)
        before = L.floors(cur_name)
        r = pg.evaluate('async () => await ChatAnchor.slim({})')
        L.wait_js(pg, f'ctx.chat.length === {n_all}', timeout=30000)
        time.sleep(1)
        rows = L.read_chat(cur_name)
        C.ok(r['saved'] is True and r['applied'] == exp['targets'] and L.floors(cur_name) == before, 'M2 默认瘦身：保存成功、楼数不变、动的楼数和计划一致', f"saved={r['saved']} applied={r['applied']} exp={exp['targets']} floors={L.floors(cur_name)}")
        C.ok('swipes' not in rows[1 + 5] and 'reasoning' not in rows[1 + 5].get('extra', {}) and 'swipe_id' not in rows[1 + 5], 'M3 老楼的重复副本和思维链被清掉')
        C.ok(len(rows[1 + 105].get('swipes', [])) == 2, 'M4 备选回复默认保留')
        C.ok(rows[-1].get('extra', {}).get('reasoning') == '最后一楼的思考', 'M5 最近 50 楼一字不动')
        s_ = L.snaps(pg)
        pre = next((x for x in s_ if x['lockReason'] == 'pre-slim'), None)
        C.ok(pre and pre['locked'] and pre['count'] == n_all, 'M6 瘦身前存了锁定快照', str(pre))
        C.ok(any(x['type'] == '瘦身' and '重复 swipe 副本' in x['msg'] and '思维链 50 楼' in x['msg'] for x in L.ca_log(pg)), 'M7 记录里写了清掉多少', str([x['msg'][:120] for x in L.ca_log(pg) if x['type'] == '瘦身']))
        r2 = pg.evaluate('async () => await ChatAnchor.slim({ dropDup: false, dropReasoning: false, dropAlternates: true })')  # 重载后酒馆会给渲染到的老楼补回副本，所以这里只清备选
        L.wait_js(pg, f'ctx.chat.length === {n_all}', timeout=30000)
        time.sleep(1)
        rows = L.read_chat(cur_name)
        C.ok(r2['applied'] == 11 and 'swipes' not in rows[1 + 105], 'M8 勾上备选后，备选也清掉', f"applied={r2['applied']} row106_swipes={rows[1 + 105].get('swipes')}")
        saved = pg.evaluate('async (id) => await ChatAnchor.restoreInPlace(id)', pre['id'])
        L.wait_js(pg, f'ctx.chat.length === {n_all}', timeout=30000)
        time.sleep(1)
        rows = L.read_chat(cur_name)
        C.ok(saved is True and rows[1 + 5].get('swipes') == [rows[1 + 5]['mes']] and rows[1 + 5]['extra'].get('reasoning') == '想了想 5' and len(rows[1 + 105]['swipes']) == 2, 'M9 用「瘦身前」快照恢复，副本、思维链、备选全回来')
        # 酒馆的 reloadCurrentChat 有互斥锁，正在重读时立刻返回；slim 必须等聊天真正读回来才算完
        L.slow_fetch(pg, '/api/chats/get', 2500)
        L.ev(pg, 'for (let i = 0; i < 20; i++) { const m = ctx.chat[i]; m.swipe_id = 0; m.swipes = [m.mes]; } await ctx.saveChat();')
        time.sleep(0.5)
        r3 = L.ev(pg, 'const r = await ChatAnchor.slim({}); return [r.applied, ctx.chat.length];')
        C.ok(r3[0] >= 20 and r3[1] == n_all, 'M11 重新读取很慢时，slim 也要等聊天读回来才返回（返回时楼数完整）', str(r3))
        # 用户实际遇到的：瘦身后酒馆还在重读、聊天暂时是空的，这时点体检看到「0 楼 325 KB」。现在体检和瘦身都要拒绝并说明原因
        r4 = L.ev(pg, '''window.__caReload = ctx.reloadCurrentChat(); await new Promise(r => setTimeout(r, 300));
            const out = { len: ctx.chat.length };
            try { await ChatAnchor.checkup(); out.checkup = 'no-throw'; } catch (e) { out.checkup = e.message; }
            try { await ChatAnchor.slim({}); out.slim = 'no-throw'; } catch (e) { out.slim = e.message; }
            await window.__caReload; out.after = ctx.chat.length; return out;''')
        C.ok(r4['len'] == 0 and '空的' in r4['checkup'] and '空的' in r4['slim'] and r4['after'] == n_all, 'M13 聊天正在重读（暂时 0 楼）时，体检和瘦身都拒绝并说明原因，读完后楼数完整', str(r4))
        L.unslow_fetch(pg, '/api/chats/get')
        # ---- 标签段落（1.2.11）：预设让模型把思考写在正文里，如 <灵魂梳理>…</灵魂梳理>。酒馆不当它是思维链，瘦身按标签名清老楼里的
        blk = '<灵魂梳理>\n' + '先想想她为什么这么说。' * 160 + '\n</灵魂梳理>\n'  # 每段约 5 KB：体检只列 10 KB 以上的标签段落
        orig = L.ev(pg, '''const blk = arg; const orig = [ctx.chat[3].mes, ctx.chat[60].mes];
            for (const i of [3, 4, 60, 105]) ctx.chat[i].mes = blk + ctx.chat[i].mes;
            ctx.chat[105].swipes = [ctx.chat[105].mes, blk + '备选二']; ctx.chat[105].swipe_id = 0;
            ctx.chat[5].mes = '<灵魂梳理>没写完的 ' + ctx.chat[5].mes;
            ctx.chat[ctx.chat.length - 1].mes = blk + ctx.chat[ctx.chat.length - 1].mes;
            await ctx.saveChat(); return orig;''', blk)
        time.sleep(0.5)
        d = pg.evaluate('async () => await ChatAnchor.checkup()')
        ts = next((x for x in d.get('tagStats', []) if x['name'] == '灵魂梳理'), None)
        C.ok(ts and ts['floors'] == 5 and ts['count'] == 5 and ts['bytes'] > 200, 'M14 体检认出正文里的 <灵魂梳理> 段落有 5 楼（含最近楼，不含没写完的）', str(d.get('tagStats')))
        plan = pg.evaluate('async () => await ChatAnchor.slim({ dryRun: true, tags: ["灵魂梳理"] })')
        C.ok(plan['tags']['floors'] == 4 and plan['tags']['count'] == 6 and plan['tags']['bytes'] > 200 and plan['applied'] == 0, 'M15 只算不改：老楼里 4 楼有标签段落（没写完的、最近 50 楼的不算），备选里的两段也算', str(plan['tags']))
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel [data-act="checkup"]')
        pg.click('.ca-panel [data-act="checkup"]')
        pg.wait_for_selector('dialog[open] .ca-check', timeout=15000)
        C.ok('灵魂梳理' in L.dialog_text(pg), 'M16 体检弹窗里列出了 <灵魂梳理> 段落有多大')
        L.click_dialog_button(pg, '瘦身')
        pg.wait_for_selector('dialog[open] input[data-slim-tags]', timeout=15000)
        C.ok(pg.input_value('dialog[open] input[data-slim-tags]') == '' and not pg.is_checked('dialog[open] input[data-slim="tags"]'), 'M17 还没填标签名时，标签段落一项是空的、不勾')
        pg.click('dialog[open] [data-tag-chip="灵魂梳理"]')
        pg.wait_for_function('() => /4 楼/.test(document.querySelector("dialog[open] [data-slim-n=tags]").textContent)', timeout=5000)
        C.ok(pg.input_value('dialog[open] input[data-slim-tags]') == '灵魂梳理' and pg.is_checked('dialog[open] input[data-slim="tags"]'), 'M18 点体检看到的标签就填进输入框，数出 4 楼并自动勾上', pg.input_value('dialog[open] input[data-slim-tags]'))
        pg.uncheck('dialog[open] input[data-slim="dup"]')
        pg.uncheck('dialog[open] input[data-slim="reasoning"]')
        pg.screenshot(path=str(OUT / 't3_slim_tags.png'))
        has_preview = '() => [...document.querySelectorAll("dialog[open]")].some(d => d.innerText.includes("先看一眼要删的是什么"))'
        L.click_dialog_button(pg, '开始瘦身')
        pg.wait_for_function(has_preview, timeout=10000)
        pv = L.dialog_text(pg)
        C.ok('<灵魂梳理>' in pv and '先想想她为什么这么说' in pv and '第 106 楼会删掉这一段' in pv and '删完以后，第 106 楼的正文剩下' in pv and '像是正文本身' not in pv, 'M23 清正文之前先给看：哪个标签、几楼、举一楼的真实例子、那一楼删完剩下什么', pv.replace(chr(10), ' ')[-260:])
        pg.screenshot(path=str(OUT / 't3_slim_preview.png'))
        L.click_dialog_button(pg, '返回')
        pg.wait_for_function('() => ![...document.querySelectorAll("dialog[open]")].some(d => d.innerText.includes("先看一眼要删的是什么")) && !!document.querySelector("dialog[open] input[data-slim-tags]")', timeout=10000)
        time.sleep(0.4)
        C.ok(L.floors(cur_name) == n_all and '灵魂梳理' in L.read_chat(cur_name)[1 + 3]['mes'] and pg.input_value('dialog[open] input[data-slim-tags]') == '灵魂梳理' and pg.is_checked('dialog[open] input[data-slim="tags"]') and not pg.is_checked('dialog[open] input[data-slim="dup"]'),
             'M24 点「返回」什么都没删，回到瘦身对话框，刚才填的和勾的都还在')
        L.click_dialog_button(pg, '开始瘦身')
        pg.wait_for_function(has_preview, timeout=10000)
        L.click_dialog_button(pg, '就删这些')
        for _ in range(80):
            rows = L.read_chat(cur_name)
            if rows and '灵魂梳理' not in rows[1 + 3]['mes']:
                break
            time.sleep(0.5)
        L.wait_js(pg, f'ctx.chat.length === {n_all}', timeout=30000)
        time.sleep(1)
        rows = L.read_chat(cur_name)
        C.ok(rows[1 + 3]['mes'] == orig[0] and rows[1 + 60]['mes'] == orig[1] and '灵魂梳理' not in rows[1 + 105]['mes'] and rows[1 + 105]['swipes'] == [rows[1 + 105]['mes'], '备选二'], 'M19 老楼正文和备选里的 <灵魂梳理> 段落都清掉了，正文其余部分一字不差', repr(rows[1 + 3]['mes'][:60]))
        C.ok(rows[1 + 5]['mes'].startswith('<灵魂梳理>没写完的 ') and rows[-1]['mes'].startswith('<灵魂梳理>'), 'M20 没写完的段落和最近 50 楼的一字不动')
        saved_tags = L.ev(pg, 'return ctx.extensionSettings.chat_anchor.slimTags')
        C.ok(saved_tags == '灵魂梳理' and any(x['type'] == '瘦身' and '<灵魂梳理>' in x['msg'] for x in L.ca_log(pg)), 'M21 标签名记住了，记录里写了清掉哪种段落', str(saved_tags) + ' ' + str([x['msg'][:80] for x in L.ca_log(pg) if x['type'] == '瘦身'][-1:]))
        last = L.ev(pg, 'return ctx.extensionSettings.chat_anchor.slimLast')
        C.ok(last == {'dup': False, 'reasoning': False, 'alt': False, 'tags': '灵魂梳理'}, 'M25 这次确认并做完的选项记了下来，留给「按上次的选项瘦身」', str(last))
        close_panel(pg)

        # ---- 一步瘦身（1.2.12）：「当前」页按上次的选项算出可清多少，一个按钮、只确认一次
        L.ev(pg, 'const blk = arg; for (const i of [10, 11]) ctx.chat[i].mes = blk + ctx.chat[i].mes; await ctx.saveChat();', blk)
        time.sleep(0.5)
        pg.evaluate('() => { toastr.remove(); ChatAnchor.state.slimHint = null; ChatAnchor.open("cur"); }')
        pg.wait_for_selector('.ca-panel [data-act="slim-quick"]', timeout=10000)
        ht = pg.inner_text('.ca-panel [data-slim-hint]')
        C.ok('<灵魂梳理> 段落 2 楼' in ht and '按上次的选项瘦身' in ht and '副本' not in ht, 'M29 用过瘦身以后，提示按上次的选项算，按钮变成「按上次的选项瘦身」', ht.replace(chr(10), ' '))
        pg.evaluate('() => document.querySelector(".ca-panel [data-act=slim-quick]").click()')
        pg.wait_for_function('() => [...document.querySelectorAll("dialog[open]")].some(d => d.querySelector("h3")?.innerText === "按上次的选项瘦身")', timeout=10000)
        qt = L.dialog_text(pg)
        C.ok('<灵魂梳理> 段落 2 楼' in qt and '先想想她为什么这么说' in qt and '第 12 楼会删掉这一段' in qt and '改选项' in qt, 'M30 一步瘦身只确认一次，确认框里同样给看要删的例子，也能改选项', qt.replace(chr(10), ' ')[-260:])
        pg.screenshot(path=str(OUT / 't3_slim_quick.png'))
        L.click_dialog_button(pg, '改选项')
        pg.wait_for_selector('dialog[open] input[data-slim-tags]', timeout=15000)
        C.ok(pg.input_value('dialog[open] input[data-slim-tags]') == '灵魂梳理' and pg.is_checked('dialog[open] input[data-slim="tags"]') and L.floors(cur_name) == n_all and '灵魂梳理' in L.read_chat(cur_name)[1 + 10]['mes'],
             'M30b 点「改选项…」什么都没删，打开完整的瘦身对话框，上次的标签名和勾选都带过来')
        L.click_dialog_button(pg, '取消')
        time.sleep(0.6)
        pg.evaluate('() => { toastr.remove(); document.querySelector(".ca-panel [data-act=slim-quick]").click(); }')
        pg.wait_for_function('() => [...document.querySelectorAll("dialog[open]")].some(d => d.querySelector("h3")?.innerText === "按上次的选项瘦身")', timeout=10000)
        L.click_dialog_button(pg, '开始瘦身')
        for _ in range(80):
            rows = L.read_chat(cur_name)
            if rows and '灵魂梳理' not in rows[1 + 10]['mes']:
                break
            time.sleep(0.5)
        L.wait_js(pg, f'ctx.chat.length === {n_all}', timeout=30000)
        pg.wait_for_function('() => !!document.querySelector(".ca-panel [data-slim-hint]") && !document.querySelector(".ca-panel [data-act=slim-quick]")', timeout=10000)
        rows = L.read_chat(cur_name)
        last2 = L.ev(pg, 'return ctx.extensionSettings.chat_anchor.slimLast')
        C.ok('灵魂梳理' not in rows[1 + 10]['mes'] and '灵魂梳理' not in rows[1 + 11]['mes'] and rows[1 + 5]['mes'].startswith('<灵魂梳理>没写完的 ') and last2 == last, 'M31 清完了，老楼里没有可清的，提示自动消失；记住的选项没变', str(last2))
        close_panel(pg)

        pg.evaluate('() => { toastr.remove(); ChatAnchor.open("cur"); }')
        pg.wait_for_selector('.ca-panel [data-act="checkup"]')
        pg.click('.ca-panel [data-act="checkup"]')
        pg.wait_for_selector('dialog[open] .ca-check', timeout=15000)
        L.click_dialog_button(pg, '瘦身')
        pg.wait_for_selector('dialog[open] input[data-slim="dup"]', timeout=15000)
        txt = L.dialog_text(pg)
        C.ok('重复的 swipe 副本' in txt and '老楼的思维链' in txt and '勾选的几项里现在没有可清的' in txt and not pg.is_checked('dialog[open] input[data-slim="dup"]') and not pg.is_checked('dialog[open] input[data-slim="reasoning"]') and not pg.is_checked('dialog[open] input[data-slim="alt"]'),
             'M12 体检弹窗 → 瘦身对话框：几项都在，勾选沿用上次确认过的；勾的几项没东西可清就直说', txt.replace(chr(10), ' ')[:200])
        C.ok(pg.input_value('dialog[open] input[data-slim-tags]') == '灵魂梳理' and not pg.is_checked('dialog[open] input[data-slim="tags"]') and '没有可清的' in pg.inner_text('dialog[open] [data-slim-n="tags"]'), 'M22 再打开时标签名还在，但老楼里已经没有可清的，所以不勾')
        pg.check('dialog[open] input[data-slim="alt"]')
        pg.wait_for_function('() => document.querySelector("dialog[open] [data-slim-sum]").textContent.includes("清完约")', timeout=5000)
        C.ok(True, 'M26 勾上有东西可清的一项，合计马上变成「清完约 … → …」')
        pg.uncheck('dialog[open] input[data-slim="alt"]')
        pg.screenshot(path=str(OUT / 't3_slim.png'))
        L.click_dialog_button(pg, '取消')
        time.sleep(0.4)
        close_panel(pg)

        # ---- 故事正文那一段（<content>）不做成可点的按钮；真手填了，预览里红字提醒；取消以后不留
        L.ev(pg, '''const story = '她抬起头，看着窗外的雨。'.repeat(150), draw = 'masterpiece, 1girl, rain, window, '.repeat(160);
            for (const i of [20, 21, 22]) ctx.chat[i].mes = '<content>' + story + '</content>\\n<draw>' + draw + '</draw>';
            await ctx.saveChat();''')
        time.sleep(0.5)
        pg.evaluate('() => { toastr.remove(); ChatAnchor.open("cur"); }')
        pg.wait_for_selector('.ca-panel [data-act="checkup"]')
        pg.click('.ca-panel [data-act="checkup"]')
        pg.wait_for_selector('dialog[open] .ca-check', timeout=15000)
        ck = L.dialog_text(pg)
        L.click_dialog_button(pg, '瘦身')
        pg.wait_for_selector('dialog[open] input[data-slim-tags]', timeout=15000)
        chips = pg.evaluate('() => [...document.querySelectorAll("dialog[open] [data-tag-chip]")].map(x => x.dataset.tagChip)')
        C.ok('<content>' in ck and '<draw>' in ck and '故事本身那一段不要填' in ck and 'draw' in chips and 'content' not in chips, 'M27 体检照实列出 <content> 和 <draw>，但瘦身里只把 <draw> 做成可点的按钮，并提醒故事本身别填', f'chips={chips}')
        pg.fill('dialog[open] input[data-slim-tags]', 'content')
        pg.wait_for_function('() => /3 楼/.test(document.querySelector("dialog[open] [data-slim-n=tags]").textContent)', timeout=5000)
        L.click_dialog_button(pg, '开始瘦身')
        pg.wait_for_function(has_preview, timeout=10000)
        pv = L.dialog_text(pg)
        C.ok('看名字像是正文本身' in pv and '她抬起头，看着窗外的雨' in pv and 'masterpiece' in pv, 'M28 硬要填 content：预览里红字提醒，还能亲眼看到要删的是故事、剩下的是画图指令', pv.replace(chr(10), ' ')[-300:])
        pg.screenshot(path=str(OUT / 't3_slim_content.png'))
        L.click_dialog_button(pg, '返回')
        pg.wait_for_function('() => ![...document.querySelectorAll("dialog[open]")].some(d => d.innerText.includes("先看一眼要删的是什么")) && !!document.querySelector("dialog[open] input[data-slim-tags]")', timeout=10000)
        time.sleep(0.4)
        L.click_dialog_button(pg, '取消')
        time.sleep(0.6)
        close_panel(pg)
        kept = L.ev(pg, 'return [ctx.extensionSettings.chat_anchor.slimTags, ctx.chat[20].mes.startsWith("<content>")]')
        C.ok(kept == ['灵魂梳理', True], 'M32 反悔取消以后正文没动，填过的 content 也不会留到下次', str(kept))

        warns = [t for ty, t in con.lines if ty == 'warning' and '[小锚]' in t]
        C.ok(not warns, '小锚全程没有输出过警告', str(warns[:3]))
        C.ok(not [e for e in con.errors if 'Internal S' not in e], '页面没有未捕获的异常（horde 的 500 除外）', str(con.errors[:3]))
        b.close()
    return C.done()


if __name__ == '__main__':
    sys.exit(main())
