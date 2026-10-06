"""
t6_group.py — 群聊（优先级低，默认也会跑，约 3 分钟）。

第一部分（不装小锚）：复现群聊根因——/api/chats/group/get 失败时 loadGroupChat 返回 []，
getGroupChat 当成新群聊塞成员开场白并 saveGroupChat，覆盖原文件。
第二部分（装上小锚）：守门（reloadCurrentChat 路径 + 重新打开群的路径）、掉楼检测、覆盖恢复、恢复成新聊天。
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stlib as L  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

CHAT = 'group-301'
OUT = Path(__file__).parent / 'out'
LOAD_FAIL_DIALOG = '() => [...document.querySelectorAll("dialog[open]")].some(d => d.innerText.includes("没有读取成功"))'


def slash(pg, cmd):
    return L.ev(pg, 'const r = await ctx.executeSlashCommandsWithOptions(arg, { handleParserErrors: false, handleExecutionErrors: false }); return r?.pipe ?? null;', cmd)


def toasts(pg):
    return pg.evaluate('() => [...document.querySelectorAll("#toast-container .toast")].map(t => t.innerText)')


def main():
    L.require_st()
    OUT.mkdir(exist_ok=True)
    C = L.Checks('T6 群聊')
    with sync_playwright() as p:
        # ───────── 第一部分：不装小锚，复现群聊根因 ─────────
        C.section('根因复现（不装小锚）')
        L.patch_settings(first_run=False, ext_enabled=False)
        b, c = L.launch(p)
        pg = c.new_page()
        L.goto_app(pg, ext=False)
        gid = L.ensure_group(pg, CHAT)
        L.write_group_chat(CHAT, 301)
        pg.reload(wait_until='load')
        L.goto_app(pg, ext=False)
        L.open_group(pg, gid)
        members = L.ev(pg, 'return ctx.groups.find(g => g.id == ctx.groupId).members.length;')
        C.ok(L.chat_len(pg) == 301 and L.group_floors(CHAT) == 301, f'群聊（{members} 个成员）301 楼正常打开', f'len={L.chat_len(pg)} floors={L.group_floors(CHAT)}')
        f = L.Fault(pg, '**/api/chats/group/get', mode=502, body='<html><body>502 Bad Gateway</body></html>')
        L.ev(pg, 'ctx.reloadCurrentChat().catch(() => {});')
        L.wait_js(pg, f'ctx.chat.length <= {members}', timeout=20000)
        time.sleep(2.5)
        f.remove()
        C.ok(L.chat_len(pg) == members, f'读取失败后页面上只剩 {members} 条成员开场白', f'len={L.chat_len(pg)}')
        C.ok(L.group_floors(CHAT) == members, f'磁盘上的 301 楼群聊被覆盖成 {members} 楼', f'floors={L.group_floors(CHAT)}')
        C.ok(not pg.evaluate('() => !!document.querySelector("dialog[open]")'), '没有任何弹窗')
        b.close()

        # ───────── 第二部分：装上小锚 ─────────
        L.patch_settings(first_run=False, ext_enabled=True)
        L.write_group_chat(CHAT, 301)
        b, c = L.launch(p)
        pg = c.new_page()
        con = L.Console(pg)
        L.goto_app(pg, ext=True)
        L.open_group(pg, gid)
        key = L.group_current_key(pg)

        C.section('自动快照')
        C.ok(key == f'g|{CHAT}', '群聊的 chatKey 是 g|<chat_id>', str(key))
        s = L.wait_snaps(pg, lambda s: any(x['count'] == 301 for x in s), key=key)
        C.ok(any(x['count'] == 301 and x['reason'] == 'load' for x in s), '打开群聊后自动存了 301 楼的 load 快照', str(s)[:200])
        slash(pg, '/send 群里发一条')
        s = L.wait_snaps(pg, lambda s: s and s[0]['count'] == 302, key=key)
        C.ok(s and s[0]['count'] == 302, '/send 后存了 302 楼的快照')
        time.sleep(0.5)
        C.ok(L.group_floors(CHAT) == 302, '酒馆正常保存了群聊（守门没有误拦）', f'floors={L.group_floors(CHAT)}')

        # 群聊和角色聊天不同：loadGroupChat 没有 try/catch，fetch 抛异常时 getGroupChat 整个中断，
        # 不保存、不发 CHAT_CHANGED、屏幕留空。小锚在 1 秒后看到屏幕是空的就确认标记、弹窗。
        C.section('守门：reloadCurrentChat 时断网（酒馆抛异常，屏幕留空）')
        n_disk = L.group_floors(CHAT)
        f = L.Fault(pg, '**/api/chats/group/get', mode='abort')
        L.ev(pg, 'ctx.reloadCurrentChat().catch(() => {});')
        try:
            pg.wait_for_function(LOAD_FAIL_DIALOG, timeout=20000)
            C.ok(True, '弹出「这个聊天没有读取成功」')
        except Exception as e:
            C.ok(False, '弹出「这个聊天没有读取成功」', str(e)[:120])
        time.sleep(1)
        C.ok(L.group_floors(CHAT) == n_disk, f'磁盘群聊仍是 {n_disk} 楼', f'floors={L.group_floors(CHAT)}')
        C.ok(L.chat_len(pg) == 0, '页面上此刻是空的（酒馆群聊读取抛异常后的状态）', f'len={L.chat_len(pg)}')
        pz = L.poison(pg, key)
        C.ok(pz and pz['confirmed'], '守门标记已确认', str(pz))
        spy = L.Spy(pg, '**/api/chats/group/save')
        L.ev(pg, 'await ctx.saveChat();')
        time.sleep(0.5)
        C.ok(len(spy.calls) == 0, '此时的保存被拦下，没有发到服务器', f'calls={len(spy.calls)}')
        spy.remove()
        lg = L.ca_log(pg)
        C.ok(any(r['type'] == '守门' and '拦下' in r['msg'] for r in lg), '记录里有「守门：拦下一次保存」', str(lg[-3:]))
        f.remove()
        L.click_dialog_button(pg, '重新读取')
        L.wait_js(pg, f'ctx.chat.length === {n_disk}', timeout=20000)
        time.sleep(1)
        C.ok(L.chat_len(pg) == n_disk and L.poison(pg, key) is None, f'重新读取后回到 {n_disk} 楼，标记清除', str(L.poison(pg, key)))

        C.section('守门：切走再切回群时读取 502（元数据被重置）')
        f = L.Fault(pg, '**/api/chats/group/get', mode=502, body='<html><body>502</body></html>')
        L.select_char(pg)
        L.ev(pg, '(async () => { const el = document.querySelector(`.group_select[data-grid="${arg}"]`); el.click(); })();', gid)
        try:
            pg.wait_for_function(LOAD_FAIL_DIALOG, timeout=20000)
            C.ok(True, '弹出「这个聊天没有读取成功」')
        except Exception as e:
            C.ok(False, '弹出「这个聊天没有读取成功」', str(e)[:120])
        time.sleep(2.5)
        C.ok(L.group_floors(CHAT) == n_disk, f'磁盘群聊仍是 {n_disk} 楼', f'floors={L.group_floors(CHAT)}')
        f.remove()
        L.click_dialog_button(pg, '重新读取')
        L.wait_js(pg, f'ctx.chat.length === {n_disk}', timeout=20000)
        time.sleep(1)
        C.ok(L.chat_len(pg) == n_disk, f'重新读取后回到 {n_disk} 楼')

        C.section('掉楼检测和覆盖恢复')
        rows_full = L.read_group_chat(CHAT)
        top = L.snaps(pg, key)[0]
        L.write_group_chat(CHAT, 2, meta=rows_full[0].get('chat_metadata'), msgs=rows_full[1:3])
        L.ev(pg, 'await ctx.reloadCurrentChat();')
        L.wait_js(pg, 'ctx.chat.length === 2')
        s = L.wait_snaps(pg, lambda s: any(x['lockReason'] == 'drop' for x in s), key=key)
        drop = next((x for x in s if x['lockReason'] == 'drop'), None)
        C.ok(drop and drop['id'] == top['id'] and drop['count'] == n_disk, '掉楼前的最新快照被自动锁定', str(drop))
        C.ok(any('少了' in t for t in toasts(pg)), '弹出掉楼提醒')
        saved = pg.evaluate('async (id) => await ChatAnchor.restoreInPlace(id)', drop['id'])
        C.ok(saved is True, 'restoreInPlace 返回保存成功', str(saved))
        L.wait_js(pg, f'ctx.chat.length === {n_disk}')
        C.ok(L.group_floors(CHAT) == n_disk, f'磁盘群聊恢复到 {n_disk} 楼', f'floors={L.group_floors(CHAT)}')
        rows_restored = L.read_group_chat(CHAT)
        C.ok([r['mes'] for r in rows_restored[1:]] == [r['mes'] for r in rows_full[1:]], '恢复后的内容逐楼一致')
        C.ok(any(x['lockReason'] == 'pre-restore' and x['count'] == 2 for x in L.snaps(pg, key)), '覆盖前的状态另存成了锁定的「恢复前」快照')

        C.section('恢复成新聊天')
        new_id = pg.evaluate('async (id) => await ChatAnchor.restoreAsNew(id)', drop['id'])
        C.ok(isinstance(new_id, str) and new_id and new_id != CHAT, 'restoreAsNew 返回了新的群聊 id', str(new_id))
        L.wait_js(pg, 'ctx.chatId === arg', arg=new_id)
        C.ok(L.chat_len(pg) == n_disk, f'已切到新群聊，页面上 {n_disk} 楼', f'len={L.chat_len(pg)}')
        C.ok(L.group_floors(new_id) == n_disk, f'新文件在磁盘上有 {n_disk} 楼', f'floors={L.group_floors(new_id)}')
        C.ok(L.group_floors(CHAT) == n_disk, '原群聊文件没动')
        gfile = L.group_file_on_disk(gid)
        C.ok(gfile and new_id in gfile.get('chats', []) and gfile.get('chat_id') == new_id, '群文件里记录了新聊天并指向它', str(gfile and (gfile.get('chat_id'), gfile.get('chats'))))
        new_rows = L.read_group_chat(new_id)
        C.ok([r['mes'] for r in new_rows[1:]] == [r['mes'] for r in rows_full[1:]], '新群聊内容逐楼一致')
        slash(pg, '/send 新群聊里继续聊')
        time.sleep(1.5)
        C.ok(L.group_floors(new_id) == n_disk + 1, '新群聊可以正常保存', f'floors={L.group_floors(new_id)}')
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel .ca-snap')
        pg.screenshot(path=str(OUT / 't4_group_panel.png'))
        C.ok('小锚测试群' in pg.inner_text('.ca-panel .ca-chat-name'), '面板显示群名')

        warns = [t for ty, t in con.lines if ty == 'warning' and '[小锚]' in t]
        C.ok(not warns, '小锚全程没有输出过警告', str(warns[:3]))
        b.close()
    return C.done()


if __name__ == '__main__':
    sys.exit(main())
