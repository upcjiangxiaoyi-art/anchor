/*
 * 小锚（聊天快照）Chat Anchor — SillyTavern 扩展
 *
 * 做三件事：
 *   1. 守门：酒馆读取聊天失败时，会把开场白当成"新聊天"存回去，盖掉原存档。
 *            小锚在读取失败后暂停这个聊天的保存，直到重新读取成功。
 *   2. 快照：直接存内存里的聊天（不是从服务器取回来的），逐楼去重，
 *            所以能留很多份；打开聊天时发现比上次快照少楼，就锁住掉楼前那份并提醒。
 *   3. 补存：保存到服务器失败时记下原因并自动重试。
 *
 * 零依赖：只用 SillyTavern.getContext()，不 import 酒馆内部文件，酒馆改内部结构也不会让它加载失败。
 */

const EXT = 'chat_anchor';
const TAG = '[小锚]';
const DB_NAME = 'ST_ChatAnchor';
const DB_VER = 1;
const HOUR = 3600e3;
const DAY = 86400e3;
const DEFAULTS = Object.freeze({
    enabled: true,    // 自动快照
    guard: true,      // 读取失败时暂停保存
    retrySave: true,  // 保存失败自动重试
    alertDrop: true,  // 掉楼提醒
    recent: 12,       // 最近 N 份无条件保留
    days: 7,          // 之后每天留 1 份，留几天
    maxChats: 30,     // 最多为多少个聊天保留快照
});

const ctx = () => globalThis.SillyTavern.getContext();
const warn = (...a) => console.warn(TAG, ...a);
const tick = () => new Promise(r => setTimeout(r, 0));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[m]));
const toast = (kind, msg, opts = {}) => { try { globalThis.toastr?.[kind]?.(msg, '小锚', opts); } catch { /* 没有 toastr 也不影响功能 */ } };

const S = {
    queue: Promise.resolve(),              // 所有写库操作排队执行
    timer: null,                           // 防抖定时器
    known: { key: null, set: new Set() },  // 当前聊天已入库的楼层哈希
    last: new Map(),                       // key -> { sig, ts }
    poison: new Map(),                     // key -> { at, confirmed, okSeen, released, detail }
    lastSave: new Map(),                   // key -> { ok, at, detail }
    retry: { key: null, n: 0, timer: null, toasted: false },
    popupOpen: false,
    sinceMaint: 0,
    blockToastAt: 0,
    dropToast: null,
    srv: null,                             // 服务器备份列表的缓存 { at, rows }
    srvJob: null,                          // 正在进行的服务器列表读取 { promise, startedAt, controller }
    srvLast: null,                         // 上一次读取的结果 { at, error }
    srvTimeoutMs: 300000,                  // 服务器列表读取超时（5 分钟；有反代的话反代一般 60 秒就先返回 504）
};

function settings() {
    const all = ctx().extensionSettings;
    if (!all[EXT] || typeof all[EXT] !== 'object') all[EXT] = {};
    const s = all[EXT];
    for (const k of Object.keys(DEFAULTS)) if (s[k] === undefined) s[k] = DEFAULTS[k];
    if (!Array.isArray(s.ignore)) s.ignore = []; // 判断"有没有变"时跳过的字段，如 extra.stImageAtelier、meta.variables
    return s;
}

/** 浅拷贝后删掉要忽略的字段。路径支持两级：`mes`、`extra.xxx`；`meta.xxx` 是元数据的键。 */
function stripFields(obj, paths) {
    if (!obj || typeof obj !== 'object') return obj;
    const m = { ...obj };
    for (const p of paths) {
        const [a, b] = String(p).split('.');
        if (b === undefined) delete m[a];
        else if (m[a] && typeof m[a] === 'object') { if (m[a] === obj[a]) m[a] = { ...m[a] }; delete m[a][b]; }
    }
    return m;
}

// ───────────────────────── 哈希（cyrb53 + 长度，只在同一个聊天内比较） ─────────────────────────
function hashOf(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + '.' + str.length.toString(36);
}

// ───────────────────────── IndexedDB ─────────────────────────
let _db = null;
function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const rq = indexedDB.open(DB_NAME, DB_VER);
        rq.onupgradeneeded = () => {
            const db = rq.result;
            if (!db.objectStoreNames.contains('snaps')) db.createObjectStore('snaps', { keyPath: 'id' }).createIndex('chatKey', 'chatKey');
            if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: ['chatKey', 'hash'] }).createIndex('chatKey', 'chatKey');
            if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'chatKey' });
            if (!db.objectStoreNames.contains('log')) db.createObjectStore('log', { autoIncrement: true });
        };
        rq.onsuccess = () => {
            _db = rq.result;
            _db.onversionchange = () => { try { _db?.close(); } catch { /* 已关闭 */ } _db = null; };
            _db.onclose = () => { _db = null; };
            resolve(_db);
        };
        rq.onerror = () => reject(rq.error);
        rq.onblocked = () => reject(new Error('IndexedDB 被占用'));
    });
}

/** 开一个事务，fn 里同步发请求，事务提交后返回 fn 的返回值（通常是个装结果的对象）。 */
async function tx(stores, mode, fn) {
    for (let attempt = 0; ; attempt++) {
        const db = await openDB();
        try {
            return await new Promise((resolve, reject) => {
                const t = db.transaction(stores, mode);
                let out;
                t.oncomplete = () => resolve(out);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error || new Error('事务中止'));
                out = fn(t);
            });
        } catch (e) {
            if (attempt === 0 && e?.name === 'InvalidStateError') { _db = null; continue; }
            throw e;
        }
    }
}
const dbGet = (store, key) => tx([store], 'readonly', t => { const o = {}; t.objectStore(store).get(key).onsuccess = e => { o.v = e.target.result; }; return o; }).then(o => o.v);
const dbPut = (store, val) => tx([store], 'readwrite', t => { t.objectStore(store).put(val); });
const dbAll = store => tx([store], 'readonly', t => { const o = { v: [] }; t.objectStore(store).getAll().onsuccess = e => { o.v = e.target.result; }; return o; }).then(o => o.v);
const snapsOf = key => tx(['snaps'], 'readonly', t => { const o = { v: [] }; t.objectStore('snaps').index('chatKey').getAll(key).onsuccess = e => { o.v = e.target.result; }; return o; }).then(o => o.v.sort((a, b) => b.ts - a.ts));
const blobKeysOf = key => tx(['blobs'], 'readonly', t => { const o = { v: [] }; t.objectStore('blobs').index('chatKey').getAllKeys(key).onsuccess = e => { o.v = e.target.result; }; return o; }).then(o => o.v);
function deleteByChat(store, key) {
    const rq = store.index('chatKey').openKeyCursor(IDBKeyRange.only(key));
    rq.onsuccess = () => { const cur = rq.result; if (cur) { store.delete(cur.primaryKey); cur.continue(); } };
}

function logEvent(type, msg) {
    console.log(TAG, type, msg);
    tx(['log'], 'readwrite', t => { t.objectStore('log').add({ ts: Date.now(), type, msg: String(msg).slice(0, 600) }); }).catch(() => { });
}

function enqueue(fn) {
    const p = S.queue.then(() => fn());
    S.queue = p.catch(e => warn(e));
    return p;
}

// ───────────────────────── 当前聊天是谁 ─────────────────────────
function currentChat() {
    const c = ctx();
    if (c.groupId) {
        const g = c.groups?.find(x => x.id == c.groupId);
        if (!g?.chat_id) return null;
        return { key: 'g|' + g.chat_id, kind: 'g', groupId: String(g.id), chatName: String(g.chat_id), owner: g.name || '群聊' };
    }
    if (c.characterId !== undefined && c.characterId !== null) {
        const ch = c.characters?.[c.characterId];
        if (!ch?.chat || !ch?.avatar) return null;
        return { key: 'c|' + ch.avatar + '|' + ch.chat, kind: 'c', avatar: ch.avatar, chatName: String(ch.chat), owner: ch.name };
    }
    return null;
}

// ───────────────────────── 快照 ─────────────────────────
function previewOf(msg) {
    const text = String(msg?.mes ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { name: String(msg?.name ?? ''), text: text.slice(0, 140) };
}

async function ensureChatState(key) {
    if (S.known.key !== key) {
        const keys = await blobKeysOf(key);
        S.known = { key, set: new Set(keys.map(k => k[1])) };
    }
    if (!S.last.has(key)) {
        const latest = (await snapsOf(key))[0];
        S.last.set(key, latest ? { sig: latest.sig, ts: latest.ts } : { sig: null, ts: 0 });
    }
}

/**
 * 给当前聊天存一份快照。内容没变时跳过（除非 force）。
 * @returns {Promise<object|null>} 新快照记录；跳过或无聊天时为 null
 */
function takeSnapshot(reason = 'auto', opts = {}) {
    return enqueue(() => doSnapshot(reason, opts));
}

async function doSnapshot(reason, { force = false, lock = false } = {}) {
    const info = currentChat();
    if (!info) return null;
    const c = ctx();
    const msgs = c.chat.slice();
    if (!msgs.length) return null;
    const p = S.poison.get(info.key);
    if (p && !p.okSeen && !p.released && (p.confirmed || msgs.length <= 1)) return null; // 没读出来的聊天不存快照

    const metaJson = JSON.stringify(c.chatMetadata ?? {});
    const ignore = settings().ignore.filter(Boolean);
    const ignoreMsg = ignore.filter(x => !x.startsWith('meta.'));
    const ignoreMeta = ignore.filter(x => x.startsWith('meta.')).map(x => x.slice(5));
    const hashes = new Array(msgs.length);
    const sigs = new Array(msgs.length); // 判断"有没有变"用：跳过忽略字段。blob 的哈希仍按完整内容算
    const jsons = new Array(msgs.length);
    let total = 0;
    let t0 = performance.now();
    for (let i = 0; i < msgs.length; i++) {
        const j = JSON.stringify(msgs[i]) ?? 'null';
        jsons[i] = j;
        hashes[i] = hashOf(j);
        sigs[i] = ignoreMsg.length ? hashOf(JSON.stringify(stripFields(msgs[i], ignoreMsg)) ?? 'null') : hashes[i];
        total += j.length;
        if (performance.now() - t0 > 10) { // 分片，不卡界面
            await tick();
            if (currentChat()?.key !== info.key) return null;
            t0 = performance.now();
        }
    }
    const metaHash = 'M' + hashOf(metaJson);
    const metaSig = ignoreMeta.length ? 'M' + hashOf(JSON.stringify(stripFields(c.chatMetadata ?? {}, ignoreMeta))) : metaHash;
    const sig = hashOf(sigs.join(',') + '|' + metaSig);

    await ensureChatState(info.key);
    const last = S.last.get(info.key);
    if (!force && last.sig === sig) return null;

    const known = S.known.set;
    const fresh = new Map();
    for (let i = 0; i < hashes.length; i++) if (!known.has(hashes[i])) fresh.set(hashes[i], jsons[i]);
    if (!known.has(metaHash)) fresh.set(metaHash, metaJson);

    const ts = Math.max(Date.now(), last.ts + 1);
    const pv = previewOf(msgs[msgs.length - 1]);
    const snap = {
        id: info.key + '#' + ts, chatKey: info.key, ts, count: msgs.length, hashes, meta: metaHash, sig,
        name: pv.name, preview: pv.text, reason, locked: !!lock, lockReason: lock ? reason : '', size: total,
    };
    const prev = await dbGet('chats', info.key);
    await tx(['blobs', 'snaps', 'chats'], 'readwrite', t => {
        const b = t.objectStore('blobs');
        for (const [hash, json] of fresh) b.put({ chatKey: info.key, hash, json });
        t.objectStore('snaps').put(snap);
        t.objectStore('chats').put({
            ...(prev || {}), chatKey: info.key, kind: info.kind, avatar: info.avatar || '', groupId: info.groupId || '',
            owner: info.owner, chatName: info.chatName, lastTs: ts, lastCount: msgs.length,
        });
    });
    for (const h of fresh.keys()) known.add(h);
    S.last.set(info.key, { sig, ts });

    try { await prune(info.key); } catch (e) { warn('整理旧快照失败', e); }
    if (++S.sinceMaint >= 25) { S.sinceMaint = 0; maintenance().catch(warn); }
    refreshPanel();
    return snap;
}

/** 决定留哪些：锁定的 + 最近 N 份 + 24 小时内每小时 1 份 + N 天内每天 1 份。 */
function chooseKeep(snaps, st, now) {
    const keep = new Set();
    let autoLocks = 0;
    for (const s of snaps) {
        if (!s.locked) continue;
        if (s.lockReason === 'manual') keep.add(s.id);
        else if (autoLocks++ < 8) keep.add(s.id); // 自动锁定的最多护住最新 8 份
    }
    snaps.slice(0, Math.max(1, st.recent)).forEach(s => keep.add(s.id));
    const hours = new Set(), days = new Set();
    for (const s of snaps) {
        const age = now - s.ts;
        if (age <= DAY) { const h = Math.floor(s.ts / HOUR); if (!hours.has(h)) { hours.add(h); keep.add(s.id); } }
        if (age <= st.days * DAY) { const d = new Date(s.ts).toDateString(); if (!days.has(d)) { days.add(d); keep.add(s.id); } }
    }
    return keep;
}

/** 删掉超出保留规则的快照，并回收没有快照再引用的楼层。只能在队列里调用。 */
async function prune(key, forceGc = false) {
    const snaps = await snapsOf(key);
    const keep = chooseKeep(snaps, settings(), Date.now());
    const drop = snaps.filter(s => !keep.has(s.id));
    if (!drop.length && !forceGc) return 0;
    const live = new Set();
    for (const s of snaps) if (keep.has(s.id)) { live.add(s.meta); for (const h of s.hashes) live.add(h); }
    const dead = (await blobKeysOf(key)).filter(k => !live.has(k[1]));
    await tx(['snaps', 'blobs'], 'readwrite', t => {
        const a = t.objectStore('snaps'), b = t.objectStore('blobs');
        for (const s of drop) a.delete(s.id);
        for (const k of dead) b.delete(k);
    });
    if (S.known.key === key) for (const k of dead) S.known.set.delete(k[1]);
    return drop.length;
}

async function deleteChatData(key) {
    await tx(['snaps', 'blobs', 'chats'], 'readwrite', t => {
        deleteByChat(t.objectStore('snaps'), key);
        deleteByChat(t.objectStore('blobs'), key);
        t.objectStore('chats').delete(key);
    });
    if (S.known.key === key) S.known = { key: null, set: new Set() };
    S.last.delete(key);
}

/** 聊天数超过上限时，淘汰最久没动过的（当前聊天、30 天内有锁定快照的除外）；顺便裁剪记录。 */
function maintenance() {
    return enqueue(async () => {
        const st = settings();
        const chats = (await dbAll('chats')).sort((a, b) => a.lastTs - b.lastTs);
        const curKey = currentChat()?.key;
        let extra = chats.length - Math.max(1, st.maxChats);
        for (const rec of chats) {
            if (extra <= 0) break;
            if (rec.chatKey === curKey) continue;
            const snaps = await snapsOf(rec.chatKey);
            if (snaps.some(s => s.locked && Date.now() - s.ts < 30 * DAY)) continue;
            await deleteChatData(rec.chatKey);
            extra--;
        }
        await tx(['log'], 'readwrite', t => {
            const store = t.objectStore('log');
            store.count().onsuccess = e => {
                let over = e.target.result - 300;
                if (over <= 0) return;
                store.openKeyCursor().onsuccess = ev => { const cur = ev.target.result; if (cur && over-- > 0) { store.delete(cur.primaryKey); cur.continue(); } };
            };
        });
    });
}

function schedule(delay = 1200) {
    if (!settings().enabled) return;
    clearTimeout(S.timer);
    S.timer = setTimeout(() => { S.timer = null; takeSnapshot('auto').catch(warn); }, delay);
}

// ───────────────────────── 打开聊天时：守门结果 + 掉楼检查 ─────────────────────────
async function onChatChanged() {
    clearTimeout(S.timer); S.timer = null;
    const info = currentChat();
    const count = ctx().chat.length; // 先同步记下楼数，后面都是异步
    for (const k of [...S.poison.keys()]) if (!info || k !== info.key) S.poison.delete(k);
    if (!info) return;

    const p = S.poison.get(info.key);
    if (p && !p.released) {
        if (p.okSeen) {
            S.poison.delete(info.key);
        } else if (Date.now() - p.at < 20000 || p.confirmed) {
            p.confirmed = true;
            logEvent('读取失败', `「${info.chatName}」没读出来（${p.detail}），已暂停保存，存档未被覆盖`);
            showLoadFailed(info, p);
            return;
        } else {
            S.poison.delete(info.key);
        }
    }
    if (!settings().enabled) return;

    const rec = await dbGet('chats', info.key);
    if (currentChat()?.key !== info.key) return;
    if (rec && count < rec.lastCount) {
        const latest = (await snapsOf(info.key))[0];
        if (latest && latest.count > count) {
            await enqueue(async () => {
                const fresh = await dbGet('snaps', latest.id);
                if (fresh && !fresh.locked) await dbPut('snaps', { ...fresh, locked: true, lockReason: 'drop' });
                await dbPut('chats', { ...rec, alert: { from: latest.count, to: count, snapId: latest.id, ts: Date.now() } });
            });
            logEvent('掉楼', `「${info.chatName}」上次快照 ${latest.count} 楼，这次打开只有 ${count} 楼，已锁定掉楼前的快照`);
            if (settings().alertDrop) {
                clearDropToast();
                S.dropToast = globalThis.toastr?.warning?.(`「${info.chatName}」少了 ${latest.count - count} 楼（${latest.count} → ${count}）。掉楼前的快照已锁定，点这里恢复。`, '小锚',
                    { timeOut: 0, extendedTimeOut: 0, closeButton: true, onclick: () => openPanel('cur') });
            }
        }
    }
    if (count > 0) await takeSnapshot('load');
}

function clearDropToast() {
    try { if (S.dropToast) globalThis.toastr?.clear?.(S.dropToast); } catch { /* 已经消失 */ }
    S.dropToast = null;
}

function showLoadFailed(info, p) {
    if (S.popupOpen) return;
    S.popupOpen = true;
    (async () => {
        const c = ctx();
        const html = `<div class="ca-dialog">
            <h3>这个聊天没有读取成功</h3>
            <p>读取「${esc(info.chatName)}」时连接失败${p.detail ? `（${esc(p.detail)}）` : ''}。屏幕上现在是空的或只剩开场白，服务器上的存档没有被改动。</p>
            <p>为了不让开场白盖掉存档，小锚已暂停保存这个聊天。重新读取成功后会自动恢复正常。</p>
        </div>`;
        const res = await c.callGenericPopup(html, c.POPUP_TYPE.TEXT, '', {
            okButton: '重新读取', cancelButton: '稍后再说',
            customButtons: [{ text: '解除暂停', result: 2, tooltip: '放行保存：屏幕上的内容会覆盖服务器存档' }],
        });
        S.popupOpen = false;
        if (res === c.POPUP_RESULT.AFFIRMATIVE) {
            await ctx().reloadCurrentChat();
        } else if (res === 2) {
            const sure = await c.Popup.show.confirm('确定解除暂停？', '解除后，屏幕上的内容（很可能只有开场白）会覆盖服务器上的存档。');
            if (sure === c.POPUP_RESULT.AFFIRMATIVE) { p.released = true; logEvent('守门', `用户手动解除了「${info.chatName}」的保存暂停`); }
        }
    })().catch(e => { S.popupOpen = false; warn(e); });
}

// ───────────────────────── fetch 守门 ─────────────────────────
function classify(input, init) {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : null);
    if (!url) return null;
    const path = url.split('?')[0];
    let op, kind;
    if (path.endsWith('/api/chats/get')) { op = 'load'; kind = 'c'; }
    else if (path.endsWith('/api/chats/group/get')) { op = 'load'; kind = 'g'; }
    else if (path.endsWith('/api/chats/save')) { op = 'save'; kind = 'c'; }
    else if (path.endsWith('/api/chats/group/save')) { op = 'save'; kind = 'g'; }
    else return null;

    const body = init?.body;
    if (op === 'load') {
        if (typeof body !== 'string') return null;
        const b = JSON.parse(body);
        const key = kind === 'c' ? (b.avatar_url && b.file_name ? `c|${b.avatar_url}|${b.file_name}` : null) : (b.id ? `g|${b.id}` : null);
        return key ? { op, kind, key } : null;
    }
    let key = null;
    if (typeof body === 'string') { // 只看开头和结尾，不解析整个几 MB 的请求体
        if (kind === 'g') {
            const m = /^\{"id":("(?:[^"\\]|\\.)*")/.exec(body.slice(0, 800));
            if (m) key = 'g|' + JSON.parse(m[1]);
        } else {
            const m1 = /"file_name":("(?:[^"\\]|\\.)*")/.exec(body.slice(0, 3000));
            const m2 = /"avatar_url":("(?:[^"\\]|\\.)*")(?:,"force":(?:true|false))?\}$/.exec(body.slice(-800));
            if (m1 && m2) key = `c|${JSON.parse(m2[1])}|${JSON.parse(m1[1])}`;
        }
    }
    const cur = currentChat()?.key || null;
    return { op, kind, key: key || cur, cur };
}

function shouldBlock(info) {
    if (!settings().guard || !info.key) return false;
    const p = S.poison.get(info.key);
    if (!p || p.okSeen || p.released) return false;
    if (p.confirmed) return true;
    if (Date.now() - p.at > 20000) { S.poison.delete(info.key); return false; }
    // 还没确认是酒馆自己读取失败：只拦"刚被清空、只剩开场白"的状态，避免误伤正常保存
    if (info.key !== info.cur) return false;
    const chat = ctx().chat;
    return chat.length <= 1 || (info.kind === 'g' && chat.length <= 20 && chat.every(m => !m?.is_user));
}

function onLoadSettled(info, ok, detail) {
    const p = S.poison.get(info.key);
    if (ok) { if (p) p.okSeen = true; return; }
    const entry = { at: Date.now(), confirmed: false, okSeen: false, released: false, detail: String(detail) };
    S.poison.set(info.key, entry);
    // 群聊读取遇到网络错误时，酒馆会直接抛异常：不保存、不发"聊天已切换"、屏幕留空。
    // 这时用户再发一句话就会把空聊天存回去盖掉原文件，所以 1 秒后看到当前聊天是空的，就当作读取失败处理。
    // 别的插件读取失败不会把屏幕清空，不会误伤。
    setTimeout(() => {
        if (S.poison.get(info.key) !== entry || entry.confirmed || entry.okSeen || entry.released) return;
        const cur = currentChat();
        if (cur?.key !== info.key || ctx().chat.length !== 0) return;
        entry.confirmed = true;
        logEvent('读取失败', `「${cur.chatName}」没读出来（${entry.detail}），屏幕是空的，已暂停保存，存档未被覆盖`);
        showLoadFailed(cur, entry);
    }, 1000);
    // 20 秒内没有等到酒馆的"聊天已切换"，说明不是酒馆自己在读取（比如别的插件），标记作废
    setTimeout(() => { if (S.poison.get(info.key) === entry && !entry.confirmed) S.poison.delete(info.key); }, 20000);
}

/** 记录里显示聊天文件名，不显示内部键 */
const nameOf = key => String(key || '').split('|').pop() || '未知聊天';

function onBlocked(info) {
    logEvent('守门', `拦下一次保存：「${nameOf(info.key)}」还没读取成功`);
    if (Date.now() - S.blockToastAt > 8000) {
        S.blockToastAt = Date.now();
        toast('warning', '聊天还没读取成功，这次保存已拦下，服务器上的存档没有被覆盖。');
    }
}

function onSaveSettled(info, resp, err) {
    const key = info.key;
    if (resp?.ok) {
        S.lastSave.set(key, { ok: true, at: Date.now() });
        if (S.retry.key === key && S.retry.n > 0) {
            logEvent('补存', `「${nameOf(key)}」补存成功`);
            if (S.retry.toasted) toast('success', '刚才没存上的内容已经补存到服务器。');
        }
        if (S.retry.key === key) { clearTimeout(S.retry.timer); S.retry = { key: null, n: 0, timer: null, toasted: false }; }
        return;
    }
    const finish = detail => {
        S.lastSave.set(key, { ok: false, at: Date.now(), detail });
        if (/"integrity"/.test(detail)) { logEvent('保存失败', `「${nameOf(key)}」完整性校验未通过（酒馆会自己弹窗处理）`); return; }
        logEvent('保存失败', `「${nameOf(key)}」${detail}`);
        if (key && key === currentChat()?.key) {
            takeSnapshot('auto').catch(warn); // 确保没存上的内容至少在本地有一份
            scheduleRetry(key, detail);
        }
    };
    if (resp) resp.clone().text().then(t => finish(`HTTP ${resp.status} ${t.slice(0, 200)}`), () => finish(`HTTP ${resp.status}`));
    else finish(`网络错误 ${err?.message || err}`);
}

function scheduleRetry(key, detail) {
    if (!settings().retrySave) return;
    if (S.retry.key !== key) { clearTimeout(S.retry.timer); S.retry = { key, n: 0, timer: null, toasted: false }; }
    const r = S.retry;
    if (!r.toasted) { r.toasted = true; toast('warning', `这次没能存到服务器（${detail.slice(0, 80)}）。内容已在本地快照里，稍后自动重试。`, { timeOut: 8000 }); }
    const delays = [3000, 8000, 20000];
    if (r.n >= delays.length) { logEvent('补存', `「${nameOf(key)}」重试 ${delays.length} 次仍失败，等下次保存`); return; }
    clearTimeout(r.timer);
    r.timer = setTimeout(async () => {
        if (currentChat()?.key !== key) return;
        r.n++;
        try { await ctx().saveChat(); } catch (e) { warn(e); }
    }, delays[r.n]);
}

function installFetchGuard() {
    if (globalThis.__chatAnchorFetch) return;
    const orig = globalThis.fetch;
    const wrapped = function (input, init) {
        let info = null;
        try { info = classify(input, init); } catch { info = null; }
        if (!info) return orig.apply(this, arguments);
        if (info.op === 'save') {
            let block = false;
            try { block = shouldBlock(info); } catch { block = false; }
            if (block) {
                try { onBlocked(info); } catch { /* 记录失败不影响拦截 */ }
                return Promise.resolve(new Response('{"error":"chat_anchor_guard"}', { status: 409, statusText: 'Blocked by Chat Anchor', headers: { 'Content-Type': 'application/json' } }));
            }
            const p = orig.apply(this, arguments);
            p.then(r => { try { onSaveSettled(info, r, null); } catch (e) { warn(e); } }, e => { try { onSaveSettled(info, null, e); } catch (e2) { warn(e2); } });
            return p;
        }
        const p = orig.apply(this, arguments);
        p.then(r => { try { onLoadSettled(info, r.ok, `HTTP ${r.status}`); } catch (e) { warn(e); } },
            e => { try { if (e?.name !== 'AbortError') onLoadSettled(info, false, e?.message || String(e)); } catch (e2) { warn(e2); } });
        return p;
    };
    globalThis.fetch = wrapped;
    globalThis.__chatAnchorFetch = true;
}

// ───────────────────────── 恢复 / 导出 / 预览 ─────────────────────────
async function loadSnapData(snap) {
    const want = [...new Set([...snap.hashes, snap.meta])];
    const map = await tx(['blobs'], 'readonly', t => {
        const m = new Map();
        const store = t.objectStore('blobs');
        for (const h of want) store.get([snap.chatKey, h]).onsuccess = e => { if (e.target.result) m.set(h, e.target.result.json); };
        return m;
    });
    const lines = [];
    let missing = 0;
    for (const h of snap.hashes) {
        const j = map.get(h);
        if (j === undefined) missing++;
        else if (j !== 'null') lines.push(j);
    }
    return { metaJson: map.get(snap.meta) ?? '{}', lines, missing };
}

function buildJsonl(data, names) {
    let meta = {};
    try { meta = JSON.parse(data.metaJson) || {}; } catch { meta = {}; }
    const header = JSON.stringify({ chat_metadata: meta, user_name: names.user || 'User', character_name: names.char || 'Character' });
    return header + '\n' + data.lines.join('\n');
}

function uploadHeaders() {
    const h = { ...ctx().getRequestHeaders() };
    delete h['Content-Type']; // multipart 由浏览器自己带 boundary
    return h;
}

async function waitFor(fn, ms = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(100); }
    return false;
}

async function getSnap(id) {
    const snap = await dbGet('snaps', id);
    if (!snap) throw new Error('这份快照已经不存在了');
    return snap;
}

/** 把一份 .jsonl 文本导入成指定角色下的新聊天，并打开它。返回新聊天的名字。 */
async function importToCharacter(jsonl, idx) {
    let c = ctx();
    const ch = c.characters[idx];
    // 先切到目标角色：酒馆在第一次打开角色时才建它的聊天目录，目录不存在导入会失败
    if (c.groupId || String(c.characterId) !== String(idx)) {
        await c.selectCharacterById(idx);
        if (!await waitFor(() => !ctx().groupId && String(ctx().characterId) === String(idx))) throw new Error(`没能切到角色「${ch.name}」。请手动打开这个角色，再试一次`);
        c = ctx();
    }
    const fd = new FormData();
    fd.set('file_type', 'jsonl');
    fd.set('avatar', new File([jsonl], 'chat-anchor.jsonl', { type: 'application/octet-stream' }));
    fd.set('avatar_url', ch.avatar);
    fd.set('user_name', c.name1);
    fd.set('character_name', ch.name);
    const r = await fetch('/api/chats/import', { method: 'POST', body: fd, headers: uploadHeaders(), cache: 'no-cache' });
    const out = r.ok ? await r.json().catch(() => null) : null;
    const fileName = out?.fileNames?.[0];
    if (!fileName) throw new Error(`导入失败（HTTP ${r.status}${out?.error ? '，服务器拒绝了这个文件' : ''}）。可以改用「导出」把文件存下来`);
    const chatName = fileName.replace(/\.jsonl$/i, '');
    await ctx().openCharacterChat(chatName);
    return chatName;
}

/** 恢复成一个新聊天（走酒馆官方的导入接口，不覆盖任何现有文件）。 */
async function restoreAsNew(id) {
    const snap = await getSnap(id);
    const rec = await dbGet('chats', snap.chatKey);
    const data = await loadSnapData(snap);
    if (data.missing) logEvent('恢复', `快照缺 ${data.missing} 楼数据，其余照常恢复`);
    await takeSnapshot('auto').catch(warn);
    const c = ctx();

    if (snap.chatKey.startsWith('g|')) {
        const group = c.groups?.find(g => String(g.id) === String(rec?.groupId));
        if (!group || String(c.groupId) !== String(group.id)) throw new Error('请先打开这个群聊，再恢复它的快照');
        const fd = new FormData();
        fd.set('avatar', new File([buildJsonl(data, { user: c.name1, char: group.name })], 'chat-anchor.jsonl', { type: 'application/octet-stream' }));
        fd.set('file_type', 'jsonl');
        const r = await fetch('/api/chats/group/import', { method: 'POST', body: fd, headers: uploadHeaders(), cache: 'no-cache' });
        const out = r.ok ? await r.json() : null;
        if (!out?.res) throw new Error(`导入失败（HTTP ${r.status}）。可以改用「导出」把文件存下来`);
        if (!Array.isArray(group.chats)) group.chats = [];
        group.chats.push(out.res);
        await c.openGroupChat(group.id, out.res);
        logEvent('恢复', `群聊快照（${snap.count} 楼）已恢复成新聊天「${out.res}」`);
        return out.res;
    }

    let idx = c.characters.findIndex(ch => ch.avatar === rec?.avatar);
    if (idx < 0) {
        if (c.groupId || c.characterId === undefined || c.characterId === null) throw new Error('找不到原来的角色卡。请先打开要恢复到的角色，或用「导出」把文件存下来');
        const ok = await c.Popup.show.confirm('找不到原来的角色卡', `这份快照属于「${esc(rec?.owner || '未知角色')}」，但这张卡已经不在了。要恢复到当前打开的角色「${esc(c.name2)}」吗？`);
        if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return null;
        idx = Number(c.characterId);
    }
    const chatName = await importToCharacter(buildJsonl(data, { user: c.name1, char: c.characters[idx].name }), idx);
    logEvent('恢复', `快照（${snap.count} 楼）已恢复成新聊天「${chatName}」`);
    return chatName;
}

/** 用快照覆盖当前打开的聊天。覆盖前会先把当前状态存成一份锁定快照，可以反悔。 */
async function restoreInPlace(id) {
    const snap = await getSnap(id);
    const info = currentChat();
    if (!info || info.key !== snap.chatKey) throw new Error('这份快照不属于当前打开的聊天');
    const p = S.poison.get(info.key);
    if (p && p.confirmed && !p.okSeen && !p.released) throw new Error('这个聊天还没读取成功，请先点「重新读取」');
    const data = await loadSnapData(snap);
    const msgs = [];
    for (const line of data.lines) { try { const m = JSON.parse(line); if (m && typeof m === 'object') msgs.push(m); } catch { /* 跳过坏行 */ } }
    if (!msgs.length) throw new Error('这份快照里没有可用的楼层');
    let meta = {};
    try { meta = JSON.parse(data.metaJson) || {}; } catch { meta = {}; }

    await takeSnapshot('pre-restore', { force: true, lock: true });
    const c = ctx();
    if (currentChat()?.key !== info.key) throw new Error('聊天已经切换，已取消恢复');
    const integrity = c.chatMetadata?.integrity; // 沿用当前文件的校验码，否则酒馆会拒绝保存
    c.chat.splice(0, c.chat.length, ...msgs);
    c.updateChatMetadata({ ...meta, ...(integrity ? { integrity } : {}) }, true);

    const t0 = Date.now();
    await c.saveChat();
    const ls = S.lastSave.get(info.key);
    const saved = !!(ls && ls.ok && ls.at >= t0);
    if (saved) {
        await ctx().reloadCurrentChat();
    } else {
        const c2 = ctx();
        if (typeof c2.clearChat === 'function' && typeof c2.printMessages === 'function') { await c2.clearChat(); await c2.printMessages(); }
        toast('warning', '内容已恢复到页面上，但还没成功存到服务器。先别刷新，等自动补存成功的提示。', { timeOut: 10000 });
    }
    const rec = await dbGet('chats', info.key);
    if (rec?.alert) await enqueue(() => dbPut('chats', { ...rec, alert: null }));
    logEvent('恢复', `「${info.chatName}」已用 ${snap.count} 楼的快照覆盖${saved ? '' : '（服务器保存未确认）'}`);
    return saved;
}

/** 把文本存成文件：手机上走系统分享（可选"存储到文件"），其它情况直接下载。 */
async function saveFile(name, text) {
    const file = new File([text], name, { type: 'application/octet-stream' });
    if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent) && navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e?.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

/** 弹窗显示最后 60 楼。lines 是每楼一条 JSON 字符串。 */
async function showPreview(lines) {
    const from = Math.max(0, lines.length - 60);
    const parts = [];
    for (let i = from; i < lines.length; i++) {
        try { const m = JSON.parse(lines[i]); parts.push(`#${i}  ${m.name ?? ''}\n${m.mes ?? ''}`); } catch { /* 跳过坏行 */ }
    }
    const ta = document.createElement('textarea');
    ta.className = 'text_pole ca-preview';
    ta.readOnly = true;
    ta.value = (from > 0 ? `（共 ${lines.length} 楼，这里显示最后 60 楼）\n\n` : '') + parts.join('\n\n\n');
    const c = ctx();
    await c.callGenericPopup(ta, c.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: '关闭' });
}

// ───────────────────────── 旧插件「聊天记录快速恢复」留下的备份 ─────────────────────────
const LEGACY_DB = 'ST_ChatBackup';

/** 只读打开旧插件的库；库不存在时返回 null，并且不会顺手建一个空库。 */
async function openLegacy() {
    try {
        if (indexedDB.databases) { const list = await indexedDB.databases(); if (!list.some(d => d.name === LEGACY_DB)) return null; }
    } catch { /* 查不了就直接试着打开 */ }
    return new Promise(resolve => {
        const rq = indexedDB.open(LEGACY_DB);
        rq.onupgradeneeded = () => { try { rq.transaction.abort(); } catch { /* 忽略 */ } }; // 库原本不存在：撤销创建
        rq.onsuccess = () => {
            const db = rq.result;
            if (!db.objectStoreNames.contains('backups_meta') || !db.objectStoreNames.contains('backups_content')) { db.close(); resolve(null); return; }
            resolve(db);
        };
        rq.onerror = e => { e.preventDefault?.(); resolve(null); };
        rq.onblocked = () => resolve(null);
    });
}
async function legacyRead(store, query) {
    const db = await openLegacy();
    if (!db) return null;
    try {
        return await new Promise((resolve, reject) => {
            const os = db.transaction([store], 'readonly').objectStore(store);
            const rq = query ? os.get(query) : os.getAll();
            rq.onsuccess = () => resolve(rq.result);
            rq.onerror = () => reject(rq.error);
        });
    } finally { db.close(); } // 用完就关，不挡旧插件自己用
}
const legacyList = async () => ((await legacyRead('backups_meta')) || []).sort((a, b) => b.timestamp - a.timestamp);
async function legacyContent(chatKey, timestamp) {
    const row = await legacyRead('backups_content', [chatKey, Number(timestamp)]);
    const text = row?.chatFileContent;
    if (typeof text !== 'string' || !text.trim()) throw new Error('这份旧备份的内容读不出来');
    return text.trim();
}
const legacyLines = text => text.split('\n').slice(1).filter(l => l.trim());

async function legacyExport(chatKey, timestamp) {
    const meta = await legacyRead('backups_meta', [chatKey, Number(timestamp)]);
    const text = await legacyContent(chatKey, timestamp);
    await saveFile(`${String(meta?.chatName || meta?.entityName || 'chat').replace(/[\\/:*?"<>|]/g, '_')} ${stamp(Number(timestamp))}.jsonl`, text);
}

/** 把旧备份导入成新聊天。目标角色：当前打开的同名角色 > 唯一的同名角色 > 当前打开的角色（会先问）。 */
async function legacyImport(chatKey, timestamp, { ask = true } = {}) {
    if (String(chatKey).startsWith('group_')) throw new Error('群聊的旧备份请用「导出」存成文件，再到群聊里用酒馆的「导入聊天」');
    const meta = await legacyRead('backups_meta', [chatKey, Number(timestamp)]);
    const text = await legacyContent(chatKey, timestamp);
    const c = ctx();
    const hasOpen = !c.groupId && c.characterId !== undefined && c.characterId !== null;
    const same = [];
    c.characters.forEach((ch, i) => { if (ch.name === meta?.entityName) same.push(i); });
    let idx = -1;
    if (hasOpen && same.includes(Number(c.characterId))) idx = Number(c.characterId);
    else if (same.length === 1) idx = same[0];
    else if (hasOpen) {
        if (ask) {
            const ok = await c.Popup.show.confirm('导入到当前角色？', `这份备份属于「${esc(meta?.entityName || '未知角色')}」，${same.length ? '同名的角色卡不止一张' : '没找到同名的角色卡'}。要导入到当前打开的「${esc(c.name2)}」吗？`);
            if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return null;
        }
        idx = Number(c.characterId);
    } else throw new Error(`请先打开「${meta?.entityName || '要恢复到的角色'}」，再点导入`);
    await takeSnapshot('auto').catch(warn);
    const chatName = await importToCharacter(text, idx);
    logEvent('恢复', `旧插件的备份（${legacyLines(text).length} 楼）已导入成新聊天「${chatName}」`);
    return chatName;
}

// ───────────────────────── 两份快照差在哪 ─────────────────────────
const FIELD_NAMES = {
    mes: '正文', swipe_id: '当前是第几个 swipe', swipes: 'swipe 列表', swipe_info: 'swipe 附带信息', name: '名字', send_date: '发送时间',
    gen_started: '生成开始时间', gen_finished: '生成结束时间', is_user: '是否用户发言', is_system: '是否系统消息', force_avatar: '头像',
    'extra.token_count': 'token 计数', 'extra.reasoning': '思维链', 'extra.reasoning_duration': '思考用时', 'extra.display_text': '显示文本',
    'extra.api': '接口', 'extra.model': '模型', 'extra.image': '图片', 'extra.title': '标题', 'extra.bias': '偏置', 'extra.memory': '摘要',
    variables: '变量', tainted: '已改动标记', lastInContextMessageId: '上下文范围标记', integrity: '校验码', note_prompt: '作者注释',
    note_interval: '作者注释频率', note_depth: '作者注释深度', note_position: '作者注释位置', timedWorldInfo: '世界书定时',
    chat_id_hash: '聊天标识', main_chat: '主聊天', scenario: '场景', system_prompt: '系统提示', mes_example: '对话示例',
};
const fieldName = k => FIELD_NAMES[k] ? `${FIELD_NAMES[k]}（${k}）` : k;
const BOOKKEEPING = new Set(['gen_started', 'gen_finished', 'extra.token_count', 'extra.reasoning_duration', 'extra.api', 'extra.model', 'send_date', 'lastInContextMessageId', 'tainted']);

function keysDiff(x, y) {
    const out = [];
    for (const k of new Set([...Object.keys(x || {}), ...Object.keys(y || {})])) {
        const vx = x?.[k], vy = y?.[k];
        if (JSON.stringify(vx) === JSON.stringify(vy)) continue;
        if (k === 'extra' && vx && vy && typeof vx === 'object' && typeof vy === 'object') { for (const e of new Set([...Object.keys(vx), ...Object.keys(vy)])) if (JSON.stringify(vx[e]) !== JSON.stringify(vy[e])) out.push('extra.' + e); }
        else out.push(k);
    }
    return out;
}

/** 新快照相对旧快照改了什么。不读数据库，只比哈希：用来在列表里写一句话。 */
function describeChange(s, older) {
    if (!older) return null;
    if (s.count !== older.count) return { kind: 'count', text: `${s.count > older.count ? '+' : '−'}${Math.abs(s.count - older.count)}` };
    const changed = [];
    for (let i = 0; i < s.hashes.length; i++) if (s.hashes[i] !== older.hashes[i]) changed.push(i);
    if (changed.length === 1) return { kind: 'floor', text: `改了第 ${changed[0] + 1} 楼` };
    if (changed.length > 1) return { kind: 'floor', text: `改了 ${changed.length} 楼` };
    if (s.meta !== older.meta) return { kind: 'meta', text: '只有聊天设置变了' };
    return { kind: 'same', text: '内容相同' };
}

/** 两份快照逐楼、逐字段地比。返回 { floors: [{ index, change, fields }], metaKeys } */
async function diffSnaps(newId, oldId) {
    const [a, b] = await Promise.all([getSnap(newId), getSnap(oldId)]);
    if (a.chatKey !== b.chatKey) throw new Error('两份快照不属于同一个聊天');
    const n = Math.max(a.hashes.length, b.hashes.length);
    const want = new Set();
    for (let i = 0; i < n; i++) if (a.hashes[i] !== b.hashes[i]) { want.add(a.hashes[i]); want.add(b.hashes[i]); }
    if (a.meta !== b.meta) { want.add(a.meta); want.add(b.meta); }
    want.delete(undefined);
    const map = await tx(['blobs'], 'readonly', t => {
        const m = new Map();
        const st = t.objectStore('blobs');
        for (const h of want) st.get([a.chatKey, h]).onsuccess = e => { if (e.target.result) m.set(h, e.target.result.json); };
        return m;
    });
    const parse = h => { try { return JSON.parse(map.get(h)); } catch { return null; } };
    const out = { from: b.count, to: a.count, floors: [], metaKeys: [] };
    for (let i = 0; i < n; i++) {
        if (a.hashes[i] === b.hashes[i]) continue;
        if (i >= a.hashes.length) { out.floors.push({ index: i, change: '删除', fields: [] }); continue; }
        if (i >= b.hashes.length) { out.floors.push({ index: i, change: '新增', fields: [] }); continue; }
        const x = parse(a.hashes[i]), y = parse(b.hashes[i]);
        out.floors.push({ index: i, change: '修改', fields: x && y ? keysDiff(x, y) : ['（内容读不出来）'] });
    }
    if (a.meta !== b.meta) out.metaKeys = keysDiff(parse(a.meta), parse(b.meta));
    return out;
}

async function showWhy(newId, oldId) {
    const [d, a, b] = await Promise.all([diffSnaps(newId, oldId), getSnap(newId), getSnap(oldId)]);
    const lines = [];
    const shown = d.floors.slice(0, 20);
    for (const f of shown) lines.push(`第 ${f.index + 1} 楼 ${f.change}${f.fields.length ? '：' + f.fields.map(fieldName).join('、') : ''}`);
    if (d.floors.length > shown.length) lines.push(`…还有 ${d.floors.length - shown.length} 楼`);
    if (d.metaKeys.length) lines.push(`聊天设置：${d.metaKeys.map(fieldName).join('、')}`);
    if (!lines.length) lines.push('两份内容完全一样（强制存的）。');
    const allBookkeeping = d.floors.every(f => f.change === '修改' && f.fields.length && f.fields.every(k => BOOKKEEPING.has(k))) && d.metaKeys.every(k => BOOKKEEPING.has(k));
    const note = allBookkeeping
        ? '这些都是酒馆自己的记账字段（计数、时间戳、标记），不是你改的。'
        : '正文、swipe、变量这类变化通常来自你的操作或正在跑的脚本（状态栏、变量脚本等）。';
    const c = ctx();
    const st = settings();
    const fields = [...new Set([...d.floors.flatMap(f => f.fields), ...d.metaKeys.map(k => 'meta.' + k)])].filter(k => !k.startsWith('（') && !st.ignore.includes(k)).slice(0, 3);
    const html = `<div class="ca-dialog"><h3>${fmtDay(a.ts)} ${fmtTime(a.ts)} 这份比 ${fmtDay(b.ts)} ${fmtTime(b.ts)} 那份</h3>
        <p>${lines.map(esc).join('<br>')}</p><p class="ca-note">${note}</p>
        ${fields.length ? '<p class="ca-note">点「以后忽略」：这个字段单独变化时不再存快照。真要存的时候仍然存完整内容，只是恢复时这个字段可能是旧值。</p>' : ''}</div>`;
    const res = await c.callGenericPopup(html, c.POPUP_TYPE.TEXT, '', {
        okButton: '关闭', cancelButton: false, allowVerticalScrolling: true,
        customButtons: fields.map((k, i) => ({ text: `以后忽略「${fieldName(k).replace(/（.*/, '')}」`, result: 10 + i })),
    });
    const pick = fields[Number(res) - 10];
    if (pick) {
        st.ignore = [...new Set([...st.ignore, pick])];
        c.saveSettingsDebounced();
        S.last.delete(a.chatKey); // 下一次按新规则重新算
        logEvent('设置', `以后忽略字段 ${pick} 的变化`);
        toast('success', `以后「${pick}」单独变了不会再存快照。可以在「设置」里改回来。`);
        refreshPanel();
    }
}

const stamp = ts => { const d = new Date(ts); const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`; };

async function exportSnap(id) {
    const snap = await getSnap(id);
    const rec = await dbGet('chats', snap.chatKey);
    const data = await loadSnapData(snap);
    const jsonl = buildJsonl(data, { user: ctx().name1, char: rec?.owner });
    const name = `${String(rec?.chatName || 'chat').replace(/[\\/:*?"<>|]/g, '_')} ${stamp(snap.ts)}.jsonl`;
    await saveFile(name, jsonl);
}

async function previewSnap(id) {
    const snap = await getSnap(id);
    const data = await loadSnapData(snap);
    await showPreview(data.lines);
}

// ───────────────────────── 服务器上的备份（酒馆自带，data/<用户>/backups/） ─────────────────────────
// 和在宝塔 / 1Panel 里翻 backups 文件夹看到的是同一批文件，这里通过酒馆自己的接口读，不需要面板。

/** 纯 JS 的 SHA-256：云酒馆常用 http 访问，那种环境下浏览器不提供 crypto.subtle。 */
function sha256Hex(str) {
    const K = [], H = [], comp = {};
    for (let n = 2, c = 0; c < 64; n++) {
        if (comp[n]) continue;
        for (let i = n * 2; i < 320; i += n) comp[i] = true;
        if (c < 8) H[c] = (Math.pow(n, 0.5) * 4294967296) | 0;
        K[c++] = (Math.pow(n, 1 / 3) * 4294967296) | 0;
    }
    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;
    const total = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len / 536870912));
    dv.setUint32(total - 4, (len * 8) >>> 0);
    const w = new Int32Array(64);
    const rot = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], b = w[i - 2];
            w[i] = (w[i - 16] + (rot(a, 7) ^ rot(a, 18) ^ (a >>> 3)) + w[i - 7] + (rot(b, 17) ^ rot(b, 19) ^ (b >>> 10))) | 0;
        }
        let [a, b, c, d, e, f, g, h] = H;
        for (let i = 0; i < 64; i++) {
            const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
            const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

/** 和服务器 src/endpoints/chats.js 的 getBackupKey 保持一致：角色卡文件名 → 备份文件名里的那一段。 */
function backupKeyOf(cardName, withHash = true) {
    const clean = String(cardName).replace(/[/?<>\\:*|"]/g, '').replace(/[\x00-\x1f\x80-\x9f]/g, '').replace(/[. ]+$/, '');
    const plain = clean.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    return withHash && /[^\x20-\x7E]/.test(cardName) ? `${plain}_${sha256Hex(String(cardName)).slice(0, 8)}` : plain;
}

/** 备份文件名里的那一段 → 是哪张角色卡。 */
function backupOwners() {
    const exact = new Map(), loose = new Map();
    ctx().characters.forEach((ch, idx) => {
        const card = String(ch.avatar || '').replace('.png', '');
        if (!card) return;
        exact.set(backupKeyOf(card), { idx, name: ch.name });
        const k = backupKeyOf(card, false); // 旧版酒馆的文件名不带哈希，可能多张卡撞名
        loose.set(k, loose.has(k) ? null : { idx, name: ch.name });
    });
    return key => exact.get(key) || loose.get(key) || null;
}

/**
 * 读取服务器上的备份列表。酒馆这个接口会把 backups 目录里每一份都读一遍，备份多时要等很久，
 * 所以：同一时刻只发一个请求；有超时；读到就缓存 10 分钟；失败时留着上一次的结果；面板从不 await 它。
 */
const SRV_CACHE_KEY = 'chat_anchor_srv_list';
const SRV_TTL = 1800000; // 30 分钟内不自动重读

/** 读到过的列表记在 localStorage：读一次很贵，刷新页面后也不用重读。存不下或读不到都当没有。 */
function loadSrvCache() {
    if (S.srv) return;
    try {
        const v = JSON.parse(localStorage.getItem(SRV_CACHE_KEY) || 'null');
        if (v && Array.isArray(v.rows) && v.at) S.srv = { at: v.at, rows: v.rows, cached: true };
    } catch { /* 读不到就当没有 */ }
}
function saveSrvCache(at, rows) {
    try { localStorage.setItem(SRV_CACHE_KEY, JSON.stringify({ at, rows: rows.map(r => ({ ...r, preview: r.preview.slice(0, 60) })) })); }
    catch { /* 存不下就算了 */ }
}
const srvIsSlowError = msg => /HTTP 50[234]|秒服务器还没/.test(String(msg || ''));

function serverBackups(force = false) {
    loadSrvCache();
    if (!force && S.srv && Date.now() - S.srv.at < SRV_TTL) return Promise.resolve(S.srv.rows);
    if (S.srvJob) return S.srvJob.promise;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const job = { startedAt: Date.now(), controller, promise: null };
    const timeoutMs = Number(S.srvTimeoutMs) || 90000;
    const timer = setTimeout(() => { try { controller?.abort(); } catch { /* 忽略 */ } }, timeoutMs);
    job.promise = (async () => {
        let error = null;
        try {
            const r = await fetch('/api/backups/chat/get', { method: 'POST', headers: ctx().getRequestHeaders(), signal: controller?.signal });
            if (r.status === 404) throw new Error('这个版本的酒馆没有备份接口，需要 1.17 或更新');
            if (r.status === 504 || r.status === 502) throw new Error(`反向代理没等到酒馆的回应就放弃了（HTTP ${r.status}）`);
            if (!r.ok) throw new Error(`读取服务器备份失败（HTTP ${r.status}）`);
            const list = await r.json().catch(() => null);
            if (!Array.isArray(list)) throw new Error('服务器返回的不是备份列表');
            const rows = [];
            for (const b of list) {
                const m = /^chat_(.*)_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.jsonl$/.exec(b?.file_name || '');
                if (!m) continue;
                rows.push({
                    file: b.file_name, key: m[1], count: Number(b.chat_items) || 0, size: String(b.file_size || ''),
                    order: Number(m.slice(2).join('')), when: `${Number(m[3])}月${Number(m[4])}日 ${m[5]}:${m[6]}`,
                    preview: String(b.mes || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140),
                });
            }
            rows.sort((a, b) => b.order - a.order);
            S.srv = { at: Date.now(), rows };
            saveSrvCache(S.srv.at, rows);
            return rows;
        } catch (e) {
            error = e?.name === 'AbortError'
                ? `等了 ${Math.round(timeoutMs / 1000)} 秒服务器还没把备份列表给出来。备份文件多的时候酒馆要把每一份都读一遍，会很慢`
                : String(e?.message || e);
            logEvent('服务器备份', `读取列表失败：${error}`);
            throw new Error(error);
        } finally {
            clearTimeout(timer);
            if (S.srvJob === job) S.srvJob = null;
            S.srvLast = { at: Date.now(), error };
            if (P.tab === 'srv') refreshPanel(); // 面板开着就自动显示结果
        }
    })();
    S.srvJob = job;
    return job.promise;
}

async function serverText(file) {
    const r = await fetch('/api/backups/chat/download', { method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ name: file }) });
    if (!r.ok) throw new Error(`下载备份失败（HTTP ${r.status}）`);
    const text = (await r.text()).trim();
    if (!text) throw new Error('这份备份是空的');
    return text;
}

/** 把服务器上的一份备份导入成新聊天。认得出是哪张卡就导给它，认不出就问要不要导到当前角色。 */
async function serverRestore(file, { ask = true } = {}) {
    const m = /^chat_(.*)_\d{8}-\d{6}\.jsonl$/.exec(file);
    const owner = m ? backupOwners()(m[1]) : null;
    const c = ctx();
    let idx = owner ? owner.idx : -1;
    if (idx < 0) {
        if (c.groupId || c.characterId === undefined || c.characterId === null) throw new Error('认不出这份备份属于哪张角色卡。请先打开要恢复到的角色，再点恢复');
        if (ask) {
            const ok = await c.Popup.show.confirm('导入到当前角色？', `认不出这份备份属于哪张角色卡。要导入到当前打开的「${esc(c.name2)}」吗？`);
            if (ok !== c.POPUP_RESULT.AFFIRMATIVE) return null;
        }
        idx = Number(c.characterId);
    }
    const text = await serverText(file);
    await takeSnapshot('auto').catch(warn);
    const chatName = await importToCharacter(text, idx);
    logEvent('恢复', `服务器备份 ${file}（${legacyLines(text).length} 楼）已导入成新聊天「${chatName}」`);
    return chatName;
}

// ───────────────────────── 面板 ─────────────────────────
const P = { popup: null, root: null, tab: 'cur', viewKey: null, srvKey: undefined, busy: false, again: false, srvTick: null };
const REASON = { manual: '手动', drop: '掉楼前', 'pre-restore': '恢复前', hidden: '切后台时' };
const z2 = n => String(n).padStart(2, '0');
const fmtTime = ts => { const d = new Date(ts); return `${z2(d.getHours())}:${z2(d.getMinutes())}`; };
function fmtDay(ts) {
    const d = new Date(ts), now = new Date();
    const day0 = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day0(now) - day0(d)) / DAY);
    return diff === 0 ? '今天' : diff === 1 ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`;
}
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

function openPanel(tab) {
    const c = ctx();
    clearDropToast();
    if (P.root) { if (tab) { P.tab = tab; P.viewKey = null; } refreshPanel(); return; }
    P.tab = tab || 'cur';
    P.viewKey = null;
    const root = document.createElement('div');
    root.className = 'ca-panel';
    root.addEventListener('click', e => { onPanelClick(e).catch(err => { warn(err); toast('error', String(err?.message || err)); }); });
    root.addEventListener('change', onPanelChange);
    P.root = root;
    P.popup = new c.Popup(root, c.POPUP_TYPE.DISPLAY, '', { wide: true, large: true, allowVerticalScrolling: true, onClose: () => { P.root = null; P.popup = null; } });
    P.popup.show();
    refreshPanel();
}

async function closePanel() {
    const pop = P.popup;
    P.root = null; P.popup = null;
    try { await pop?.complete?.(ctx().POPUP_RESULT.CANCELLED); } catch { /* 已关闭 */ }
}

function refreshPanel() {
    if (!P.root) return;
    if (P.busy) { P.again = true; return; }
    P.busy = true;
    render().catch(warn).finally(() => { P.busy = false; if (P.again) { P.again = false; refreshPanel(); } });
}

async function render() {
    const root = P.root;
    if (!root) return;
    const info = currentChat();
    let body;
    if (P.tab === 'cur') body = await renderTimeline(info?.key, info, false);
    else if (P.tab === 'all') body = P.viewKey ? await renderTimeline(P.viewKey, info, true) : await renderChats(info);
    else if (P.tab === 'srv') body = await renderServer(info);
    else if (P.tab === 'log') body = await renderLog();
    else body = await renderSettings();
    if (P.root !== root) return;
    const tabs = [['cur', '当前'], ['all', '全部'], ['srv', '服务器'], ['log', '记录'], ['set', '设置']];
    const scroller = root.closest('.popup-content') || root.parentElement;
    const top = scroller?.scrollTop ?? 0;
    root.innerHTML = `
        <header class="ca-head">
            <div class="ca-title"><i class="fa-solid fa-anchor"></i><span>小锚</span></div>
            <div class="menu_button" data-act="snap-now" title="给当前聊天存一份并锁定">立即快照</div>
        </header>
        <nav class="ca-tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" class="ca-tab" role="tab" aria-selected="${P.tab === id}" data-act="tab" data-tab="${id}">${label}</button>`).join('')}</nav>
        <section class="ca-body">${body}</section>`;
    if (scroller) scroller.scrollTop = top;
}

async function renderTimeline(key, info, withBack) {
    const back = withBack ? '<button type="button" class="ca-back" data-act="back"><i class="fa-solid fa-chevron-left"></i>全部聊天</button>' : '';
    if (!key) return back + '<div class="ca-empty">先打开一个聊天。<br>打开后小锚会自动开始存快照。</div>';
    const [rec, snaps] = await Promise.all([dbGet('chats', key), snapsOf(key)]);
    const isCur = info?.key === key;
    const owner = rec?.owner || info?.owner || '';
    const chatName = rec?.chatName || info?.chatName || '';
    let html = `${back}<div class="ca-chat-name">${esc(owner)}</div><div class="ca-chat-file">${esc(chatName)}${isCur ? '' : '（不是当前打开的聊天）'}</div>`;

    const p = S.poison.get(key);
    if (isCur && p && p.confirmed && !p.okSeen && !p.released) {
        html += `<div class="ca-banner">这个聊天还没读取成功，保存已暂停，服务器上的存档没有被改动。
            <div class="ca-banner-acts"><div class="menu_button" data-act="reload">重新读取</div></div></div>`;
    } else if (rec?.alert && snaps.some(s => s.id === rec.alert.snapId)) {
        const a = rec.alert;
        html += `<div class="ca-banner">${fmtDay(a.ts)} ${fmtTime(a.ts)} 打开时少了 ${a.from - a.to} 楼（${a.from} → ${a.to}）。掉楼前的快照已锁定。
            <div class="ca-banner-acts"><div class="menu_button" data-act="restore" data-id="${esc(a.snapId)}">恢复那一份</div><div class="menu_button" data-act="ack" data-key="${esc(key)}">不用了</div></div></div>`;
    }
    if (!snaps.length) return html + '<div class="ca-empty">这个聊天还没有快照。<br>发一条消息，或点右上角「立即快照」。</div>';

    let day = '';
    let open = false;
    snaps.forEach((s, i) => {
        const d = fmtDay(s.ts);
        if (d !== day) { if (open) html += '</ol>'; html += `<div class="ca-day">${d}</div><ol class="ca-line">`; open = true; day = d; }
        const older = snaps[i + 1];
        const ch = describeChange(s, older);
        const deltaHtml = ch ? `<button type="button" class="ca-delta ca-why${ch.kind === 'count' && s.count < older.count ? ' is-neg' : ''}" data-act="why" data-prev="${esc(older.id)}" title="看看改了什么">${esc(ch.text)}</button>` : '';
        const tag = REASON[s.lockReason] || REASON[s.reason] || (s.locked ? '已锁定' : '');
        html += `<li class="ca-snap${s.locked ? ' is-locked' : ''}${s.lockReason === 'drop' ? ' is-drop' : ''}" data-id="${esc(s.id)}">
            <div class="ca-snap-head"><time>${fmtTime(s.ts)}</time><span class="ca-floors">${s.count} 楼</span>${deltaHtml}${tag ? `<span class="ca-tag">${tag}</span>` : ''}</div>
            <div class="ca-prev"><b>${esc(s.name)}</b> ${esc(s.preview) || '（空消息）'}</div>
            <div class="ca-acts">
                <div class="menu_button" data-act="restore">恢复</div>
                <button type="button" class="ca-icon" data-act="preview" title="预览最后 60 楼" aria-label="预览"><i class="fa-solid fa-eye"></i></button>
                <button type="button" class="ca-icon" data-act="export" title="导出 .jsonl 文件" aria-label="导出"><i class="fa-solid fa-file-export"></i></button>
                <button type="button" class="ca-icon${s.locked ? ' is-on' : ''}" data-act="lock" title="${s.locked ? '解除锁定' : '锁定：不会被自动清理'}" aria-label="锁定"><i class="fa-solid ${s.locked ? 'fa-lock' : 'fa-lock-open'}"></i></button>
                <button type="button" class="ca-icon" data-act="del" title="删除这份快照" aria-label="删除"><i class="fa-solid fa-trash-can"></i></button>
            </div></li>`;
    });
    if (open) html += '</ol>';
    return html;
}

async function renderLegacy() {
    let rows = [];
    try { rows = await legacyList(); } catch (e) { warn('读取旧插件备份失败', e); }
    if (!rows.length) return '';
    return `<div class="ca-legacy"><div class="ca-chat-name">旧插件留下的备份</div>
        <div class="ca-note">来自「聊天记录快速恢复」。建议先点导出把文件存下来，再导入。</div>
        <ul class="ca-chats">${rows.map(r => `<li class="ca-chat ca-old" data-lk="${esc(r.chatKey)}" data-lt="${esc(r.timestamp)}">
            <div class="ca-chat-main"><div class="ca-chat-name">${esc(r.entityName)}</div>
            <div class="ca-chat-file">${esc(r.chatName)}</div>
            <div class="ca-chat-meta">${Number(r.lastMessageId) + 1} 楼，备份于 ${fmtDay(r.timestamp)} ${fmtTime(r.timestamp)}</div>
            <div class="ca-prev">${esc(String(r.lastMessagePreview || '').slice(0, 140))}</div>
            <div class="ca-acts"><div class="menu_button" data-act="old-export">导出文件</div><div class="menu_button" data-act="old-import">导入成新聊天</div>
            <button type="button" class="ca-icon" data-act="old-preview" title="预览最后 60 楼" aria-label="预览"><i class="fa-solid fa-eye"></i></button></div></div>
        </li>`).join('')}</ul></div>`;
}

async function renderChats(info) {
    const legacy = await renderLegacy();
    const chats = (await dbAll('chats')).sort((a, b) => b.lastTs - a.lastTs);
    if (!chats.length) return legacy || '<div class="ca-empty">还没有任何快照。<br>打开一个聊天聊几句就有了。</div>';
    return legacy + '<ul class="ca-chats">' + chats.map(r => `<li class="ca-chat" data-act="view" data-key="${esc(r.chatKey)}">
        <div class="ca-chat-main"><div class="ca-chat-name">${esc(r.owner)}${r.chatKey === info?.key ? '（当前）' : ''}</div>
        <div class="ca-chat-file">${esc(r.chatName)}</div>
        <div class="ca-chat-meta">${r.lastCount} 楼，最后快照 ${fmtDay(r.lastTs)} ${fmtTime(r.lastTs)}${r.alert ? '，有一次掉楼记录' : ''}</div></div>
        <button type="button" class="ca-icon" data-act="del-chat" data-key="${esc(r.chatKey)}" title="删除这个聊天的全部快照" aria-label="删除"><i class="fa-solid fa-trash-can"></i></button>
    </li>`).join('') + '</ul>';
}

const SRV_HEAD = `<div class="ca-note">酒馆自己存在服务器上的备份，每个角色留最近 50 份。和在宝塔、1Panel 里翻 backups 文件夹看到的是同一批文件。时间按服务器的时钟。</div>
        <div class="ca-banner-acts"><div class="menu_button" data-act="srv-refresh">刷新</div></div>`;

/** 「正在读取…已等 N 秒」里的秒数每秒更新一次，不重画整个面板。 */
function tickServerWait() {
    clearTimeout(P.srvTick);
    P.srvTick = setTimeout(() => {
        const el = P.root?.querySelector('[data-srv-wait]');
        if (!el || !S.srvJob) return;
        const secs = Math.round((Date.now() - S.srvJob.startedAt) / 1000);
        el.textContent = secs >= 2 ? `已等 ${secs} 秒。` : '';
        tickServerWait();
    }, 1000);
}

/** 读不出来（504 / 超时）时给的处理办法：小锚改不了服务器，只能告诉用户怎么把目录弄小。 */
const SRV_SLOW_HELP = `<div class="ca-note">这说明酒馆在服务器上读备份目录读了太久：每张卡留 50 份，每份都是整个聊天的完整副本，目录一大酒馆就要读好几分钟，反向代理（宝塔 / 1Panel / 云平台）一般等 60 秒就放弃。小锚改不了服务器，能做的是：<br>
1. 到宝塔 / 1Panel 的文件管理打开 酒馆/data/&lt;用户&gt;/backups/，按时间排序，把旧的 chat_*.jsonl 删掉一批（只是备份，不影响聊天本身）。<br>
2. 酒馆目录下 config.yaml：backups.common.numberOfBackups 从 50 改成 10，backups.chat.maxTotalBackups 从 -1 改成 200，重启酒馆，然后随便发一条消息：酒馆会在这次保存时自动把目录裁到 200 份，以后也不会再长大。做了这步第 1 步可以不做。<br>
3. 反代配置里把 proxy_read_timeout 加到 300 秒。<br>
点「再试一次」前先等两分钟：代理放弃了，酒馆可能还在读上一次的。</div>`;

async function renderServer(info) {
    loadSrvCache();
    const stale = !S.srv || Date.now() - S.srv.at > SRV_TTL;
    if (stale && !S.srvJob && !S.srvLast?.error) serverBackups().catch(() => { }); // 没有或过期：后台去读，错误记在 S.srvLast
    if (!S.srv) {
        if (S.srvJob) {
            tickServerWait();
            return `${SRV_HEAD}<div class="ca-empty">正在读取服务器上的备份… <span data-srv-wait></span><br>酒馆要把服务器上每一份备份都读一遍，备份多就慢。可以先去别的页，读完会自动显示。</div>`;
        }
        const err = S.srvLast?.error;
        return `${SRV_HEAD}<div class="ca-empty">${esc(err || '还没有读取')}</div>${srvIsSlowError(err) ? SRV_SLOW_HELP : ''}<div class="ca-banner-acts"><div class="menu_button" data-act="srv-refresh">再试一次</div></div>`;
    }
    const rows = S.srv.rows;
    let head = SRV_HEAD;
    if (S.srvJob) { tickServerWait(); head += '<div class="ca-note">正在重新读取… <span data-srv-wait></span></div>'; }
    else if (S.srvLast?.error && S.srvLast.at > S.srv.at) head += `<div class="ca-note">刚才没刷新成功：${esc(S.srvLast.error)}。下面是上一次读到的列表（${fmtDay(S.srv.at)} ${fmtTime(S.srv.at)}）。</div>${srvIsSlowError(S.srvLast.error) ? SRV_SLOW_HELP : ''}`;
    else head += `<div class="ca-note">列表读取于 ${fmtDay(S.srv.at)} ${fmtTime(S.srv.at)}${S.srv.cached ? '（上次记住的）' : ''}。要看最新的点「刷新」。</div>`;
    const ownerOf = backupOwners();
    const groups = new Map();
    for (const r of rows) { if (!groups.has(r.key)) groups.set(r.key, []); groups.get(r.key).push(r); }
    if (!groups.size) return head + '<div class="ca-empty">服务器上没有聊天备份。<br>可能是酒馆配置里关掉了备份。</div>';

    if (P.srvKey === undefined) { // 默认打开当前角色
        const card = info?.kind === 'c' ? String(info.avatar).replace('.png', '') : null;
        const mine = card && [backupKeyOf(card), backupKeyOf(card, false)].find(k => groups.has(k));
        P.srvKey = mine || null;
    }
    if (P.srvKey && groups.has(P.srvKey)) {
        const list = groups.get(P.srvKey);
        const owner = ownerOf(P.srvKey);
        let html = `${head}<button type="button" class="ca-back" data-act="srv-back"><i class="fa-solid fa-chevron-left"></i>全部角色</button>
            <div class="ca-chat-name">${owner ? esc(owner.name) : '认不出的角色'}</div><div class="ca-chat-file">这个角色下所有聊天的备份都在这里，共 ${list.length} 份</div><ol class="ca-line">`;
        list.forEach((r, i) => {
            const older = list[i + 1], newer = list[i - 1];
            const delta = older ? r.count - older.count : 0;
            const before = !!newer && r.count >= 10 && newer.count <= r.count / 2; // 下一份突然少了一半以上
            html += `<li class="ca-snap${before ? ' is-locked is-drop' : ''}" data-file="${esc(r.file)}">
                <div class="ca-snap-head"><time>${r.when}</time><span class="ca-floors">${r.count} 楼</span>${delta ? `<span class="ca-delta${delta < 0 ? ' is-neg' : ''}">${delta > 0 ? '+' : '−'}${Math.abs(delta)}</span>` : ''}${before ? '<span class="ca-tag">掉楼前</span>' : ''}</div>
                <div class="ca-prev">${esc(r.preview) || '（空消息）'}　${esc(r.size)}</div>
                <div class="ca-acts"><div class="menu_button" data-act="srv-restore">恢复成新聊天</div>
                <button type="button" class="ca-icon" data-act="srv-preview" title="预览最后 60 楼" aria-label="预览"><i class="fa-solid fa-eye"></i></button>
                <button type="button" class="ca-icon" data-act="srv-export" title="导出 .jsonl 文件" aria-label="导出"><i class="fa-solid fa-file-export"></i></button></div></li>`;
        });
        return html + '</ol>';
    }
    P.srvKey = null;
    return head + '<ul class="ca-chats">' + [...groups.entries()].map(([key, list]) => {
        const owner = ownerOf(key);
        return `<li class="ca-chat" data-act="srv-view" data-skey="${esc(key)}"><div class="ca-chat-main">
            <div class="ca-chat-name">${owner ? esc(owner.name) : '认不出的角色'}</div>
            <div class="ca-chat-meta">${list.length} 份备份，最多 ${Math.max(...list.map(r => r.count))} 楼，最近一份 ${list[0].when}</div>
            ${owner ? '' : `<div class="ca-prev">${esc(list[0].preview)}</div>`}</div><i class="fa-solid fa-chevron-right ca-chev"></i></li>`;
    }).join('') + '</ul>';
}

async function renderLog() {
    const rows = (await dbAll('log')).slice(-150).reverse();
    const head = '<div class="ca-note">读取失败、保存失败、掉楼、恢复都会记在这里。排查问题时点「复制记录」发给帮你看的人。</div><div class="ca-banner-acts"><div class="menu_button" data-act="copy-log">复制记录</div></div>';
    if (!rows.length) return head + '<div class="ca-empty">目前一切正常，没有记录。</div>';
    return head + '<ul class="ca-log">' + rows.map(r => `<li><time>${fmtDay(r.ts)} ${fmtTime(r.ts)}</time><b class="${/失败|掉楼/.test(r.type) ? 'is-bad' : ''}">${esc(r.type)}</b> ${esc(r.msg)}</li>`).join('') + '</ul>';
}

async function renderSettings() {
    const st = settings();
    const [chats, snaps] = await Promise.all([dbAll('chats'), tx(['snaps'], 'readonly', t => { const o = {}; t.objectStore('snaps').count().onsuccess = e => { o.v = e.target.result; }; return o; }).then(o => o.v)]);
    let usage = '';
    try { const est = await navigator.storage?.estimate?.(); if (est?.usage) usage = `，本站一共占用 ${fmtSize(est.usage)}`; } catch { /* 不支持就不显示 */ }
    const toggle = (k, title, desc) => `<label class="ca-row"><span><b>${title}</b><small>${desc}</small></span><input type="checkbox" data-set="${k}" ${st[k] ? 'checked' : ''}></label>`;
    const num = (k, title, desc, min, max) => `<label class="ca-row"><span><b>${title}</b><small>${desc}</small></span><input type="number" class="text_pole" data-set="${k}" min="${min}" max="${max}" value="${st[k]}"></label>`;
    return toggle('guard', '读取失败时暂停保存', '聊天没读出来时，不让开场白盖掉服务器上的存档')
        + toggle('enabled', '自动快照', '发消息、收到回复、编辑、删除之后各存一份，内容没变就跳过')
        + toggle('alertDrop', '掉楼提醒', '打开聊天时发现比上次快照少楼，弹出提示')
        + toggle('retrySave', '保存失败自动重试', '没存上服务器时，隔 3 秒、8 秒、20 秒各再试一次')
        + num('recent', '最近保留几份', '最新的这几份一定留着', 3, 100)
        + num('days', '按天保留几天', '更早的快照：24 小时内每小时留 1 份，之后每天留 1 份', 1, 60)
        + num('maxChats', '最多保留几个聊天', '超出后清掉最久没动的聊天（有锁定快照的不清）', 3, 200)
        + `<label class="ca-row is-stack"><span><b>忽略这些字段的变化</b><small>别的扩展往消息里写的记账信息（比如 extra.stImageAtelier）单独变了不存快照。逗号分隔；点快照旁的「改了什么」可以直接加。</small></span><input type="text" class="text_pole" data-set="ignore" value="${esc(st.ignore.join(', '))}" placeholder="无"></label>`
        + `<div class="ca-note">现在有 ${chats.length} 个聊天、${snaps} 份快照${usage}。<br>快照存在这台设备的浏览器里：换设备、清除网站数据、卸载 App 后就没有了。重要的聊天请用「导出」另存一份。</div>
        <div class="ca-banner-acts"><div class="menu_button" data-act="wipe">清空全部快照</div></div>`;
}

function onPanelChange(e) {
    const el = e.target.closest('[data-set]');
    if (!el) return;
    const st = settings();
    const k = el.dataset.set;
    if (el.type === 'checkbox') st[k] = el.checked;
    else if (k === 'ignore') { st.ignore = [...new Set(String(el.value).split(/[,，;；\s]+/).map(x => x.trim()).filter(Boolean))]; el.value = st.ignore.join(', '); S.last.clear(); }
    else {
        const v = Math.round(Number(el.value));
        const min = Number(el.min), max = Number(el.max);
        st[k] = Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : DEFAULTS[k];
        el.value = st[k];
    }
    ctx().saveSettingsDebounced();
}

async function onPanelClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el || !P.root?.contains(el)) return;
    const act = el.dataset.act;
    const c = ctx();
    const id = el.dataset.id || el.closest('[data-id]')?.dataset.id;
    const yes = async (title, text) => (await c.Popup.show.confirm(title, text)) === c.POPUP_RESULT.AFFIRMATIVE;

    if (act === 'tab') { P.tab = el.dataset.tab; P.viewKey = null; P.srvKey = undefined; return refreshPanel(); }
    if (act === 'back') { P.viewKey = null; return refreshPanel(); }
    if (act === 'view') { P.viewKey = el.dataset.key; return refreshPanel(); }
    if (act === 'reload') { await closePanel(); return ctx().reloadCurrentChat(); }
    if (act === 'snap-now') {
        if (!currentChat()) return toast('info', '先打开一个聊天。');
        const snap = await takeSnapshot('manual', { force: true, lock: true });
        toast(snap ? 'success' : 'info', snap ? `已存下 ${snap.count} 楼并锁定。` : '现在没有可以存的内容。');
        return refreshPanel();
    }
    if (act === 'ack') {
        const rec = await dbGet('chats', el.dataset.key);
        if (rec) await enqueue(() => dbPut('chats', { ...rec, alert: null }));
        return refreshPanel();
    }
    if (act === 'copy-log') {
        const rows = (await dbAll('log')).slice(-150);
        const text = rows.map(r => `${new Date(r.ts).toLocaleString()} [${r.type}] ${r.msg}`).join('\n') || '（没有记录）';
        try { await navigator.clipboard.writeText(text); toast('success', '记录已复制。'); }
        catch { await c.callGenericPopup(Object.assign(document.createElement('textarea'), { className: 'text_pole ca-preview', value: text, readOnly: true }), c.POPUP_TYPE.TEXT, '', { wide: true, okButton: '关闭' }); }
        return;
    }
    if (act === 'wipe') {
        if (!await yes('清空全部快照？', '所有聊天的快照都会删除，包括锁定的。服务器上的聊天不受影响。')) return;
        await enqueue(async () => {
            await tx(['snaps', 'blobs', 'chats'], 'readwrite', t => { for (const n of ['snaps', 'blobs', 'chats']) t.objectStore(n).clear(); });
            S.known = { key: null, set: new Set() }; S.last.clear();
        });
        return refreshPanel();
    }
    if (act === 'del-chat') {
        e.stopPropagation();
        if (!await yes('删除这个聊天的全部快照？', '只删快照，服务器上的聊天不受影响。')) return;
        await enqueue(() => deleteChatData(el.dataset.key));
        return refreshPanel();
    }
    if (act === 'srv-refresh') { serverBackups(true).catch(() => { }); return refreshPanel(); } // 正在读就不再发第二个请求
    if (act === 'srv-back') { P.srvKey = null; return refreshPanel(); }
    if (act === 'srv-view') { P.srvKey = el.dataset.skey; return refreshPanel(); }
    if (act.startsWith('srv-')) {
        const file = el.closest('[data-file]')?.dataset.file;
        if (!file) return;
        if (act === 'srv-preview') return showPreview(legacyLines(await serverText(file)));
        if (act === 'srv-export') return saveFile(file, await serverText(file));
        if (act === 'srv-restore') {
            const pop = P.popup;
            const name = await serverRestore(file);
            if (name) { if (P.popup === pop) await closePanel(); toast('success', `已恢复成新聊天「${name}」。`); }
        }
        return;
    }
    if (act.startsWith('old-')) {
        const li = el.closest('[data-lk]');
        const lk = li?.dataset.lk, lt = li?.dataset.lt;
        if (!lk) return;
        if (act === 'old-export') return legacyExport(lk, lt);
        if (act === 'old-preview') return showPreview(legacyLines(await legacyContent(lk, lt)));
        if (act === 'old-import') {
            const pop = P.popup;
            const name = await legacyImport(lk, lt);
            if (name) { if (P.popup === pop) await closePanel(); toast('success', `已导入成新聊天「${name}」。`); }
        }
        return;
    }
    if (!id) return;
    if (act === 'why') return showWhy(id, el.dataset.prev);
    if (act === 'preview') return previewSnap(id);
    if (act === 'export') return exportSnap(id);
    if (act === 'lock') {
        await enqueue(async () => { const s = await dbGet('snaps', id); if (s) await dbPut('snaps', { ...s, locked: !s.locked, lockReason: s.locked ? '' : 'manual' }); });
        return refreshPanel();
    }
    if (act === 'del') {
        const s = await getSnap(id);
        if (s.locked && !await yes('删除锁定的快照？', '这份快照是锁定的，删除后无法找回。')) return;
        await enqueue(async () => {
            await tx(['snaps'], 'readwrite', t => { t.objectStore('snaps').delete(id); });
            await prune(s.chatKey, true);
            const latest = (await snapsOf(s.chatKey))[0];
            S.last.set(s.chatKey, latest ? { sig: latest.sig, ts: latest.ts } : { sig: null, ts: 0 });
        });
        return refreshPanel();
    }
    if (act === 'restore') {
        const s = await getSnap(id);
        const canInPlace = currentChat()?.key === s.chatKey;
        const html = `<div class="ca-dialog"><h3>恢复 ${fmtDay(s.ts)} ${fmtTime(s.ts)} 的快照（${s.count} 楼）</h3>
            ${canInPlace ? '<p><b>覆盖当前聊天</b>：聊天文件名不变。覆盖前会把现在的内容另存一份锁定快照，可以反悔。</p>' : ''}
            <p><b>恢复成新聊天</b>：在这个角色下新建一个聊天，现有的聊天都不动。</p></div>`;
        const res = await c.callGenericPopup(html, c.POPUP_TYPE.TEXT, '', {
            okButton: canInPlace ? '覆盖当前聊天' : false, cancelButton: '取消',
            customButtons: [{ text: '恢复成新聊天', result: 2 }],
        });
        if (res !== c.POPUP_RESULT.AFFIRMATIVE && res !== 2) return;
        await closePanel();
        if (res === 2) { const name = await restoreAsNew(id); if (name) toast('success', `已恢复成新聊天「${name}」。`); }
        else { const saved = await restoreInPlace(id); if (saved) toast('success', `已恢复到 ${s.count} 楼。`); }
    }
}

// ───────────────────────── 启动 ─────────────────────────
function addEntryPoints() {
    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('ca_wand')) {
        const item = document.createElement('div');
        item.id = 'ca_wand';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = '<div class="fa-solid fa-anchor extensionsMenuExtensionButton"></div><span>小锚快照</span>';
        item.addEventListener('click', () => openPanel('cur'));
        menu.appendChild(item);
    }
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (host && !document.getElementById('ca_drawer')) {
        const box = document.createElement('div');
        box.id = 'ca_drawer';
        box.innerHTML = `<div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>小锚（聊天快照）</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <div class="menu_button" id="ca_open"><i class="fa-solid fa-anchor"></i><span>打开小锚</span></div>
                <small>查看快照、恢复聊天、调整设置。也可以从输入框旁的魔法棒菜单打开。</small>
            </div></div>`;
        box.querySelector('#ca_open').addEventListener('click', () => openPanel('cur'));
        host.appendChild(box);
    }
}

let started = false;
function start() {
    if (started) return;
    started = true;
    const c = ctx();
    const ev = c.eventTypes || c.event_types || {};
    const on = (name, fn) => { if (name) c.eventSource.on(name, fn); };
    settings();
    addEntryPoints();

    on(ev.CHAT_CHANGED, () => { onChatChanged().catch(warn); });
    on(ev.MESSAGE_SENT, () => schedule(300));
    for (const name of [ev.MESSAGE_RECEIVED, ev.GENERATION_ENDED, ev.GENERATION_STOPPED, ev.MESSAGE_EDITED, ev.MESSAGE_UPDATED,
        ev.MESSAGE_SWIPED, ev.MESSAGE_SWIPE_DELETED, ev.MESSAGE_DELETED, ev.MESSAGE_REASONING_EDITED, ev.MESSAGE_REASONING_DELETED]) {
        on(name, () => schedule(1200));
    }
    // 切到后台前立刻存一份：手机上页面随时可能被系统回收
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && settings().enabled) { clearTimeout(S.timer); S.timer = null; takeSnapshot('hidden').catch(warn); } });
    window.addEventListener('pagehide', () => { if (S.timer) { clearTimeout(S.timer); S.timer = null; takeSnapshot('hidden').catch(warn); } });
    window.addEventListener('online', () => { const k = currentChat()?.key; const ls = k && S.lastSave.get(k); if (ls && !ls.ok && settings().retrySave) ctx().saveChat(); });

    try { navigator.storage?.persist?.().catch(() => { }); } catch { /* 不支持就算了 */ }
    setTimeout(() => maintenance().catch(warn), 20000);
    if (currentChat()) onChatChanged().catch(warn);
    console.log(TAG, '已启动');
}

installFetchGuard(); // 尽早装上，赶在第一次读取聊天之前
try {
    const c = ctx();
    const ready = (c.eventTypes || c.event_types || {}).APP_READY;
    if (ready) c.eventSource.on(ready, start);
    setTimeout(start, 5000); // 兜底：老版本没有 APP_READY 的粘性事件
} catch (e) { warn('启动失败', e); }

// 调试 / 自动化入口
globalThis.ChatAnchor = {
    open: openPanel, snapshot: takeSnapshot, restoreInPlace, restoreAsNew, exportSnap,
    list: async key => snapsOf(key || currentChat()?.key),
    stats: async () => ({ chats: (await dbAll('chats')).length, snaps: (await dbAll('snaps')).length, blobs: (await blobKeysOf(currentChat()?.key)).length }),
    log: () => dbAll('log'),
    diff: diffSnaps,
    legacy: { list: legacyList, importAsNew: legacyImport, exportFile: legacyExport },
    server: { list: serverBackups, restore: serverRestore, keyOf: backupKeyOf, sha256: sha256Hex },
    state: S,
};
