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
const VERSION = '1.2.12'; // 和 manifest.json 保持一致（测试会核对）
const TAG = '[小锚]';
const DB_NAME = 'ST_ChatAnchor';
const DB_VER = 1;
const HOUR = 3600e3;
const DAY = 86400e3;
const DEFAULTS = Object.freeze({
    enabled: true,    // 自动快照
    guard: true,      // 读取失败时暂停保存
    retrySave: true,  // 保存失败自动重试
    gzipSaves: true,  // 大的保存请求由小锚 gzip 后再发
    alertDrop: true,  // 掉楼提醒
    recent: 12,       // 最近 N 份无条件保留
    days: 7,          // 之后每天留 1 份，留几天
    maxChats: 30,     // 最多为多少个聊天保留快照
    slimTags: '',     // 瘦身时清掉老楼正文里 <标签>…</标签> 整段的标签名，逗号分隔，如「灵魂梳理」
});

const ctx = () => globalThis.SillyTavern.getContext();
const warn = (...a) => console.warn(TAG, ...a);
const tick = () => new Promise(r => setTimeout(r, 0));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[m]));
const toast = (kind, msg, opts = {}) => { try { globalThis.toastr?.[kind]?.(msg, '小锚', opts); } catch { /* 没有 toastr 也不影响功能 */ } };
/** 一直显示的提示，返回一个函数，调用它关掉这条提示 */
const toastHold = msg => {
    let el = null;
    try { el = globalThis.toastr?.info?.(msg, '小锚', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false }); } catch { /* 同上 */ }
    return () => { try { if (el) globalThis.toastr?.clear?.(el); } catch { /* 同上 */ } };
};

const S = {
    queue: Promise.resolve(),              // 所有写库操作排队执行
    timer: null,                           // 防抖定时器
    known: { key: null, set: new Set() },  // 当前聊天已入库的楼层哈希
    last: new Map(),                       // key -> { sig, ts }
    poison: new Map(),                     // key -> { at, confirmed, okSeen, released, detail }
    lastSave: new Map(),                   // key -> { ok, at } 或 { ok: false, at, detail, status, since, fails }：since/fails 是这一段连续没存上的起点和次数
    retry: { key: null, n: 0, timer: null, toasted: false },
    retryQuick: [3000, 8000, 20000],       // 没存上后先快速试这几次（毫秒）
    retrySlow: [60000, 120000, 300000],    // 还不行且是临时故障：按这个间隔慢慢试，最后一个值一直用下去
    saveToast: null,                       // 一直没存上时挂着的那条提示 { key, el }
    loading: new Map(),                    // key -> 正在进行的读取请求数（读取期间的空聊天不许存，也不自己发起保存）
    slimHint: null,                        // 「当前」页瘦身提示的缓存 { sig, at, bytes, parts }
    slimHintMin: 1048576,                  // 老楼里可清的超过这么多才在「当前」页提示
    msgCache: new WeakMap(),               // 消息对象 -> { fp, hash, sig, len }：大聊天只重算变过的楼
    gzipAbove: 4 * 1048576,                // 保存请求体超过这个字节数就由小锚压缩（酒馆自己只压 8 MB 以下的）
    gzipBroken: false,                     // 服务器不认压缩的请求体：这个会话内不再压
    gzipLogged: new Set(),                 // 每个聊天只记一次「已压缩」
    dirty: new Set(),                      // 酒馆事件报过的楼号，下次快照必须重算
    forceFull: false,                      // 删过楼：下次快照全量重算
    lastFull: new Map(),                   // key -> 上次全量重算的时间
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
    if (typeof s.slimTags !== 'string') s.slimTags = '';
    if (!s.slimLast || typeof s.slimLast !== 'object') s.slimLast = null; // 上一次确认并做完的瘦身选项 { dup, reasoning, alt, tags }
    return s;
}

/**
 * 一楼的"便宜指纹"：不序列化，只看长度和键数。几十 MB 的聊天每次快照都 stringify 一遍太费手机，
 * 所以老楼指纹没变就先信上次算好的哈希；指纹变了、酒馆报过事件、最后 30 楼、以及每 10 分钟一次的全量核对，才真正重算。
 */
function fingerprint(m) {
    let fp = `${m.mes?.length ?? -1}|${m.swipe_id ?? ''}|${m.name ?? ''}|${m.send_date ?? ''}|${m.gen_finished ?? ''}|${Object.keys(m).length}`;
    if (Array.isArray(m.swipes)) { let t = 0; for (const x of m.swipes) t += (x?.length | 0); fp += `|s${m.swipes.length}:${t}`; }
    const ex = m.extra;
    if (ex && typeof ex === 'object') {
        for (const k in ex) {
            const v = ex[k];
            fp += `|${k}:${typeof v === 'string' ? v.length : Array.isArray(v) ? 'a' + v.length : v && typeof v === 'object' ? 'o' + Object.keys(v).length : v}`;
        }
    }
    return fp;
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

async function doSnapshot(reason, { force = false, lock = false, full: fullOpt = false } = {}) {
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
    await ensureChatState(info.key);
    const known = S.known.set;
    const dirty = S.dirty;
    S.dirty = new Set();
    // 全量：打开聊天、手动、恢复前、删过楼、或者距上次全量超过 10 分钟。其余只重算尾部 30 楼和变过的楼
    const full = fullOpt || S.forceFull || (reason !== 'auto' && reason !== 'hidden') || Date.now() - (S.lastFull.get(info.key) || 0) > 600000;
    S.forceFull = false;
    const tailFrom = Math.max(0, msgs.length - 30);
    const hashes = new Array(msgs.length);
    const sigs = new Array(msgs.length); // 判断"有没有变"用：跳过忽略字段。blob 的哈希仍按完整内容算
    const fresh = new Map();
    let total = 0, reused = 0;
    let t0 = performance.now();
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const isObj = !!m && typeof m === 'object';
        const fp = isObj ? fingerprint(m) : String(m);
        const cached = isObj ? S.msgCache.get(m) : undefined;
        if (!full && cached && cached.fp === fp && i < tailFrom && !dirty.has(i) && known.has(cached.hash)) {
            hashes[i] = cached.hash; sigs[i] = cached.sig; total += cached.len; reused++;
            continue;
        }
        const j = JSON.stringify(m) ?? 'null';
        const h = hashOf(j);
        hashes[i] = h;
        sigs[i] = ignoreMsg.length ? hashOf(JSON.stringify(stripFields(m, ignoreMsg)) ?? 'null') : h;
        total += j.length;
        if (!known.has(h)) fresh.set(h, j);
        if (isObj) S.msgCache.set(m, { fp, hash: h, sig: sigs[i], len: j.length });
        if (performance.now() - t0 > 10) { // 分片，不卡界面
            await tick();
            if (currentChat()?.key !== info.key) return null;
            t0 = performance.now();
        }
    }
    if (full) S.lastFull.set(info.key, Date.now());
    const metaHash = 'M' + hashOf(metaJson);
    const metaSig = ignoreMeta.length ? 'M' + hashOf(JSON.stringify(stripFields(c.chatMetadata ?? {}, ignoreMeta))) : metaHash;
    const sig = hashOf(sigs.join(',') + '|' + metaSig);

    const last = S.last.get(info.key);
    if (!force && last.sig === sig) return null;
    if (!known.has(metaHash)) fresh.set(metaHash, metaJson);

    const ts = Math.max(Date.now(), last.ts + 1);
    const pv = previewOf(msgs[msgs.length - 1]);
    const snap = {
        id: info.key + '#' + ts, chatKey: info.key, ts, count: msgs.length, hashes, meta: metaHash, sig,
        name: pv.name, preview: pv.text, reason, locked: !!lock, lockReason: lock ? reason : '', size: total, full, reused,
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
    if (S.saveToast && S.saveToast.key !== info?.key) clearSaveToast();
    S.slimHint = null;
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
            <p>「${esc(info.chatName)}」没有读出来${p.detail ? `（${esc(p.detail)}）` : ''}。屏幕上现在是空的或只剩开场白，服务器上的存档没有被改动。</p>
            <p>为了不让开场白盖掉存档，小锚已暂停保存这个聊天。重新读取成功后会自动恢复正常。</p>
            ${/内容是空的/.test(p.detail || '') ? '<p class="ca-note">如果重新读取几次都这样：要么服务器这会儿读不出文件，过一会儿再试；要么服务器上的存档真的已经空了（比如在别的设备上清空过）。后一种情况点「解除暂停」，再到小锚里用快照恢复。</p>' : ''}
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

/**
 * 聊天正在读取、内存里还是空的，这时候的保存请求里没有任何楼层，放过去就是拿空聊天盖掉服务器上的存档。
 * 酒馆自己在清空聊天时会取消排队中的保存，但别的扩展（以及小锚自己的补存定时器）不一定。
 */
function emptyDuringLoad(info) {
    return !!settings().guard && !!info.key && info.key === info.cur && (S.loading.get(info.key) || 0) > 0 && ctx().chat.length === 0;
}

function onBlocked(info, loading = false) {
    logEvent('守门', loading ? `拦下一次保存：「${nameOf(info.key)}」正在读取，内容还是空的` : `拦下一次保存：「${nameOf(info.key)}」还没读取成功`);
    if (Date.now() - S.blockToastAt > 8000) {
        S.blockToastAt = Date.now();
        toast('warning', loading ? '聊天还在读取，这次保存已拦下，服务器上的存档没有被动。' : '聊天还没读取成功，这次保存已拦下，服务器上的存档没有被覆盖。');
    }
}

// ───────────────────────── 保存失败：记账、说人话、补存 ─────────────────────────
/** 值得隔一会儿再试的失败：断网、服务器没响应。413、403 这类要人处理的，试多少次都一样 */
const isTransient = status => [0, 408, 429, 500, 502, 503, 504].includes(status);

/** 把保存失败翻成大白话：why 是原因，todo 是该怎么办，refresh 表示只有刷新页面才能好 */
function explainSave(ls) {
    const status = Number(ls?.status) || 0;
    const detail = String(ls?.detail || '');
    const auto = settings().retrySave ? '小锚会隔几分钟自动再试，恢复后自动补存，不用做什么。' : '恢复后点下面的「现在再存一次」。';
    if (/"integrity"/.test(detail)) return { why: '服务器上的这个聊天被别的设备或别的标签页改过，酒馆为了防止互相覆盖拦下了保存', todo: '按酒馆弹出的提示处理。拿不准就先点右上角「立即快照」。' };
    if (!status) return { why: '连不上服务器，可能是手机断网、信号差，或者服务器没开', todo: auto };
    if (status === 413) {
        return { why: '聊天整份上传太大，被服务器前面的反代拒绝了（HTTP 413）',
            todo: settings().gzipSaves && typeof CompressionStream === 'function' && !S.gzipBroken
                ? '先点「体检」做一次瘦身，再点下面的按钮。根治要把反代的上传上限调大（nginx 的 client_max_body_size）。'
                : '到「设置」里打开「大聊天保存时压缩」，再点下面的按钮。还不行就先「体检」瘦身。' };
    }
    if (status === 401) return { why: '服务器要求重新登录（HTTP 401）', todo: '新开一个标签页打开酒馆登录一次，再回到这里点下面的按钮。' };
    if (status === 403 && /csrf/i.test(detail)) return { why: '这个页面的登录凭证失效了（HTTP 403）', todo: '只有刷新页面才能恢复。刷新前先点右上角「立即快照」，刷新后如果少了内容，回到小锚用最新的快照恢复。', refresh: true };
    if (status === 403) return { why: '服务器拒绝了这次保存（HTTP 403），可能是登录过期或被安全设置拦了', todo: '新开一个标签页看酒馆还能不能正常打开，再回到这里点下面的按钮。' };
    if (status === 400) return { why: '服务器说收到的内容不对（HTTP 400），多半是请求在半路被代理或网关弄坏了', todo: '点下面的按钮再试一次。一直这样就到「记录」页点「复制记录」，发给帮你看的人。' };
    if (status === 500) return { why: '酒馆服务器内部出错（HTTP 500），常见的是服务器磁盘满了或文件写不进去', todo: `去服务器上看酒馆的日志。${auto}` };
    if (status === 502 || status === 503 || status === 504) return { why: `服务器没有响应（HTTP ${status}），酒馆可能在重启或者没开`, todo: auto };
    return { why: `保存被拒绝（HTTP ${status}）`, todo: '点下面的按钮再试一次。一直这样就到「记录」页点「复制记录」，发给帮你看的人。' };
}

/** 小锚自己发起的保存（补存、回到页面、手动按钮）只在聊天确实在内存里的时候做。酒馆重新读取时会先把聊天清空，所以空着就不存 */
function canSaveNow(key) {
    return !!key && currentChat()?.key === key && ctx().chat.length > 0;
}

/** 小锚记得这个聊天有几楼（最近一份快照的楼数）。读库最多等 0.8 秒，读不到就当不知道 */
async function knownFloors(key) {
    try {
        const rec = await Promise.race([dbGet('chats', key), sleep(800).then(() => null)]);
        return Number(rec?.lastCount) || 0;
    } catch { return 0; }
}

/** 先探一下服务器在不在，免得把几十 MB 传给一个没开的服务器 */
async function serverReachable() {
    try { return (await fetch('/csrf-token', { cache: 'no-store' })).ok; } catch { return false; }
}

function clearSaveToast() {
    const t = S.saveToast;
    S.saveToast = null;
    try { if (t?.el) globalThis.toastr?.clear?.(t.el); } catch { /* 已经消失 */ }
}

/** 保存状态变了：更新面板顶部的横幅；快速重试用完还没存上，就挂一条不会自己消失的提示 */
function saveStateChanged(key) {
    try {
        updateSaveBanner();
        const ls = S.lastSave.get(key);
        const failing = ls && !ls.ok && key === currentChat()?.key;
        if (!failing) { if (S.saveToast?.key === key) clearSaveToast(); return; }
        if (S.saveToast?.key === key || /"integrity"/.test(ls.detail)) return; // 已经挂过了；完整性问题酒馆自己会弹窗
        if (ls.fails < 4 && Date.now() - ls.since < 30000) return;              // 先让快速重试试完
        clearSaveToast();
        const mark = { key, el: null };
        S.saveToast = mark;
        mark.el = globalThis.toastr?.warning?.(`「${nameOf(key)}」一直没能存到服务器：${explainSave(ls).why}。点这里看怎么办。`, '小锚',
            { timeOut: 0, extendedTimeOut: 0, onclick: () => { mark.el = null; openPanel('cur'); } }) || null; // 点过以后这一段不再弹，标记留着
    } catch (e) { warn(e); }
}

function saveBannerHtml() {
    const info = currentChat();
    const ls = info && S.lastSave.get(info.key);
    if (!ls || ls.ok) return '';
    const x = explainSave(ls);
    const day = fmtDay(ls.since);
    return `<div class="ca-banner" data-save-banner><b>这个聊天从${day === '今天' ? '' : ` ${day}`} ${fmtTime(ls.since)} 起就没能存到服务器</b>（试了 ${ls.fails} 次）。
        <div>原因：${esc(x.why)}。</div>
        <div>怎么办：${esc(x.todo)}</div>
        <div class="ca-note">${x.refresh ? '没存上的内容在小锚的快照里。' : '这段时间的内容都在小锚的快照里，没有丢。先别刷新页面。'}</div>
        <div class="ca-banner-acts"><div class="menu_button" data-act="save-now">现在再存一次</div></div></div>`;
}

/** 只改横幅那一块，不重画整个面板（用户可能正在设置页打字） */
function updateSaveBanner() {
    const slot = P.root?.querySelector('[data-save-slot]');
    if (!slot) return;
    const html = saveBannerHtml();
    if (P.saveHtml !== html) { P.saveHtml = html; slot.innerHTML = html; }
}

function onSaveSettled(info, resp, err) {
    const key = info.key;
    if (resp?.ok) {
        const prev = S.lastSave.get(key);
        S.lastSave.set(key, { ok: true, at: Date.now() });
        if (prev && !prev.ok) { // 一段没存上的时间结束了
            const mins = Math.max(1, Math.round((Date.now() - prev.since) / 60000));
            logEvent('补存', `「${nameOf(key)}」补存成功（之前 ${prev.fails} 次没存上，前后约 ${mins} 分钟）`);
            if ((S.retry.key === key && S.retry.toasted) || S.saveToast?.key === key) toast('success', '刚才没存上的内容已经补存到服务器。');
        }
        if (S.retry.key === key) { clearTimeout(S.retry.timer); S.retry = { key: null, n: 0, timer: null, toasted: false }; }
        saveStateChanged(key);
        return;
    }
    const finish = (detail, status) => {
        const prev = S.lastSave.get(key);
        const cont = !!prev && !prev.ok;
        S.lastSave.set(key, { ok: false, at: Date.now(), detail, status, since: cont ? prev.since : Date.now(), fails: cont ? prev.fails + 1 : 1 });
        if (/"integrity"/.test(detail)) { logEvent('保存失败', `「${nameOf(key)}」完整性校验未通过（酒馆会自己弹窗处理）`); saveStateChanged(key); return; }
        logEvent('保存失败', `「${nameOf(key)}」${detail}`);
        if (key && key === currentChat()?.key) {
            takeSnapshot('auto').catch(warn); // 确保没存上的内容至少在本地有一份
            scheduleRetry(key, detail, status);
        }
        saveStateChanged(key);
    };
    if (resp) resp.clone().text().then(t => finish(`HTTP ${resp.status} ${t.slice(0, 200)}`, resp.status), () => finish(`HTTP ${resp.status}`, resp.status));
    else finish(`网络错误 ${err?.message || err}`, 0);
}

/**
 * 补存。先快速试三次（3 / 8 / 20 秒）；还不行的话，断网、服务器没响应这类临时故障改成隔几分钟试一次，
 * 每次先探一下服务器在不在（不白传几十 MB），最多两小时。413、403 这类要人处理的不再自动试。
 */
function scheduleRetry(key, detail, status) {
    if (!settings().retrySave) return;
    if (S.retry.key !== key) { clearTimeout(S.retry.timer); S.retry = { key, n: 0, timer: null, toasted: false }; }
    const r = S.retry;
    if (!r.toasted) { r.toasted = true; toast('warning', `这次没能存到服务器：${explainSave({ status, detail }).why}。内容已在本地快照里，稍后自动重试。`, { timeOut: 8000 }); }
    const quick = S.retryQuick, slow = S.retrySlow;
    let delay, probe = false;
    if (r.n < quick.length) delay = quick[r.n];
    else {
        if (!r.logged) { r.logged = true; logEvent('补存', `「${nameOf(key)}」重试 ${quick.length} 次仍失败，${isTransient(status) ? '之后隔几分钟再试' : '等下次保存'}`); }
        if (!isTransient(status) || r.n >= quick.length + 26) return;
        delay = slow[Math.min(r.n - quick.length, slow.length - 1)];
        probe = true;
    }
    clearTimeout(r.timer);
    r.timer = setTimeout(async () => {
        if (S.retry !== r || currentChat()?.key !== key) return;
        r.n++;
        if (!canSaveNow(key) || (probe && !(await serverReachable()))) return scheduleRetry(key, detail, status); // 聊天正在读取，或者服务器还没回来：过会儿再看
        try { await ctx().saveChat(); } catch (e) { warn(e); }
    }, delay);
}

/** 回到页面、网络恢复时：这个聊天还有没存上的内容就马上再试一次 */
function retryIfFailing(why) {
    const key = currentChat()?.key;
    const ls = key && S.lastSave.get(key);
    if (!ls || ls.ok || !settings().retrySave || /"integrity"/.test(ls.detail) || !canSaveNow(key)) return;
    if (why !== 'online' && (!isTransient(ls.status) || Date.now() - ls.at < 15000)) return;
    serverReachable().then(ok => { if (ok && canSaveNow(key)) return ctx().saveChat(); }).catch(warn);
}

function installFetchGuard() {
    if (globalThis.__chatAnchorFetch) return;
    const orig = globalThis.fetch;
    const wrapped = function (input, init) {
        let info = null;
        try { info = classify(input, init); } catch { info = null; }
        if (!info) return orig.apply(this, arguments);
        if (info.op === 'save') {
            let block = false, loading = false;
            try { block = shouldBlock(info); if (!block) block = loading = emptyDuringLoad(info); } catch { block = false; }
            if (block) {
                try { onBlocked(info, loading); } catch { /* 记录失败不影响拦截 */ }
                return Promise.resolve(new Response('{"error":"chat_anchor_guard"}', { status: 409, statusText: 'Blocked by Chat Anchor', headers: { 'Content-Type': 'application/json' } }));
            }
            const p = sendSave(this, arguments, input, init, info);
            p.then(r => { try { onSaveSettled(info, r, null); } catch (e) { warn(e); } }, e => { try { onSaveSettled(info, null, e); } catch (e2) { warn(e2); } });
            return p;
        }
        const p = orig.apply(this, arguments);
        try { trackLoad(info, p); } catch (e) { warn(e); }
        return p;
    };
    globalThis.fetch = wrapped;
    globalThis.__chatAnchorFetch = true;

    /**
     * 盯住一次读取，直到内容真的被读完。只看、不改响应内容，任何异常都不影响酒馆自己读。
     * - 从发出请求到响应体读完，记在 S.loading 里：这段时间内存里的聊天是空的，不许存（见 emptyDuringLoad）。
     * - 请求失败、非 2xx → 读取失败（原来就有）。
     * - 响应头是 200，但内容下到一半断了、或者不是完整的 JSON（json() 抛错）→ 读取失败。
     * - 内容读出来一楼都没有，而小锚记得这个聊天有 2 楼以上 → 也当读取失败：
     *   酒馆服务器读文件时出任何异常都是返回 200 + 空对象。
     * 后两种酒馆都会当成"空聊天"，塞进开场白存回去，把原文件盖掉。
     */
    function trackLoad(info, p) {
        const key = info.key;
        S.loading.set(key, (S.loading.get(key) || 0) + 1);
        let open = true;
        const end = () => { if (!open) return; open = false; const n = (S.loading.get(key) || 1) - 1; if (n > 0) S.loading.set(key, n); else S.loading.delete(key); };
        const settle = (ok, detail) => { end(); try { onLoadSettled(info, ok, detail); } catch (e) { warn(e); } };
        p.then(r => {
            try {
                if (!r.ok) return settle(false, `HTTP ${r.status}`);
                let started = false, seen = false;
                const judge = async (value, isText) => { // 读完了：读出来的是不是空的
                    if (seen) return;
                    seen = true;
                    try {
                        const rows = isText ? (String(value).trim().length > 2 ? 1 : 0) : (Array.isArray(value) ? value.length - (info.kind === 'c' ? 1 : 0) : 0); // 角色聊天第一行是文件头
                        if (rows > 0) return settle(true, '');
                        const known = await knownFloors(key);
                        if (known >= 2) settle(false, `服务器返回的内容是空的，而小锚上次存的是 ${known} 楼`); else settle(true, '');
                    } catch (e) { warn(e); settle(true, ''); }
                };
                for (const name of ['json', 'text']) {
                    const real = r[name];
                    if (typeof real !== 'function') continue;
                    r[name] = async function (...args) {
                        started = true;
                        let value;
                        try { value = await real.apply(r, args); } catch (e) { if (!seen) { seen = true; settle(false, `内容没读完（${e?.message || e}）`); } throw e; }
                        await judge(value, name === 'text');
                        return value;
                    };
                }
                setTimeout(() => { if (!started && !seen) { seen = true; settle(true, ''); } }, 60000); // 一直没人读响应体（不是酒馆在读）：按读到了算
            } catch (e) { warn(e); settle(true, ''); }
        }, e => { if (e?.name === 'AbortError') end(); else settle(false, e?.message || String(e)); });
    }

    /**
     * 发保存请求。请求体太大就先 gzip：酒馆自己只压 8 MB 以下的（config 里 maxPayloadSize 默认 8mb，超时 3 秒），
     * 更大的原样发，几十 MB 的聊天很容易撞上反代的 client_max_body_size（默认 50m）而 413。
     * 服务器端 body-parser 自带解压，不需要任何开关。任何异常都退回原样发；服务器不认就改回原样重发一次，之后不再压。
     */
    async function sendSave(self, args, input, init, info) {
        const body = init?.body;
        const limit = Number(S.gzipAbove) || 4 * 1048576;
        if (!settings().gzipSaves || S.gzipBroken || typeof body !== 'string' || body.length < limit || typeof CompressionStream !== 'function') return orig.apply(self, args);
        let gzInit, before, after;
        try {
            const bytes = new TextEncoder().encode(body);
            const gz = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
            const headers = new Headers(init.headers || {});
            headers.set('Content-Encoding', 'gzip');
            gzInit = { ...init, headers, body: gz };
            before = bytes.length; after = gz.length;
        } catch (e) { warn('压缩保存请求失败，原样发送', e); return orig.apply(self, args); }
        if (!S.gzipLogged.has(info.key)) { S.gzipLogged.add(info.key); logEvent('压缩', `「${nameOf(info.key)}」的保存请求 ${fmtSize(before)} → ${fmtSize(after)}，由小锚压缩后发送`); }
        const r = await orig.call(self, input, gzInit);
        if (r.status !== 400 && r.status !== 415) return r;
        const text = await r.clone().text().catch(() => '');
        if (/"integrity"/.test(text)) return r; // 完整性错误和压缩无关，交给酒馆自己处理
        S.gzipBroken = true;
        logEvent('压缩', `服务器不接受压缩的保存请求（HTTP ${r.status}），已改回原样发送，这次会话不再压缩`);
        return orig.apply(self, args);
    }
}

// ───────────────────────── 恢复 / 导出 / 预览 ─────────────────────────
async function loadSnapData(snap) {
    const want = new Set([...snap.hashes, snap.meta]);
    // 一次按 chatKey 整批读出来再挑（几十 MB 的聊天逐楼 get 要几十秒，整批读几秒）
    const map = await tx(['blobs'], 'readonly', t => {
        const m = new Map();
        t.objectStore('blobs').index('chatKey').getAll(snap.chatKey).onsuccess = e => { for (const r of e.target.result) if (want.has(r.hash)) m.set(r.hash, r.json); };
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

/**
 * 等酒馆把聊天真正读回来。酒馆的 reloadCurrentChat 外面有互斥锁：已经有一次重读在进行时它会立刻返回，
 * 不能当作"读完了"——否则用户会在聊天还是空的那几秒里看到 0 楼。
 */
async function waitReloaded(key, expectCount, ms = 120000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (currentChat()?.key !== key) return false; // 用户切走了，不用等了
        const n = ctx().chat.length;
        if (n > 0 && (expectCount == null || n === expectCount)) return true;
        await sleep(200);
    }
    return ctx().chat.length > 0;
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
    if (!c.chat.length) throw new Error('聊天正在重新读取，等它读完再恢复');
    const integrity = c.chatMetadata?.integrity; // 沿用当前文件的校验码，否则酒馆会拒绝保存
    c.chat.splice(0, c.chat.length, ...msgs);
    c.updateChatMetadata({ ...meta, ...(integrity ? { integrity } : {}) }, true);

    const t0 = Date.now();
    await c.saveChat();
    const ls = S.lastSave.get(info.key);
    const saved = !!(ls && ls.ok && ls.at >= t0);
    if (saved) {
        await ctx().reloadCurrentChat();
        await waitReloaded(info.key, msgs.length);
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

// ───────────────────────── 体检：这个聊天多大、什么占的 ─────────────────────────
const fieldLabel = k => FIELD_NAMES[k] ? `${FIELD_NAMES[k]}（${k}）` : (k.startsWith('extra.') ? `扩展写的 ${k}` : k);
const ST_OWN = new Set(['mes', 'swipes', 'swipe_info', 'swipe_id', 'name', 'is_user', 'is_system', 'send_date', 'force_avatar', 'gen_started', 'gen_finished', 'extra.reasoning', 'extra.reasoning_duration', 'extra.token_count', 'extra.api', 'extra.model', 'extra.display_text', 'extra.image', 'extra.title', 'extra.bias', 'extra.memory', 'extra.inline_image', 'extra.media', 'extra.reasoning_type', 'extra.isSmallSys', 'extra.type']);

/** 在内存里把当前聊天按字段称一遍重。不碰服务器。几十 MB 的聊天手机上要几秒。 */
async function checkup() {
    const info = currentChat();
    if (!info) throw new Error('先打开一个聊天');
    const c = ctx();
    const msgs = c.chat;
    if (!msgs.length) throw new Error('聊天现在是空的，多半是还在重新读取。等它读完再体检');
    const enc = new TextEncoder();
    const size = v => { const j = JSON.stringify(v); return j === undefined ? 0 : enc.encode(j).byteLength; }; // 精确字节数：中文 3 字节、英文 1 字节，不能用平均比例换算
    const fields = new Map();
    const heavy = [];
    const tagMap = new Map(); // 正文里 <标签>…</标签> 段落：名字 → 几楼、几段、多大
    let bytes = 0;
    let t0 = performance.now();
    for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i];
        const total = size(m) || 4;
        bytes += total;
        let topKey = '', topN = 0;
        if (m && typeof m === 'object') {
            for (const k of Object.keys(m)) {
                const v = m[k];
                if (k === 'extra' && v && typeof v === 'object') {
                    for (const ek of Object.keys(v)) { const n = size(v[ek]); const key = 'extra.' + ek; fields.set(key, (fields.get(key) || 0) + n); if (n > topN) { topN = n; topKey = key; } }
                } else { const n = size(v); fields.set(k, (fields.get(k) || 0) + n); if (n > topN) { topN = n; topKey = k; } }
            }
        }
        heavy.push({ index: i, bytes: total, top: topKey, topBytes: topN });
        countTagBlocks(m?.mes, tagMap, enc);
        if (performance.now() - t0 > 10) { await tick(); t0 = performance.now(); }
    }
    const tagStats = topTags(tagMap);
    const metaObj = c.chatMetadata ?? {};
    const metaJson = JSON.stringify(metaObj);
    const metaBytes = enc.encode(metaJson).byteLength;
    const metaFields = Object.keys(metaObj).map(k => ({ key: k, bytes: size(metaObj[k]) })).sort((a, b) => b.bytes - a.bytes);
    let gzBytes = null;
    if (bytes > 1048576 && typeof CompressionStream === 'function') { // 估一下压缩后多大（和「大聊天保存时压缩」发出去的大小一致）
        try {
            let idx = -1;
            const rs = new ReadableStream({ pull(ctrl) { if (idx >= msgs.length) { ctrl.close(); return; } ctrl.enqueue(enc.encode((idx < 0 ? metaJson : JSON.stringify(msgs[idx]) ?? 'null') + '\n')); idx++; } });
            const reader = rs.pipeThrough(new CompressionStream('gzip')).getReader();
            let n = 0;
            for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.byteLength; }
            gzBytes = n;
        } catch { gzBytes = null; }
    }
    heavy.sort((a, b) => b.bytes - a.bytes);
    const list = [...fields].map(([key, n]) => ({ key, bytes: n, own: ST_OWN.has(key) })).sort((a, b) => b.bytes - a.bytes);
    const extBytes = list.filter(f => !f.own).reduce((a, f) => a + f.bytes, 0);
    return {
        chatName: info.chatName, owner: info.owner, count: msgs.length, bytes: bytes + metaBytes, gzBytes, extBytes,
        fields: list, meta: { bytes: metaBytes, fields: metaFields }, tagStats,
        heavy: heavy.slice(0, 5).map(h => ({ index: h.index, bytes: h.bytes, top: h.top, topBytes: h.topBytes })),
    };
}

function checkupText(d) {
    const pct = n => d.bytes ? Math.round(n / d.bytes * 100) : 0;
    const lines = [`小锚体检 · 「${d.chatName}」 ${d.count} 楼`, `整份 ${fmtSize(d.bytes)}${d.gzBytes ? `，压缩后约 ${fmtSize(d.gzBytes)}` : ''}。酒馆每次保存都整份上传。`, '什么占地方：'];
    for (const f of d.fields.slice(0, 10)) lines.push(`  ${String(pct(f.bytes)).padStart(3)}%  ${fmtSize(f.bytes).padStart(8)}  ${fieldLabel(f.key)}`);
    if (d.meta.bytes > 10240) lines.push(`  ${String(pct(d.meta.bytes)).padStart(3)}%  ${fmtSize(d.meta.bytes).padStart(8)}  聊天设置（元数据）：${d.meta.fields.slice(0, 3).map(f => `${f.key} ${fmtSize(f.bytes)}`).join('，')}`);
    lines.push('最重的楼：' + d.heavy.map(h => `第 ${h.index + 1} 楼 ${fmtSize(h.bytes)}（${h.top}）`).join('、'));
    const bigTags = (d.tagStats || []).filter(t => t.bytes >= 10240);
    if (bigTags.length) lines.push('正文由这些标签段落组成：' + bigTags.map(t => `<${t.name}> ${fmtSize(t.bytes)}（${t.floors} 楼）`).join('、') + '。其中用完就没用的（画图指令、思考过程之类）可以在瘦身里填标签名清掉老楼里的；故事本身那一段不要填。');
    if (d.extBytes > d.bytes * 0.2) lines.push(`别的扩展写进楼里的数据占了 ${pct(d.extBytes)}%。让那个扩展把数据存到自己的文件里、楼里只留引用，文件就能瘦一大截。`);
    return lines.join('\n');
}

async function showCheckup(d) {
    const c = ctx();
    const pct = n => d.bytes ? Math.round(n / d.bytes * 100) : 0;
    const rows = d.fields.slice(0, 8).map(f => `<li><span>${esc(fieldLabel(f.key))}</span><b>${fmtSize(f.bytes)} · ${pct(f.bytes)}%</b></li>`).join('')
        + (d.meta.bytes > 10240 ? `<li><span>聊天设置（元数据）${esc(d.meta.fields.slice(0, 2).map(f => f.key).join('、'))}</span><b>${fmtSize(d.meta.bytes)} · ${pct(d.meta.bytes)}%</b></li>` : '');
    const html = `<div class="ca-dialog"><h3>「${esc(d.chatName)}」体检</h3>
        <p>${d.count} 楼，整份 <b>${fmtSize(d.bytes)}</b>${d.gzBytes ? `，压缩后约 <b>${fmtSize(d.gzBytes)}</b>` : ''}。酒馆每次保存都整份上传这么多。</p>
        <p><b>什么占地方</b></p><ol class="ca-check">${rows}</ol>
        <p><b>最重的楼</b>：${d.heavy.map(h => `第 ${h.index + 1} 楼 ${fmtSize(h.bytes)}（${esc(h.top)}）`).join('、')}</p>
        ${(d.tagStats || []).some(t => t.bytes >= 10240) ? `<p><b>正文由这些标签段落组成</b>：${d.tagStats.filter(t => t.bytes >= 10240).map(t => `&lt;${esc(t.name)}&gt; ${fmtSize(t.bytes)}（${t.floors} 楼）`).join('、')}<br><small>哪段是故事本身、哪段是画图指令或思考过程这类用完就没用的，只有你知道。用完没用的可以在「瘦身…」里填标签名，清掉老楼里的；开始前会先给你看要删的是什么。故事本身那一段不要填。</small></p>` : ''}
        <p class="ca-note">楼数不是问题，每楼的重量才是。${d.extBytes > d.bytes * 0.2 ? `别的扩展写进楼里的数据占了 ${pct(d.extBytes)}%：让那个扩展把数据存到自己的文件里、楼里只留引用，文件就能瘦一大截。` : '这个聊天大部分是正文本身，没什么可卸的包袱。'}</p></div>`;
    const res = await c.callGenericPopup(html, c.POPUP_TYPE.TEXT, '', { okButton: '关闭', cancelButton: false, allowVerticalScrolling: true, customButtons: [{ text: '复制报告', result: 2 }, { text: '瘦身…', result: 3 }] });
    if (res === 3) return showSlim(d);
    if (res === 2) {
        const text = checkupText(d);
        try { await navigator.clipboard.writeText(text); toast('success', '报告已复制。'); }
        catch { await c.callGenericPopup(Object.assign(document.createElement('textarea'), { className: 'text_pole ca-preview', value: text, readOnly: true }), c.POPUP_TYPE.TEXT, '', { wide: true, okButton: '关闭' }); }
    }
}

// ───────────────────────── 瘦身：卸掉老楼身上酒馆格式留下的包袱 ─────────────────────────
// 只动最近 N 楼以前的楼。默认只清两样零信息损失的：swipes 里只有当前正文那一份副本（酒馆给每条 AI 回复都存一份，
// 和 mes 一模一样）连带 swipe_info，以及老楼的思维链。真正的备选回复默认不清。别的扩展写的 extra.* 一个字不碰。
const SLIM_KEEP = 50;

// 「标签段落」：很多预设让模型把思考过程写在正文里，用 <灵魂梳理>…</灵魂梳理> 这类自定义标签包起来。酒馆没把它们当思维链
// （除非推理格式里正好设了这对前后缀），所以它们算正文，体检里也归在正文。瘦身可以按用户填的标签名把老楼里的整段去掉。
/** 用户填的「灵魂梳理, <心流>」整理成标签名数组：去掉尖括号和斜杠，去重 */
const parseTags = str => [...new Set(String(str || '').split(/[,，;；\s]+/).map(x => x.trim().replace(/^<\/?\s*|\s*\/?>$/g, '').trim()).filter(Boolean))];
const escRe = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 匹配 <标签 …>…</标签> 整段（跨行、非贪婪；缺结尾标签的不匹配），后面紧跟的一个换行一起算进去。第 1 组是标签名 */
function tagRegex(tags) {
    if (!tags?.length) return null;
    return new RegExp(`<(${tags.map(escRe).join('|')})(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>\\n?`, 'g');
}
/**
 * 去掉正文里的标签段。返回 { out, n }；没匹配到、或整楼只有这一段（去掉就空了）返回 null。
 * onHit(name, block)：真的会删的每一段调一次，预览和分项统计用。
 */
function stripTagBlocks(str, re, onHit) {
    if (typeof str !== 'string' || !re) return null;
    re.lastIndex = 0;
    const first = re.exec(str);
    if (!first) return null;
    re.lastIndex = 0;
    let n = 0;
    const hits = onHit ? [] : null;
    let out = str.replace(re, (block, name) => { n++; if (hits) hits.push([name, block]); return ''; });
    if (!str.slice(0, first.index).trim()) out = out.replace(/^\s+/, ''); // 段落在开头：把它留下的空行也去掉
    if (!out.trim()) return null;
    if (hits) for (const [name, block] of hits) onHit(name, block);
    return { out, n };
}
const CLOSE_TAG_RE = /<\/([A-Za-z一-鿿][\w一-鿿:-]*)\s*>/g;
/** 名字一看就是正文本身的标签：不做成可点的按钮，真填了要红字提醒 */
const BODYISH = /^(content|正文|内容|body|main|story|text|reply|response|message|msg|剧情|故事|回复)$/i;

/** 数一楼正文里有哪些 <标签>…</标签> 段落。不认标签名：先找有结尾的标签名，再按名字配对，免得 <br> 这类没结尾的标签让正则扫到底 */
function countTagBlocks(mes, tagMap, enc) {
    if (typeof mes !== 'string' || !mes.includes('</')) return;
    const closers = new Set();
    for (const x of mes.matchAll(CLOSE_TAG_RE)) closers.add(x[1]);
    const re = tagRegex([...closers]);
    const seen = new Set();
    for (let x; re && (x = re.exec(mes));) {
        const ts = tagMap.get(x[1]) || { name: x[1], floors: 0, count: 0, bytes: 0 };
        ts.count++; ts.bytes += enc.encode(x[0]).byteLength;
        if (!seen.has(x[1])) { seen.add(x[1]); ts.floors++; }
        tagMap.set(x[1], ts);
    }
}
const topTags = tagMap => [...tagMap.values()].sort((x, y) => y.bytes - x.bytes).slice(0, 5);
/** 整个聊天的标签段落统计（体检里顺带做；不经过体检直接开瘦身对话框时单独跑一遍） */
async function scanTags(msgs) {
    const enc = new TextEncoder(), tagMap = new Map();
    let t0 = performance.now();
    for (const m of msgs) {
        countTagBlocks(m?.mes, tagMap, enc);
        if (performance.now() - t0 > 10) { await tick(); t0 = performance.now(); }
    }
    return topTags(tagMap);
}

/**
 * 酒馆读完聊天后会显示出来的第一楼的下标。从这一楼起，酒馆一显示就调 ensureSwipes 把 swipes: [mes] 补回去，
 * 清了也白清，所以「重复副本」只算、只清更早的楼。瘦身完会重新读取，显示的就是最近 chat_truncation 楼（0 = 全部）。
 */
function shownFrom(total) {
    const n = ctx().powerUserSettings?.chat_truncation;
    if (typeof n === 'number' && n >= 0) return n > 0 ? Math.max(0, total - n) : 0;
    const first = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));
    return Number.isInteger(first) && first >= 0 ? first : Math.max(0, total - 100);
}

/**
 * 只算不改：老楼里能卸掉什么、各多少字节。opts 里的 drop* 决定哪些算进 targets。
 * 各项的字节数互不重叠：tags.bytes 只算正文里的段落，加上一定会留下的 swipes 里的；会随「重复副本」「备选」一起删掉的
 * swipes 里的段落记在 tags.inDup / tags.inAlt，那一项不清的时候才加进来（见 slimTagBytes）。
 */
async function slimPlan(msgs, { keepRecent = SLIM_KEEP, dropDup = true, dropReasoning = true, dropAlternates = false, dropTags = false, tags = null, shown = null } = {}) {
    const enc = new TextEncoder();
    const size = v => v === undefined ? 0 : enc.encode(JSON.stringify(v) ?? '').byteLength;
    const names = Array.isArray(tags) ? parseTags(tags.join(',')) : parseTags(settings().slimTags);
    const re = tagRegex(names);
    const end = Math.max(0, msgs.length - keepRecent);
    const from = Math.min(end, Number.isInteger(shown) ? shown : shownFrom(msgs.length));
    const per = new Map(names.map(x => [x, { name: x, floors: 0, count: 0, bytes: 0, ex: null }]));
    const plan = { total: msgs.length, keepRecent, end, shown: from,
        dup: { floors: 0, bytes: 0, skipped: 0 }, alt: { floors: 0, bytes: 0, count: 0 }, reasoning: { floors: 0, bytes: 0 },
        tags: { names, floors: 0, count: 0, bytes: 0, inDup: 0, inAlt: 0, per: [], sample: null }, targets: [], bytes: 0 };
    let t0 = performance.now();
    for (let i = 0; i < end; i++) {
        const m = msgs[i];
        if (!m || typeof m !== 'object') continue;
        const t = { i, dup: false, alt: false, reasoning: false, tags: false };
        let sw = ''; // 这楼的 swipes 归哪类：alt 备选，dup 会被「重复副本」删掉，kept 酒馆会补回去所以不动
        if (Array.isArray(m.swipes)) {
            if (m.swipes.length > 1) { sw = 'alt'; plan.alt.floors++; plan.alt.count += m.swipes.length - 1; plan.alt.bytes += size(m.swipes) + size(m.swipe_info) + 24; t.alt = dropAlternates; }
            else if (i < from) { sw = 'dup'; plan.dup.floors++; plan.dup.bytes += size(m.swipes) + size(m.swipe_info) + 24; t.dup = dropDup; }
            else { sw = 'kept'; plan.dup.skipped++; }
        }
        if (m.extra && typeof m.extra === 'object' && (m.extra.reasoning || m.extra.reasoning_duration != null)) {
            plan.reasoning.floors++; plan.reasoning.bytes += size(m.extra.reasoning) + size(m.extra.reasoning_duration) + size(m.extra.reasoning_type) + 40; t.reasoning = dropReasoning;
        }
        if (re) {
            let n = 0;
            const seen = new Set();
            const r = stripTagBlocks(m.mes, re, (name, block) => {
                const pt = per.get(name);
                if (!pt) return;
                pt.count++; pt.bytes += enc.encode(block).byteLength;
                if (!seen.has(name)) { seen.add(name); pt.floors++; }
                pt.ex = { index: i, block }; // 留最靠后的一楼做例子：离现在最近，用户最认得
            });
            if (r) { n += r.n; plan.tags.bytes += size(m.mes) - size(r.out); plan.tags.sample = { index: i, rest: r.out }; }
            if (sw) for (const one of m.swipes) {
                const rs = stripTagBlocks(one, re);
                if (!rs) continue;
                n += rs.n;
                const saved = size(one) - size(rs.out);
                if (sw === 'dup') plan.tags.inDup += saved; else if (sw === 'alt') plan.tags.inAlt += saved; else plan.tags.bytes += saved;
            }
            if (n) { plan.tags.floors++; plan.tags.count += n; t.tags = dropTags; }
        }
        if (t.dup || t.alt || t.reasoning || t.tags) plan.targets.push(t);
        if (performance.now() - t0 > 10) { await tick(); t0 = performance.now(); }
    }
    plan.tags.per = [...per.values()].filter(x => x.count);
    plan.bytes = slimBytes(plan, { dup: dropDup, reasoning: dropReasoning, alt: dropAlternates, tags: dropTags });
    return plan;
}
/** 「标签段落」一项能清多少：swipes 要是随别的项一起删了，里面的段落就不再重复算 */
const slimTagBytes = (plan, picks) => plan.tags.bytes + (picks.dup ? 0 : plan.tags.inDup) + (picks.alt ? 0 : plan.tags.inAlt);
/** 按勾选的项算一共能清多少 */
const slimBytes = (plan, picks) => (picks.dup ? plan.dup.bytes : 0) + (picks.reasoning ? plan.reasoning.bytes : 0) + (picks.alt ? plan.alt.bytes : 0) + (picks.tags ? slimTagBytes(plan, picks) : 0);

/** 真正动手。先存一份锁定的「瘦身前」快照，改内存里的楼，保存成功才重新读取。dryRun 只返回计划。 */
async function slim(opts = {}) {
    const { dryRun = false, keepRecent = SLIM_KEEP, dropDup = true, dropReasoning = true, dropAlternates = false, dropTags = false, tags = null, shown = null } = opts;
    const info = currentChat();
    if (!info) throw new Error('先打开一个聊天');
    if (!ctx().chat.length) throw new Error('聊天现在是空的，多半是还在重新读取。等它读完再瘦身');
    const plan = await slimPlan(ctx().chat, { keepRecent, dropDup, dropReasoning, dropAlternates, dropTags, tags, shown });
    if (dryRun || !plan.targets.length) return { ...plan, applied: 0, saved: null };
    const p = S.poison.get(info.key);
    if (p && p.confirmed && !p.okSeen && !p.released) throw new Error('这个聊天还没读取成功，请先点「重新读取」');
    await takeSnapshot('pre-slim', { force: true, lock: true });
    if (currentChat()?.key !== info.key) throw new Error('聊天已经切换，已取消瘦身');
    const msgs = ctx().chat;
    if (msgs.length !== plan.total) throw new Error(msgs.length ? '聊天在这期间变了，已取消瘦身，请再点一次' : '聊天正在重新读取，等它读完再瘦身');
    const re = tagRegex(plan.tags.names);
    for (const t of plan.targets) {
        const m = msgs[t.i];
        if (!m || typeof m !== 'object') continue;
        if (t.dup || t.alt) { delete m.swipes; delete m.swipe_info; delete m.swipe_id; }
        if (t.reasoning && m.extra) { delete m.extra.reasoning; delete m.extra.reasoning_duration; delete m.extra.reasoning_type; }
        if (t.tags && re) {
            const r = stripTagBlocks(m.mes, re);
            if (r) m.mes = r.out;
            if (Array.isArray(m.swipes)) m.swipes = m.swipes.map(one => stripTagBlocks(one, re)?.out ?? one);
        }
    }
    S.forceFull = true; // 老楼变了，下一次快照全量重算
    S.slimHint = null;
    const t0 = Date.now();
    await ctx().saveChat();
    const ls = S.lastSave.get(info.key);
    const saved = !!(ls && ls.ok && ls.at >= t0);
    if (saved) { await ctx().reloadCurrentChat(); await waitReloaded(info.key, plan.total); }
    else toast('warning', '瘦身后的内容还没成功存到服务器。先别刷新，等自动补存成功的提示。', { timeOut: 10000 });
    const parts = [];
    if (dropDup && plan.dup.floors) parts.push(`重复 swipe 副本 ${plan.dup.floors} 楼`);
    if (dropReasoning && plan.reasoning.floors) parts.push(`思维链 ${plan.reasoning.floors} 楼`);
    if (dropAlternates && plan.alt.count) parts.push(`备选回复 ${plan.alt.count} 条`);
    if (dropTags && plan.tags.floors) parts.push(`正文里的 ${plan.tags.names.map(x => `<${x}>`).join(' ')} 段落 ${plan.tags.floors} 楼`);
    logEvent('瘦身', `「${info.chatName}」清掉约 ${fmtSize(plan.bytes)}：${parts.join('、')}；最近 ${keepRecent} 楼没动${saved ? '' : '（服务器保存未确认）'}`);
    return { ...plan, applied: plan.targets.length, saved };
}

/** 一段长文字掐头去尾，给人看个大概 */
function excerpt(text, head = 90, tail = 30) {
    const x = String(text ?? '').replace(/\s+/g, ' ').trim();
    return x.length > head + tail + 8 ? `${x.slice(0, head)} …… ${x.slice(-tail)}` : x;
}

/** 标签段落的预览：每个标签举最靠后一楼的真实例子，再给出那一楼删完剩下什么。改正文之前必须让人亲眼看到 */
function tagPreviewHtml(plan) {
    const enc = new TextEncoder();
    const inner = block => block.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>\s*$/, '');
    let html = '';
    for (const pt of plan.tags.per) {
        html += `<p><b>&lt;${esc(pt.name)}&gt;</b>：${pt.floors} 楼的正文里有，共 ${fmtSize(pt.bytes)}。比如第 ${pt.ex.index + 1} 楼会删掉这一段（${fmtSize(enc.encode(pt.ex.block).byteLength)}）：</p>
            <blockquote class="ca-quote is-del">${esc(excerpt(inner(pt.ex.block)))}</blockquote>`;
        if (BODYISH.test(pt.name)) html += `<p class="ca-danger">「${esc(pt.name)}」看名字像是正文本身。删了它，老楼里就只剩别的段落了。确定要删吗？</p>`;
    }
    if (!html) html = `<p>老楼的正文里没有这些段落，只在备选回复里有 ${plan.tags.count} 段，会一起清掉。</p>`;
    if (plan.tags.sample) html += `<p>删完以后，第 ${plan.tags.sample.index + 1} 楼的正文剩下：</p><blockquote class="ca-quote">${esc(excerpt(plan.tags.sample.rest, 120, 40))}</blockquote>`;
    return html;
}

async function confirmTags(plan) {
    const c = ctx();
    const html = `<div class="ca-dialog"><h3>先看一眼要删的是什么</h3>
        <p>会从前 ${plan.end} 楼里删掉下面这些段落，一共 ${plan.tags.floors} 楼。删的是正文，清了就没了。</p>
        ${tagPreviewHtml(plan)}
        <p class="ca-note">拿不准就点「返回」。开始前会先存一份锁定快照「瘦身前」，后悔可以用它恢复。</p></div>`;
    const res = await c.callGenericPopup(html, c.POPUP_TYPE.CONFIRM, '', { okButton: '就删这些，开始瘦身', cancelButton: '返回', allowVerticalScrolling: true });
    return res === c.POPUP_RESULT.AFFIRMATIVE;
}

/** 真正开始瘦身（对话框和「按上次的选项」共用）：提示一直挂到重读完成；remember 时记住这次的选项 */
async function runSlim(o, remember = true) {
    const done = toastHold('正在瘦身，大聊天要几秒…保存后会重新读取一遍，读完才算完成。');
    let r;
    try { r = await slim({ dropDup: !!o.dup, dropReasoning: !!o.reasoning, dropAlternates: !!o.alt, dropTags: !!o.tags, tags: parseTags(o.tags) }); } finally { done(); }
    if (remember) { // 记住这次确认并做完的选项；标签名只在真的用过之后才记（填了又取消的不留）
        const st = settings();
        st.slimLast = { dup: !!o.dup, reasoning: !!o.reasoning, alt: !!o.alt, tags: o.tags || '' };
        if (o.tags) st.slimTags = o.tags;
        ctx().saveSettingsDebounced();
    }
    S.slimHint = null;
    if (!r.applied) toast('info', '老楼里没有可清的。');
    else toast(r.saved === false ? 'warning' : 'success', `瘦身完成，清掉约 ${fmtSize(r.bytes)}${r.saved === false ? '，但服务器保存未确认' : ''}。`);
    refreshPanel();
    return r;
}

/** 瘦身对话框。d 是体检结果（从体检弹窗进来时有）；从「当前」页直接进来时没有，标签统计现算 */
async function showSlim(d) {
    const c = ctx();
    const st = settings();
    const info = currentChat();
    if (!info) throw new Error('先打开一个聊天');
    if (!c.chat.length) throw new Error('聊天现在是空的，多半是还在重新读取。等它读完再瘦身');
    const all = { keepRecent: SLIM_KEEP, dropDup: true, dropReasoning: true, dropAlternates: true, dropTags: true };
    let plan = await slimPlan(c.chat, { ...all, tags: parseTags(st.slimTags) });
    const total = d?.bytes || 0;
    if (!plan.end) {
        await c.callGenericPopup(`<div class="ca-dialog"><h3>还不用瘦身</h3><p>最近 ${SLIM_KEEP} 楼一律不动，这个聊天只有 ${plan.total} 楼，没有更早的楼可以处理。</p></div>`, c.POPUP_TYPE.TEXT, '', { okButton: '关闭' });
        return null;
    }
    const tagStats = d?.tagStats || await scanTags(c.chat);
    const last = st.slimLast;
    const picks = { dup: last ? !!last.dup : true, reasoning: last ? !!last.reasoning : true, alt: last ? !!last.alt : false, tags: plan.tags.floors > 0 && (last ? !!last.tags : true) };
    const el = document.createElement('div');
    el.className = 'ca-dialog';
    const n = (bytes, floors) => floors ? `${fmtSize(bytes)} · ${floors} 楼` : '没有可清的';
    const row = (k, title, note, bytes, floors) => `<label class="ca-row is-stack ca-slim-row"><span><b><input type="checkbox" data-slim="${k}" ${picks[k] ? 'checked' : ''}> ${title}</b><small>${note}</small></span><span class="ca-slim-n" data-slim-n="${k}">${n(bytes, floors)}</span></label>`;
    const shownN = plan.total - shownFrom(plan.total);
    const dupNote = plan.shown > 0
        ? `酒馆给每条回复都多存了一份和正文一模一样的文本，去掉不丢任何内容。酒馆每次读取聊天，会给它显示出来的最近 ${shownN} 楼重新补上这份副本，所以这里只算更早的楼。以后翻回去看老楼，看到的那几楼也会被补回来`
        : '酒馆给每条回复都多存了一份和正文一模一样的文本。但你的酒馆设置成一次显示全部楼层（用户设置里的「要加载 # 条消息」是 0），它会把每一楼的副本都补回去，这项现在清不掉。把那个数字改成 100 再来就能清';
    const chips = tagStats.filter(t => t.bytes >= 10240 && !BODYISH.test(t.name)).slice(0, 5).map(t => `<span class="ca-chip" data-tag-chip="${esc(t.name)}">&lt;${esc(t.name)}&gt; ${fmtSize(t.bytes)}</span>`).join('');
    el.innerHTML = `<h3>「${esc(d?.chatName || info.chatName)}」瘦身</h3>
        <p>最近 ${SLIM_KEEP} 楼一律不动，只处理前 ${plan.end} 楼。别的扩展写进楼里的数据不碰。</p>
        <p class="ca-note" data-slim-sum></p>
        ${row('dup', '重复的 swipe 副本', dupNote, plan.dup.bytes, plan.dup.floors)}
        ${row('reasoning', '老楼的思维链', '模型的思考过程，不影响正文，老楼的没人回头看', plan.reasoning.bytes, plan.reasoning.floors)}
        ${row('alt', '老楼里没被选中的备选回复', `共 ${plan.alt.count} 条。清了就看不到那些备选了，默认不清`, plan.alt.bytes, plan.alt.floors)}
        <div class="ca-row is-stack ca-slim-row ca-slim-tags"><label><span><b><input type="checkbox" data-slim="tags" ${picks.tags ? 'checked' : ''}> 老楼正文里的「标签段落」</b><small>预设让模型写在正文里、用完就没用的段落，比如画图指令 &lt;draw&gt;…&lt;/draw&gt;、思考过程 &lt;灵魂梳理&gt;…&lt;/灵魂梳理&gt;。填标签名，多个用逗号分开。故事本身那一段不要填。缺结尾标签的、整楼只有这一段的不动。<b>这项会改老楼正文</b>，开始前会先给你看要删的是什么</small></span><span class="ca-slim-n" data-slim-n="tags"></span></label>
            <input type="text" class="text_pole" data-slim-tags value="${esc(st.slimTags || '')}" placeholder="标签名，例如：draw">${chips ? `<small>正文里看到的标签，点一下填进去。只填用完就没用的：${chips}</small>` : ''}</div>
        <p class="ca-note">开始前会先存一份锁定快照「瘦身前」，后悔可以用它恢复。瘦身后会自动保存并重新读取。</p>`;
    const input = el.querySelector('[data-slim-tags]');
    const sum = () => {
        el.querySelector('[data-slim-n="tags"]').textContent = n(slimTagBytes(plan, picks), plan.tags.floors);
        const bytes = slimBytes(plan, { ...picks, tags: picks.tags && plan.tags.floors > 0 });
        el.querySelector('[data-slim-sum]').textContent = !bytes ? '勾选的几项里现在没有可清的。' : total ? `清完约 ${fmtSize(total)} → ${fmtSize(Math.max(0, total - bytes))}。` : `一共约可清掉 ${fmtSize(bytes)}。`;
    };
    let timer = null, pending = null, seq = 0;
    const recountNow = async () => { // 标签名一变就重新数一遍，几十 MB 的聊天也只要几十毫秒
        const my = ++seq;
        const p2 = await slimPlan(ctx().chat, { ...all, tags: parseTags(input.value) });
        if (my !== seq) return;
        plan = p2;
        el.querySelector('[data-slim="tags"]').checked = picks.tags = plan.tags.floors > 0;
        sum();
    };
    const recount = () => { clearTimeout(timer); timer = setTimeout(() => { timer = null; pending = recountNow().catch(warn).finally(() => { pending = null; }); }, 350); };
    el.addEventListener('change', e => { const k = e.target?.dataset?.slim; if (k) { picks[k] = e.target.checked; sum(); } });
    el.addEventListener('input', e => { if (e.target === input) recount(); });
    el.addEventListener('click', e => {
        const chip = e.target.closest('[data-tag-chip]');
        if (!chip) return;
        const cur = parseTags(input.value);
        if (!cur.includes(chip.dataset.tagChip)) cur.push(chip.dataset.tagChip);
        input.value = cur.join(', ');
        recount();
    });
    sum();
    for (;;) {
        const res = await c.callGenericPopup(el, c.POPUP_TYPE.CONFIRM, '', { okButton: '开始瘦身', cancelButton: '取消', allowVerticalScrolling: true });
        const go = res === c.POPUP_RESULT.AFFIRMATIVE;
        if (timer) { clearTimeout(timer); timer = null; if (go) await recountNow(); } else if (pending) await pending; // 刚改完标签名就点了开始：先按最新的数完
        if (!go) return null;
        const tags = parseTags(input.value);
        const useTags = picks.tags && plan.tags.floors > 0;
        if (!picks.dup && !picks.reasoning && !picks.alt && !useTags) return null;
        if (useTags && !await confirmTags(plan)) continue; // 「返回」：回到这个对话框接着改
        return runSlim({ dup: picks.dup, reasoning: picks.reasoning, alt: picks.alt, tags: useTags ? tags.join(', ') : '' });
    }
}

/** 「当前」页的一步瘦身：按上次确认过的选项，只确认一次。没用过瘦身就直接开对话框 */
async function quickSlim() {
    const c = ctx();
    const last = settings().slimLast;
    if (!last) return showSlim(null);
    if (!currentChat()) throw new Error('先打开一个聊天');
    if (!c.chat.length) throw new Error('聊天现在是空的，多半是还在重新读取。等它读完再瘦身');
    const plan = await slimPlan(c.chat, { dropDup: !!last.dup, dropReasoning: !!last.reasoning, dropAlternates: !!last.alt, dropTags: !!last.tags, tags: parseTags(last.tags) });
    const picks = { dup: !!last.dup, reasoning: !!last.reasoning, alt: !!last.alt, tags: !!last.tags && plan.tags.floors > 0 };
    const items = slimParts(plan, picks, true);
    if (!items.length) { toast('info', '按上次的选项，老楼里现在没有可清的。'); return null; }
    const html = `<div class="ca-dialog"><h3>按上次的选项瘦身</h3>
        <p>最近 ${SLIM_KEEP} 楼不动。前 ${plan.end} 楼里会清掉约 <b>${fmtSize(slimBytes(plan, picks))}</b>：</p>
        <ul class="ca-list">${items.map(x => `<li>${x}</li>`).join('')}</ul>
        ${picks.tags ? tagPreviewHtml(plan) : ''}
        <p class="ca-note">开始前会先存一份锁定快照「瘦身前」，后悔可以用它恢复。瘦身后会自动保存并重新读取。</p></div>`;
    const res = await c.callGenericPopup(html, c.POPUP_TYPE.CONFIRM, '', { okButton: '开始瘦身', cancelButton: '取消', allowVerticalScrolling: true, customButtons: [{ text: '改选项…', result: 2 }] });
    if (res === 2) return showSlim(null);
    if (res !== c.POPUP_RESULT.AFFIRMATIVE) return null;
    return runSlim({ dup: picks.dup, reasoning: picks.reasoning, alt: picks.alt, tags: picks.tags ? last.tags : '' }, false);
}

/** 按勾选的项列出各能清多少。detail 为真时带字节数（确认框用），否则只写楼数（提示用）。返回的是 HTML 片段 */
function slimParts(plan, picks, detail) {
    const out = [];
    const b = n => detail ? `，${fmtSize(n)}` : '';
    if (picks.dup && plan.dup.floors) out.push(`重复的 swipe 副本 ${plan.dup.floors} 楼${b(plan.dup.bytes)}`);
    if (picks.reasoning && plan.reasoning.floors) out.push(`思维链 ${plan.reasoning.floors} 楼${b(plan.reasoning.bytes)}`);
    if (picks.alt && plan.alt.floors) out.push(`备选回复 ${plan.alt.count} 条${b(plan.alt.bytes)}`);
    if (picks.tags && plan.tags.floors) out.push(`${plan.tags.names.map(x => `&lt;${esc(x)}&gt;`).join(' ')} 段落 ${plan.tags.floors} 楼${b(slimTagBytes(plan, picks))}`);
    return out;
}

/**
 * 「当前」页的瘦身提示：老楼里按上次的选项（没用过就按默认）现在能清多少，超过 S.slimHintMin 才显示。
 * 面板画完以后再算，算完只改那一小块；同一个聊天、楼数没变的话一分钟内不重算。
 */
async function updateSlimHint() {
    const info = currentChat();
    if (!info || !P.root?.querySelector('[data-slim-hint]')) return;
    const c = ctx();
    if (!c.chat.length) return;
    const last = settings().slimLast;
    const o = last || { dup: true, reasoning: true, alt: false, tags: '' };
    const sig = [info.key, c.chat.length, shownFrom(c.chat.length), S.last.get(info.key)?.ts || 0, JSON.stringify(o)].join('|'); // 存过新快照（内容变了）就重算
    let h = S.slimHint;
    if (!h || h.sig !== sig || Date.now() - h.at > 60000) {
        const plan = await slimPlan(c.chat, { dropDup: !!o.dup, dropReasoning: !!o.reasoning, dropAlternates: !!o.alt, dropTags: !!o.tags, tags: parseTags(o.tags) });
        const picks = { dup: !!o.dup, reasoning: !!o.reasoning, alt: !!o.alt, tags: !!o.tags && plan.tags.floors > 0 };
        h = S.slimHint = { sig, at: Date.now(), bytes: slimBytes(plan, picks), parts: slimParts(plan, picks, false) };
    }
    const slot = P.root?.querySelector('[data-slim-hint]');
    if (!slot || currentChat()?.key !== info.key) return;
    slot.innerHTML = h.bytes >= S.slimHintMin && h.parts.length
        ? `<div class="ca-hint">老楼里攒了约 <b>${fmtSize(h.bytes)}</b> 可以清：${h.parts.join('、')}。
            <div class="ca-banner-acts"><div class="menu_button" data-act="slim-quick">${last ? '按上次的选项瘦身' : '瘦身…'}</div></div></div>`
        : '';
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
    const added = d.floors.filter(f => f.change === '新增').length, removed = d.floors.filter(f => f.change === '删除').length;
    const allFields = d.floors.flatMap(f => f.fields);
    const allBookkeeping = d.floors.every(f => f.change === '修改' && f.fields.length && f.fields.every(k => BOOKKEEPING.has(k))) && d.metaKeys.every(k => BOOKKEEPING.has(k));
    const regenerated = allFields.some(k => k === 'gen_finished' || k === 'extra.reasoning_duration' || k === 'swipe_info');
    const thirdParty = [...new Set([...allFields, ...d.metaKeys].filter(k => !FIELD_NAMES[k] && !BOOKKEEPING.has(k)))];
    let note;
    if (added || removed) note = `${added ? `新增 ${added} 楼` : ''}${added && removed ? '，' : ''}${removed ? `删除 ${removed} 楼` : ''}：发消息、收到回复或删楼，其余是跟着来的记账字段。`;
    else if (allBookkeeping) note = '这些都是酒馆自己的记账字段（计数、时间戳、标记），不是你改的。';
    else if (regenerated) note = '这一楼重新生成过或换过 swipe（有新的生成时间、思考用时）。';
    else if (thirdParty.length) note = `${thirdParty.slice(0, 4).join('、')} 不是酒馆自己的字段，是别的扩展或脚本写的${allFields.includes('mes') ? '，而且它连正文也改了' : ''}。`;
    else note = '正文、swipe、变量这类变化通常来自你的操作或正在跑的脚本（状态栏、变量脚本等）。';
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
const P = { popup: null, root: null, tab: 'cur', viewKey: null, srvKey: undefined, busy: false, again: false, srvTick: null, saveHtml: '' };
const REASON = { manual: '手动', drop: '掉楼前', 'pre-restore': '恢复前', 'pre-slim': '瘦身前', hidden: '切后台时' };
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
    P.saveHtml = saveBannerHtml();
    root.innerHTML = `
        <header class="ca-head">
            <div class="ca-title"><i class="fa-solid fa-anchor"></i><span>小锚</span><small class="ca-by" title="由 Claude（Anthropic）和江一起做的">by Claude</small></div>
            <div class="menu_button" data-act="snap-now" title="给当前聊天存一份并锁定">立即快照</div>
        </header>
        <div data-save-slot>${P.saveHtml}</div>
        <nav class="ca-tabs" role="tablist">${tabs.map(([id, label]) => `<button type="button" class="ca-tab" role="tab" aria-selected="${P.tab === id}" data-act="tab" data-tab="${id}">${label}</button>`).join('')}</nav>
        <section class="ca-body">${body}</section>`;
    if (scroller) scroller.scrollTop = top;
    updateSlimHint().catch(warn); // 页面上有提示位才会算
}

async function renderTimeline(key, info, withBack) {
    const back = withBack ? '<button type="button" class="ca-back" data-act="back"><i class="fa-solid fa-chevron-left"></i>全部聊天</button>' : '';
    if (!key) return back + '<div class="ca-empty">先打开一个聊天。<br>打开后小锚会自动开始存快照。</div>';
    const [rec, snaps] = await Promise.all([dbGet('chats', key), snapsOf(key)]);
    const isCur = info?.key === key;
    const owner = rec?.owner || info?.owner || '';
    const chatName = rec?.chatName || info?.chatName || '';
    let html = `${back}<div class="ca-chat-name">${esc(owner)}</div><div class="ca-chat-file">${esc(chatName)}${isCur ? '' : '（不是当前打开的聊天）'}</div>`;
    if (isCur) html += '<button type="button" class="ca-back" data-act="checkup"><i class="fa-solid fa-stethoscope"></i>体检：这个聊天多大、什么占的</button><div data-slim-hint></div>';

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
        + toggle('gzipSaves', '大聊天保存时压缩', '保存请求超过 4 MB 就由小锚压缩后再发（酒馆自己只压 8 MB 以下的）。能绕过反代的大小限制，手机上也省流量')
        + num('recent', '最近保留几份', '最新的这几份一定留着', 3, 100)
        + num('days', '按天保留几天', '更早的快照：24 小时内每小时留 1 份，之后每天留 1 份', 1, 60)
        + num('maxChats', '最多保留几个聊天', '超出后清掉最久没动的聊天（有锁定快照的不清）', 3, 200)
        + `<label class="ca-row is-stack"><span><b>忽略这些字段的变化</b><small>别的扩展往消息里写的记账信息（比如 extra.stImageAtelier）单独变了不存快照。逗号分隔；点快照旁的「改了什么」可以直接加。</small></span><input type="text" class="text_pole" data-set="ignore" value="${esc(st.ignore.join(', '))}" placeholder="无"></label>`
        + `<div class="ca-note">现在有 ${chats.length} 个聊天、${snaps} 份快照${usage}。<br>快照存在这台设备的浏览器里：换设备、清除网站数据、卸载 App 后就没有了。重要的聊天请用「导出」另存一份。</div>
        <div class="ca-banner-acts"><div class="menu_button" data-act="wipe">清空全部快照</div></div>
        <div class="ca-note ca-foot" data-version="${VERSION}">小锚 ${VERSION} · 由 Claude（Anthropic）和江一起做的</div>`;
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
    if (act === 'checkup') { toast('info', '正在体检，大聊天要几秒…', { timeOut: 2500 }); return showCheckup(await checkup()); }
    if (act === 'slim-quick') return quickSlim();
    if (act === 'save-now') {
        const key = currentChat()?.key;
        if (!canSaveNow(key)) return toast('info', '聊天正在读取或者是空的，等它读完再存。');
        toast('info', '正在保存…', { timeOut: 2000 });
        await ctx().saveChat(); // 成功、失败都由保存结果那边更新横幅和提示
        return;
    }
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
    // 事件带的楼号记成"脏"，下次快照一定重算那一楼（MESSAGE_SWIPE_DELETED 传的是对象，MESSAGE_DELETED 传的是新楼数所以单独处理）
    const mark = id => { const n = Number(id && typeof id === 'object' ? id.messageId : id); if (Number.isInteger(n) && n >= 0) S.dirty.add(n); };
    on(ev.MESSAGE_SENT, id => { mark(id); schedule(300); });
    for (const name of [ev.MESSAGE_RECEIVED, ev.GENERATION_ENDED, ev.GENERATION_STOPPED, ev.MESSAGE_EDITED, ev.MESSAGE_UPDATED,
        ev.MESSAGE_SWIPED, ev.MESSAGE_SWIPE_DELETED, ev.MESSAGE_REASONING_EDITED, ev.MESSAGE_REASONING_DELETED]) {
        on(name, id => { mark(id); schedule(1200); });
    }
    on(ev.MESSAGE_DELETED, () => {
        S.forceFull = true; schedule(1200);
        // 删到只剩 0–1 楼时不会再有新快照（空聊天不存），小锚记的楼数要跟着降：
        // 否则下次读取会被当成"读出来是空的"，打开时也会误报掉楼
        const info = currentChat(), n = ctx().chat.length;
        if (info && n <= 1) enqueue(async () => { const rec = await dbGet('chats', info.key); if (rec && rec.lastCount > n) await dbPut('chats', { ...rec, lastCount: n }); }).catch(warn);
    });
    // 切到后台前立刻存一份：手机上页面随时可能被系统回收
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && settings().enabled) { clearTimeout(S.timer); S.timer = null; takeSnapshot('hidden').catch(warn); }
        if (document.visibilityState === 'visible') { try { retryIfFailing('visible'); } catch (e) { warn(e); } }
    });
    window.addEventListener('pagehide', () => { if (S.timer) { clearTimeout(S.timer); S.timer = null; takeSnapshot('hidden').catch(warn); } });
    window.addEventListener('online', () => { try { retryIfFailing('online'); } catch (e) { warn(e); } });

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
    diff: diffSnaps, loadSnapData, getSnap, checkup, checkupText, slim, slimPlan: opts => slimPlan(ctx().chat, opts), quickSlim, explainSave, canSaveNow,
    legacy: { list: legacyList, importAsNew: legacyImport, exportFile: legacyExport },
    server: { list: serverBackups, restore: serverRestore, keyOf: backupKeyOf, sha256: sha256Hex },
    state: S,
};
