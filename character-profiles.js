// 按角色记住“上一次用的”预设、接口类型和模型。
// 规则：只在切换到另一个角色时恢复一次；之后在这个角色里随时可以改，改了就记下来，
// 下次再打开这个角色时用的就是最后一次的选择。绝不在使用过程中把用户的修改改回去。
// 只保存选择本身（预设名、接口类型、模型名），不复制 API 密钥或预设内容。
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
    return { api, source, preset, model: settings[key], key, control: id };
}

const same = (a, b) => !!a && !!b && ['api', 'source', 'preset', 'model'].every(key => a[key] === b[key]);

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
    let queue = Promise.resolve();

    function saved(id) {
        return id && Object.hasOwn(settings.characterProfiles || {}, id) ? settings.characterProfiles[id] : null;
    }
    function record() {
        win.clearTimeout(timer); timer = null;
        if (stopped || applying || !enabled() || !owner || owner !== avatar()) return;
        // 预设加载完成事件万一没来，最多等 5 秒，不能让记录永远卡住。
        if (waitingPreset && Date.now() - waitingSince < 5000) { schedule(400); return; }
        waitingPreset = false;
        const value = read();
        if (!value || same(value, saved(owner))) return;
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
        const apiSettings = value.api === 'openai' ? context().chatCompletionSettings : context().textCompletionSettings;
        if (apiSettings[value.api === 'openai' ? 'chat_completion_source' : 'type'] !== value.source) {
            setControl(value.api === 'openai' ? 'chat_completion_source' : 'textgen_type', value.source);
        }
        // Re-derive the control, rather than trusting a stored selector.
        const current = read();
        if (!current || current.api !== value.api || current.source !== value.source) throw new Error('保存的模型类型当前不受支持');
        if (current.model !== value.model) setControl(current.control, value.model, true);
        if (read()?.model !== value.model) throw new Error('宿主未接受保存的模型选择');
    }
    async function arrive(id) {
        // 正在生成时不换设置（正常情况下切换前生成已经结束或转入后台）。
        for (let tries = 0; busy() && tries < 20; tries++) await new Promise(resolve => win.setTimeout(resolve, 500));
        if (stopped || avatar() !== id) return;
        const value = enabled() ? saved(id) : null;
        if (value && !same(value, read())) {
            applying = true;
            try { await apply(id, value); }
            catch (error) { notify(`角色配置未完整恢复：${error.message}`); }
            finally { applying = false; }
        }
        if (stopped || avatar() !== id) return;
        owner = id; waitingPreset = false;
        // 第一次打开、还没有记录的角色：把当前选择记作它的初始配置。
        if (enabled() && !saved(id)) record();
    }
    function onChatChanged() {
        const id = avatar();
        if (id === owner) return;          // 同一角色的另一份聊天：保持现在的选择
        record();                          // 先把上一个角色最后的选择记下
        owner = undefined;                 // 恢复完成前，界面上的选择不归任何角色
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
        if (/^(main_api|chat_completion_source|textgen_type|settings_preset_|model_|custom_model_id|azure_openai_model)/.test(id) || id.endsWith('_model')) schedule();
    };
    const guardSend = event => {
        if (!applying) return;
        if (event.type === 'click' ? event.target?.closest?.('#send_but') : event.target?.id === 'send_textarea' && event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault(); event.stopImmediatePropagation(); notify('正在恢复角色的预设与模型，请稍后发送。');
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
    on(events.OAI_PRESET_CHANGED_BEFORE, () => { if (!applying) { waitingPreset = true; waitingSince = Date.now(); } });
    on(events.OAI_PRESET_CHANGED_AFTER, () => { waitingPreset = false; if (!applying) schedule(); });
    on(events.PRESET_CHANGED, () => { waitingPreset = false; if (!applying) schedule(); });
    on(events.CHATCOMPLETION_MODEL_CHANGED, () => { if (!applying) schedule(); });
    on(events.SETTINGS_UPDATED, () => { if (!applying) schedule(); });
    // 发送那一刻用的就是用户想要的配置：直接记下，防止任何事件遗漏。
    on(events.GENERATION_STARTED, (_type, _options, dryRun) => { if (!dryRun && !applying) record(); });
    on(events.CHAT_CHANGED, onChatChanged);
    // 酒馆就绪事件对晚到的订阅者会立刻同步回调，推迟一拍再处理。
    on(events.APP_READY, () => win.setTimeout(onChatChanged, 0));
    onChatChanged();

    return {
        // 等待“切换角色后的恢复”完成；不会额外再恢复一次。
        activate: () => queue,
        flush: record,
        get ready() { return queue; },
        dispose() { record(); stopped = true; win.clearTimeout(timer); cleanups.forEach(fn => fn()); },
    };
}
