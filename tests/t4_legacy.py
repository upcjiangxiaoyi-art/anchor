"""
t4_legacy.py — 旧插件「聊天记录快速恢复」留下的备份救援（照搬 1.2.0 沙盒里的 7 项）。

旧插件的库：IndexedDB ST_ChatBackup，backups_meta / backups_content，键 [chatKey, timestamp]，内容是整份 jsonl 字符串。
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stlib as L  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(__file__).parent / 'out'
MAKE_DB = """async () => {
  const lines = [JSON.stringify({ chat_metadata: { integrity: 'old-plugin-test' }, user_name: 'unused', character_name: 'unused' })];
  for (let i = 0; i < 420; i++) lines.push(JSON.stringify({ name: i % 2 ? 'Seraphina' : 'User', is_user: i % 2 === 0, is_system: false, send_date: new Date().toISOString(), mes: '旧备份第' + i + '楼 ' + '漠北的风沙尚未褪尽。'.repeat(30), extra: {} }));
  const key = { chatKey: 'char_7_某个聊天', timestamp: Date.now() - 3600e3 };
  await new Promise((res, rej) => { const rq = indexedDB.open('ST_ChatBackup', 2);
    rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('backups_meta', { keyPath: ['chatKey', 'timestamp'] }); db.createObjectStore('backups_content', { keyPath: ['chatKey', 'timestamp'] }); };
    rq.onsuccess = () => { const db = rq.result; const t = db.transaction(['backups_meta', 'backups_content'], 'readwrite');
      t.objectStore('backups_meta').put({ ...key, entityName: 'Seraphina', chatName: '某个聊天', lastMessageId: 419, lastMessagePreview: '旧备份第419楼 漠北的风沙尚未褪尽。', lastTwoMessages: [] });
      t.objectStore('backups_content').put({ ...key, chatFileContent: lines.join('\\n') + '\\n' });
      t.oncomplete = () => { db.close(); res(); }; t.onerror = () => rej(t.error); };
    rq.onerror = () => rej(rq.error); });
  return key; }"""


def main():
    L.require_st()
    L.patch_settings(first_run=False, ext_enabled=True)
    L.clear_char_chats()
    OUT.mkdir(exist_ok=True)
    C = L.Checks('T4 旧插件备份救援')
    with sync_playwright() as p:
        b, c = L.launch(p)
        pg = c.new_page()
        con = L.Console(pg)
        L.goto_app(pg, ext=True)
        L.select_char(pg)
        r = pg.evaluate('async () => ({ list: (await ChatAnchor.legacy.list()).length, dbs: (await indexedDB.databases()).map(d => d.name) })')
        C.ok(r['list'] == 0 and 'ST_ChatBackup' not in r['dbs'], 'L1 没有旧库时返回空，且不会顺手建一个空库', str(r))
        key = pg.evaluate(MAKE_DB)
        lst = pg.evaluate('async () => (await ChatAnchor.legacy.list()).map(r => [r.entityName, r.lastMessageId])')
        C.ok(lst == [['Seraphina', 419]], 'L2 读到旧插件的备份', str(lst))
        pg.evaluate('() => ChatAnchor.open("all")')
        pg.wait_for_selector('.ca-panel .ca-old', timeout=5000)
        C.ok(pg.locator('.ca-panel .ca-old').count() == 1, 'L3 「全部」页顶部列出旧备份')
        pg.screenshot(path=str(OUT / 't4_legacy_panel.png'))
        pg.click('.ca-old [data-act="old-preview"]')
        pg.wait_for_selector('textarea.ca-preview', timeout=5000)
        C.ok('旧备份第419楼' in pg.evaluate('() => document.querySelector("textarea.ca-preview")?.value || ""'), 'L4 预览能打开，显示最后几楼')
        pg.evaluate('() => [...document.querySelectorAll("dialog[open] .popup-button-ok")].pop()?.click()')
        time.sleep(0.6)
        pg.click('.ca-old [data-act="old-import"]')
        L.wait_js(pg, 'ctx.chat.length === 420', timeout=20000)
        time.sleep(1)
        new_name = L.chat_id(pg) or ''
        C.ok('imported' in new_name and L.floors(new_name) == 420, 'L5 导入成新聊天（磁盘上 420 楼）', f'{new_name} floors={L.floors(new_name)}')
        C.ok(L.chat_len(pg) == 420, 'L6 已打开导入的聊天', f'len={L.chat_len(pg)}')
        with pg.expect_download(timeout=8000) as di:
            pg.evaluate('async (k) => { await ChatAnchor.legacy.exportFile(k.chatKey, k.timestamp); }', key)
        n = sum(1 for l in open(di.value.path(), encoding='utf8') if l.strip()) - 1
        C.ok(n == 420, 'L7 导出文件 420 楼', di.value.suggested_filename)
        warns = [t for ty, t in con.lines if ty == 'warning' and '[小锚]' in t]
        C.ok(not warns, '小锚全程没有输出过警告', str(warns[:3]))
        b.close()
    return C.done()


if __name__ == '__main__':
    sys.exit(main())
