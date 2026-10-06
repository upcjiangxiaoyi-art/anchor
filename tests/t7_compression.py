"""
t7_compression.py — 酒馆开了 requestCompression 时，守门和补存还对不对。

酒馆要用 performance.requestCompression.enabled=true（minPayloadSize 调小）启动：
  ST_COMPRESS=1 ST_PORT=8124 ST_DATA=/some/other/data ST_DIR=~/st tests/run.sh t7
开了压缩以后，保存请求体是 gzip 的二进制，守门从请求体里拿不到文件名，会退回到"当前聊天"。
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stlib as L  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

NAME = 'gz-301'
LOAD_FAIL_DIALOG = '() => [...document.querySelectorAll("dialog[open]")].some(d => d.innerText.includes("没有读取成功"))'


def slash(pg, cmd):
    return L.ev(pg, 'const r = await ctx.executeSlashCommandsWithOptions(arg, { handleParserErrors: false, handleExecutionErrors: false }); return r?.pipe ?? null;', cmd)


def wait_log(pg, pred, timeout=15.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        lg = L.ca_log(pg)
        if any(pred(r) for r in lg):
            return lg
        time.sleep(0.3)
    return L.ca_log(pg)


def main():
    L.require_st()
    L.patch_settings(first_run=False, ext_enabled=True)
    L.clear_char_chats()
    C = L.Checks('T7 开启 requestCompression')
    with sync_playwright() as p:
        b, c = L.launch(p)
        pg = c.new_page()
        con = L.Console(pg)
        L.goto_app(pg, ext=True)
        L.select_char(pg)
        L.write_chat(NAME, 301)
        L.open_chat(pg, NAME)
        key = L.current_key(pg)
        L.wait_snaps(pg, lambda s: any(x['count'] == 301 for x in s))

        C.section('压缩确实开着')
        spy = L.Spy(pg, '**/api/chats/save')
        slash(pg, '/send 压缩测试')
        L.wait_snaps(pg, lambda s: s and s[0]['count'] == 302)
        time.sleep(0.5)
        call = spy.calls[-1] if spy.calls else None
        if not (call and call['gzip']):
            print('    保存请求没有被压缩。酒馆要用 ST_COMPRESS=1 起（或 config.yaml 里 performance.requestCompression.enabled: true，minPayloadSize 调小），而且端口上不能是已有的旧实例。', flush=True)
        C.ok(call and call['gzip'] and call['encoding'] == 'gzip', 'G1 保存请求体是 gzip（Content-Encoding: gzip，魔数 1f8b）', str(call and (call['encoding'], call['len'])))
        C.ok(L.floors(NAME) == 302, 'G2 服务器解压后正常落盘（302 楼）', f'floors={L.floors(NAME)}')
        ls = pg.evaluate('(k) => ChatAnchor.state.lastSave.get(k) || null', key)
        C.ok(ls and ls['ok'], 'G3 守门按"当前聊天"记下了这次保存成功', str(ls))
        spy.remove()

        C.section('第三方读取失败 + 压缩保存不误拦')
        n_disk = L.floors(NAME)
        f = L.Fault(pg, '**/api/chats/get', mode='abort', times=1)
        L.ev(pg, '''const ch = ctx.characters[ctx.characterId];
            try { await fetch('/api/chats/get', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({ ch_name: ch.name, file_name: ch.chat, avatar_url: ch.avatar }) }); } catch {}''')
        pz = L.poison(pg, key)
        C.ok(pz and not pz['confirmed'], 'G4 读取失败后有一个未确认的标记', str(pz))
        spy = L.Spy(pg, '**/api/chats/save')
        slash(pg, '/send 第三方读取失败后的压缩保存')
        time.sleep(1.5)
        C.ok(len(spy.calls) >= 1 and spy.calls[-1]['gzip'], 'G5 压缩的保存没有被拦，到达了服务器', f'calls={len(spy.calls)}')
        C.ok(L.floors(NAME) == n_disk + 1, 'G6 磁盘 +1 楼', f'floors={L.floors(NAME)}')
        C.ok(not pg.evaluate(LOAD_FAIL_DIALOG), 'G7 没有弹窗')
        spy.remove()
        f.remove()

        C.section('断网读取失败：守门照常拦，重新读取后压缩保存恢复')
        n_disk = L.floors(NAME)
        f = L.Fault(pg, '**/api/chats/get', mode='abort')
        L.ev(pg, 'ctx.reloadCurrentChat().catch(() => {});')
        try:
            pg.wait_for_function(LOAD_FAIL_DIALOG, timeout=20000)
            C.ok(True, 'G8 弹出「这个聊天没有读取成功」')
        except Exception as e:
            C.ok(False, 'G8 弹出「这个聊天没有读取成功」', str(e)[:120])
        time.sleep(2)
        C.ok(L.floors(NAME) == n_disk, f'G9 磁盘仍是 {n_disk} 楼', f'floors={L.floors(NAME)}')
        f.remove()
        L.click_dialog_button(pg, '重新读取')
        L.wait_js(pg, f'ctx.chat.length === {n_disk}', timeout=20000)
        time.sleep(1)
        spy = L.Spy(pg, '**/api/chats/save')
        slash(pg, '/send 重新读取后的压缩保存')
        time.sleep(1.5)
        C.ok(L.poison(pg, key) is None and spy.calls and spy.calls[-1]['gzip'] and L.floors(NAME) == n_disk + 1, 'G10 标记清除，之后的压缩保存正常', f'floors={L.floors(NAME)} calls={len(spy.calls)}')
        spy.remove()

        C.section('覆盖恢复 + 补存')
        n_disk = L.floors(NAME)
        rows_full = L.read_chat(NAME)
        top = L.snaps(pg)[0]
        L.write_chat(NAME, 1, meta=rows_full[0].get('chat_metadata'), msgs=[rows_full[1]])
        L.ev(pg, 'await ctx.reloadCurrentChat();')
        L.wait_js(pg, 'ctx.chat.length === 1')
        L.wait_snaps(pg, lambda s: any(x['lockReason'] == 'drop' for x in s))
        spy = L.Spy(pg, '**/api/chats/save')
        saved = pg.evaluate('async (id) => await ChatAnchor.restoreInPlace(id)', top['id'])
        C.ok(saved is True and L.floors(NAME) == n_disk and any(c_['gzip'] for c_ in spy.calls), 'G11 覆盖恢复的保存是压缩的，且能确认保存成功', f'saved={saved} floors={L.floors(NAME)}')
        spy.remove()
        f = L.Fault(pg, '**/api/chats/save', mode=500, times=1, body='Internal Server Error')
        slash(pg, '/send 这条压缩保存会失败一次')
        lg = wait_log(pg, lambda r: r['type'] == '补存' and '成功' in r['msg'], timeout=15)
        C.ok(any(r['type'] == '补存' and '成功' in r['msg'] for r in lg) and L.floors(NAME) == n_disk + 1, 'G12 压缩保存失败后 3 秒补存成功', f'floors={L.floors(NAME)} hits={f.hits} passed={f.passed}')
        f.remove()

        warns = [t for ty, t in con.lines if ty == 'warning' and '[小锚]' in t]
        C.ok(not warns, '小锚全程没有输出过警告', str(warns[:3]))
        b.close()
    return C.done()


if __name__ == '__main__':
    sys.exit(main())
