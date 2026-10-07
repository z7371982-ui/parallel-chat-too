/* 并行对话 0.6.1 — 单页面后台生成。
 *
 * 不再为每个会话启动第二个酒馆页面（iframe）。切换对话时，只把正在进行的
 * 生成请求留在后台继续接收；切回该对话后，由酒馆原生流程把保存下来的响应
 * 重新走一遍（正则、变量脚本、保存都是原生逻辑）。不自行拼接提示词，不直接
 * 写聊天文件，不保存 API 密钥。
 */
const VERSION = '0.6.1';
const KEY = '__PARALLEL_TAVERN_V2__';
const MAX_SESSIONS = 3;
const STORE = 'parallel-tavern.jobs.v1';
const STORE_LIMIT = 1500000;
const GEN_URL = /\/api\/(?:backends\/(?:chat-completions|text-completions|kobold)\/generate|novelai\/generate(?:-stream)?)(?:[?#]|$)/;
const TYPES = ['normal', 'regenerate', 'swipe', 'continue'];
const NULL_BODY = [101, 204, 205, 304];

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(test, timeout, step = 50) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (test()) return true; await delay(step); }
    return test();
}

// ---------------------------------------------------------------------------
// 响应解析：只用于面板预览、复制文本，以及接口类型改变后的兜底转码。
// 正常切回时直接回放原始字节，由酒馆自己解析。
// ---------------------------------------------------------------------------
const asText = value => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(part => typeof part === 'string' ? part : (part?.type === 'text' || part?.text) && !part.thought ? part.text || '' : '').join('') : '';
function pick(data, out) {
    if (!data || typeof data !== 'object') return;
    const choice = data.choices?.[0];
    const parts = data.candidates?.[0]?.content?.parts;
    out.text += asText(choice?.delta?.content ?? choice?.message?.content ?? choice?.text)
        || (typeof data.delta?.text === 'string' ? data.delta.text : '')
        || (Array.isArray(parts) ? parts.filter(p => !p.thought).map(p => p.text || '').join('') : '')
        || (Array.isArray(data.content) ? data.content.filter(p => p?.type === 'text').map(p => p.text || '').join('') : '')
        || asText(data.results?.[0]?.text ?? data.token ?? data.output ?? data.response ?? (typeof data.content === 'string' ? data.content : ''))
        || (typeof data.text === 'string' ? data.text : '');
    out.reasoning += asText(choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? choice?.message?.reasoning_content ?? choice?.message?.reasoning)
        || (typeof data.delta?.thinking === 'string' ? data.delta.thinking : '')
        || (Array.isArray(parts) ? parts.filter(p => p.thought).map(p => p.text || '').join('') : '');
}
function parseBody(body) {
    const out = { text: '', reasoning: '' };
    if (/^\s*[[{"]/.test(body)) {
        try { const data = JSON.parse(body); if (typeof data === 'string') out.text = data; else pick(data, out); return out; } catch { /* 可能是被截断的流 */ }
    }
    for (const line of body.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try { pick(JSON.parse(payload), out); } catch { /* 不完整的最后一行 */ }
    }
    return out;
}
// 同时带上各家接口的字段，酒馆按当前接口类型取其中一种。
function reencode({ text, reasoning }, stream) {
    if (!stream) {
        return JSON.stringify({
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) }, text }],
            content: [{ type: 'text', text }], results: [{ text }], output: text,
        });
    }
    const chunk = (t, r) => 'data: ' + JSON.stringify({
        type: 'content_block_delta', token: t,
        choices: [{ index: 0, text: t, delta: { content: t, ...(r ? { reasoning_content: r } : {}) } }],
        delta: r ? { type: 'thinking_delta', thinking: r } : { type: 'text_delta', text: t },
        candidates: [{ content: { parts: [r ? { text: r, thought: true } : { text: t }] } }],
    }) + '\n\n';
    return (reasoning ? chunk('', reasoning) : '') + chunk(text, '') + 'data: [DONE]\n\n';
}
function signature(input, init) {
    let path = '';
    try { path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname; } catch { /* keep empty */ }
    const sig = { path, src: '', stream: false };
    try {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (body) { sig.src = String(body.chat_completion_source || body.api_type || ''); sig.stream = body.stream === true || body.streaming === true; }
    } catch { /* 非 JSON 请求体按原样处理 */ }
    if (/generate-stream/.test(path)) sig.stream = true;
    return sig;
}

export function start({ settings, save, installProfiles }) {
    const host = window, doc = document;
    if (host[KEY]) return host[KEY];
    const ctx = () => host.SillyTavern.getContext();
    const emitter = ctx().eventSource;
    const events = ctx().eventTypes || ctx().event_types || {};
    const teardown = [];
    const encoder = new TextEncoder();
    let disposed = false;

    // ----- 状态 -----
    const sessions = new Map();   // key -> { key, avatar, name, chatId, job, unread, touched }
    const jobs = new Map();       // id  -> job
    let curKey = null;
    let gen = null;               // 最近一次原生生成的类型与所在对话
    let quietPending = 0;
    let armed = null;             // 下一条生成请求由本扩展接管
    let replayArm = null;         // 切回后等待原生流程发起的那次请求
    let switching = false, reattachBusy = false, reattachTimer = null;
    let profile = null;

    function on(name, fn) {
        if (!name || !emitter?.on) return;
        emitter.on(name, fn);
        teardown.push(() => emitter.removeListener ? emitter.removeListener(name, fn) : emitter.off?.(name, fn));
    }
    function current() {
        try {
            const c = ctx();
            if (c.groupId) return { key: null, group: true };
            const character = c.characters?.[c.characterId];
            const chatId = c.chatId ?? c.getCurrentChatId?.();
            if (!character?.avatar || !chatId) return { key: null };
            return { key: `${character.avatar}\n${chatId}`, avatar: character.avatar, name: character.name, chatId: String(chatId) };
        } catch { return { key: null }; }
    }
    function isGenerating() {
        if (doc.body.dataset.generating === 'true') return true;
        const stop = doc.getElementById('mes_stop');
        return !!stop && host.getComputedStyle(stop).display !== 'none';
    }
    // 滑动生成被中断后，酒馆还要把滑动状态收尾；这期间不能切换聊天。
    const isSwiping = () => doc.body.dataset.swiping === 'true';
    const foregroundJob = () => [...jobs.values()].find(job => job.attached) || null;
    function ensureSession(info) {
        let session = sessions.get(info.key);
        if (!session) {
            if (sessions.size >= MAX_SESSIONS) {
                const idle = [...sessions.values()].filter(s => !s.job && s.key !== curKey).sort((a, b) => a.touched - b.touched)[0];
                if (!idle) return null;
                sessions.delete(idle.key);
            }
            session = { key: info.key, avatar: info.avatar, name: info.name, chatId: info.chatId, job: null, unread: false, touched: 0 };
            sessions.set(info.key, session);
        }
        session.name = info.name || session.name; session.touched = Date.now();
        return session;
    }
    function syncCurrent() {
        const info = current();
        curKey = info.key;
        if (info.key) ensureSession(info);
    }

    // ----- 后台任务 -----
    function bodyText(job) {
        if (job.decodedAt !== job.bytes) {
            const all = new Uint8Array(job.bytes); let offset = 0;
            for (const chunk of job.chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
            job.decoded = new TextDecoder().decode(all); job.decodedAt = job.bytes; job.parsed = null;
        }
        return job.decoded;
    }
    function parsed(job) {
        const body = bodyText(job);
        return job.parsed ||= (job.head && job.head.status >= 400 ? { text: '', reasoning: '' } : parseBody(body));
    }
    function persist() {
        try {
            const list = [];
            let size = 0;
            for (const job of jobs.values()) {
                if (job.attached || job.status === 'running' || !job.head) continue;
                const body = bodyText(job);
                size += body.length;
                if (size > STORE_LIMIT) break;
                list.push({ id: job.id, key: job.key, avatar: job.avatar, name: job.name, chatId: job.chatId, type: job.type, sig: job.sig,
                    head: job.head, created: job.created, baseLength: job.baseLength, cont: job.cont, swipeIndex: job.swipeIndex, finishedAt: job.finishedAt, truncated: !!job.truncated, body });
            }
            if (list.length) host.localStorage.setItem(STORE, JSON.stringify(list));
            else host.localStorage.removeItem(STORE);
        } catch { /* 存储不可用只影响刷新后的恢复 */ }
    }
    function restore() {
        try {
            const list = JSON.parse(host.localStorage.getItem(STORE) || '[]');
            for (const item of Array.isArray(list) ? list : []) {
                if (!item?.id || !item.key || !item.head || typeof item.body !== 'string' || sessions.size >= MAX_SESSIONS) continue;
                const chunk = encoder.encode(item.body);
                const job = { ...item, status: 'done', chunks: [chunk], bytes: chunk.byteLength, attached: false, detaching: false, front: null, ac: new AbortController(), restored: true };
                delete job.body;
                jobs.set(job.id, job);
                sessions.set(job.key, { key: job.key, avatar: job.avatar, name: job.name, chatId: job.chatId, job, unread: true, touched: job.finishedAt || 0 });
            }
        } catch { /* 损坏的记录直接忽略 */ }
    }
    function drop(job, { abort = false } = {}) {
        if (abort && job.status === 'running') { job.status = 'stopped'; try { job.ac.abort(); } catch { /* already finished */ } }
        jobs.delete(job.id);
        const session = sessions.get(job.key);
        if (session?.job === job) { session.job = null; session.unread = false; }
        if (replayArm?.job === job) releaseReplay();
        persist(); queueRender();
    }
    function settle() {
        if (isGenerating()) return;
        for (const job of [...jobs.values()]) {
            if (job.attached && !job.detaching && job.status !== 'running') drop(job);
        }
    }
    function finish(job, error) {
        if (job.status === 'running') job.status = 'done';
        job.finishedAt = Date.now();
        const front = job.front; job.front = null;
        if (front) { try { error ? front.error(error) : front.close(); } catch { /* 原生端已取消读取 */ } }
        if (error && !job.head) { job.failure = error; job.onFail?.(error); }
        else if (error) job.truncated = true;
        if (job.status === 'stopped' && !job.keepPartial) { drop(job); return; }
        if (!job.attached && !job.detaching) announce(job);
        queueRender(); host.setTimeout(settle, 300);
    }
    function announce(job) {
        const session = sessions.get(job.key);
        if (!session || session.job !== job) return;
        persist();
        if (job.key === curKey && !switching) { scheduleReattach(50); return; }
        session.unread = true;
        if (switching) return;
        completionSound();
        notify(job.failure ? `${job.name} 的后台生成失败，切回可查看原因。` : `${job.name} 的回复已完成，可以切回查看。`);
    }
    function pump(job, request) {
        request.then(async response => {
            job.head = { status: response.status, statusText: response.statusText, type: response.headers.get('content-type') || 'application/json' };
            job.onHead?.();
            const add = value => {
                if (!value?.byteLength) return;
                job.chunks.push(value); job.bytes += value.byteLength;
                if (job.front) { try { job.front.enqueue(value.slice()); } catch { job.front = null; } }
            };
            if (NULL_BODY.includes(response.status)) { /* no body */ }
            else if (response.body?.getReader) {
                const reader = response.body.getReader();
                for (;;) { const { done, value } = await reader.read(); if (done) break; add(value); }
            } else add(new Uint8Array(await response.arrayBuffer()));
            finish(job);
        }).catch(error => finish(job, error));
    }
    function buildResponse(job, bytes = null) {
        const head = job.head;
        const init = { status: head.status >= 200 && head.status <= 599 ? head.status : 200, statusText: head.statusText || '', headers: { 'Content-Type': bytes ? (job.replaySig?.stream ? 'text/event-stream' : 'application/json') : head.type } };
        if (NULL_BODY.includes(init.status)) return new host.Response(null, init);
        if (bytes) return new host.Response(bytes, { ...init, status: 200 });
        let controller;
        const body = new host.ReadableStream({
            start(c) {
                controller = c;
                for (const chunk of job.chunks) c.enqueue(chunk.slice());
                if (job.status !== 'running') c.close(); else job.front = c;
            },
            cancel() { if (job.front === controller) job.front = null; },
        });
        return new host.Response(body, init);
    }
    // 交给酒馆的那一端：它的中止信号只在“不是转入后台”时才真正取消网络请求。
    function serve(job, signal, makeResponse) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const abortError = () => new host.DOMException('The operation was aborted.', 'AbortError');
            const onAbort = () => {
                signal?.removeEventListener('abort', onAbort);
                const userStop = !job.detaching;
                if (userStop && job.status === 'running') { job.status = 'stopped'; try { job.ac.abort(); } catch { /* ignore */ } }
                const front = job.front; job.front = null;
                try { front?.error(abortError()); } catch { /* already closed */ }
                if (!settled) { settled = true; reject(abortError()); }
                if (userStop) { host.setTimeout(() => { if (jobs.has(job.id) && job.status !== 'running') drop(job); }, 0); }
            };
            if (signal?.aborted) { onAbort(); return; }
            signal?.addEventListener('abort', onAbort);
            const deliver = () => {
                if (settled) return;
                settled = true;
                try { resolve(makeResponse()); } catch (error) { reject(error); }
            };
            job.onFail = error => { if (!settled) { settled = true; reject(error); } };
            if (job.failure && !job.head) { job.onFail(job.failure); return; }
            job.onHead = deliver;
            if (job.head) deliver();
        });
    }
    function intercept(arm, input, init) {
        const signal = init?.signal || (typeof input === 'object' ? input.signal : null);
        const sig = signature(input, init);
        if (arm.replay) return replay(arm.replay, sig, signal);
        for (const old of [...jobs.values()]) if (old.attached && old.status !== 'running') drop(old);
        const info = arm.gen.info;
        const session = ensureSession(info);
        if (!session || session.job) return nativeFetch.call(host, input, init);
        const job = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, key: info.key, avatar: info.avatar, name: info.name, chatId: info.chatId,
            type: arm.gen.type, cont: arm.gen.cont, sig, status: 'running', chunks: [], bytes: 0, head: null, attached: true, detaching: false, front: null,
            ac: new AbortController(), baseLength: ctx().chat.length, created: false, startedAt: Date.now() };
        // 滑动生成：此刻 swipe_id 指向即将生成的那一格。
        if (job.type === 'swipe') job.swipeIndex = Number(ctx().chat[job.baseLength - 1]?.swipe_id) || 0;
        jobs.set(job.id, job); session.job = job; session.unread = false;
        let request;
        try { request = nativeFetch.call(host, input, { ...(init || {}), signal: job.ac.signal }); }
        catch (error) { drop(job); throw error; }
        pump(job, request); queueRender();
        return serve(job, signal, () => buildResponse(job));
    }
    function replay(job, sig, signal) {
        releaseReplay();
        job.attached = true; job.replaySig = sig;
        const session = sessions.get(job.key); if (session) session.unread = false;
        queueRender();
        const same = !job.head || job.head.status >= 400 || (job.sig.path === sig.path && job.sig.src === sig.src && job.sig.stream === sig.stream);
        if (same) return serve(job, signal, () => buildResponse(job));
        // 接口类型或流式开关与发起时不同：等完整结果后转成当前接口能读的格式。
        return waitFor(() => job.status !== 'running' || !!signal?.aborted, 3600000, 200)
            .then(() => serve(job, signal, () => buildResponse(job, encoder.encode(reencode(parsed(job), sig.stream)))));
    }
    function releaseReplay() {
        const arm = replayArm; replayArm = null;
        if (!arm) return;
        host.clearTimeout(arm.timer);
        if (arm.draft) {
            const input = doc.getElementById('send_textarea');
            if (input && !input.value) { input.value = arm.draft; input.dispatchEvent(new host.Event('input', { bubbles: true })); }
        }
    }

    // ----- 阅读位置：切走时记住读到哪一楼，切回后恢复 -----
    const readings = new Map();   // key -> { bottom } | { mesid, offset }
    let restoringUntil = 0, readingTimer = null, cancelRestore = () => {};
    const scroller = () => doc.getElementById('chat');
    function recordReading() {
        if (disposed || Date.now() < restoringUntil || !curKey) return;
        const el = scroller();
        // 聊天正在清空或加载另一份时不记录，避免把旧位置覆盖掉。
        if (!el || current().key !== curKey) return;
        const nodes = el.querySelectorAll('.mes[mesid]');
        if (!nodes.length) return;
        readings.delete(curKey);
        if (el.scrollHeight - el.clientHeight - el.scrollTop < 8) { readings.set(curKey, { bottom: true }); }
        else {
            const top = el.getBoundingClientRect().top + el.clientTop;
            for (const node of nodes) {
                const r = node.getBoundingClientRect();
                if (r.bottom > top && r.height > 0) { readings.set(curKey, { bottom: false, mesid: node.getAttribute('mesid'), offset: r.top - top }); break; }
            }
        }
        if (readings.size > 40) readings.delete(readings.keys().next().value);
    }
    const onChatScroll = () => { if (readingTimer === null) readingTimer = host.setTimeout(() => { readingTimer = null; recordReading(); }, 150); };
    scroller()?.addEventListener('scroll', onChatScroll, { passive: true });
    // 点聊天区以外的任何东西（角色列表、历史记录、关闭聊天…）之前先记一次，不依赖滚动事件。
    const onOutsideClick = event => { if (!event.target?.closest?.('#chat')) recordReading(); };
    doc.addEventListener('click', onOutsideClick, true);
    teardown.push(() => { scroller()?.removeEventListener('scroll', onChatScroll); doc.removeEventListener('click', onOutsideClick, true); host.clearTimeout(readingTimer); cancelRestore(); });
    const pendingWrite = key => { const job = sessions.get(key)?.job; return !!job && !job.mismatch; };
    function restoreReading(key) {
        cancelRestore();
        const saved = key && readings.get(key);
        // 有后台回复要写回时不恢复，让酒馆自己滚到新回复。
        if (!saved || saved.bottom || saved.mesid == null || pendingWrite(key)) return;
        restoringUntil = Date.now() + 1600;
        let cancelled = false;
        const timers = [], inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
        const cancel = () => {
            if (cancelled) return;
            cancelled = true; restoringUntil = 0;
            timers.forEach(id => host.clearTimeout(id));
            for (const name of inputs) host.removeEventListener(name, cancel, true);
        };
        for (const name of inputs) host.addEventListener(name, cancel, { capture: true, passive: true });
        const apply = () => {
            if (cancelled || curKey !== key || pendingWrite(key)) return;
            const el = scroller();
            const anchor = el && [...el.querySelectorAll('.mes[mesid]')].find(node => node.getAttribute('mesid') === saved.mesid);
            if (!anchor) return;
            const top = el.getBoundingClientRect().top + el.clientTop;
            const delta = anchor.getBoundingClientRect().top - top - saved.offset;
            if (Math.abs(delta) > 1) el.scrollTop += delta;
        };
        // 酒馆加载完会滚到底，图片加载还会改变高度：短时间内多校正几次，用户一操作就停。
        for (const ms of [0, 120, 350, 800, 1400]) timers.push(host.setTimeout(apply, ms));
        timers.push(host.setTimeout(cancel, 1600));
        cancelRestore = cancel;
    }

    const nativeFetch = host.fetch;
    function parallelFetch(input, init) {
        const arm = armed;
        if (arm && !disposed) {
            let match = false;
            try {
                const url = typeof input === 'string' ? input : input?.url || String(input);
                const method = String(init?.method || input?.method || 'GET').toUpperCase();
                match = Date.now() < arm.until && method === 'POST' && GEN_URL.test(new URL(url, host.location.href).pathname);
            } catch { /* 无法识别的请求原样放行 */ }
            if (match) { armed = null; return intercept(arm, input, init); }
        }
        return nativeFetch.apply(host, arguments);
    }
    host.fetch = parallelFetch;
    teardown.push(() => { if (host.fetch === parallelFetch) host.fetch = nativeFetch; });

    on(events.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun) return;
        if (type === 'quiet') { quietPending++; return; }
        quietPending = 0;
        const info = current(), chat = ctx().chat, last = chat[chat.length - 1];
        gen = { type, info, cont: type === 'continue' && last ? { mes: String(last.mes ?? '') } : null };
        queueRender();
    });
    on(events.GENERATE_AFTER_DATA, (_data, dryRun) => {
        if (dryRun) return;
        if (quietPending > 0) { quietPending--; return; }
        if (!gen) return;
        if (replayArm && replayArm.job.key === gen.info.key) armed = { replay: replayArm.job, until: Date.now() + 15000 };
        else if (gen.info.key && TYPES.includes(gen.type)) armed = { gen, until: Date.now() + 15000 };
    });
    const generationOver = () => { host.setTimeout(() => { settle(); queueRender(); }, 150); };
    on(events.GENERATION_ENDED, generationOver);
    on(events.GENERATION_STOPPED, generationOver);
    on(events.CHAT_CHANGED, () => { syncCurrent(); restoreReading(curKey); queueRender(); scheduleReattach(400); });
    on(events.APP_READY, () => { syncCurrent(); queueRender(); scheduleReattach(600); });

    // ----- 转入后台 / 切回 -----
    async function detach(job) {
        if (!job.attached || job.detaching) return false;
        if ([...sessions.values()].filter(s => s.job && s.job !== job).length >= MAX_SESSIONS - 1) {
            notify(`后台最多同时保留 ${MAX_SESSIONS - 1} 个回复。请先切回查看或丢弃其中一个。`);
            return false;
        }
        job.detaching = true;
        let ended = false;
        const onEnded = () => { ended = true; };
        emitter.on(events.GENERATION_ENDED, onEnded);
        try {
            ctx().stopGeneration();
            await waitFor(() => ended, 1200);
            await waitFor(() => !isGenerating() && !isSwiping(), 8000);
            if (job.type === 'swipe') { await delay(150); await waitFor(() => !isSwiping(), 5000); }
            const c = ctx(), chat = c.chat, last = chat[chat.length - 1];
            if (current().key === job.key && last && !last.is_user) {
                let own = job.type === 'continue' || chat.length > job.baseLength;
                if (job.type === 'swipe' && Array.isArray(last.swipes) && last.swipes.length) {
                    // 首个字到达前中断时，酒馆把 swipe_id 留在尚不存在的那一格；存盘前先拨回。
                    if ((Number(last.swipe_id) || 0) >= last.swipes.length) { last.swipe_id = last.swipes.length - 1; last.mes = last.swipes[last.swipe_id]; }
                    own = job.swipeIndex >= 1 && last.swipes.length >= job.swipeIndex;
                }
                if (own) {
                    job.created = true;
                    (last.extra ||= {}).pt_job = job.id;
                    try { await c.saveChat(); } catch { /* 原生保存失败时酒馆自己会提示 */ }
                }
            }
        } finally {
            emitter.removeListener ? emitter.removeListener(events.GENERATION_ENDED, onEnded) : emitter.off?.(events.GENERATION_ENDED, onEnded);
            job.attached = false; job.detaching = false; job.front = null; job.onHead = null; job.onFail = null;
        }
        if (job.status !== 'running') { const session = sessions.get(job.key); if (session?.job === job) session.unread = true; persist(); }
        queueRender();
        return true;
    }
    function scheduleReattach(ms) {
        host.clearTimeout(reattachTimer);
        reattachTimer = host.setTimeout(() => void tryReattach(), ms);
    }
    async function tryReattach() {
        if (disposed || reattachBusy || switching) return;
        const info = current();
        if (!info.key) return;
        const session = sessions.get(info.key), job = session?.job;
        if (!job) {
            // 任务已不存在（刷新、丢弃）：清掉旧标记即可，文本保持原样。
            const chat = ctx().chat, last = chat[chat.length - 1];
            if (last?.extra?.pt_job && !jobs.has(last.extra.pt_job)) delete last.extra.pt_job;
            return;
        }
        if (job.attached || job.detaching || job.mismatch || replayArm) return;
        if (isGenerating() || isSwiping()) { scheduleReattach(800); return; }
        reattachBusy = true;
        try {
            try { await profile?.activate?.(); } catch { /* 配置恢复失败不阻止写回 */ }
            if (current().key !== job.key || isGenerating() || session.job !== job || job.attached) return;
            const c = ctx(), chat = c.chat, last = chat[chat.length - 1];
            const marked = !!last && !last.is_user && last.extra?.pt_job === job.id;
            let mode = null;
            if (job.type === 'swipe') {
                const index = job.swipeIndex;
                if (marked && index >= 1 && Array.isArray(last.swipes) && (last.swipes.length === index || last.swipes.length === index + 1)) {
                    // 去掉中断时留下的半截滑动，再让原生流程生成同一格。
                    last.swipes.length = index;
                    if (Array.isArray(last.swipe_info) && last.swipe_info.length > index) last.swipe_info.length = index;
                    last.swipe_id = index - 1; last.mes = last.swipes[index - 1];
                    delete last.extra.pt_job; mode = 'swipe';
                }
            } else if (job.type === 'continue') {
                if (marked && job.cont) {
                    last.mes = job.cont.mes;
                    if (Array.isArray(last.swipes) && last.swipes.length) last.swipes[Number(last.swipe_id) || 0] = job.cont.mes;
                    delete last.extra.pt_job; mode = 'continue';
                }
            } else if (job.created) {
                if (marked && chat.length === job.baseLength + 1) mode = 'regenerate';
            } else if (chat.length === job.baseLength) mode = last?.is_user ? 'regenerate' : 'normal';
            if (!mode) {
                job.mismatch = true; session.unread = true;
                notify(`「${job.name}」的聊天内容已有变化，后台回复没有自动写入。可在并行面板里复制文本或丢弃。`);
                render(); return;
            }
            session.unread = false;
            replayArm = { job, draft: '', timer: host.setTimeout(() => { if (replayArm?.job === job) { releaseReplay(); queueRender(); } }, 30000) };
            trigger(mode);
            queueRender();
        } finally { reattachBusy = false; }
    }
    function trigger(mode) {
        const c = ctx();
        const click = id => { const node = doc.getElementById(id); if (node) { node.click(); return true; } return false; };
        const run = type => Promise.resolve().then(() => c.generate(type)).catch(error => console.warn('[并行对话] 回放失败', error));
        if (mode === 'regenerate') { if (!click('option_regenerate')) void run('regenerate'); }
        else if (mode === 'continue') { if (!click('option_continue')) void run('continue'); }
        else if (mode === 'swipe') {
            if (typeof c.swipe?.right === 'function') Promise.resolve().then(() => c.swipe.right()).catch(() => {});
            else doc.querySelector('#chat .last_mes .swipe_right')?.click();
        } else {
            // 末尾不是用户消息的普通生成：先收起输入框草稿，避免被当成新消息发出。
            const input = doc.getElementById('send_textarea');
            if (input?.value) { replayArm.draft = input.value; input.value = ''; }
            void run('normal');
        }
    }
    async function openSession(target) {
        if (switching || disposed) return;
        switching = true;
        try {
            recordReading();
            const now = current();
            if (now.avatar === target.avatar && (!target.chatId || now.chatId === target.chatId)) { panelOpen = false; pickerOpen = false; render(); scheduleReattach(50); return; }
            if (replayArm) { notify('正在写回后台回复，请稍等一下再切换。'); return; }
            if (isGenerating()) {
                const job = foregroundJob();
                if (!job) { notify('当前这次生成无法转入后台（群聊、扩展自己的请求或不支持的接口）。请等待完成或先停止。'); return; }
                if (!(await detach(job))) return;
            }
            const c = ctx();
            const index = c.characters.findIndex(character => character?.avatar === target.avatar);
            if (index < 0) { notify('没有找到这个角色，请先刷新角色列表。'); return; }
            panelOpen = false; pickerOpen = false; render();
            if (c.groupId || String(c.characterId) !== String(index)) await c.selectCharacterById(index, { switchMenu: false });
            if (current().avatar !== target.avatar) { notify('酒馆没有完成切换，请稍后再试。'); return; }
            if (target.chatId && current().chatId !== target.chatId) await c.openCharacterChat(target.chatId);
        } catch (error) {
            notify(`切换失败：${shortError(error)}`);
        } finally {
            switching = false; syncCurrent(); render(); scheduleReattach(400);
        }
    }
    function closeSession(session) {
        if (session.job) {
            if (session.job.attached && isGenerating()) { notify('这个对话正在前台生成，请先停止或等待完成。'); return; }
            if (!host.confirm(session.job.status === 'running' ? '这个对话还在后台生成，关闭会丢弃这次回复。确定关闭？' : '这个对话有一条还没写回的后台回复，关闭会丢弃它。确定关闭？')) return;
            drop(session.job, { abort: true });
        }
        if (session.key !== curKey) sessions.delete(session.key);
        controlsKey = null; render();
    }
    function stopSession(session) {
        const job = session.job;
        if (session.key === curKey && (!job || job.attached)) { try { ctx().stopGeneration(); } catch (error) { notify(`停止失败：${shortError(error)}`); } return; }
        if (job?.status === 'running') {
            if (!job.head) { drop(job, { abort: true }); notify('已停止，这次回复还没有收到内容。'); return; }
            // 保留已收到的部分，切回后照常写入。
            job.keepPartial = true; job.status = 'done';
            try { job.ac.abort(); } catch { /* ignore */ }
        }
        queueRender();
    }
    async function copyJob(job) {
        const { text, reasoning } = parsed(job);
        const value = text || reasoning || bodyText(job);
        try { await host.navigator.clipboard.writeText(value); notify('已复制回复文本。'); }
        catch {
            const area = element('textarea'); area.value = value; area.readOnly = true; area.style.cssText = 'width:100%;height:160px';
            picker.replaceChildren(element('p', 'pt-muted', '浏览器不允许自动复制，请手动全选复制。'), area, button('返回', () => { pickerOpen = false; render(); }));
            pickerOpen = true; panelOpen = true; render(); area.focus(); area.select();
        }
    }

    // ----- 提示音 -----
    const soundKey = 'parallel-tavern.completion-sound';
    let nightMode = false, soundEnabled = true, audioContext = null;
    try { nightMode = host.localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch { /* default */ }
    try { soundEnabled = host.localStorage.getItem(soundKey) !== 'off'; } catch { /* default */ }
    function unlockSound() {
        if (!soundEnabled || disposed) return;
        try {
            const Audio = host.AudioContext || host.webkitAudioContext;
            if (!Audio) return;
            audioContext ||= new Audio();
            if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {});
        } catch { /* 音频限制不能影响聊天 */ }
    }
    function completionSound() {
        if (!soundEnabled || disposed || audioContext?.state !== 'running') return;
        try {
            const at = audioContext.currentTime;
            const gain = audioContext.createGain(); gain.connect(audioContext.destination);
            gain.gain.setValueAtTime(0, at);
            gain.gain.linearRampToValueAtTime(0.10, at + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, at + 0.6);
            const tone = audioContext.createOscillator(); tone.type = 'sine';
            tone.frequency.setValueAtTime(660, at); tone.frequency.setValueAtTime(880, at + 0.16);
            tone.connect(gain);
            tone.onended = () => { tone.disconnect(); gain.disconnect(); };
            tone.start(at); tone.stop(at + 0.65);
        } catch { /* 没有输出设备 */ }
    }
    host.addEventListener('pointerdown', unlockSound, true);
    host.addEventListener('keydown', unlockSound, true);
    teardown.push(() => {
        host.removeEventListener('pointerdown', unlockSound, true); host.removeEventListener('keydown', unlockSound, true);
        if (audioContext) void audioContext.close().catch(() => {});
    });

    // ----- 界面 -----
    let launcherVisible = settings.showLauncher !== false;
    let panelOpen = false, pickerOpen = false, menuOpen = false, controlsKey = null;
    let launcherSide = null, launcherSignature = '', badgeSignature = '';
    let renderPending = false, pointerActive = false, toastTimer;
    const element = (tag, className, text) => {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const button = (text, fn, label = text) => {
        const node = element('button', 'pt-button', text);
        node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
        node.addEventListener('click', fn);
        return node;
    };
    const shortError = error => String(error?.message || error || '未知错误').slice(0, 240);
    function iconButton(label, name, action) {
        const node = button('', action, label); node.classList.add('pt-icon-button');
        const paths = { minus: 'M5 12h14', more: 'M5 12h.01M12 12h.01M19 12h.01' };
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'pt-icon'); svg.setAttribute('aria-hidden', 'true');
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name] || paths.more);
        svg.append(path); node.append(svg); return node;
    }
    function portrait(item) {
        const face = element('span', 'pt-portrait', [...(item.name || '聊')][0]);
        face.setAttribute('aria-hidden', 'true');
        try {
            const url = item.avatar && ctx().getThumbnailUrl?.('avatar', item.avatar);
            if (url) {
                const img = doc.createElement('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.src = url;
                img.addEventListener('error', () => img.remove(), { once: true }); face.append(img);
            }
        } catch { /* 缩略图不可用时保留首字 */ }
        return face;
    }
    const launcher = button('并行', event => {
        if (launcherSide) { expandLauncher(); return; }
        if (settings.avatarQuickSwitch === true && event.detail > 0) {
            const face = [...launcher.querySelectorAll('[data-pt-session]')].reverse().find(node => {
                const r = node.getBoundingClientRect();
                return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
            });
            const session = face && sessions.get(face.dataset.ptSession);
            if (session) { void openSession(session); return; }
        }
        panelOpen = !panelOpen; pickerOpen = false; render();
    });
    launcher.id = 'pt-launcher'; launcher.dataset.ttMobileSurface = 'free-window';
    const completionBadge = element('span'); completionBadge.id = 'pt-completion-badge'; completionBadge.hidden = true; completionBadge.setAttribute('aria-hidden', 'true');
    const panel = element('section'); panel.id = 'pt-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', '并行角色会话'); panel.dataset.ttMobileSurface = 'free-window';
    const picker = element('section'); picker.id = 'pt-picker'; picker.hidden = true;
    const toast = element('div'); toast.id = 'pt-toast'; toast.hidden = true; toast.setAttribute('role', 'status');
    const safeArea = element('div');
    safeArea.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    doc.body.append(launcher, panel, toast, completionBadge, safeArea);
    teardown.push(() => { for (const node of [launcher, panel, toast, completionBadge, safeArea]) node.remove(); });

    function floatingBounds() {
        const v = host.visualViewport, css = host.getComputedStyle(safeArea), root = host.getComputedStyle(doc.documentElement);
        const usable = n => Number.isFinite(n) && n >= 80;
        const vw = usable(v?.width) ? v.width : (host.innerWidth || doc.documentElement.clientWidth || 360);
        const vh = usable(v?.height) ? v.height : (host.innerHeight || doc.documentElement.clientHeight || 640);
        const x = usable(v?.width) && Number.isFinite(v.offsetLeft) ? v.offsetLeft : 0;
        const y = usable(v?.height) && Number.isFinite(v.offsetTop) ? v.offsetTop : 0;
        const inset = (side, padding, limit) => Math.min(limit / 4, Math.max(0, parseFloat(root.getPropertyValue(`--tt-inset-${side}`)) || parseFloat(padding) || 0));
        return { left: x + inset('left', css.paddingLeft, vw) + 12, top: y + inset('top', css.paddingTop, vh) + 12,
            right: x + vw - inset('right', css.paddingRight, vw) - 12, bottom: y + vh - inset('bottom', css.paddingBottom, vh) - 12 };
    }
    function positionCompletionBadge() {
        if (completionBadge.hidden || launcherSide) return;
        const faces = [...launcher.querySelectorAll('[data-pt-session]')];
        for (const badge of completionBadge.children) {
            const face = faces.find(node => node.dataset.ptSession === badge.dataset.ptSession);
            badge.hidden = !face;
            if (!face) continue;
            const r = face.getBoundingClientRect();
            badge.style.setProperty('left', `${Math.max(2, r.right - 8)}px`, 'important');
            badge.style.setProperty('top', `${Math.max(2, r.top - 5)}px`, 'important');
        }
    }
    function show(node, visible) {
        if ((node === launcher || node === completionBadge) && !launcherVisible) visible = false;
        node.hidden = !visible;
        if (visible) {
            node.style.setProperty('visibility', 'visible', 'important');
            node.style.setProperty('opacity', '1', 'important');
            node.style.setProperty('position', 'fixed', 'important');
            if (node !== toast) node.style.setProperty('transform', 'none', 'important');
        }
    }
    function dockLauncher(side) {
        launcherSide = side; launcher.dataset.side = side; launcher.dataset.ptDragged = 'true';
        panelOpen = false; pickerOpen = false; render();
    }
    function expandLauncher() {
        const side = launcherSide;
        launcherSide = null; delete launcher.dataset.side;
        const b = floatingBounds();
        launcher.style.setProperty('left', `${side === 'left' ? b.left : b.right - launcher.offsetWidth}px`, 'important');
        launcherSignature = ''; render();
    }
    function draggable(node, handle) {
        let drag = null, suppressClick = false;
        node.addEventListener('pointerdown', e => {
            if (e.button !== 0 || drag || !handle(e.target)) return;
            suppressClick = false;
            const rect = node.getBoundingClientRect(), b = floatingBounds();
            const edge = rect.left <= b.left + 24 ? 'left' : rect.right >= b.right - 24 ? 'right' : null;
            drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, moved: false, edge, side: launcherSide };
            if (node === launcher) pointerActive = true;
            try { node.setPointerCapture?.(e.pointerId); } catch { /* WebView 可能已释放指针 */ }
        });
        node.addEventListener('pointermove', e => {
            if (!drag || e.pointerId !== drag.id) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) < 5 && !drag.moved) return;
            drag.moved = true; e.preventDefault();
            node.dataset.ptDragged = 'true';
            const bounds = floatingBounds();
            const left = node === launcher && launcherSide ? (launcherSide === 'left' ? bounds.left : bounds.right - node.offsetWidth)
                : Math.max(bounds.left, Math.min(bounds.right - node.offsetWidth, drag.left + dx));
            const top = Math.max(bounds.top, Math.min(bounds.bottom - node.offsetHeight, drag.top + dy));
            for (const [k, v] of [['left', left + 'px'], ['top', top + 'px'], ['right', 'auto'], ['bottom', 'auto'], ['margin', '0']]) node.style.setProperty(k, v, 'important');
            if (node === launcher) positionCompletionBadge();
        });
        node.addEventListener('pointerup', e => {
            if (!drag || e.pointerId !== drag.id) return;
            const finished = drag; drag = null;
            suppressClick = finished.moved;
            if (node !== launcher) return;
            pointerActive = false;
            const dx = e.clientX - finished.x, dy = e.clientY - finished.y;
            if (Math.abs(dx) >= 32 && Math.abs(dx) > Math.abs(dy) * 1.3) {
                if (finished.side && (finished.side === 'left' ? dx > 0 : dx < 0)) expandLauncher();
                else if (!finished.side && finished.edge && (finished.edge === 'left' ? dx < 0 : dx > 0)) dockLauncher(finished.edge);
            }
            keepFloatingVisible();
        });
        const cancelDrag = e => {
            if (!drag || e.pointerId !== drag.id) return;
            suppressClick = drag.moved; drag = null;
            if (node === launcher) { pointerActive = false; keepFloatingVisible(); }
        };
        node.addEventListener('pointercancel', cancelDrag);
        node.addEventListener('lostpointercapture', cancelDrag);
        node.addEventListener('click', e => { if (suppressClick && e.detail > 0) { suppressClick = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
    }
    draggable(launcher, () => true);
    draggable(panel, target => !!target.closest?.('.pt-heading'));
    function keepFloatingVisible() {
        if (disposed) return;
        const b = floatingBounds();
        const width = Math.max(1, b.right - b.left), height = Math.max(1, b.bottom - b.top);
        const compact = width < 600 || height < 500;
        const panelReserve = compact ? (launcher.offsetHeight || 56) + 18 : 146;
        const set = (e, k, v) => { if (e.style.getPropertyValue(k) !== v) e.style.setProperty(k, v, 'important'); };
        for (const node of [launcher, panel]) {
            set(node, 'max-width', `${width}px`);
            if (node === panel) { set(node, 'width', `${Math.min(364, width)}px`); set(node, 'max-height', `${Math.max(1, height - panelReserve)}px`); }
            if (node.hidden || !node.offsetHeight) continue;
            const rect = node.getBoundingClientRect();
            const preferredTop = node.dataset.ptDragged ? rect.top : b.bottom - rect.height - (node === panel ? panelReserve : compact ? 0 : 76);
            const top = Math.max(b.top, Math.min(b.bottom - rect.height, preferredTop));
            const left = node === launcher && launcherSide ? (launcherSide === 'left' ? b.left : b.right - rect.width)
                : Math.max(b.left, Math.min(b.right - rect.width, node.dataset.ptDragged ? rect.left : b.right - rect.width));
            set(node, 'top', `${top}px`); set(node, 'left', `${left}px`);
            set(node, 'right', 'auto'); set(node, 'bottom', 'auto'); set(node, 'margin', '0px');
        }
        if (!toast.hidden) {
            set(toast, 'max-width', `${width}px`);
            set(toast, 'left', `${(b.left + b.right) / 2}px`);
            set(toast, 'top', `${Math.max(b.top, b.bottom - toast.offsetHeight)}px`); set(toast, 'bottom', 'auto');
        }
        positionCompletionBadge();
    }
    host.addEventListener('resize', keepFloatingVisible);
    host.visualViewport?.addEventListener('resize', keepFloatingVisible);
    host.visualViewport?.addEventListener('scroll', keepFloatingVisible);
    teardown.push(() => {
        host.removeEventListener('resize', keepFloatingVisible);
        host.visualViewport?.removeEventListener('resize', keepFloatingVisible); host.visualViewport?.removeEventListener('scroll', keepFloatingVisible);
    });
    function notify(message) {
        toast.textContent = message; show(toast, true); keepFloatingVisible();
        host.clearTimeout(toastTimer); toastTimer = host.setTimeout(() => show(toast, false), 6500);
    }

    panel.addEventListener('pointerdown', () => { pointerActive = true; }, true);
    const releasePointer = () => { pointerActive = false; };
    host.addEventListener('pointerup', releasePointer, true);
    host.addEventListener('pointercancel', releasePointer, true);
    teardown.push(() => { host.removeEventListener('pointerup', releasePointer, true); host.removeEventListener('pointercancel', releasePointer, true); });
    function queueRender() {
        if (renderPending || disposed) return;
        renderPending = true;
        host.setTimeout(() => { renderPending = false; if (!disposed) { if (pointerActive) queueRender(); else render(); } }, 160);
    }

    function stateOf(session) {
        const job = session.job, here = session.key === curKey;
        if (job && !job.attached) {
            if (job.status === 'running') return { state: 'busy', busy: true, label: `后台生成中 · 已收到 ${parsed(job).text.length} 字` };
            if (job.mismatch) return { state: 'error', label: '聊天已变化，未自动写入' };
            if (job.failure || job.head?.status >= 400) return { state: 'error', label: '生成失败 · 切回查看原因' };
            return { state: 'done', label: here ? '正在写回…' : job.truncated ? '已中断 · 切回写入已收到的部分' : '已完成 · 点击切回查看' };
        }
        if (here && isGenerating()) return { state: 'busy', busy: true, label: '正在回复…' };
        return { state: 'idle', label: here ? '当前对话' : '待命' };
    }
    function preview(session) {
        try {
            if (session.job && !session.job.attached) {
                const { text, reasoning } = parsed(session.job);
                if (text || reasoning) return (text || reasoning).slice(-200);
            }
            if (session.key === curKey) {
                const chat = ctx().chat;
                for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i].is_user && !chat[i].is_system) return String(chat[i].mes || '').slice(-200);
            }
        } catch { /* 尚未就绪 */ }
        return '';
    }
    function updateLauncher() {
        const all = [...sessions.values()];
        const states = all.map(stateOf);
        const running = states.filter(s => s.busy).length;
        const completed = all.filter(s => s.unread);
        launcher.dataset.state = running ? 'generating' : completed.length ? 'completed' : 'idle';
        const sig = JSON.stringify([running, completed.length, all.map(s => [s.key, s.name])]);
        if (sig !== launcherSignature) {
            launcherSignature = sig;
            const dock = element('span', 'pt-dock'), faces = element('span', 'pt-dock-faces');
            for (const s of all) { const face = portrait(s); face.dataset.ptSession = s.key; faces.append(face); }
            if (!all.length) faces.append(portrait({ name: '并' }));
            const label = element('span', 'pt-dock-label', completed.length ? `${completed.length} 个已完成` : '并行会话');
            label.append(element('span', 'pt-dock-note', running ? `${running} 个正在回复` : '点开查看会话'));
            dock.append(faces, label);
            launcher.replaceChildren(dock);
        }
        const nextBadge = JSON.stringify(completed.map(s => s.key));
        if (nextBadge !== badgeSignature) {
            badgeSignature = nextBadge;
            completionBadge.replaceChildren(...completed.map(s => { const badge = element('span', 'pt-avatar-badge', '1'); badge.dataset.ptSession = s.key; return badge; }));
        }
        show(completionBadge, completed.length > 0 && !launcherSide); positionCompletionBadge();
        const label = launcherSide ? `并行对话：${running ? `${running} 个会话正在生成` : completed.length ? '生成已完成' : '暂无生成'}；点击或向内滑动展开`
            : completed.length ? `并行对话：${completed.map(s => s.name).join('、')} 已生成完成，待查看` : '并行对话；拖到边缘后向外滑动可收起';
        launcher.title = label; launcher.setAttribute('aria-label', label);
    }
    function applyTheme() { for (const node of [panel, launcher, toast, completionBadge]) node.dataset.night = String(nightMode); }
    function setNightMode(value) {
        nightMode = !!value;
        try { host.localStorage.setItem('parallel-tavern.night-mode', nightMode ? 'on' : 'off'); } catch { /* ignore */ }
        applyTheme(); render();
        host.dispatchEvent(new host.CustomEvent('pt-night-mode', { detail: nightMode }));
    }
    function render() {
        if (disposed) return;
        applyTheme(); updateLauncher();
        launcher.setAttribute('aria-expanded', String(!launcherSide && panelOpen));
        show(panel, panelOpen); picker.hidden = !pickerOpen; show(launcher, true);
        keepFloatingVisible();
        if (!panelOpen) return;
        if (pickerOpen) { if (picker.parentNode !== panel) panel.replaceChildren(picker); return; }
        panel.replaceChildren();
        const row = element('div', 'pt-row');
        const heading = element('span', 'pt-heading', 'Parallel');
        heading.append(element('span', 'pt-subheading', '并 行 会 话'));
        const add = button('＋ 打开对话', showPicker, '打开对话'); add.classList.add('pt-add');
        row.append(heading, add, iconButton('收起', 'minus', () => { panelOpen = false; render(); }));
        panel.append(row);
        const all = [...sessions.values()];
        const overview = element('div', 'pt-overview');
        overview.append(element('span', 'pt-live-count', `${all.filter(s => stateOf(s).busy).length} 正在回复`), element('span', 'pt-ready-count', `${all.filter(s => s.unread).length} 待查看`));
        panel.append(overview);
        const section = element('div', 'pt-section-label', '对话'); section.append(element('span', '', `${sessions.size} / ${MAX_SESSIONS}`)); panel.append(section);
        const list = element('div', 'pt-session-list'); panel.append(list);
        if (!all.length) list.append(element('p', 'pt-muted', current().group ? '群聊暂不支持并行。打开一个单角色聊天后即可使用。' : '打开一个角色聊天后，这里会出现会话。'));
        for (const session of all) {
            const here = session.key === curKey, status = stateOf(session), job = session.job;
            const card = element('div', `pt-card${here ? ' pt-active' : ''}`);
            card.dataset.session = session.key; card.dataset.busy = String(!!status.busy); card.dataset.unread = String(!!session.unread); card.dataset.state = status.state;
            const sessionRow = element('div', 'pt-session-row');
            const open = button('', () => void openSession(session), '切换到此会话'); open.classList.add('pt-session-open');
            const copy = element('span', 'pt-session-copy'), title = element('span', 'pt-title');
            title.append(element('span', 'pt-name', session.name));
            if (here) title.append(element('span', 'pt-current', '当前'));
            else if (session.unread) title.append(element('span', 'pt-completed', '新回复'));
            copy.append(title, element('span', 'pt-chat-name', session.chatId), element('span', 'pt-preview', preview(session).replace(/\s+/g, ' ') || '点击进入对话'), element('span', 'pt-status', status.label));
            open.append(portrait(session), copy); sessionRow.append(open);
            const more = iconButton('会话操作', 'more', () => { controlsKey = controlsKey === session.key ? null : session.key; render(); });
            more.setAttribute('aria-expanded', String(controlsKey === session.key)); sessionRow.append(more); card.append(sessionRow);
            if (controlsKey === session.key) {
                const controls = element('div', 'pt-actions');
                if (status.busy) controls.append(button('停止生成', () => stopSession(session)));
                if (job && !job.attached && job.status !== 'running' && job.head) controls.append(button('复制回复', () => void copyJob(job)));
                if (job && !job.attached) { const discard = button('丢弃回复', () => { if (host.confirm('丢弃这条后台回复？聊天里已保存的内容不会改变。')) drop(job, { abort: true }); }); discard.classList.add('pt-danger'); controls.append(discard); }
                if (!here) controls.append(button('关闭会话', () => closeSession(session)));
                if (!controls.childElementCount) controls.append(element('span', 'pt-muted', '这是当前对话'));
                card.append(controls);
            }
            list.append(card);
        }
        const footer = element('div', 'pt-footer');
        footer.append(element('span', '', `v${VERSION} · 保持页面开启`), button('设置', () => { menuOpen = !menuOpen; render(); })); panel.append(footer);
        if (menuOpen) {
            const menu = element('div', 'pt-menu');
            const theme = button('夜间模式：' + (nightMode ? '开启' : '关闭'), () => setNightMode(!nightMode), '夜间模式');
            theme.setAttribute('role', 'switch'); theme.setAttribute('aria-checked', String(nightMode));
            const sound = button(`完成提示音：${soundEnabled ? '开启' : '关闭'}`, () => {
                soundEnabled = !soundEnabled;
                try { host.localStorage.setItem(soundKey, soundEnabled ? 'on' : 'off'); } catch { /* ignore */ }
                if (soundEnabled) unlockSound();
                render();
            }, '完成提示音');
            sound.setAttribute('role', 'switch'); sound.setAttribute('aria-checked', String(soundEnabled));
            const tips = element('details');
            tips.append(element('summary', '', '使用说明'), element('p', 'pt-muted', '发出消息后，从这里切到别的对话，原来的回复会在后台继续接收；切回时自动写入聊天。最多 3 个会话同时生成。刷新或退出页面会中断还没收完的回复，已收完但没写回的会保留。群聊与扩展自己发起的请求不转入后台。'));
            menu.append(theme, sound, tips); panel.insertBefore(menu, footer);
        }
    }
    function refreshLive() {
        if (disposed || pointerActive || doc.hidden) return;
        settle(); updateLauncher();
        if (!panelOpen || pickerOpen) return;
        for (const card of panel.querySelectorAll('.pt-card[data-session]')) {
            const session = sessions.get(card.dataset.session);
            if (!session) continue;
            const status = stateOf(session);
            if (card.dataset.state !== status.state) { render(); return; }
            const label = card.querySelector('.pt-status'); if (label && label.textContent !== status.label) label.textContent = status.label;
            const snippet = card.querySelector('.pt-preview'), text = preview(session).replace(/\s+/g, ' ') || '点击进入对话';
            if (snippet && snippet.textContent !== text) snippet.textContent = text;
        }
    }
    const liveTimer = host.setInterval(refreshLive, 1000);
    teardown.push(() => host.clearInterval(liveTimer));

    function chatTimestamp(value) {
        if (value == null || value === '') return 0;
        const number = Number(value), time = Number.isFinite(number) ? number : Date.parse(value);
        return Number.isFinite(time) && time > 0 ? time : 0;
    }
    function showPicker() {
        pickerOpen = true; panelOpen = true;
        picker.replaceChildren();
        const row = element('div', 'pt-row');
        row.append(element('span', 'pt-heading', '打开对话'), button('返回', () => { pickerOpen = false; render(); }));
        const search = element('input'); search.id = 'pt-search'; search.placeholder = '搜索角色名称'; search.setAttribute('aria-label', '搜索角色名称');
        const list = element('div'); list.id = 'pt-character-list';
        const fill = () => {
            list.replaceChildren();
            const filter = search.value.toLocaleLowerCase();
            const characters = ctx().characters.filter(c => c?.avatar && String(c.name || '').toLocaleLowerCase().includes(filter));
            characters.sort((a, b) => chatTimestamp(b.date_last_chat) - chatTimestamp(a.date_last_chat));
            for (const c of characters.slice(0, 120)) {
                const item = element('div', 'pt-character-choice');
                const recent = button('', () => void openSession({ avatar: c.avatar }), c.name);
                const copy = element('span', 'pt-character-copy', c.name);
                copy.append(element('span', 'pt-muted', '最近聊天'));
                recent.append(portrait(c), copy);
                const history = button('其他对话', () => void showHistory(c), `${c.name}的其他对话`);
                const arrow = element('span', 'pt-history-arrow', '→'); arrow.setAttribute('aria-hidden', 'true'); history.append(arrow);
                item.append(recent, history); list.append(item);
            }
            if (!characters.length) list.append(element('p', 'pt-muted', '没有匹配角色'));
            if (characters.length > 120) list.append(element('p', 'pt-muted', '仅显示前 120 个，请继续输入名称筛选。'));
        };
        search.addEventListener('input', fill);
        picker.append(row, search, list); fill(); render();
    }
    async function showHistory(character) {
        pickerOpen = true; panelOpen = true; picker.replaceChildren();
        const row = element('div', 'pt-row');
        row.append(element('span', 'pt-heading', character.name), button('返回', showPicker));
        const list = element('div'); list.id = 'pt-history-list';
        list.append(element('p', 'pt-muted', '正在读取聊天记录…')); picker.append(row, list); render();
        try {
            const response = await host.fetch('/api/characters/chats', {
                method: 'POST', headers: ctx().getRequestHeaders(), body: JSON.stringify({ avatar_url: character.avatar, ch_name: character.name }),
            });
            if (!response.ok) throw new Error(`读取聊天记录失败（HTTP ${response.status}）`);
            const data = await response.json();
            if (!data || data.error) throw new Error('酒馆没有返回聊天记录');
            if (!list.isConnected || !pickerOpen) return;
            const chats = Object.values(data).filter(x => x && typeof x.file_name === 'string');
            chats.sort((a, b) => String(b.last_mes || b.file_name).localeCompare(String(a.last_mes || a.file_name)));
            list.replaceChildren();
            for (const chat of chats) {
                const name = chat.file_name.replace(/\.jsonl$/i, '');
                const item = button('', () => void openSession({ avatar: character.avatar, chatId: name }), name);
                item.append(element('span', 'pt-history-name', name), element('span', 'pt-muted', `${chat.last_mes || ''}${chat.mes ? ' · ' + String(chat.mes).replace(/\s+/g, ' ').slice(-90) : ''}`));
                list.append(item);
            }
            if (!chats.length) list.append(element('p', 'pt-muted', '暂无其他聊天记录，可返回打开最近聊天。'));
        } catch (error) {
            if (!list.isConnected || !pickerOpen) return;
            list.replaceChildren(element('p', 'pt-error', shortError(error)), button('重试', () => void showHistory(character)));
        }
    }

    // 生成中直接点原生角色列表，酒馆会拒绝切换；这里接管成“转入后台再切换”。
    const captureCharacterClick = event => {
        if (!isGenerating() || !foregroundJob()) return;
        const target = event.target?.closest?.('.character_select[data-chid], .character_select[chid]');
        if (!target) return;
        const character = ctx().characters[Number(target.dataset.chid ?? target.getAttribute('chid'))];
        if (!character?.avatar || character.avatar === current().avatar) return;
        event.preventDefault(); event.stopImmediatePropagation();
        void openSession({ avatar: character.avatar });
    };
    doc.addEventListener('click', captureCharacterClick, true);
    teardown.push(() => doc.removeEventListener('click', captureCharacterClick, true));

    const warnUnload = event => {
        if ([...jobs.values()].some(job => job.status === 'running' && !job.attached)) { event.preventDefault(); event.returnValue = ''; }
    };
    host.addEventListener('beforeunload', warnUnload);
    teardown.push(() => host.removeEventListener('beforeunload', warnUnload));

    function dispose() {
        if (disposed) return;
        disposed = true;
        host.clearTimeout(reattachTimer); host.clearTimeout(toastTimer); releaseReplay();
        for (const job of jobs.values()) if (job.status === 'running' && !job.attached) { try { job.ac.abort(); } catch { /* ignore */ } }
        profile?.dispose?.();
        for (const clean of teardown.splice(0)) { try { clean(); } catch { /* 逐项隔离 */ } }
        if (host[KEY] === controller) delete host[KEY];
    }
    const controller = {
        version: VERSION,
        show() { if (launcherSide) expandLauncher(); panelOpen = true; pickerOpen = false; render(); },
        setLauncherVisible(value) { launcherVisible = value !== false; render(); },
        setNightMode,
        dispose,
        diagnostics: () => ({ version: VERSION, current: curKey, readings: [...readings].map(([k, v]) => [k.slice(0, 24), v]), restoring: restoringUntil > Date.now(), generating: isGenerating(), armed: !!armed, replay: !!replayArm,
            sessions: [...sessions.values()].map(s => ({ name: s.name, chatId: s.chatId, unread: s.unread, job: s.job ? { type: s.job.type, status: s.job.status, attached: s.job.attached, bytes: s.job.bytes, created: s.job.created, mismatch: !!s.job.mismatch } : null })) }),
    };
    host[KEY] = controller;

    restore();
    syncCurrent();
    try { profile = installProfiles?.(host, { busy: () => isGenerating() || !!replayArm, notify }) || null; } catch (error) { console.warn('[并行对话] 角色配置记忆未启用', error); }
    render();
    scheduleReattach(800);
    return controller;
}
