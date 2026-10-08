import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import * as core from '../../../../script.js';
import { installCharacterProfiles } from './character-profiles.js';
import { start } from './runtime.js';

const KEY = 'parallel_tavern';
const CONTROLLER = '__PARALLEL_TAVERN_V2__';
const VERSION = '0.6.8-r3';
let startupError = '';

void initialize().catch(error => {
    console.error('[并行对话]', error);
    const status = document.getElementById('pt-extension-status');
    startupError = `启动失败：${String(error?.message || error).slice(0, 200)}`;
    if (status) status.textContent = startupError;
});

async function initialize() {
    if (document.getElementById('pt-extension-settings')) return;
    // 0.5.x 的子页面（iframe）里不再启动任何东西。
    try { if (window.frameElement?.dataset.ptSessionId || window.__PT_CHILD_ID__) return; } catch { /* cross-origin parent */ }
    const settings = (extension_settings[KEY] ||= {});
    if (typeof settings.showLauncher !== 'boolean') settings.showLauncher = true;
    const persist = () => saveSettingsDebounced();

    const root = document.createElement('div');
    root.id = 'pt-extension-settings';
    root.className = 'extension_container';
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>并行对话 · ${VERSION}</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="pt-extension-enabled">
                    <input id="pt-extension-enabled" type="checkbox">
                    <span>开启角色并行</span>
                </label>
                <small>关闭时就是普通聊天，本扩展不接管任何生成。也可以在悬浮面板里开启或退出。</small>
                <label class="checkbox_label" for="pt-extension-show-launcher">
                    <input id="pt-extension-show-launcher" type="checkbox">
                    <span>显示悬浮窗</span>
                </label>
                <small>关闭后隐藏悬浮入口；后台回复仍会继续接收。</small>
                <small>拖到左侧后向左滑、拖到右侧后向右滑，可缩成侧边小条。黄色表示正在生成，绿色表示生成已完成；点击展开，位置在刷新后保留。</small>
                <label class="checkbox_label" for="pt-extension-avatar-switch"><input id="pt-extension-avatar-switch" type="checkbox"><span>点击悬浮头像切换对话</span></label>
                <small>默认关闭。开启后点击头像直达对应对话，点击文字区域仍打开面板。</small>
                <label class="checkbox_label" for="pt-extension-night"><input id="pt-extension-night" type="checkbox"><span>夜间模式</span></label>
                <label class="checkbox_label" for="pt-extension-character-settings"><input id="pt-extension-character-settings" type="checkbox"><span>按角色记住预设、模型与代理</span></label>
                <small>记住每个角色最后一次用的预设、接口类型和模型，下次切到这个角色时恢复。在角色里随时可以改，改了就以新的为准，不会被改回去。同一角色的不同聊天共用。同时记住原生代理预设、地址和密码，保存在酒馆扩展设置中。旧角色需重新选择一次正确代理；服务商 API 密钥仍由酒馆管理。</small>
                <div class="flex-container"><button type="button" class="menu_button" id="pt-extension-open">打开并行面板</button><button type="button" class="menu_button" id="pt-extension-diagnostics">复制诊断</button></div>
                <small>切换卡住或没反应时，先复现一次，再点“复制诊断”把内容发给作者。不含聊天内容、角色名和密钥。</small>
                <small id="pt-extension-status" role="status"></small>
            </div>
        </div>`;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('Extension settings container unavailable');
    container.append(root);

    const controller = () => window[CONTROLLER];
    const launcher = root.querySelector('#pt-extension-show-launcher');
    const avatarSwitch = root.querySelector('#pt-extension-avatar-switch');
    const night = root.querySelector('#pt-extension-night');
    const remember = root.querySelector('#pt-extension-character-settings');
    const status = root.querySelector('#pt-extension-status');
    const readNight = () => { try { return localStorage.getItem('parallel-tavern.night-mode') === 'on'; } catch { return false; } };
    launcher.checked = settings.showLauncher;
    avatarSwitch.checked = settings.avatarQuickSwitch === true;
    remember.checked = settings.rememberCharacterSettings !== false;
    night.checked = readNight();
    launcher.addEventListener('change', () => {
        settings.showLauncher = launcher.checked; persist();
        controller()?.setLauncherVisible(settings.showLauncher);
        status.textContent = settings.showLauncher ? '悬浮窗已显示。' : '悬浮窗已隐藏，可从这里重新打开面板。';
    });
    avatarSwitch.addEventListener('change', () => { settings.avatarQuickSwitch = avatarSwitch.checked; persist(); });
    const enabledBox = root.querySelector('#pt-extension-enabled');
    enabledBox.checked = settings.parallelEnabled === true;
    enabledBox.addEventListener('change', () => {
        const ok = controller()?.setEnabled?.(enabledBox.checked);
        if (ok === false || !controller()) enabledBox.checked = settings.parallelEnabled === true;
    });
    window.addEventListener('pt-parallel-enabled', () => { enabledBox.checked = settings.parallelEnabled === true; });
    remember.addEventListener('change', () => { settings.rememberCharacterSettings = remember.checked; persist(); });
    night.addEventListener('change', () => controller()?.setNightMode(night.checked));
    window.addEventListener('pt-night-mode', () => { night.checked = readNight(); });
    root.querySelector('#pt-extension-open').addEventListener('click', () => {
        if (controller()) controller().show();
        else status.textContent = startupError || '并行对话尚未启动，请刷新后重试。';
    });

    root.querySelector('#pt-extension-diagnostics').addEventListener('click', async () => {
        if (controller()?.exportDiagnostics) { await controller().exportDiagnostics(); return; }
        const text = JSON.stringify({ plugin: VERSION, started: false, startupError, userAgent: navigator.userAgent, time: new Date().toISOString() }, null, 1);
        try { await navigator.clipboard.writeText(text); status.textContent = '诊断记录已复制。'; }
        catch { status.textContent = text; }
    });
    if (window[CONTROLLER] && !window[CONTROLLER].version) {
        status.textContent = '检测到旧版并行脚本仍在运行。请停用旧脚本并刷新，新版才会接管。';
        return;
    }
    start({
        settings,
        save: saveSettingsDebounced,
        // 实时读取酒馆的“正在生成”标志（模块导出是活绑定）。旧宿主没有导出时返回 undefined，运行时会退回看界面。
        nativeBusy: () => core.is_send_press,
        nativeSaving: () => core.isChatSaving,
        installProfiles: (win, options) => installCharacterProfiles(win, { ...options, settings, save: saveSettingsDebounced }),
    });
    controller()?.setLauncherVisible(settings.showLauncher);
}

