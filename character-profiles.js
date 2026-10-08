// 按角色记住“上一次用的”预设、接口类型和模型。
// 规则：只在切换到另一个角色时恢复一次；之后在这个角色里随时可以改，改了就记下来，
// 下次再打开这个角色时用的就是最后一次的选择。绝不在使用过程中把用户的修改改回去。
// 另记住原生代理预设、地址和密码；保存在宿主扩展设置，不复制服务商密钥或预设文件。
const chatControls = {
    makersuite: ['google_model', 'model_google_select'],
    custom: ['custom_model', 'custom_model_id'],
    azure_openai: ['azure_openai_model', 'azure_openai_model'],
};
const textControls = {
    togetherai: 'model_togetherai_select', infermaticai: 'model_infermaticai_select',
    dreamgen: 'model_dreamgen_select',
};

function selection(context, doc) {
    const api = context.mainApi;
    if (!['openai', 'textgenerationwebui'].includes(api)) return null;
    const settings = api === 'openai' ? context.chatCompletionSettings : context.textCompletionSettings;
    const source = settings?.[api === 'openai' ? 'chat_completion_source' : 'type'];
    const preset = context.getPresetManager?.(api)?.getSelectedPresetName?.();
    if (!source || !preset) return null;
    const [key, id] = api === 'openai'
        ? (chatControls[source] || [`${source}_model`, `model_${source}_select`])
        : [`${source}_model`, textControls[source] || `${source}_model`];
    // Unknown/custom hosts retain their normal behavior instead of guessing a control.
    if (!doc.getElementById(id) || typeof settings[key] !== 'string') return null;
    const value = { api, source, preset, model: settings[key], key, control: id };
    if (api === 'openai' && typeof settings.reverse_proxy === 'string' && typeof settings.proxy_password === 'string') {
        value.proxy = {
            preset: doc.getElementById('openai_proxy_preset')?.value || null,
            url: settings.reverse_proxy, password: settings.proxy_password,
        };
    }
    return value;
}

const same = (a, b) => !!a && !!b && ['api', 'source', 'preset', 'model'].every(key => a[key] === b[key]) && (!b.proxy || !!a.proxy && ['preset', 'url', 'password'].every(key => a.proxy[key] === b.proxy[key]));

export function installCharacterProfiles(win, { settings, save, busy, notify }) {
    const context = () => win.SillyTavern.getContext();
    const avatar = () => { const c = context(); return !c.groupId && c.characters?.[c.characterId]?.avatar || null; };
    const events = context().eventTypes || context().event_types || {};
    const emitter = context().eventSource;
    const cleanups = [];
    const enabled = () => settings.rememberCharacterSettings !== false;
    const read = () => selection(context(), win.document);
    let stopped = false;
    let owner;                 // 当前界面上的选择属于哪个角色（切换后、恢复完成前仍属于上一个角色）
    let applying = false;      // 正在替用户恢复，期间的设置变化不是用户操作
    let waitingPreset = false; // 用户刚选了预设，等预设内容加载完再记
    let waitingSince = 0;
    let timer = null;
    let readyTimer, resumeTimer, observed, pendingEdit = false, restoreFailed = false, pendingAvatar = null;
    const legacyNotices = new Set();
    let queue = Promise.resolve();

    function saved(id) {
        return id && Object.hasOwn(settings.characterProfiles || {}, id) ? settings.characterProfiles[id] : null;
    }
    function record() {
        win.clearTimeout(timer); timer = null;
        if (stopped || applying || restoreFailed || !enabled() || !owner || owner !== avatar()) return;
        // 预设加载完成事件万一没来，最多等 5 秒，不能让记录永远卡住。
        if (waitingPreset) {
            if (Date.now() - waitingSince < 5000) { schedule(400); return; }
            waitingPreset = false; restoreFailed = true; pendingEdit = false;
            notify('预设切换没有收到完成确认，请重新选择有效预设后再发送。');
            return;
        }
        const value = read();
        if (!value) return;
        const next = JSON.stringify(value);
        if (next === observed && !pendingEdit) return;
        observed = next; pendingEdit = false;
        if (same(value, saved(owner)) && !!value.proxy === !!saved(owner)?.proxy) return;
        settings.characterProfiles ||= {};
        Object.defineProperty(settings.characterProfiles, owner, { value, enumerable: true, configurable: true, writable: true });
        save();
    }
    function schedule(ms = 300) { win.clearTimeout(timer); timer = win.setTimeout(record, ms); }

    function setControl(id, value, allowModel = false) {
        const node = win.document.getElementById(id);
        if (!node) throw new Error('当前酒馆缺少对应设置控件');
        if (node.tagName === 'SELECT' && ![...node.options].some(o => o.value === value)) {
            if (!allowModel) throw new Error('保存的接口类型当前不可用');
            // Native model controls accept explicit model IDs, including custom endpoints.
            const option = win.document.createElement('option'); option.value = value; option.textContent = value; node.append(option);
        }
        if (win.jQuery) win.jQuery(node).val(value).trigger(node.tagName === 'SELECT' ? 'change' : 'input');
        else { node.value = value; node.dispatchEvent(new win.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }
    }
    function restoreProxy(proxy) {
        if (!proxy) return;
        if (typeof proxy.url !== 'string' || typeof proxy.password !== 'string') throw new Error('保存的代理配置不完整，请重新选择代理');
        const doc = win.document;
        const passwordId = ['openai_proxy_password', 'openai_proxy_access_key'].find(id => doc.getElementById(id));
        const urlNode = doc.getElementById('openai_reverse_proxy');
        if (!passwordId || !urlNode) throw new Error('当前酒馆缺少代理地址或密码控件');
        const preset = doc.getElementById('openai_proxy_preset');
        if (proxy.preset && (!preset || ![...preset.options].some(o => o.value === proxy.preset))) {
            throw new Error('保存的代理预设已不存在，请重新选择代理');
        }
        // Native preset change restores its own address/password. Then restore the
        // character snapshot, including an explicitly empty password, in this realm.
        if (proxy.preset && preset.value !== proxy.preset) setControl(preset.id, proxy.preset);
        const apiSettings = context().chatCompletionSettings;
        if (apiSettings.reverse_proxy !== proxy.url) setControl(urlNode.id, proxy.url);
        if (apiSettings.proxy_password !== proxy.password) setControl(passwordId, proxy.password);
        if (apiSettings.reverse_proxy !== proxy.url || apiSettings.proxy_password !== proxy.password ||
            proxy.preset && preset.value !== proxy.preset) throw new Error('宿主未接受保存的代理配置');
    }
    async function apply(id, value) {
        const manager = context().getPresetManager?.(value.api);
        const presetId = manager?.findPreset?.(value.preset);
        if (presetId == null) throw new Error(`预设「${value.preset}」已不存在，保留当前选择`);
        if (context().mainApi !== value.api) setControl('main_api', value.api);
        if (manager.getSelectedPresetName() !== value.preset) {
            await new Promise((resolve, reject) => {
                const event = value.api === 'openai' ? events.OAI_PRESET_CHANGED_AFTER : events.PRESET_CHANGED;
                if (!event) { reject(new Error('宿主不支持等待预设切换完成')); return; }
                const remove = () => emitter.removeListener ? emitter.removeListener(event, done) : emitter.off?.(event, done);
                const timeout = win.setTimeout(() => { remove(); reject(new Error('预设切换超时')); }, 10000);
                const done = data => {
                    if (value.api !== 'openai' && data?.apiId && data.apiId !== value.api) return;
                    if (manager.getSelectedPresetName() !== value.preset) return;
                    win.clearTimeout(timeout); remove(); resolve();
                };
                emitter.on(event, done);
                try { manager.selectPreset(presetId); }
                catch (error) { win.clearTimeout(timeout); remove(); reject(error); }
            });
        }
        if (stopped || avatar() !== id) return;
        if (busy()) throw new Error('当前会话仍在生成或保存，请结束后重新切入恢复角色配置');
        const apiSettings = value.api === 'openai' ? context().chatCompletionSettings : context().textCompletionSettings;
        if (apiSettings[value.api === 'openai' ? 'chat_completion_source' : 'type'] !== value.source) {
            setControl(value.api === 'openai' ? 'chat_completion_source' : 'textgen_type', value.source);
        }
        // Re-derive the control, rather than trusting a stored selector.
        const current = read();
        if (!current || current.api !== value.api || current.source !== value.source) throw new Error('保存的模型类型当前不受支持');
        if (value.api === 'openai') restoreProxy(value.proxy);
        if (current.model !== value.model) setControl(current.control, value.model, true);
        if (read()?.model !== value.model) throw new Error('宿主未接受保存的模型选择');
    }
    async function arrive(id) {
        // 正在生成时不换设置（正常情况下切换前生成已经结束或转入后台）。
        for (let tries = 0; busy() && tries < 20; tries++) await new Promise(resolve => win.setTimeout(resolve, 500));
        if (stopped || avatar() !== id) return;
        if (busy()) { restoreFailed = true; notify('当前会话仍在生成或保存，结束后再恢复角色配置。'); return; }
        const value = enabled() ? saved(id) : null;
        if (value && !same(value, read())) {
            applying = true;
            try { await apply(id, value); }
            catch (error) { restoreFailed = true; notify(`角色配置未完整恢复：${error.message}`); }
            finally { applying = false; }
        }
        if (stopped || avatar() !== id) return;
        owner = id; pendingAvatar = null; waitingPreset = false;
        observed = JSON.stringify(read()); pendingEdit = false;
        if (value?.api === 'openai' && !value.proxy && read()?.proxy && !legacyNotices.has(id)) {
            legacyNotices.add(id);
            notify('这个角色的旧记录没有代理信息，请重新选择一次正确的代理预设和密码，以后会一起记住。');
        }
        // 第一次打开、还没有记录的角色：把当前选择记作它的初始配置。
        if (enabled() && !saved(id)) { observed = undefined; record(); }
    }
    function onChatChanged() {
        const id = avatar();
        if (id === owner) return;          // 同一角色的另一份聊天：保持现在的选择
        record();                          // 先把上一个角色最后的选择记下
        owner = undefined;                 // 恢复完成前，界面上的选择不归任何角色
        pendingAvatar = id; restoreFailed = false;
        if (!id) return;
        queue = queue.then(() => arrive(id)).catch(error => notify(`角色配置恢复失败：${error.message}`));
    }

    function on(name, fn) {
        if (!name || !emitter?.on) return;
        emitter.on(name, fn);
        cleanups.push(() => emitter.removeListener ? emitter.removeListener(name, fn) : emitter.off?.(name, fn));
    }
    const changed = event => {
        if (applying) return;
        const id = event.target?.id || '';
        if (id.startsWith('settings_preset_')) { waitingPreset = true; waitingSince = Date.now(); }
        if (/^(main_api|chat_completion_source|textgen_type|settings_preset_|model_|custom_model_id|azure_openai_model|openai_proxy_|openai_reverse_proxy)/.test(id) || id.endsWith('_model')) { pendingEdit = true; restoreFailed = false; schedule(); }
    };
    const guardSend = event => {
        if (!enabled() || !applying && !restoreFailed && !waitingPreset && !pendingAvatar) return;
        if (event.type === 'click' ? event.target?.closest?.('#send_but') : event.target?.id === 'send_textarea' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault(); event.stopImmediatePropagation(); notify(restoreFailed ? '角色配置恢复失败，请重新选择正确的预设、模型和代理后再发送。' : '正在恢复角色的预设、模型与代理，请稍后发送。');
        }
    };
    win.document.addEventListener('click', guardSend, true);
    win.document.addEventListener('keydown', guardSend, true);
    win.document.addEventListener('input', changed);
    win.document.addEventListener('change', changed);
    cleanups.push(() => {
        win.document.removeEventListener('click', guardSend, true); win.document.removeEventListener('keydown', guardSend, true);
        win.document.removeEventListener('input', changed); win.document.removeEventListener('change', changed);
    });
    on(events.OAI_PRESET_CHANGED_BEFORE, () => { if (!applying) { waitingPreset = true; waitingSince = Date.now(); pendingEdit = true; schedule(); } });
    on(events.OAI_PRESET_CHANGED_AFTER, () => { waitingPreset = false; if (!applying) { restoreFailed = false; schedule(); } });
    on(events.PRESET_CHANGED, () => { waitingPreset = false; if (!applying) { restoreFailed = false; schedule(); } });
    on(events.CHATCOMPLETION_MODEL_CHANGED, () => { if (!applying) schedule(); });
    on(events.SETTINGS_UPDATED, () => { if (!applying) schedule(); });
    // 发送那一刻用的就是用户想要的配置：直接记下，防止任何事件遗漏。
    on(events.GENERATION_STARTED, (_type, _options, dryRun) => { if (!dryRun && !applying) record(); });
    on(events.CHAT_CHANGED, onChatChanged);
    // 酒馆就绪事件对晚到的订阅者会立刻同步回调，推迟一拍再处理。
    on(events.APP_READY, () => { win.clearTimeout(readyTimer); readyTimer = win.setTimeout(onChatChanged, 0); });
    on(events.GENERATION_ENDED, () => {
        if (!pendingAvatar) return;
        win.clearTimeout(resumeTimer); resumeTimer = win.setTimeout(onChatChanged, 0);
    });
    onChatChanged();

    return {
        // 等待“切换角色后的恢复”完成；不会额外再恢复一次。
        activate: () => queue,
        flush: record,
        get ready() { return queue; },
        dispose() { record(); stopped = true; win.clearTimeout(timer); win.clearTimeout(readyTimer); win.clearTimeout(resumeTimer); cleanups.forEach(fn => fn()); },
    };
}
