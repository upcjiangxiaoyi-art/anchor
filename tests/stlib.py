"""
小锚端到端测试的公共部分。

环境变量（run.sh 会设好；单独跑脚本时也可以自己 export）：
  ST_DIR        SillyTavern 根目录                       默认 ~/st
  ST_PORT       酒馆端口                                  默认 8123
  ST_DATA       酒馆 dataRoot                             默认 $ST_DIR/data
  ST_USER       用户目录名                                默认 default-user
  CHROMIUM_PATH Chromium 可执行文件；不设就用 Playwright 自带的
  HEADED=1      开窗口跑（本地调试用）
"""
import json
import os
import shutil
import sys
import time
import uuid
from pathlib import Path

ST_DIR = Path(os.environ.get('ST_DIR') or (Path.home() / 'st')).expanduser().resolve()
ST_PORT = int(os.environ.get('ST_PORT', '8123'))
ST_DATA = Path(os.environ.get('ST_DATA') or (ST_DIR / 'data')).expanduser().resolve()
ST_USER = os.environ.get('ST_USER', 'default-user')
BASE = f'http://127.0.0.1:{ST_PORT}'
_default_chromium = '/opt/pw-browsers/chromium'
CHROMIUM = os.environ.get('CHROMIUM_PATH') or (_default_chromium if os.path.exists(_default_chromium) else None)
HEADED = os.environ.get('HEADED') == '1'

EXT_ID = 'third-party/st-chat-anchor'
CHAR_NAME = 'Seraphina'
CHAR_AVATAR = 'default_Seraphina.png'
USER_DIR = ST_DATA / ST_USER
CHATS_DIR = USER_DIR / 'chats' / 'default_Seraphina'
GROUP_CHATS_DIR = USER_DIR / 'group chats'
SETTINGS = USER_DIR / 'settings.json'
BACKUPS_DIR = USER_DIR / 'backups'
CHARS_DIR = USER_DIR / 'characters'

IPHONE = dict(
    viewport={'width': 390, 'height': 844},
    device_scale_factor=3,
    is_mobile=True,
    has_touch=True,
    user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    locale='zh-CN',
)


# ───────────────────────── 检查项计数 ─────────────────────────
class Checks:
    def __init__(self, title):
        self.title = title
        self.n = 0
        self.fails = []
        print(f'\n===== {title} =====', flush=True)

    def ok(self, cond, label, detail=''):
        self.n += 1
        cond = bool(cond)
        mark = 'PASS' if cond else 'FAIL'
        extra = f'   <- {detail}' if (detail and not cond) else ''
        print(f'[{mark}] {self.n:02d} {label}{extra}', flush=True)
        if not cond:
            self.fails.append(label)
        return cond

    def section(self, name):
        print(f'\n--- {name} ---', flush=True)

    def done(self):
        passed = self.n - len(self.fails)
        print(f'\n{self.title}: {passed}/{self.n} 项通过', flush=True)
        for f in self.fails:
            print(f'  失败: {f}', flush=True)
        return 0 if not self.fails else 1


# ───────────────────────── 酒馆进程 / 设置 ─────────────────────────
def st_is_up():
    import urllib.request
    try:
        with urllib.request.urlopen(BASE + '/', timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def require_st():
    if not st_is_up():
        sys.exit(f'酒馆没有在 {BASE} 上响应。先用 tests/run.sh 启动，或自己启动后再跑。')
    if not SETTINGS.exists():
        sys.exit(f'找不到 {SETTINGS}，ST_DATA / ST_USER 设对了吗？')


def patch_settings(first_run=False, ext_enabled=True):
    """改磁盘上的 settings.json：跳过首次向导；决定小锚是否启用。酒馆每次都从磁盘读，不用重启。"""
    s = json.loads(SETTINGS.read_text('utf-8'))
    s['firstRun'] = first_run
    es = s.setdefault('extension_settings', {})
    dis = [x for x in es.get('disabledExtensions', []) if x != EXT_ID]
    if not ext_enabled:
        dis.append(EXT_ID)
    es['disabledExtensions'] = dis
    SETTINGS.write_text(json.dumps(s, ensure_ascii=False), 'utf-8')


def clear_char_chats():
    """每次测试前清掉 Seraphina 的所有聊天文件（和交接信里的做法一致）。"""
    if CHATS_DIR.exists():
        shutil.rmtree(CHATS_DIR)
    CHATS_DIR.mkdir(parents=True, exist_ok=True)


# ───────────────────────── 聊天文件 ─────────────────────────
def stamp(ts=None):
    t = time.localtime(ts)
    return f'{t.tm_year}-{t.tm_mon}-{t.tm_mday} @{t.tm_hour:02d}h {t.tm_min:02d}m {t.tm_sec:02d}s 000ms'


def make_msg(i, user_name='User', char_name=CHAR_NAME, text=None, swipes=0, words=60):
    is_user = i % 2 == 1
    body = text if text is not None else (f'第 {i} 楼 ' + ' '.join(f'w{i}_{k}' for k in range(words)))
    m = {
        'name': user_name if is_user else char_name,
        'is_user': is_user,
        'is_system': False,
        'send_date': stamp(),
        'mes': body,
        'extra': {},
    }
    if not is_user and swipes > 0:
        m['swipe_id'] = 0
        m['swipes'] = [body] + [f'{body} (swipe {k})' for k in range(1, swipes + 1)]
        m['swipe_info'] = [{'send_date': m['send_date'], 'gen_started': None, 'gen_finished': None, 'extra': {}} for _ in m['swipes']]
    return m


def chat_header(meta=None, user_name='User', char_name=CHAR_NAME):
    return {'user_name': user_name, 'character_name': char_name, 'create_date': stamp(), 'chat_metadata': meta or {}}


def write_chat(name, n, meta=None, swipes=0, words=60, msgs=None):
    """往 Seraphina 的聊天目录写一个 n 楼的 .jsonl（第 0 楼是开场白位置，这里统一用生成的内容）。"""
    CHATS_DIR.mkdir(parents=True, exist_ok=True)
    rows = [chat_header(meta)] + (msgs if msgs is not None else [make_msg(i, swipes=swipes, words=words) for i in range(n)])
    path = CHATS_DIR / f'{name}.jsonl'
    path.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n', 'utf-8')
    return path


def read_chat(name, directory=None):
    path = (directory or CHATS_DIR) / f'{name}.jsonl'
    if not path.exists():
        return None
    rows = []
    for line in path.read_text('utf-8').splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def floors(name, directory=None):
    rows = read_chat(name, directory)
    return None if rows is None else max(0, len(rows) - 1)


def chat_files():
    return sorted(p.stem for p in CHATS_DIR.glob('*.jsonl')) if CHATS_DIR.exists() else []


# ───────────────────────── 浏览器 ─────────────────────────
def launch(p, mobile=True):
    kwargs = {'headless': not HEADED}
    if CHROMIUM:
        kwargs['executable_path'] = CHROMIUM
    browser = p.chromium.launch(**kwargs)
    context = browser.new_context(**(IPHONE if mobile else {'viewport': {'width': 1280, 'height': 800}}))
    context.set_default_timeout(20000)
    return browser, context


class Console:
    """收集控制台输出和页面错误，顺便记下 4xx/5xx 的响应。"""

    def __init__(self, page):
        self.lines = []
        self.errors = []
        self.bad = []
        page.on('console', lambda m: self.lines.append((m.type, m.text)))
        page.on('pageerror', lambda e: self.errors.append(str(e)))
        page.on('response', lambda r: self.bad.append((r.status, r.url)) if r.status >= 400 else None)

    def find(self, needle):
        return [t for _, t in self.lines if needle in t]

    def anchor(self):
        return self.find('[小锚]')


def goto_app(page, ext=True, timeout=90000):
    page.goto(BASE + '/', wait_until='load')
    page.wait_for_function('() => window.SillyTavern?.getContext && document.getElementById("send_textarea")', timeout=timeout)
    page.wait_for_function('() => SillyTavern.getContext().characters.length > 0', timeout=timeout)
    if ext:
        page.wait_for_function('() => window.ChatAnchor && document.getElementById("ca_wand")', timeout=timeout)
    else:
        page.wait_for_timeout(1500)


def ev(page, body, arg=None):
    """在页面里跑一段 async 代码，ctx 已经取好。"""
    return page.evaluate('async (arg) => { const ctx = SillyTavern.getContext(); ' + body + ' }', arg)


def wait_js(page, expr, timeout=20000, arg=None):
    page.wait_for_function('(arg) => { const ctx = SillyTavern.getContext(); return (' + expr + '); }', arg=arg, timeout=timeout)


def char_index(page):
    return ev(page, 'return ctx.characters.findIndex(c => c.avatar === arg);', CHAR_AVATAR)


def select_char(page):
    idx = char_index(page)
    assert idx >= 0, '找不到 Seraphina'
    ev(page, 'await ctx.selectCharacterById(arg);', idx)
    wait_js(page, 'String(ctx.characterId) === String(arg) && ctx.chat.length > 0', arg=idx)
    return idx


def open_chat(page, name):
    ev(page, 'await ctx.openCharacterChat(arg);', name)
    wait_js(page, 'ctx.chatId === arg', arg=name)


def chat_len(page):
    return ev(page, 'return ctx.chat.length;')


def chat_id(page):
    return ev(page, 'return ctx.chatId;')


def snaps(page, key=None):
    return page.evaluate('async (k) => (await ChatAnchor.list(k)).map(s => ({id: s.id, ts: s.ts, count: s.count, reason: s.reason, locked: s.locked, lockReason: s.lockReason, sig: s.sig, size: s.size}))', key)


def wait_snaps(page, pred, timeout=15.0, key=None):
    t0 = time.time()
    last = []
    while time.time() - t0 < timeout:
        last = snaps(page, key)
        if pred(last):
            return last
        time.sleep(0.25)
    return last


def ca_log(page):
    return page.evaluate('async () => (await ChatAnchor.log()).map(r => ({ts: r.ts, type: r.type, msg: r.msg}))')


def ca_stats(page):
    return page.evaluate('async () => await ChatAnchor.stats()')


def current_key(page):
    return page.evaluate('() => { const c = SillyTavern.getContext(); const ch = c.characters[c.characterId]; return c.groupId ? null : (ch ? `c|${ch.avatar}|${ch.chat}` : null); }')


def poison(page, key):
    return page.evaluate('(k) => { const p = ChatAnchor.state.poison.get(k); return p ? {at: p.at, confirmed: p.confirmed, okSeen: p.okSeen, released: p.released, detail: p.detail} : null; }', key)


def dialog_text(page):
    return page.evaluate('() => [...document.querySelectorAll("dialog[open]")].map(d => d.innerText).join("\\n---\\n")')


def click_dialog_button(page, text):
    page.locator('dialog[open] .popup-button-ok, dialog[open] .popup-button-cancel, dialog[open] .popup-button-custom, dialog[open] .menu_button').filter(has_text=text).first.click()


# ───────────────────────── 故障注入 ─────────────────────────
class Fault:
    """让匹配的请求失败：mode='abort' 模拟断网，mode=502 等数字返回该状态码。times 限定只坏前几次。
    注意：回调里不能 sleep，同步 API 会把整个事件循环卡住；要模拟慢服务器用 slow_fetch()。"""

    def __init__(self, page, url_glob, mode='abort', times=None, body=None):
        self.page = page
        self.url_glob = url_glob
        self.mode = mode
        self.times = times
        self.body = body
        self.hits = 0
        self.passed = 0
        self.bodies = []
        page.route(url_glob, self._handle)

    def _handle(self, route, request):
        if self.times is not None and self.hits >= self.times:
            self.passed += 1
            self.bodies.append(request.post_data)
            return route.continue_()
        self.hits += 1
        if self.mode == 'abort':
            return route.abort('connectionfailed')
        status = int(self.mode)
        return route.fulfill(status=status, content_type='text/html', body=self.body or f'<html><body><h1>{status}</h1></body></html>')

    def remove(self):
        try:
            self.page.unroute(self.url_glob, self._handle)
        except Exception:
            pass


class Spy:
    """只记录不拦截：数一数某个接口被请求了几次，存下请求体。"""

    def __init__(self, page, url_glob):
        self.page = page
        self.url_glob = url_glob
        self.calls = []
        page.route(url_glob, self._handle)

    def _handle(self, route, request):
        self.calls.append({'t': time.time(), 'headers': request.headers, 'body': request.post_data, 'len': len(request.post_data_buffer or b'')})
        route.continue_()

    def remove(self):
        try:
            self.page.unroute(self.url_glob, self._handle)
        except Exception:
            pass


# ───────────────────────── 群聊文件 ─────────────────────────
GROUP_NAME = '小锚测试群'
MEMBER2_NAME = 'Bob'


def group_msg(i, names=('User', CHAR_NAME, MEMBER2_NAME), words=60):
    who = names[i % len(names)]
    return {
        'name': who,
        'is_user': who == 'User',
        'is_system': False,
        'send_date': stamp(),
        'mes': f'第 {i} 楼 ' + ' '.join(f'g{i}_{k}' for k in range(words)),
        'extra': {},
    }


def write_group_chat(chat_id, n, meta=None, msgs=None):
    GROUP_CHATS_DIR.mkdir(parents=True, exist_ok=True)
    header = {'chat_metadata': meta or {}, 'user_name': 'unused', 'character_name': 'unused'}
    rows = [header] + (msgs if msgs is not None else [group_msg(i) for i in range(n)])
    path = GROUP_CHATS_DIR / f'{chat_id}.jsonl'
    path.write_text('\n'.join(json.dumps(r, ensure_ascii=False) for r in rows) + '\n', 'utf-8')
    return path


def group_floors(chat_id):
    return floors(chat_id, GROUP_CHATS_DIR)


def read_group_chat(chat_id):
    return read_chat(chat_id, GROUP_CHATS_DIR)


def group_file_on_disk(gid):
    p = USER_DIR / 'groups' / f'{gid}.json'
    return json.loads(p.read_text('utf-8')) if p.exists() else None


def ensure_member2(page):
    """没有 Bob 就建一个（有开场白）。返回头像文件名。"""
    av = ev(page, 'return ctx.characters.find(c => c.name === arg)?.avatar || null;', MEMBER2_NAME)
    if av:
        return av
    av = ev(page, '''const fd = new FormData();
        fd.set('ch_name', arg); fd.set('first_mes', '我是 ' + arg + '，这是我的开场白。'); fd.set('description', '测试用'); fd.set('fav', 'false');
        const h = { ...ctx.getRequestHeaders() }; delete h['Content-Type'];
        const r = await fetch('/api/characters/create', { method: 'POST', headers: h, body: fd });
        if (!r.ok) throw new Error('create char ' + r.status);
        return await r.text();''', MEMBER2_NAME)
    return av


def ensure_group(page, chat_id):
    """没有测试群就建一个（成员：Seraphina + Bob），当前聊天指向 chat_id。返回群 id。"""
    g = ev(page, 'return ctx.groups.find(g => g.name === arg) || null;', GROUP_NAME)
    if g:
        return g['id']
    av2 = ensure_member2(page)
    g = ev(page, '''const r = await fetch('/api/groups/create', { method: 'POST', headers: ctx.getRequestHeaders(), body: JSON.stringify({
            name: arg.name, members: arg.members, avatar_url: '', allow_self_responses: false, activation_strategy: 0, generation_mode: 0,
            disabled_members: [], chat_metadata: {}, fav: false, chat_id: arg.chat_id, chats: [arg.chat_id] }) });
        if (!r.ok) throw new Error('create group ' + r.status);
        return await r.json();''', {'name': GROUP_NAME, 'members': [CHAR_AVATAR, av2], 'chat_id': chat_id})
    return g['id']


def open_group(page, gid):
    """像用户一样点角色列表里的群（手机布局下列表是隐藏的，所以用 DOM click 触发委托事件）。"""
    page.evaluate('(gid) => { const el = document.querySelector(`.group_select[data-grid="${gid}"]`); if (!el) throw new Error("列表里没有这个群"); el.click(); }', gid)
    wait_js(page, 'String(ctx.groupId) === String(arg) && ctx.chat.length > 0', arg=gid)


def group_current_key(page):
    return page.evaluate('() => { const c = SillyTavern.getContext(); const g = c.groups.find(x => x.id == c.groupId); return g ? "g|" + g.chat_id : null; }')


def clear_backups():
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    for f in BACKUPS_DIR.glob('chat_*.jsonl'):
        f.unlink()


def backup_files():
    return sorted(p.name for p in BACKUPS_DIR.glob('chat_*.jsonl')) if BACKUPS_DIR.exists() else []


def clone_card(new_name):
    """把 Seraphina 的卡复制一份改名（用来测中文文件名的角色）。返回头像文件名。"""
    src = CHARS_DIR / CHAR_AVATAR
    dst = CHARS_DIR / f'{new_name}.png'
    if not dst.exists():
        shutil.copyfile(src, dst)
    return dst.name


def remove_card(new_name):
    for p in [CHARS_DIR / f'{new_name}.png', USER_DIR / 'chats' / new_name]:
        if p.is_dir():
            shutil.rmtree(p)
        elif p.exists():
            p.unlink()


# ───────────────────────── 慢服务器：在页面里给 fetch 加延迟 ─────────────────────────
_SLOW_JS = """(arg) => {
    if (!window.__caSlow) {
        const orig = window.fetch;
        window.__caSlow = { orig, rules: new Map(), hits: 0 };
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || String(input);
            for (const [sub, delay] of window.__caSlow.rules) {
                if (!url.includes(sub)) continue;
                window.__caSlow.hits++;
                const signal = init && init.signal;
                const self = this, args = arguments;
                return new Promise((resolve, reject) => {
                    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
                    if (signal && signal.aborted) return abort();
                    const t = setTimeout(() => resolve(orig.apply(self, args)), delay);
                    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); abort(); }, { once: true });
                });
            }
            return orig.apply(this, arguments);
        };
    }
    if (arg.delay === null) window.__caSlow.rules.delete(arg.sub); else window.__caSlow.rules.set(arg.sub, arg.delay);
    window.__caSlow.hits = 0;
}"""


def slow_fetch(page, url_substr, delay_ms):
    """让页面里包含 url_substr 的 fetch 先等 delay_ms 再真正发出（会响应 AbortController）。"""
    page.evaluate(_SLOW_JS, {'sub': url_substr, 'delay': delay_ms})


def unslow_fetch(page, url_substr):
    page.evaluate(_SLOW_JS, {'sub': url_substr, 'delay': None})


def slow_hits(page):
    return page.evaluate('() => window.__caSlow ? window.__caSlow.hits : 0')
