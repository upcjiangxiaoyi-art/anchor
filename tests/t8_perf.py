"""
t8_perf.py — 几千楼的聊天：快照、去重、整理、恢复各要多久，主线程卡不卡。

默认 3000 楼，角色楼带 2 个 swipe，每楼约 700 字。`FLOORS=824 WORDS=1500 EXTRA_KB=40` 模拟用户那个 50MB 的聊天。只打印数字，阈值放得很宽（卡主线程 > 200ms 的任务数、首次快照 < 20 秒），
目的是留下基线，不是卡 CI。可用 FLOORS=5000 调大。
"""
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import stlib as L  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

FLOORS = int(os.environ.get('FLOORS', '3000'))
WORDS = int(os.environ.get('WORDS', '110'))        # 每楼多少个词（约 6 字节一个）
EXTRA_KB = int(os.environ.get('EXTRA_KB', '0'))    # 角色楼 extra 里塞多少 KB 文本，模拟图片扩展；824 楼 + 40KB ≈ 用户的 50MB 聊天
NAME = f'perf-{FLOORS}-{WORDS}-{EXTRA_KB}'
OUT = Path(__file__).parent / 'out'
LONGTASK_JS = '''() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true }); } catch {} }'''


def long_tasks(pg, reset=True):
    v = pg.evaluate('() => { const a = (window.__lt || []).slice(); if (arguments[0]) window.__lt = []; return a; }' if False else '() => { const a = (window.__lt || []).slice(); window.__lt = []; return a; }')
    return v


def timed_eval(pg, js, arg=None):
    t0 = time.time()
    r = pg.evaluate(js, arg)
    return r, round((time.time() - t0) * 1000)


def main():
    L.require_st()
    L.patch_settings(first_run=False, ext_enabled=True)
    L.clear_char_chats()
    OUT.mkdir(exist_ok=True)
    C = L.Checks(f'T8 性能（{FLOORS} 楼）')
    path = L.write_chat(NAME, FLOORS, swipes=2, words=WORDS, extra_kb=EXTRA_KB)
    size_mb = path.stat().st_size / 1048576
    print(f'    聊天文件 {size_mb:.1f} MB', flush=True)
    with sync_playwright() as p:
        b, c = L.launch(p)
        pg = c.new_page()
        con = L.Console(pg)
        L.goto_app(pg, ext=True)
        L.select_char(pg)
        pg.evaluate(LONGTASK_JS)

        t0 = time.time()
        L.open_chat(pg, NAME)
        t_open = round((time.time() - t0) * 1000)
        s = L.wait_snaps(pg, lambda s: any(x['count'] == FLOORS for x in s), timeout=60)
        t_first = round((time.time() - t0) * 1000)
        lt_load = long_tasks(pg)
        print(f'    酒馆打开 {FLOORS} 楼：{t_open} ms；小锚首次快照落库（含酒馆渲染）：{t_first} ms；期间 >50ms 的长任务 {len(lt_load)} 个，最长 {max(lt_load or [0])} ms', flush=True)
        C.ok(any(x['count'] == FLOORS for x in s), 'P1 首次快照成功', str(s[:1]))
        C.ok(t_first - t_open < 20000, 'P2 首次快照（全部楼层入库）20 秒内完成', f'{t_first - t_open} ms')

        # 内容没变：只算哈希不写库
        long_tasks(pg)
        _, ms = timed_eval(pg, 'async () => { const t0 = performance.now(); const r = await ChatAnchor.snapshot("auto"); return [r, Math.round(performance.now() - t0)]; }')
        lt = long_tasks(pg)
        print(f'    无变化重算（{FLOORS} 楼逐楼 stringify+hash）：{ms} ms，长任务 {len(lt)} 个，最长 {max(lt or [0])} ms', flush=True)
        C.ok(max(lt or [0]) < 200, 'P3 重算快照不卡主线程（没有 >200ms 的长任务）', f'{lt[:10]}')

        # 改一楼：只写一个新 blob
        long_tasks(pg)
        r, ms = timed_eval(pg, 'async () => { const ctx = SillyTavern.getContext(); ctx.chat[ctx.chat.length - 1].mes += " 改了一下"; const t0 = performance.now(); const r = await ChatAnchor.snapshot("auto"); return [!!r, Math.round(performance.now() - t0)]; }')
        lt = long_tasks(pg)
        st = L.ca_stats(pg)
        print(f'    改 1 楼后快照：{r[1]} ms（含整理旧快照），blob 总数 {st["blobs"]}，长任务 {len(lt)} 个，最长 {max(lt or [0])} ms', flush=True)
        C.ok(r[0] and st['blobs'] <= FLOORS + 3, 'P4 改一楼只新增一个 blob（跨快照去重）', str(st))

        # 连续 15 次编辑 → 15 份快照，看库增长和整理耗时
        long_tasks(pg)
        t0 = time.time()
        pg.evaluate('''async () => { const ctx = SillyTavern.getContext(); for (let i = 0; i < 15; i++) { ctx.chat[ctx.chat.length - 1 - i].mes += " x"; await ChatAnchor.snapshot("auto"); } }''')
        t_15 = round((time.time() - t0) * 1000)
        lt = long_tasks(pg)
        st = L.ca_stats(pg)
        est = pg.evaluate('async () => { try { const e = await navigator.storage.estimate(); return Math.round((e.usage || 0) / 1048576 * 10) / 10; } catch { return null; } }')
        print(f'    连续 15 次快照：{t_15} ms（平均 {t_15 // 15} ms/份），现在 {st["snaps"]} 份快照、{st["blobs"]} 个 blob，本站存储约 {est} MB，长任务最长 {max(lt or [0])} ms', flush=True)
        C.ok(st['snaps'] <= 12 + 5 and st['blobs'] <= FLOORS + 40, 'P5 保留规则生效，blob 只多了改过的那些', str(st))

        # 恢复成新聊天 / 覆盖恢复
        snap_id = L.snaps(pg)[0]['id']
        long_tasks(pg)
        t0 = time.time()
        new_name = pg.evaluate('async (id) => await ChatAnchor.restoreAsNew(id)', snap_id)
        t_new = round((time.time() - t0) * 1000)
        lt = long_tasks(pg)
        print(f'    恢复成新聊天（导入 + 打开）：{t_new} ms，长任务最长 {max(lt or [0])} ms', flush=True)
        C.ok(isinstance(new_name, str) and L.floors(new_name) == FLOORS, f'P6 恢复成新聊天 {FLOORS} 楼', f'{new_name} floors={L.floors(new_name)}')
        L.wait_snaps(pg, lambda s: any(x['count'] == FLOORS for x in s), timeout=60)
        snap_id = L.snaps(pg)[0]['id']
        t_read = pg.evaluate('async (id) => { const t0 = performance.now(); await ChatAnchor.loadSnapData(await ChatAnchor.getSnap(id)); return Math.round(performance.now() - t0); }', snap_id)
        t0 = time.time()
        saved = pg.evaluate('async (id) => await ChatAnchor.restoreInPlace(id)', snap_id)
        t_inplace = round((time.time() - t0) * 1000)
        print(f'    覆盖恢复（含恢复前快照、保存、重新读取）：{t_inplace} ms，其中从库里读出全部楼层 {t_read} ms', flush=True)
        C.ok(saved is True and L.floors(new_name) == FLOORS, 'P7 覆盖恢复成功')

        # 面板打开速度
        t0 = time.time()
        pg.evaluate('() => ChatAnchor.open("cur")')
        pg.wait_for_selector('.ca-panel .ca-snap')
        print(f'    面板打开到列表出现：{round((time.time() - t0) * 1000)} ms', flush=True)
        pg.screenshot(path=str(OUT / 't8_perf_panel.png'))
        warns = [t for ty, t in con.lines if ty == 'warning' and '[小锚]' in t]
        C.ok(not warns, '小锚全程没有输出过警告', str(warns[:3]))
        b.close()
    return C.done()


if __name__ == '__main__':
    sys.exit(main())
