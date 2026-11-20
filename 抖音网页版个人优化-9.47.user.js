// ==UserScript==
// @name         抖音网页版个人优化
// @namespace    https://greasyfork.org/zh-CN/users/1662248-fengyulll
// @version      9.47
// @author       fengyulll
// @description  抖音网页版个人优化：侧栏悬浮、播放器增强、自动跳过广告/直播、直播间真实人数与消息过滤
// @license      MIT
// @match        https://live.douyin.com/*
// @match        https://www.douyin.com/*
// @grant        none
// @run-at       document-start
// @noframes
// @downloadURL https://update.greasyfork.org/scripts/604370/%E6%8A%96%E9%9F%B3%E7%BD%91%E9%A1%B5%E7%89%88%E4%B8%AA%E4%BA%BA%E4%BC%98%E5%8C%96.user.js
// @updateURL https://update.greasyfork.org/scripts/604370/%E6%8A%96%E9%9F%B3%E7%BD%91%E9%A1%B5%E7%89%88%E4%B8%AA%E4%BA%BA%E4%BC%98%E5%8C%96.meta.js
// ==/UserScript==

(function () {
    'use strict';

    /* =====================================================================
     * 0. 幂等保护与环境标记
     * ===================================================================== */
    if (window.__DY_OPT_LOADED__) return;
    window.__DY_OPT_LOADED__ = true;

    const html = document.documentElement;
    const isLiveHost = location.hostname.indexOf('live.') === 0;
    html.classList.add(isLiveHost ? 'xydy-live' : 'xydy-www');

    const initStyle = document.createElement('style');
    initStyle.id = 'gm-init-styles';
    initStyle.textContent = `
        /* v9.47：页面底色不再写死 #161616，改成用 JS 从抖音自己的容器上读出来的
           --gm-nav-bg（见 syncNavBg）。抖音换配色时它会跟着变，不会再出现
           「补的色块和抖音不一样」。
           这条不能整个删掉：直播页底部、顶栏左边这些地方本来就有几十像素是
           抖音自己的容器没铺到的，靠它兜底；9.44/9.45 把它删干净之后，
           底部就露出浏览器画布，看着就是一条空白带。 */
        html, body {
            background-color: var(--gm-nav-bg, #161616) !important;
            margin: 0 !important; padding: 0 !important;
        }
        [data-gm-popup-hidden], [data-gm-pause-hidden] { display: none !important; }
    `;
    html.appendChild(initStyle);

    const osd = document.createElement('div');
    osd.style.cssText = 'position:fixed;top:20%;left:50%;transform:translate(-50%,-50%);' +
        'background:rgba(0,0,0,0.78);color:#fff;padding:10px 20px;border-radius:8px;' +
        'font-size:16px;z-index:2147483647;pointer-events:none;opacity:0;' +
        'transition:opacity .3s ease;font-family:-apple-system,sans-serif;';
    html.appendChild(osd);
    let osdTimer = null;
    function showTip(msg, ms) {
        osd.textContent = msg;
        osd.style.opacity = '1';
        clearTimeout(osdTimer);
        osdTimer = setTimeout(() => { osd.style.opacity = '0'; }, ms || 1500);
    }

    function safeRun(fn) {
        try { fn(); } catch (e) {
            if (!safeRun._last || Date.now() - safeRun._last > 10000) {
                safeRun._last = Date.now();
                console.warn('[抖音优化] 某个任务执行失败：', e);
            }
        }
    }

    /* =====================================================================
     * 1. 快捷键解析（配置面板用）
     * ===================================================================== */
    const ALLOWED_CODE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Space|Arrow(Up|Down|Left|Right)|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Backquote|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Comma|Period|Slash|Backslash|Numpad[0-9])$/;

    function parseHotkey(spec) {
        if (typeof spec !== 'string' || !spec || spec.length > 48) return null;
        const parts = spec.split('+');
        const code = parts.pop();
        if (!ALLOWED_CODE.test(code)) return null;
        const mods = { ctrl: false, alt: false, shift: false, meta: false };
        for (const p of parts) {
            const k = p.toLowerCase();
            if (k === 'ctrl' || k === 'control') mods.ctrl = true;
            else if (k === 'alt') mods.alt = true;
            else if (k === 'shift') mods.shift = true;
            else if (k === 'meta' || k === 'cmd') mods.meta = true;
            else return null;
        }
        return Object.assign({ code: code, raw: spec }, mods);
    }

    const KEY_LABEL = {
        Space: '空格', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
        Escape: 'Esc', Enter: '回车', Tab: 'Tab', Backspace: '退格', Delete: 'Del',
        Insert: 'Ins', Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
        Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
        Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\'
    };

    function hotkeyLabel(spec) {
        const h = parseHotkey(spec) || parseHotkey('Alt+KeyS');
        let s = '';
        if (h.ctrl) s += 'Ctrl + ';
        if (h.alt) s += 'Alt + ';
        if (h.shift) s += 'Shift + ';
        if (h.meta) s += 'Win + ';
        const c = h.code;
        return s + (KEY_LABEL[c] ||
            (c.indexOf('Key') === 0 ? c.slice(3) :
             c.indexOf('Digit') === 0 ? c.slice(5) :
             c.indexOf('Numpad') === 0 ? '小键盘' + c.slice(6) : c));
    }

    /* v9.41：抖音自带的键盘快捷键（它自己的「键盘快捷键」面板里列的那套）。
       我们绑键前先对一下，撞上了就提示 —— 两边同时触发比不给快捷键更烦人。 */
    const DY_HOTKEYS = {
        KeyZ: '赞/取消赞', KeyC: '收藏/取消收藏', KeyG: '关注/取消关注', KeyF: '进入作者主页',
        KeyX: '评论', KeyV: '复制分享口令', KeyP: '推荐给朋友', KeyR: '不感兴趣',
        KeyN: '相关推荐', KeyB: '开始/关闭弹幕', KeyJ: '清屏', KeyK: '自动连播',
        KeyY: '网页内全屏', KeyH: '全屏', KeyL: '稍后在看', KeyU: '小窗模式',
        Space: '暂停', ArrowUp: '上下翻页', ArrowDown: '上下翻页',
        ArrowLeft: '快进快退', ArrowRight: '快进快退',
        Equal: '音量加（Shift+=）', Minus: '音量减（Shift+-）'
    };
    /* 只有不带 Ctrl / Alt / Win 的组合才可能和抖音撞（它也认裸键 + Shift） */
    function douyinConflict(spec) {
        const h = parseHotkey(spec);
        if (!h || h.ctrl || h.alt || h.meta) return '';
        const name = DY_HOTKEYS[h.code];
        if (!name) return '';
        /* 音量那两档带 Shift，裸 = / - 反而不会触发；其余是裸键，带不带 Shift 都提示 */
        if ((h.code === 'Equal' || h.code === 'Minus') && !h.shift) return '';
        return name;
    }

    function specFromEvent(e) {
        if (!ALLOWED_CODE.test(e.code || '')) return null;
        let s = '';
        if (e.ctrlKey) s += 'Ctrl+';
        if (e.altKey) s += 'Alt+';
        if (e.shiftKey) s += 'Shift+';
        if (e.metaKey) s += 'Meta+';
        return s + e.code;
    }

    function hotkeyMatches(e) {
        return specMatches(e, config.settingsHotkey);
    }

    /* 通用版：任意绑定串都能拿来比对（面板快捷键 / 倍速快捷键共用） */
    function specMatches(e, spec) {
        const h = parseHotkey(spec) ||
            (spec === defaultConfig.settingsHotkey ? parseHotkey('Alt+KeyS') : null);
        return !!h && (e.code || '') === h.code &&
            !!e.ctrlKey === h.ctrl && !!e.altKey === h.alt &&
            !!e.shiftKey === h.shift && !!e.metaKey === h.meta;
    }

    /* =====================================================================
     * 2. 配置读取与保存
     * ===================================================================== */
    const CONFIG_KEY = 'gm_douyin_config';
    const COOKIE_KEY = 'gm_dy_cfg';
    /* v9.40：视频流目标画质可选项 —— 就是抖音清晰度菜单里那几档。
       [内部值, 显示名, 等级]。等级用来和档位对象比较，数值越大越高；
       auto = 不干预，交给抖音自己的自适应。 */
    const QUALITY_TARGETS = [
        ['auto', '智能（不干预）', 0],
        ['540', '标清 540P', 50],
        ['720', '高清 720P', 100],
        ['1080', '高清 1080P', 200],
        ['2k', '超清 2K', 300],
        ['4k', '超清 4K', 400]
    ];
    /* v9.40：直播间目标画质 —— 就是直播清晰度菜单里那几档（原画/蓝光/超清/高清/标清）。
       [值, 显示名, 等级]，等级用播放器自己的档位标识排序（ld < sd < hd < uhd < origin），
       和视频流那套分辨率等级完全分开：直播没有 4K/2K 的概念，别混着比。
       auto = 不干预，连 webcast_local_quality 都不写，交给抖音自适应。 */
    const LIVE_QUALITY_TARGETS = [
        ['auto', '智能（不干预）', 0],
        ['ld', '标清', 1],
        ['sd', '高清', 2],
        ['hd', '超清', 3],
        ['uhd', '蓝光', 4],
        ['origin', '原画', 5]
    ];
    /* v9.19：配置版本锚点。以后要改结构（拆键、改类型）时按版本号迁移，
       老用户不会因为缺字段直接吃默认值。
       v9.43 → 3：人数轮询默认值 4s 改 2s，老存档一次性迁过去。
       v9.45 → 4：跨域名同步默认开启，老存档里的 false（旧默认值）一并迁过去。 */
    const CONFIG_VERSION = 4;
    /* 抖音自带的倍速档位（0.75 ~ 3.0），「设定倍速」只在其中取值 */
    const SPEED_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2, 3];

    const defaultConfig = {
        __v: CONFIG_VERSION,
        hideEffects: true,
        hideSwitchBtn: true,
        hideDownloadApp: true,
        hideLivePopups: true,
        /* v9.41：聊天室里的「送礼信息 / 福袋口令」DOM 过滤整个下线 ——
           实测抖音现在的聊天室行是虚拟列表（absolute 定位、行高 0），
           藏不干净，用户也不在意那两条；要的是**弹幕层**关掉。
           现在只保留下面这个开关（直接去关抖音弹幕设置里的那两项）。 */
        danmakuSwitchOff: false,
        /* v9.41：界面清理（去按钮 / 去弹窗）。设置面板里独立一页，
           以后这类开关全部往里加，不用在长列表里翻。 */
        cleanAiDouyin: true,        // 播放器右侧「AI抖音」入口
        cleanListenDouyin: true,    // 右侧工具栏「听抖音」
        cleanTopClient: true,       // 顶部「客户端」下载入口
        cleanDiamond: true,         // 顶部「充钻石」
        cleanWallpaper: true,       // 顶部「壁纸」
        /* 播放器右侧的两个浮层：点了收藏 / 分享才弹出来的那一大块。
           按钮本身保留，只把弹出来的面板收掉。 */
        cleanCollectPopup: true,    // 收藏弹窗（选收藏夹 / 新建收藏夹）
        cleanSharePopup: true,      // 分享弹窗（分享给朋友 / 复制链接）
        hideGiftAudio: true,
        showViewerCount: true,
        wheelVolume: true,           // 画面内滚轮调音量（仅直播间）
        hoverVolumeWheel: true,      // 接管抖音原生「hover 音量图标」滚轮（全站固定步进）
        volumeStep: 0.05,
        spacePause: true,
        doubleFullScreen: true,
        clickPause: true,            // 视频流：左键单击画面 → 播放/暂停
        clickPauseLive: false,       // 直播间：左键单击画面 → 播放/暂停（默认不接管）
        resumeAudio: true,
        highlightSearch: true,
        enableSidebar: true,
        liveSidebar: true,           // 直播间单独显示悬浮侧栏（关掉后直播间侧栏完全隐藏）
        liveCenterSearch: true,      // live 域名顶栏搜索框补偿到视口正中
        liveMaxQuality: true,        // 直播间默认切到目标画质（默认原画）
        /* v9.40：直播目标画质（全局偏好）。origin/uhd/hd/sd/ld = 上限档位，
           当前直播间没有该档位时按可用列表取不高于它的最高档；auto = 不干预。 */
        liveQualityTarget: 'origin',
        detachCam: true,             // 聊天室上方的摄像头小窗独立浮出（可拖动）
        camSelector: '',             // 摄像头小窗的 CSS 选择器（留空自动识别）
        videoMaxQuality: true,       // 视频流（www）默认切到最高画质（超清 4K）
        pollViewerCount: true,       // 主动轮询刷新在线人数
        /* v9.43：默认 4s 太慢（加上主循环 1.5s 的延迟，肉眼就是「半天不动」）。
           现在 2s 轮询 + 350ms 快通道 + 网络推送事件驱动。 */
        countPollSec: 2,             // 人数轮询间隔（秒，1~30）
        enableGestures: true,
        autoClosePausePopup: true,   // 监听并关闭「长时间无操作，已暂停播放」弹窗
        skipAds: true,               // 推荐流自动跳过广告视频
        skipLiveFeed: true,          // 推荐流自动跳过直播卡片
        adSkipAction: 'next',        // 广告跳过方式：next=只划走 / block=点不感兴趣
        liveSkipAction: 'block',     // 直播跳过方式：block=点不感兴趣 / next=只划走
        chatroomToggleSelector: '',  // 聊天室收起/展开按钮的自定义 CSS 选择器（留空自动查找）
        /* v9.45：默认开启 —— www / live 两个域名共用一份配置，
           在一边改的开关另一边立刻生效，不用再各调一遍。 */
        crossDomainSync: true,
        /* v9.38：设置面板的「液态玻璃」外观（D 样板材质 + C 样板按压反馈/圆角）。
           纯 CSS 实现，只切一个 class，关掉立刻回到原来的不透明深色面板。
           liquidLens：真透镜折射（SDF 位移滤镜），仅液态玻璃开启时生效。
           glassPress：按住面板轻微缩小、松手回弹的按压反馈。 */
        liquidGlass: true,
        liquidLens: false,
        glassPress: true,
        settingsHotkey: 'Alt+KeyS',  // 设置面板快捷键（可自定义）
        /* v9.41：倍速加 / 减。选中某个档位后每按一次跳一档，档位就是抖音自带的
           0.75 ~ 3.0 那七档，比分档点选更顺手。 */
        speedUpHotkey: 'Alt+Equal',          // 加速一档（默认 Alt + =）
        speedDownHotkey: 'Alt+Minus',        // 减速一档（默认 Alt + -）
        /* 注意：抖音自己的键位表里 Shift+= / Shift+- 是「音量加 / 音量减」，
           所以这两个默认值刻意加了 Alt，别改回去。 */
        speedNormalHotkey: 'Shift+Digit1',   // 原倍速（1.0x）
        speedAltHotkey: 'Shift+Digit2',      // 切到「设定倍速」
        speedAlt: 2,                          // 设定倍速（0.75/1/1.25/1.5/1.75/2/3）
        speedSync: true,                      // 倍速同时写进抖音自己的倍速栏（下一条沿用）
        filterKeywords: [],
        filterSkipAction: 'next',    // 黑名单命中后的处理：next=只划走 / block=点不感兴趣
        /* v9.40：视频流目标画质（全局偏好）。4k/2k/1080/720/540 = 上限档位，
           目标视频没有该档位时由抖音自己逐级下降；auto = 不干预。 */
        videoQualityTarget: '4k',
        /* 学到的档位对象库：{ '超清 4K': {done,gearName,gearType,gearClarity,qualityType,clarityReal}, … }
           抖音自己写 MANUAL_SWITCH 时按档位名归类存下来，换档位直接取用。
           跟着 config 一起持久化（本地存储 + 可选 cookie 跨域名镜像）。 */
        qualityTpls: {},
    };

    function readCookie(name) {
        try {
            const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
            return m ? decodeURIComponent(m[1]) : null;
        } catch (e) { return null; }
    }

    function normalize(raw) {
        const cfg = Object.assign({}, defaultConfig);
        if (!raw || typeof raw !== 'object') return cfg;
        for (const k of Object.keys(defaultConfig)) {
            if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
            const v = raw[k];
            if (k === 'filterKeywords') {
                cfg[k] = Array.isArray(v)
                    ? v.filter(s => typeof s === 'string').map(s => s.trim()).filter(Boolean)
                    : (typeof v === 'string' ? v.split('\n').map(s => s.trim()).filter(Boolean) : []);
            } else if (k === '__v') {
                cfg[k] = CONFIG_VERSION;          // 版本号永远跟当前脚本走
            } else if (k === 'countPollSec') {
                const n = Number(v);
                /* v9.43：下限从 2s 放到 1s —— 人数刷新要跟上直播推送 */
                cfg[k] = (Number.isFinite(n) && n >= 1 && n <= 30)
                    ? Math.round(n) : defaultConfig.countPollSec;
            } else if (k === 'volumeStep') {
                const n = Number(v);
                cfg[k] = (Number.isFinite(n) && n > 0 && n <= 0.2) ? n : defaultConfig.volumeStep;
            } else if (k === 'settingsHotkey') {
                cfg[k] = parseHotkey(v) ? v : defaultConfig.settingsHotkey;
            } else if (k === 'speedNormalHotkey' || k === 'speedAltHotkey' ||
                       k === 'speedUpHotkey' || k === 'speedDownHotkey') {
                cfg[k] = parseHotkey(v) ? v : defaultConfig[k];
            } else if (k === 'speedAlt') {
                const n = Number(v);
                cfg[k] = SPEED_STEPS.indexOf(n) >= 0 ? n : defaultConfig.speedAlt;
            } else if (k === 'chatroomToggleSelector') {
                cfg[k] = (typeof v === 'string') ? v.trim().slice(0, 300) : '';
            } else if (k === 'camSelector') {
                cfg[k] = (typeof v === 'string') ? v.trim().slice(0, 300) : '';
            } else if (k === 'adSkipAction' || k === 'liveSkipAction' || k === 'filterSkipAction') {
                // 只接受两个合法值，其余回落到默认
                cfg[k] = (v === 'block' || v === 'next') ? v : defaultConfig[k];
            } else if (k === 'videoQualityTarget') {
                cfg[k] = QUALITY_TARGETS.some(t => t[0] === v) ? v : defaultConfig.videoQualityTarget;
            } else if (k === 'liveQualityTarget') {
                cfg[k] = LIVE_QUALITY_TARGETS.some(t => t[0] === v) ? v : defaultConfig.liveQualityTarget;
            } else if (k === 'qualityTpls') {
                /* 档位对象库：只收「档位名 → 对象」，对象里必须有 gearName，其余不校验
                   （字段是平台真值，不强加我们的形状）。深拷贝，别跟 defaultConfig 共享。 */
                const out = {};
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    let n = 0;
                    for (const name of Object.keys(v)) {
                        if (n++ > 12) break;
                        const o = v[name];
                        if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
                        if (typeof o.gearName !== 'string' || !o.gearName) continue;
                        out[name.slice(0, 24)] = o;
                    }
                }
                cfg[k] = out;
            } else if (typeof defaultConfig[k] === 'boolean') {
                cfg[k] = !!v;
            }
        }
        return cfg;
    }

    function loadConfig() {
        let local = null, mirror = null;
        try {
            const saved = localStorage.getItem(CONFIG_KEY);
            if (saved) local = JSON.parse(saved);
        } catch (e) {}
        try {
            const c = readCookie(COOKIE_KEY);
            if (c) mirror = JSON.parse(c);
        } catch (e) {}
        let raw = local;
        if (mirror && (!local || (Number(mirror.__ts) || 0) > (Number(local.__ts) || 0))) raw = mirror;
        const cfg = normalize(raw);
        /* v9.43：老存档里的 4s 就是旧默认值（那时候最小只能选 2s），
           升级到 v3 时一次性迁到新的 2s。用户自己选的 1/3/5… 一律不动。 */
        if ((Number(raw && raw.__v) || 0) < 3 && cfg.countPollSec === 4)
            cfg.countPollSec = defaultConfig.countPollSec;
        /* v9.45：跨域名同步改成默认开启。老存档里存的是旧默认值 false，
           升级到 v4 时一起打开（想关的话在面板里关掉，之后不会再被改回去）。 */
        if ((Number(raw && raw.__v) || 0) < 4 && cfg.crossDomainSync === false)
            cfg.crossDomainSync = true;
        /* cookie 镜像里刻意不带档位库（那玩意儿体积大，容易把 cookie 撑爆），
           所以库始终以本地存储为准，别让镜像里的空库把学到的档位清掉。 */
        try {
            if (local && local.qualityTpls && typeof local.qualityTpls === 'object') {
                cfg.qualityTpls = normalize({ qualityTpls: local.qualityTpls }).qualityTpls;
            }
        } catch (e) {}
        return cfg;
    }

    let config = loadConfig();

    function persistConfig() {
        const json = JSON.stringify(Object.assign({}, config, { __ts: Date.now() }));
        try { localStorage.setItem(CONFIG_KEY, json); } catch (e) {}
        try {
            if (config.crossDomainSync) {
                /* cookie 镜像里剔除档位库：库只对 www 视频流有用，塞进 cookie
                   既没用又容易顶到 4KB 上限，导致整份配置被浏览器丢掉 */
                const slim = JSON.stringify(Object.assign({}, config, {
                    __ts: Date.now(), qualityTpls: {}
                }));
                document.cookie = COOKIE_KEY + '=' + encodeURIComponent(slim) +
                    '; domain=.douyin.com; path=/; max-age=31536000; SameSite=Lax';
            } else {
                document.cookie = COOKIE_KEY + '=; domain=.douyin.com; path=/; max-age=0';
            }
        } catch (e) {}
    }

    function saveConfig() {
        persistConfig();
        updateStyles();
        updateSidebarFlag();
        syncSidebarHostState(true);
        /* 只有「关掉」时才需要立刻把用户原来的清晰度还回去；开启不必抢写，
           交给新视频加载与 URL 变化时的流程。 */
        if (!config.videoMaxQuality) restoreVideoQuality();
    }

    /* =====================================================================
     * 3. UI 基础样式（无悬浮按钮，面板固定居中）
     * ===================================================================== */
    const baseStyle = document.createElement('style');
    baseStyle.id = 'gm-base-styles';
    baseStyle.textContent = `
        /* v9.38：面板改为两层结构 —— 外壳只当玻璃（不滚），.gm-panel-scroll 才滚动。
           之前面板自己是滚动容器，4px 滚动条直通右边玻璃边沿，
           方形轨道在右上/右下两个圆角处把 squircle 曲线顶破（右侧两角看着缺一块）；
           现在圆角由不滚的外壳统一裁，滚动条缩在玻璃壳里面，右侧圆角干净了。 */
        #gm-settings-panel {
            position: fixed; top: 50%; left: 50%;
            transform: translate(-50%, -50%);
            width: 320px; max-height: 80vh;
            display: none; flex-direction: column;
            overflow: hidden;
            background: #1b1b20; color: #fff; border-radius: 14px;
            z-index: 2147483647; box-shadow: 0 12px 40px rgba(0,0,0,0.7);
            border: 1px solid rgba(255,255,255,0.15);
            font-family: -apple-system, sans-serif;
            user-select: none; -webkit-user-select: none; box-sizing: border-box;
        }
        #gm-settings-panel.show { display: flex; }
        .gm-panel-scroll {
            overflow-y: auto; overflow-x: hidden;
            padding: 16px; min-height: 0; flex: 1 1 auto;
        }
        .gm-panel-scroll::-webkit-scrollbar { width: 4px; }
        .gm-panel-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.2); border-radius: 4px; }

        /* ------------------------------------------------------------------
           v9.38 液态玻璃外观（材质照「液态玻璃小样D-脚本面板.html」样板）

           玻璃全部画在「外壳」一层上：外壳不滚动（滚动的是内层
           .gm-panel-scroll），background / inset 阴影 / backdrop-filter
           都钉在边框盒上。磨砂层绝不能挂伪元素 —— 棋盘格消融实验证实：
           负 z-index 伪元素 + backdrop-filter 在 Chrome 上会向外渗 ~8px
           糊边（clip-path 也堵不住），直接挂元素本层裁得干干净净。
           滤镜作用区也必须收在元素框内，超出会把模糊洇到边框外。

           backdrop-filter 走变量 --gm-lens-f：默认磨砂档，
           开「真透镜折射」时由 JS 把 SDF 位移滤镜写进这个变量。
           圆角与按压反馈取自 C 样板（corner-shape: squircle / scale .978）。
           ------------------------------------------------------------------ */
        #gm-settings-panel.gm-glass {
            background-color: rgba(16,17,22,.40);
            background-image:
                /* ① 随指针移动的镜面高光：小而锐 */
                radial-gradient(150px 120px at var(--gm-gx, 30%) var(--gm-gy, -8%),
                    rgba(255,255,255,.16), transparent 72%),
                /* ② tint：一层极薄的深色底，压住复杂背景保证可读 */
                linear-gradient(160deg,
                    rgba(30,32,42,.52), rgba(16,17,22,.46) 46%, rgba(28,24,38,.50));
            -webkit-backdrop-filter: var(--gm-lens-f, blur(14px) saturate(1.7) brightness(1.04));
            backdrop-filter: var(--gm-lens-f, blur(14px) saturate(1.7) brightness(1.04));
            border: 1px solid rgba(255,255,255,.26);
            border-radius: 30px;
            corner-shape: squircle; /* Chrome 139+：连续曲率圆角，苹果那种「没有突然转折」的方角 */
            text-shadow: 0 1px 2px rgba(0,0,0,.45);
            box-shadow:
                /* 悬浮投影 */
                0 26px 64px -20px rgba(0,0,0,.72),
                /* 玻璃厚度：上沿一道亮沿、下沿一道暗边 + 底部反光 */
                inset 0 1px 0 rgba(255,255,255,.72),
                inset 0 -1px 0 rgba(255,255,255,.16),
                inset 0 -22px 34px -26px rgba(255,255,255,.30),
                inset 0 14px 28px -24px rgba(0,0,0,.18);
            /* 按压反馈：按下缩一点，松手果冻回弹 */
            transition: transform .28s cubic-bezier(.34, 1.4, .64, 1), box-shadow .28s ease;
            will-change: transform;
        }
        #gm-settings-panel.gm-glass.gm-pressed {
            transform: translate(-50%, -50%) scale(.978);
        }
        /* 标题条原来是实心深色，玻璃模式下必须透明，否则顶部会有一条「不透明的盖」 */
        #gm-settings-panel.gm-glass h3 {
            background: transparent !important;
            border-bottom-color: rgba(255,255,255,.14);
            border-radius: 30px 30px 0 0;
        }
        /* 输入类控件也顺手透一点，别在玻璃上像贴了块塑料 */
        #gm-settings-panel.gm-glass .gm-input,
        #gm-settings-panel.gm-glass .gm-select,
        #gm-settings-panel.gm-glass .gm-textarea,
        #gm-settings-panel.gm-glass .gm-hk-input {
            background: rgba(255,255,255,.09);
            border-color: rgba(255,255,255,.18);
        }
        #gm-settings-panel.gm-glass .gm-select option { background: #232630; }
        /* 灰字压在毛玻璃上会更灰，玻璃模式单独提亮一档 */
        #gm-settings-panel.gm-glass .gm-hint { color: rgba(255,255,255,.62); }
        #gm-settings-panel.gm-glass .gm-sub-row { color: rgba(255,255,255,.72); }
        #gm-settings-panel.gm-glass h3 small { color: rgba(255,255,255,.55); }
        #gm-settings-panel.gm-glass #gm-panel-close { color: rgba(255,255,255,.7); }
        #gm-settings-panel.gm-glass .gm-switch input:checked + .gm-slider {
            box-shadow: 0 0 12px rgba(255,44,85,.55), inset 0 1px 0 rgba(255,255,255,.3);
        }
        /* 弹性入场（只影响 transform/opacity，不改布局） */
        @keyframes gmGlassIn {
            from { opacity: 0; transform: translate(-50%, -50%) scale(.965); }
            to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        #gm-settings-panel.gm-glass.show {
            animation: gmGlassIn .26s cubic-bezier(.34, 1.5, .64, 1);
        }
        /* 真透镜：入场缩放会让整块面板的 SVG 滤镜每帧重算，开面板明显慢半拍；
           透镜档直接出现，不跑动画。 */
        #gm-settings-panel.gm-glass.gm-lens-on.show { animation: none; }
        @media (prefers-reduced-motion: reduce) {
            #gm-settings-panel.gm-glass.show { animation: none; }
        }

        /* 标题条横跨面板全宽、与主体同色：v9.3 的半透明面板 + 不透明标题
           会在顶部左右各留一条异色缝隙，看起来像「顶部颜色不对」。 */
        #gm-settings-panel h3 {
            margin: -16px -16px 6px -16px;
            padding: 16px 16px 8px 16px;
            font-size: 15px; font-weight: 600;
            border-bottom: 1px solid rgba(255,255,255,.1);
            /* v9.8：sticky + 负 margin-top 会把标题下移，正好压住下面那行提示，
               截图里就只剩半截字。改回普通流内标题。 */
            position: relative; background: #1b1b20; z-index: 10;
            border-radius: 14px 14px 0 0;
            display: flex; align-items: center; justify-content: space-between;
        }
        /* v9.42：标题与页签挪到滚动容器外面（固定不滚），
           上面那条的负 margin 是给「标题在滚动容器里」准备的，这里必须覆盖掉，
           否则标题会被负 margin 顶到面板外。放在它后面，同优先级后者生效。 */
        #gm-settings-panel > h3 {
            margin: 0; padding: 14px 16px 10px 16px;
            border-radius: 14px 14px 0 0;
            flex: 0 0 auto;
        }
        /* v9.42：顶部页签。常用/清理/快捷键/高级/诊断，一页只放相关内容，
           主界面不再是一条几百项的流水账。 */
        .gm-tabs {
            display: flex; gap: 4px;
            padding: 0 16px 10px;
            flex: 0 0 auto;
            border-bottom: 1px solid rgba(255,255,255,.10);
        }
        .gm-tab {
            flex: 1 1 0; min-width: 0;
            padding: 6px 2px; font-size: 12px; line-height: 1.2;
            color: rgba(255,255,255,.62);
            background: rgba(255,255,255,.06);
            border: 1px solid transparent; border-radius: 8px;
            cursor: pointer; font-family: inherit;
            transition: background .16s ease, color .16s ease;
            white-space: nowrap;
        }
        .gm-tab:hover { background: rgba(255,255,255,.12); color: rgba(255,255,255,.85); }
        .gm-tab.active {
            background: rgba(255,255,255,.20);
            color: #fff; font-weight: 600;
            border-color: rgba(255,255,255,.22);
        }
        #gm-settings-panel h3 small { font-weight: 400; color: #888; font-size: 11px; margin-left: 6px; }
        #gm-panel-close {
            cursor: pointer; font-size: 18px; line-height: 1; color: #aaa;
            padding: 0 2px; border-radius: 4px;
        }
        #gm-panel-close:hover { color: #fff; background: rgba(255,255,255,.12); }
        .gm-hint { font-size: 11px; color: #888; margin: 0 0 10px 0; line-height: 1.5; }
        .gm-setting-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; font-size: 13px; }
        .gm-setting-row:last-child { margin-bottom: 0; }

        /* v9.20.7 面板分组：40 多个开关平铺在一起完全找不到东西，
           按用途分区 + 分割线 + 子项缩进，排障项收进折叠里。 */
        .gm-section {
            margin: 14px 0 10px; padding-top: 12px;
            border-top: 1px solid rgba(255,255,255,.08);
            font-size: 12px; font-weight: 700; color: #ff2c55;
            letter-spacing: .5px;
        }
        .gm-sub-row {
            display: flex; justify-content: space-between; align-items: center;
            margin: -6px 0 14px 12px; font-size: 12px; color: #aaa;
        }
        .gm-details {
            margin-top: 16px; padding-top: 12px;
            border-top: 1px solid rgba(255,255,255,.1);
        }
        .gm-details > summary {
            cursor: pointer; font-size: 13px; font-weight: 600; color: #ddd;
            list-style: none; padding: 2px 0 10px; user-select: none;
        }
        .gm-details > summary::-webkit-details-marker { display: none; }
        .gm-details > summary::before { content: '▸ '; color: #888; }
        .gm-details[open] > summary::before { content: '▾ '; }

        .gm-switch { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; }
        .gm-switch input { opacity: 0; width: 0; height: 0; }
        .gm-slider { position: absolute; cursor: pointer; inset: 0; background-color: rgba(255,255,255,.2); transition: .3s; border-radius: 22px; }
        .gm-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 2px; bottom: 2px; background-color: #fff; transition: .3s; border-radius: 50%; }
        .gm-switch input:checked + .gm-slider { background-color: #ff2c55; }
        .gm-switch input:checked + .gm-slider:before { transform: translateX(18px); }

        .gm-input {
            background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
            color: #fff; border-radius: 6px; width: 45px; text-align: center;
            padding: 4px 0; outline: none; font-size: 13px; font-family: inherit;
        }
        .gm-input:focus { border-color: #ff2c55; }
        .gm-input::-webkit-outer-spin-button, .gm-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

        .gm-select {
            background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
            color: #fff; border-radius: 6px; padding: 4px 6px; outline: none;
            font-size: 12px; font-family: inherit; max-width: 200px; cursor: pointer;
        }
        .gm-select:focus { border-color: #ff2c55; }
        .gm-select option { background: #232323; color: #fff; }

        .gm-hk-input {
            background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
            color: #fff; border-radius: 6px; width: 120px; text-align: center;
            padding: 4px 6px; outline: none; font-size: 12px; font-family: inherit;
            cursor: pointer; user-select: none; -webkit-user-select: none;
        }
        .gm-hk-input:focus, .gm-hk-input.capturing {
            border-color: #ff2c55; background: rgba(255,44,85,.15);
        }

        /* 回到 v8.8 的高亮样式。只给「点一下会触发抖音搜索」的词
           染青色文字，不加背景框、不加描边、不改整段评论。 */
        .gm-search-word-highlight {
            color: #00FFFF !important; -webkit-text-fill-color: #00FFFF !important;
        }
        .gm-search-word-highlight * {
            color: #00FFFF !important; -webkit-text-fill-color: #00FFFF !important;
        }
        .gm-search-word-highlight svg { display: none !important; }

        /* v9.5：人数直接改文本节点显示，不再用 font-size:0 + ::before。
           伪元素方案容易被抖音自身 !important 规则压掉，表现为「读到了却看不见」。 */
        [data-gm-real-count] {
            white-space: nowrap !important; font-variant-numeric: tabular-nums !important;
        }

        .gm-textarea {
            width: 100%; height: 80px; background: rgba(255,255,255,.1);
            border: 1px solid rgba(255,255,255,.2); color: #fff; border-radius: 6px;
            padding: 8px; box-sizing: border-box; outline: none; font-size: 12px;
            resize: none; font-family: inherit; margin-top: 4px;
        }
        .gm-textarea:focus { border-color: #ff2c55; }

        .gm-sel-input {
            width: 100%; box-sizing: border-box; font-family: inherit;
            background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2);
            color: #fff; border-radius: 6px; padding: 5px 7px; outline: none; font-size: 12px;
        }
        .gm-sel-input:focus { border-color: #ff2c55; }
        .gm-sel-input::placeholder { color: #777; }
        .gm-btn {
            background: rgba(255,255,255,.12); color: #fff; font-family: inherit;
            border: 1px solid rgba(255,255,255,.2); border-radius: 6px;
            padding: 4px 12px; cursor: pointer; font-size: 12px;
        }
        .gm-btn:hover { background: rgba(255,255,255,.22); }
    `;
    html.appendChild(baseStyle);

    /* =====================================================================
     * 4. 动态注入纯 CSS 功能
     * ===================================================================== */
    let dynamicStyle = document.getElementById('gm-dynamic-styles');
    if (!dynamicStyle) {
        dynamicStyle = document.createElement('style');
        dynamicStyle.id = 'gm-dynamic-styles';
        html.appendChild(dynamicStyle);
    }

    function updateStyles() {
        const css = [];

        /* live 域名顶栏仍按「左侧有 164px 侧栏」算宽度，搜索框因此偏左。
           把 #douyin-header 宽度还原成 100%，顶栏就按整屏重新分栏。 */
        if (isLiveHost) {
            css.push(`
                html.xydy-live #douyin-header, html.xydy-live [id^="douyin-header"] {
                    width: 100% !important;
                }
            `);
        }
        if (config.hideLivePopups) {
            /* v9.37.1：这里原来还一起藏了 `#ShortTouchLayout x-view`、
               `#ShortTouchLayout .ShortTouchContainer` 和
               `pace-island[id^="island_"]:has(.ShortTouchContainer)` 整块。
               直播间左上角那个「抢福袋」挂件就是 ShortTouch 渲染的
               （字节 Lynx 框架，内容不在普通 DOM 文本节点里 —— 所以按
               「福袋」两个字去扫永远扫不到，只能被这条 CSS 一锅端掉）。
               现在只留右上角展馆 banner 的 tooltip，挂件交回给 isPromoPopup
               逐个判断（它已经不会误伤福袋）。 */
            css.push(`
                [data-e2e="exhibition-banner"] .dylive-tooltip {
                    display: none !important;
                }
            `);
        }

        /* :has() 单独成规则：选择器列表非 forgiving，一个无效会连坐整条规则 */
        if (config.hideEffects) {
            css.push(`
                #BottomLayout, #GiftTrayLayout, #GiftEffectLayout, #GiftMenuLayout,
                [data-e2e="gifts-container"], div[id^="gift_effect_bg_"],
                div[class*="like-layer"], div[class*="like-effect"], div[class*="LikeEffect"],
                div[class*="heart-layer"], div[class*="heart-effect"], [id^="LikeEffectLayout"] {
                    display: none !important;
                }
            `);
            /* v9.47：这两条「连外壳一起藏」的规则删掉了。
               `.douyin-player-controls > div:has([data-e2e="gifts-container"])`
               会匹配到控制条自己的直接子块，命中后整块 display:none ——
               诊断里那个「后代 210 个、有尺寸 0 个」的空壳就是这么来的。
               gifts-container 本身已经被上一条藏掉了，外壳留着不占视觉，
               占位由下面的操作栏折叠处理，不需要连坐。 */
            /* v9.47：抖音改版后给「全窗口播放」在底部留了一条操作栏的高度
               （实测 88px，里面装礼物栏）。我们把礼物栏藏掉，这条高度却还在，
               控制条就一直停在「离底 88px」的位置。
               这里在**样式层**先把它压成 0：样式从 document-start 就生效，
               抖音挂载时量到的高度就是 0，控制条一开始就排在窗口底部，
               不会再沿用那个旧值（JS 的 collapseEmptyOpBar 只作兜底）。
               限定 .__playerIsFull：常规直播间那条栏里还装着评论输入框，不能动。 */
            css.push(`
                html.xydy-live .__playerIsFull div[class*="OperatingBarPluginContainer"] {
                    height: 0 !important;
                    min-height: 0 !important;
                    max-height: 0 !important;
                    padding: 0 !important;
                    margin: 0 !important;
                }
            `);
        }

        if (config.hideSwitchBtn) {
            css.push(`
                .positionBox .xgplayer-playswitch[data-state="normal"],
                div.xgplayer-playswitch, .xgplayer-playswitch,
                [data-e2e="live-play-switch"], [class*="playswitch"] { display: none !important; }
                div[data-e2e="slideList"] { padding: 0 !important; }
            `);
            css.push(`
                [data-e2e="feed-live"] > div:has(svg path[d^="M7.269 16.316"]),
                [data-e2e="feed-live"] > div:has(svg path[d^="M16.731 7.684"]) { display: none !important; }
            `);
        }

        if (config.hideDownloadApp) {            css.push(`
                #douyin-navigation > a[href*="/jingxuan"]:empty,
                #douyin-web-download-guide-container,
                [data-e2e="douyin-navigation"] a[href*="/jingxuan"]:empty { display: none !important; }
            `);
            css.push(`
                [data-e2e="douyin-navigation"] div:has(> div:first-child > img[src*="douyin-pc-web"]),
                [data-e2e="douyin-navigation"] div:has(> div:only-child > img[src*="/webcast/douyin_live/media/"]),
                [data-e2e="douyin-navigation"] div:only-child:has(> img[src*="/webcast/douyin_live/media/"]) {
                    display: none !important;
                }
            `);
        }

        /* v9.24：摄像头小窗浮出后，别被聊天室列的 overflow 裁掉。
           v9.27：不再把内层强行拉成 100% —— 那个小窗内部是
           #double_screen 这类写死像素的双画面结构，硬拉只会把画面挤到角落、
           剩下大片透明。改成「整个壳子等比缩放」（见 applyCamBox），
           内容保持页面原本的排布，只是整体变大。 */
        if (config.detachCam) {
            css.push(`
                div:has(> .xydy-cam-detached) { overflow: visible !important; }
            `);
        }

        /* ---- 4.4 悬浮侧边栏 ---- */
        if (config.enableSidebar) {
            css.push(`
                /* 外层：高度贴合内容 + 不裁剪任何浮层 */
                html.xydy-sidebar-on .xydy-sidebar-root,
                html.xydy-sidebar-on #douyin-navigation.xydy-sidebar-root {
                    position: fixed !important;
                    left: 4px !important; top: 50% !important;
                    right: auto !important; bottom: auto !important;
                    width: 164px !important;
                    height: auto !important; min-height: 0 !important;
                    /* v9.37.1：原来是硬上限 600px。实测侧栏内容有 1040px 高，
                       被压到 600 之后整体还垂直居中 —— 底边离视口底还剩 219px，
                       内容继续往下画却没有背景，看起来就是「侧栏下方留白太多」。
                       改成贴合视口（只留 4px 上下安全边距）。 */
                    max-height: calc(100dvh - 8px) !important;
                    padding: 0 !important;
                    transform: translateY(-50%) !important;
                    border-radius: 20px !important;
                    border: 1px solid rgba(255,255,255,0.10) !important;
                    /* v9.45：底板颜色由 JS 从抖音自己的容器读出来（--gm-nav-bg），
                       读不到才退回 #161616。抖音换配色时这里自动跟上。 */
                    background-color: var(--gm-nav-bg, #161616) !important;
                    background-image: none !important;
                    background-clip: padding-box !important;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.45) !important;
                    z-index: 1001 !important;
                    display: flex !important; flex-direction: column !important;
                    box-sizing: border-box !important;
                    /* v9.2：不再创建独立层叠上下文，内部气泡才能盖过外部浮层 */
                    overflow: visible !important;
                    /* v9.19：高度/位移改成短过渡，避免测量值微调时整块硬跳 */
                    transition: transform .25s cubic-bezier(.25,1,.5,1), opacity .2s ease,
                                height .18s ease, top .18s ease !important;
                    will-change: transform;
                }

                /* v9.19.2：www 的通知气泡（「收藏的合集有更新」）在 #root 深处，
                   祖先全是全屏容器，逐层提权提不过侧栏的 1001。改为：这类气泡
                   直接抬到 600，同时把侧栏临时降到 500 —— 只在气泡存在期间，
                   气泡一消失类就摘掉。 */
                html.xydy-bubble-over .xydy-sidebar-root,
                html.xydy-bubble-over #douyin-navigation.xydy-sidebar-root {
                    z-index: 500 !important;
                }
                /* v9.20.3：这里绝不能写 position !important。
                   气泡本身多半是 absolute（portal 定位），强改成 relative 会把它
                   从绝对定位点拉回文档流，视觉上就是「气泡从下面窜到上面」。
                   position 只在它原本是 static 时由 JS 补 relative（见 pinBubbleTop）。 */
                .gm-bubble-top {
                    z-index: 600 !important;
                }

                /* 顶层描边：保证四边四角细边框连续可见。
                   v9.2 降到 z-index:2，不再压住侧栏内部 hover 气泡。 */
                html.xydy-sidebar-on .xydy-sidebar-root::after {
                    content: '' !important;
                    position: absolute !important; inset: -1px !important;
                    border: 1px solid rgba(255,255,255,0.10) !important;
                    border-radius: 20px !important;
                    background: transparent !important;
                    pointer-events: none !important; z-index: 2 !important;
                }

                html.xydy-sidebar-on.xydy-sidebar-hidden .xydy-sidebar-root,
                html.xydy-sidebar-on.xydy-sidebar-hidden #douyin-navigation.xydy-sidebar-root {
                    transform: translateY(-50%) translateX(calc(-100% - 16px)) !important;
                    opacity: 0 !important; pointer-events: none !important;
                }
                html.xydy-sidebar-on:not(.xydy-sidebar-hidden) .xydy-sidebar-root,
                html.xydy-sidebar-on:not(.xydy-sidebar-hidden) #douyin-navigation.xydy-sidebar-root {
                    transform: translateY(-50%) translateX(0) !important;
                }

                /* 内层：紧凑、透明、继承圆角、绝不裁剪 */
                html.xydy-sidebar-on .xydy-sidebar-root > div,
                html.xydy-sidebar-on .xydy-sidebar-root [data-e2e="douyin-navigation"],
                html.xydy-sidebar-on .xydy-sidebar-root .AVblXapA {
                    position: relative !important;
                    width: 100% !important;
                    height: auto !important; min-height: 0 !important; max-height: none !important;
                    flex: 0 0 auto !important;
                    display: flex !important; flex-direction: column !important;
                    padding: 4px 0 4px 0 !important;
                    box-sizing: border-box !important;
                    overflow: visible !important;
                    overscroll-behavior: contain !important;
                    border-radius: inherit !important;
                    background-color: transparent !important;
                    background-image: none !important;
                    border: none !important; box-shadow: none !important;
                }
                html.xydy-sidebar-on .xydy-sidebar-root ::-webkit-scrollbar { display: none !important; }

                html.xydy-sidebar-on .xydy-sidebar-root > div > div {
                    height: auto !important; min-height: 0 !important;
                }
                /* v9.8：抖音内层常带 min-height:100vh，会把 fixed 外层撑成整屏高 */
                html.xydy-sidebar-on .xydy-sidebar-root div,
                html.xydy-sidebar-on .xydy-sidebar-root ul,
                html.xydy-sidebar-on .xydy-sidebar-root li {
                    min-height: 0 !important;
                }

                html.xydy-sidebar-on .xydy-sidebar-root a,
                html.xydy-sidebar-on .xydy-sidebar-root [role="button"],
                html.xydy-sidebar-on .xydy-sidebar-root .AVblXapA > div,
                html.xydy-sidebar-on .xydy-sidebar-root [data-e2e="douyin-navigation"] > div {
                    width: 100% !important; box-sizing: border-box !important;
                    flex: none !important; margin: 0 !important;
                }
                /* 菜单项一律不许被压缩，否则外层钉矮后底部项会溢出背景块 */
                html.xydy-sidebar-on .xydy-sidebar-root :where(a, [role="button"], li, div) {
                    flex-shrink: 0 !important;
                }

                /* v9.37.4：live 页的菜单项比 www 页松一圈 —— 截图对比：
                   菜单项上下间距大、整体更高（live 10 项约 501px，www 约 441px，
                   每项差 6px 左右）。这里把上下内边距收到 6px 让它贴回来，
                   左右同时收到 8px（图标离边框 30px vs www 22px）。
                   只动菜单项自身，不改侧栏宽度、不改图标尺寸。 */
                html.xydy-live.xydy-sidebar-on .xydy-sidebar-root [data-e2e="douyin-navigation"] :is(a, [role="button"]) {
                    padding-top: 6px !important;
                    padding-bottom: 6px !important;
                    padding-left: 8px !important;
                    padding-right: 8px !important;
                    box-sizing: border-box !important;
                }

                html.xydy-sidebar-on .xydy-sidebar-root a:hover,
                html.xydy-sidebar-on .xydy-sidebar-root div[class*="active"],
                html.xydy-sidebar-on .xydy-sidebar-root div[class*="selected"],
                html.xydy-sidebar-on .xydy-sidebar-root [class*="selected"] {
                    background-color: rgba(255,255,255,0.12) !important;
                    border-radius: 10px !important;
                }

                html.xydy-sidebar-on .xydy-sidebar-root :where(footer, .PkTZC_CY, .Y9qfItNq, .IWnT0pMe) {
                    display: none !important;
                }
                html.xydy-sidebar-on #panel-menu,
                html.xydy-sidebar-on .xydy-sidebar-root :where(pace-island) { display: none !important; }
                html.xydy-sidebar-on .xydy-sidebar-root .kCzNsmN5:not(:has(a)) { display: none !important; }

                html.xydy-sidebar-on .xydy-sidebar-root,
                html.xydy-sidebar-on .xydy-sidebar-root svg {
                    color: rgba(241,245,249,0.94) !important; fill: currentColor !important;
                }

                /* v9.2：带红点项的 hover 提示气泡原先被侧栏盖住左半文字。
                   解除侧栏内部气泡的宽度/裁剪限制并提层。整条都是增强规则，
                   老内核不支持 :is() 时丢弃也不影响其它规则。 */
                html.xydy-sidebar-on .xydy-sidebar-root :is(
                    [class*="tooltip"], [class*="Tooltip"], [class*="popover"], [class*="Popover"],
                    [class*="bubble"], [class*="Bubble"], [class*="tips"], [class*="Tips"],
                    [class*="notice"], [class*="Notice"], [class*="badge"], [class*="Badge"],
                    [class*="redPoint"], [class*="red-point"], [role="tooltip"], [data-e2e*="tooltip"]) {
                    width: auto !important; min-width: 0 !important; max-width: none !important;
                    height: auto !important;
                    overflow: visible !important; white-space: nowrap !important;
                    z-index: 10000 !important;
                }

                /* A 方案：不再改写顶栏几何（left / right / width / max-width）。
                   黑块改由 initStyle 让 html/body 与 #root/#dark 同色消除；
                   顶栏内部布局完全交还抖音，搜索框回到原生居中位置。
                   下面 #douyin-right-container / #sliderVideo 等属内容区，
                   与顶栏无关，保持原样。 */
                html.xydy-sidebar-on #dark > div,
                html.xydy-sidebar-on #root > div {
                    margin-left: 0 !important; padding-left: 0 !important;
                }
                html.xydy-sidebar-on #douyin-right-container {
                    left: 0 !important;
                    flex: 1 1 auto !important; width: 100% !important; min-width: 0 !important;
                    margin-left: 0 !important; padding-left: 0 !important;
                    /* v9.45：不再给它刷 #161616 / #000。底色由抖音自己那层容器决定，
                       我们写死就会和它当前配色对不上。 */
                }
                html.xydy-sidebar-on #sliderVideo,
                html.xydy-sidebar-on .parent-route-container,
                html.xydy-sidebar-on #slider-card {
                    margin-left: 0 !important; padding-left: 0 !important;
                    width: 100% !important; max-width: 100% !important;
                }
                html.xydy-sidebar-on #dark { min-height: 100vh !important; }
                html.xydy-sidebar-on .recommend-slidelist { height: 100% !important; }
                html.xydy-sidebar-on .recommend-slidelist .fullscreen_capture_feedback {
                    height: 100% !important; padding-bottom: 0 !important;
                }
                html.xydy-sidebar-on .recommend-slidelist .fullscreen_capture_feedback > div {
                    height: 100% !important;
                }
            `);
        }

        /* 关闭「直播间悬浮侧栏」时不再隐藏抖音原生侧栏：所有悬浮规则都带
           html.xydy-sidebar-on 前缀，开关关掉后自然失效；残留的 inline
           覆盖由 restoreNativeSidebar() 清掉，刷新后 sidebarEnabled() 为
           false，各函数不再写入，原生侧栏自然恢复。 */

        dynamicStyle.textContent = css.join('\n');
    }
    updateStyles();

    /* =====================================================================
     * 5. 侧边栏根节点标记 + 感应逻辑
     * ===================================================================== */
    let sidebarRoot = null;
    let lastFitAt = 0;
    let stableH = 0, stableFirst = 0, stableCount = 0;

    function isLivePage() {
        if (isLiveHost) return true;
        if (document.querySelector('[id^="living_player_container"]')) return true;
        /* v9.41：www 里的内嵌直播间（/follow/live/xxx、搜索或推荐点开的直播）
           根本没有 living_player_container，旧判定直接 false ——
           于是真实人数整条链路一次都不跑（诊断里 poll:idle / cached:null /
           lastPreciseAgo:never 就是这么来的），直播画质、弹幕开关同理。
           这里按「路径」和「人数条」两条兜底。 */
        if (/\/live\/\d{5,}/.test(location.pathname)) return true;
        if (document.querySelector('[data-e2e="live-room-audience"]')) return true;
        return false;
    }

    /* 浏览器原生全屏 / 抖音网页全屏（Y 键）时收起悬浮侧栏。
       只认「带 fullscreen 语义且铺满视口」的容器，避免把直播间本来就近乎
       铺满的播放器误判成全屏。 */
    const FS_CLASS_RE = /fullscreen|full_screen|full-screen|webfs|cssfs/i;
    const FS_PARENT_RE = /fullscreen[-_]?parent/i;
    /* 逐 token 判断：body 常带 xgplayer-fullscreen-parent，那只是播放器容器
       的父标记，不是全屏态。整串 test 会误报，使隐藏/离开窗口逻辑被跳过。 */
    function fsClassTokens(c) {
        return String(c || '').split(/\s+/).some(t =>
            FS_CLASS_RE.test(t) && !FS_PARENT_RE.test(t));
    }
    function isFullscreenActive() {
        try {
            if (document.fullscreenElement || document.webkitFullscreenElement ||
                document.mozFullScreenElement) return true;
        } catch (e) {}
        if (fsClassTokens(html.className)) return true;
        if (document.body && fsClassTokens(document.body.className || '')) return true;
        const list = document.querySelectorAll(
            '[class*="fullscreen"], [class*="full-screen"], [class*="webFullscreen"], ' +
            '[class*="cssfullscreen"], [data-fullscreen="true"]');
        for (let i = 0; i < list.length && i < 40; i++) {
            const r = list[i].getBoundingClientRect();
            if (r.width >= window.innerWidth * 0.9 &&
                r.height >= window.innerHeight * 0.8 &&
                r.left <= 8 && r.top <= 8) return true;
        }
        return false;
    }
    function sidebarSuppressed() { return isFullscreenActive(); }

    // 视频流常驻悬浮侧栏；直播间由 liveSidebar 单独控制，全屏时统一收起
    function sidebarEnabled() {
        if (!config.enableSidebar) return false;
        return !isLivePage() || !!config.liveSidebar;
    }

    /* 记录被我们写过 inline 的元素，关闭悬浮栏时才能精准还原。 */
    function markTouched(el) {
        if (el && el.setAttribute && !el.hasAttribute('data-gm-sidebar-touched'))
            el.setAttribute('data-gm-sidebar-touched', '1');
    }

    function refreshSidebarRoot() {
        const el = document.querySelector('#douyin-navigation, [data-e2e="douyin-navigation"]');
        if (!el) return;
        if (el === sidebarRoot) {
            if (sidebarEnabled() && !el.classList.contains('xydy-sidebar-root'))
                el.classList.add('xydy-sidebar-root');
            return;
        }
        if (sidebarRoot) {
            sidebarRoot.classList.remove('xydy-sidebar-root');
            sidebarRoot.style.removeProperty('height');
        }
        sidebarRoot = el;
        if (sidebarEnabled()) el.classList.add('xydy-sidebar-root');
        lastFitAt = 0;
        clearSidebarStretch();
    }

    /* 清掉抖音内层 min-height:100vh / height:100vh 的撑高。
       这一步必须与 fitSidebarHeight 解耦、且不受 xydy-sidebar-hidden 影响：
       页面加载初始侧栏就是 hidden，旧版在这里直接 return，撑高会一直留到
       鼠标移到左边缘才被清。 */
    /* v9.19：getComputedStyle 是最贵的读取之一，260 个元素 × 每 1.5s 全是重复活。
       用 WeakSet 记住已确认过的节点，每 5 秒清一次以便跟上 React 重置样式。 */
    let stretchSeen = new WeakSet(), stretchSeenAt = 0;
    function clearSidebarStretch() {
        if (!sidebarEnabled() || !sidebarRoot || !sidebarRoot.isConnected) return;
        const vh = window.innerHeight;
        const now = Date.now();
        if (now - stretchSeenAt > 5000) { stretchSeen = new WeakSet(); stretchSeenAt = now; }
        const nodes = sidebarRoot.querySelectorAll(
            'div, ul, ol, li, section, nav, aside, main');
        for (let i = 0; i < nodes.length && i < 260; i++) {
            const el = nodes[i];
            if (stretchSeen.has(el)) continue;
            stretchSeen.add(el);
            let cs;
            try { cs = window.getComputedStyle(el); } catch (e) { continue; }
            const mh = parseFloat(cs.minHeight) || 0;
            const hh = parseFloat(cs.height) || 0;
            if (mh >= vh * 0.4) {
                markTouched(el);
                el.style.setProperty('min-height', '0', 'important');
            }
            if (hh >= vh * 0.6) {
                markTouched(el);
                el.style.setProperty('height', 'auto', 'important');
            }
        }
    }

    /* 侧栏高度 = 所有可见菜单项首尾差 + padding，并用 scrollHeight 纠正。
       scrollHeight 在 overflow:visible 下包含溢出内容，能保证背景块至少
       覆盖到最后一项（「短剧 / 小游戏」不再掉在背景外面）。 */
    /* live 侧栏顶部常留一块约 60px 的空占位（被隐藏的 logo / 搜索区），
       菜单整体被推下去，背景块上方一大片留白。折叠位于第一个菜单项上方、
       完全无文本、且不含链接的容器。 */
    function collapseSidebarTopGap(firstTop) {
        if (!sidebarRoot || !isFinite(firstTop)) return false;
        let changed = false;
        /* v9.19.2：首屏文本还没渲染时，菜单项看起来也是「无文字空块」，
           旧逻辑会把「推荐」这类项当空占位隐藏掉（live 页侧栏少一项的来源）。
           每轮先复检已隐藏的块：一旦有文字就恢复；折叠也加上高度上限。 */
        sidebarRoot.querySelectorAll('[data-gm-nav-gap]').forEach(el => {
            if ((el.textContent || '').trim()) {
                el.style.removeProperty('display');
                el.removeAttribute('data-gm-nav-gap');
                changed = true;
            }
        });
        const rr = sidebarRoot.getBoundingClientRect();
        if (firstTop - rr.top < 24) return changed;
        const nodes = sidebarRoot.querySelectorAll('div, section, header, nav');
        for (let i = 0; i < nodes.length && i < 140; i++) {
            const el = nodes[i];
            if (el === sidebarRoot) continue;
            if (el.querySelector('a, [role="button"]')) continue;
            if ((el.textContent || '').trim()) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            // 空占位块一般 16~96px；更高的容器可能是还没渲染的菜单区，别动
            if (r.height < 16 || r.height > 96 || r.width < 60) continue;
            if (r.bottom > firstTop + 4 || r.top < rr.top - 4) continue;
            markTouched(el);
            el.setAttribute('data-gm-nav-gap', '1');
            el.style.setProperty('display', 'none', 'important');
            changed = true;
        }
        return changed;
    }

    /* v9.37.1：与上面的「顶部空块折叠」对称 —— 侧栏内容下方常挂着一块
       几百像素高的空占位（live 实测 `#1=540@496`，正好填满 496~1036），
       它是侧栏被撑成整屏、背景块下面一大片黑的直接原因。
       v9.37.2：改为**先看内层的直接子块**。之前按「最后一个有内容元素的底边」
       反推，可空块自己内部只要有一个带文字的节点就会把基准拉到最底，
       结果一块都折不掉（实测就是这样）。现在直接按子块判定：
       有文字的留、纯空的折 —— 这块占位天生没有文字。 */
    function collapseSidebarBottomGap() {
        if (!sidebarRoot || !sidebarRoot.isConnected) return false;
        let changed = false;
        const inner = sidebarRoot.querySelector('[data-e2e="douyin-navigation"]') || sidebarRoot;

        const fold = (el) => {
            /* 用独立标记 data-gm-nav-gap-b：collapseSidebarTopGap 的复检会把
               「带文字的 data-gm-nav-gap」恢复回来，两者共用一个标记会互相打架
               （折下去、下一轮又被恢复，来回震荡）。 */
            if (el.hasAttribute('data-gm-nav-gap-b')) {
                /* React 重渲染会把 inline display 清掉，标记还在 —— 补回来 */
                if (el.style.display !== 'none') {
                    el.style.setProperty('display', 'none', 'important');
                    changed = true;
                }
                return;
            }
            markTouched(el);
            el.setAttribute('data-gm-nav-gap-b', '1');
            el.style.setProperty('display', 'none', 'important');
            changed = true;
        };

        /* ① 内层直接子块：无文字就是空占位。至少要留一块（菜单本身）。 */
        const kids = Array.from(inner.children || []);
        if (kids.length > 1) {
            for (let i = 0; i < kids.length; i++) {
                const el = kids[i];
                if (!el || !el.getBoundingClientRect) continue;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (r.height < 30 || r.width < 50) continue;
                if ((el.textContent || '').trim()) continue;
                fold(el);
            }
        }

        /* ①-b 上面那条依赖「块内完全没有文字节点」。实测这块 540px 的占位里
           藏着隐藏的文字节点，textContent 不为空，所以一直折不掉。改用几何特征：
           **内层最后一块 + 紧接在上一块之后 + 一直延伸到侧栏底边**。
           三条件同时满足的，只可能是那块把侧栏撑满的占位。 */
        if (kids.length > 1) {
            for (let i = kids.length - 1; i >= 1; i--) {
                const el = kids[i];
                let r, pr;
                try {
                    r = el.getBoundingClientRect();
                    pr = kids[i - 1].getBoundingClientRect();
                } catch (e) { break; }
                if (r.height < 100) break;
                if (r.top - pr.bottom > 40) break;          // 和上一块断开了，不是占位
                const rr = sidebarRoot.getBoundingClientRect();
                if (rr.bottom - r.bottom > 40) break;       // 没有延伸到侧栏底边
                fold(el);
                break;
            }
        }

        /* ② 兜底：内层以外、且整体落在所有内层内容下方的纯空块 */
        let contentBottom = 0;
        const marks = sidebarRoot.querySelectorAll(
            'a, [role="button"], li, span, p, img, svg, picture, canvas');
        for (let i = 0; i < marks.length && i < 600; i++) {
            const el = marks[i];
            if (el.closest && el.closest('#gm-settings-panel')) continue;
            if (el.closest && el.closest('[data-gm-nav-gap], [data-gm-nav-gap-b]')) continue;
            const isMedia = /^(IMG|SVG|PICTURE|CANVAS)$/.test(el.tagName);
            if (!isMedia && !(el.textContent || '').trim()) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (r.height < 1 || r.width < 1) continue;
            if (r.bottom > contentBottom) contentBottom = r.bottom;
        }
        if (contentBottom) {
            const nodes = sidebarRoot.querySelectorAll('div, section, footer, nav, ul');
            for (let i = 0; i < nodes.length && i < 200; i++) {
                const el = nodes[i];
                if (el === sidebarRoot || el === inner) continue;
                if (el.hasAttribute('data-gm-nav-gap') ||
                    el.hasAttribute('data-gm-nav-gap-b')) { fold(el); continue; }
                if (el.querySelector('a, [role="button"]')) continue;
                if ((el.textContent || '').trim()) continue;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (r.height < 40 || r.width < 60) continue;
                if (r.top < contentBottom - 4) continue;
                fold(el);
            }
        }
        return changed;
    }

    /* v9.37.9：改「上下 padding」这条路走不通 —— 卡片高度是 `盒高 + 8` 推导出来的，
       给盒子加 padding 会把卡片一起撑高（内容下移 k、卡片底边也下移 k），
       实测写进 pad=16/0 之后缝隙仍是 17/33。
       现在改成**只平移盒子**：`position:relative; top:Npx` 不参与布局，
       卡片尺寸一个像素都不变，内容下移多少，上方缝隙就多多少、下方就少多少。 */
    let sidebarShiftSheet = null;
    /* v9.37.10：除了「上下对齐」，还要「边距和 www 页一样窄」。
       实测 www 约 17px、live 之前 25px。纯位移改不了「上下之和」，
       所以同时把菜单盒的高度收一收（卡片高度=盒高+8，会跟着变），
       再用 top 微调对齐。两个值都写进同一张样式表。 */
    const SIDEBAR_GAP_TARGET = 17;
    function writeSidebarShift(px, heightPx) {
        try {
            if (!sidebarShiftSheet || !sidebarShiftSheet.isConnected) {
                sidebarShiftSheet = document.createElement('style');
                sidebarShiftSheet.id = 'gm-sidebar-shift';
                (document.head || document.documentElement).appendChild(sidebarShiftSheet);
            }
            const css = 'html.xydy-sidebar-on [data-gm-nav-shift="1"]{' +
                'position:relative !important;top:' + px + 'px !important;' +
                (heightPx ? 'height:' + heightPx + 'px !important;' : '') +
                'overflow:visible !important;}';
            if (sidebarShiftSheet.textContent !== css) {
                sidebarShiftSheet.textContent = css;
            }
        } catch (e) {}
    }
    /* 找真实菜单项：a / [role=button] / li，带文字、尺寸像一项 */
    function sidebarMenuItems() {
        if (!sidebarRoot) return [];
        const out = [];
        let n = 0;
        const nodes = sidebarRoot.querySelectorAll('a, [role="button"], li');
        for (const el of nodes) {
            if (++n > 120) break;
            if (el.closest && el.closest(
                '#gm-settings-panel, [class*="tooltip"], [class*="Tooltip"], ' +
                '[class*="popover"], [class*="Popover"], [role="tooltip"]')) continue;
            if (el.closest && el.closest('[data-gm-nav-gap], [data-gm-nav-gap-b]')) continue;
            const txt = ((el.textContent || '') + '').replace(/\s+/g, '');
            if (txt.length < 2) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (!r || r.height < 22 || r.height > 80 || r.width < 70) continue;
            out.push({ el: el, r: r });
        }
        out.sort((a, b) => a.r.top - b.r.top);
        return out;
    }
    /* v9.37.7：菜单项的盒子上下内边距并不相等（首项顶到图标 4px、
       末项图标到下沿 11px 这种），所以「盒子到卡片」相等之后，眼睛看到的
       图标/文字仍然偏下。这里改成量**内容真实边界**：首项里所有可见子元素
       的最小 top、末项里所有可见子元素的最大 bottom。 */
    function itemVisualSpan(el) {
        let top = Infinity, bottom = -Infinity;
        if (!el) return null;
        let n = 0;
        const kids = el.querySelectorAll('*');
        for (const c of kids) {
            if (++n > 40) break;
            let r;
            try { r = c.getBoundingClientRect(); } catch (e) { continue; }
            if (!r || r.width < 4 || r.height < 4) continue;
            if (r.top < top) top = r.top;
            if (r.bottom > bottom) bottom = r.bottom;
        }
        if (!isFinite(top)) {
            try {
                const r = el.getBoundingClientRect();
                top = r.top; bottom = r.bottom;
            } catch (e) { return null; }
        }
        return { top: top, bottom: bottom };
    }
    function balanceSidebarPadding() {
        if (!sidebarRoot || !sidebarRoot.isConnected) return false;
        const items = sidebarMenuItems();
        if (items.length < 3) { sidebarGapDbg = '菜单项仅 ' + items.length + ' 个'; return false; }
        /* v9.37.8：抖音给**每个菜单项都单独包了一层 div**，所以「同父」只剩 1 个，
           前面几版全卡在这里（诊断 `同父菜单项仅 1 个`）。现在改成：
             ① 去掉「包含别的菜单项」的外层（li 套 a 这种）；
             ② 取同时包含首末项的**最深公共祖先**当菜单容器。 */
        const els = items.map(x => x.el);
        const kept = items.filter(it => !els.some(o => o !== it.el && it.el.contains(o)));
        if (kept.length < 3) {
            sidebarGapDbg = '去重后菜单项仅 ' + kept.length + ' 个';
            return false;
        }
        const firstEl = kept[0].el, lastEl = kept[kept.length - 1].el;
        let parent = firstEl.parentElement;
        while (parent && parent !== sidebarRoot && !parent.contains(lastEl)) {
            parent = parent.parentElement;
        }
        if (!parent || parent === sidebarRoot) {
            /* 首末项的公共祖先就是卡片本身：退一步用「卡片下、包含它们的那个子块」 */
            let b = firstEl;
            while (b && b.parentElement && b.parentElement !== sidebarRoot) {
                b = b.parentElement;
            }
            parent = (b && b !== firstEl) ? b : null;
        }
        if (!parent || parent === sidebarRoot || !parent.getBoundingClientRect) {
            sidebarGapDbg = '找不到菜单容器';
            return false;
        }
        /* v9.37.6：以**卡片**（用户看到的圆角背景块）为准量空隙。
           卡片里除菜单容器之外还有别的层（内层 padding、外层留白），
           它们上下并不相等，所以「容器自己上下 padding 相等」根本不够。 */
        let cr;
        try { cr = sidebarRoot.getBoundingClientRect(); } catch (e) { return false; }
        if (!cr.height) return false;
        const firstSpan = itemVisualSpan(firstEl) || kept[0].r;
        const lastSpan = itemVisualSpan(lastEl) || kept[kept.length - 1].r;
        const gapTop = firstSpan.top - cr.top;
        const gapBottom = cr.bottom - lastSpan.bottom;
        sidebarGapDbg = 'gT=' + Math.round(gapTop) + ' gB=' + Math.round(gapBottom) +
            ' n=' + kept.length +
            ' box=' + parent.tagName.toLowerCase() + '.' +
            String(parent.className || '').trim().split(/\s+/)[0];
        if (gapTop < 0 || gapBottom < 0) return false;
        let cs;
        try { cs = window.getComputedStyle(parent); } catch (e) { return false; }
        /* 当前平移量（我们自己写的 top；static 时 computed 是 auto → 0） */
        let curTop = Math.round(parseFloat(cs.top) || 0);
        if (!isFinite(curTop)) curTop = 0;
        let curBoxH = 0;
        try { curBoxH = Math.round(parent.getBoundingClientRect().height); } catch (e) {}
        if (!curBoxH) return false;
        const d = gapBottom - gapTop;
        const G = (gapTop + gapBottom) / 2;
        sidebarGapDbg += ' d=' + Math.round(d) + ' top=' + curTop + ' boxH=' + curBoxH;
        let top = curTop;
        let boxH = curBoxH;
        let changed = false;
        /* ① 先对齐：下方多出 d → 盒子下移 d/2（不参与布局） */
        if (Math.abs(d) > 2) {
            top = curTop + Math.round(d / 2);
            if (top > 80) top = 80;
            if (top < -80) top = -80;
            changed = true;
        } else if (Math.abs(G - SIDEBAR_GAP_TARGET) > 2) {
            /* ② 再收边距：整块上下的空隙一起缩/放。
               卡片高度 = 盒高 + 8，所以改盒高等于改卡片高；
               改完下一轮重新实测，再靠 ① 微调对齐。 */
            const want = Math.round(curBoxH - 2 * (G - SIDEBAR_GAP_TARGET));
            /* 不能比「首项盒子顶 → 末项盒子底」更矮，否则会把菜单挤出去 */
            const minH = Math.round(kept[kept.length - 1].r.bottom -
                kept[0].r.top) + 10;
            boxH = Math.max(minH, Math.min(want, curBoxH + 200));
            changed = true;
        }
        const state = 'top' + top + '/h' + boxH;
        if (!changed) {
            /* 已经对称且边距到位：只保证标记和规则还在 */
            if (parent.getAttribute('data-gm-nav-shift') === '1' &&
                sidebarPadApplied === state) return false;
        } else if (sidebarPadApplied === state) {
            return false;
        }
        markTouched(parent);
        parent.setAttribute('data-gm-nav-box', '1');
        parent.setAttribute('data-gm-nav-shift', '1');
        writeSidebarShift(top, boxH);
        sidebarPadApplied = state;
        return changed;
    }
    let sidebarPadApplied = null;
    let sidebarGapDbg = '';

    /* 抖音内层常带几十像素的 padding-top / margin-top，光折叠空块不够。
       从第一个菜单项的父链往上，把明显偏大的顶部间距清零。 */
    function tightenSidebarTop(firstTop, firstItemEl) {
        if (!sidebarRoot || !firstItemEl || !isFinite(firstTop)) return;
        if (sidebarRoot.hasAttribute('data-gm-nav-tight-done')) return;
        const rr = sidebarRoot.getBoundingClientRect();
        if (firstTop - rr.top < 10) return;
        let el = firstItemEl.parentElement, d = 0;
        while (el && el !== sidebarRoot && d++ < 7) {
            let cs;
            try { cs = window.getComputedStyle(el); } catch (e) { break; }
            const pt = parseFloat(cs.paddingTop) || 0;
            const mt = parseFloat(cs.marginTop) || 0;
            if (pt > 6) { markTouched(el); el.style.setProperty('padding-top', '0', 'important'); }
            if (mt > 6) { markTouched(el); el.style.setProperty('margin-top', '0', 'important'); }
            el = el.parentElement;
        }
        sidebarRoot.setAttribute('data-gm-nav-tight-done', '1');
    }

    /* v9.19.1：鼠标在侧栏附近时抖音内部在做展开/收起动画。这里不再冻结
       拟合（冻结会让高度一直不定型，反而被抖音撑成整屏），只记录指针是否
       还在左侧，几何反查类任务用它做开关。 */
    let sidebarPointerNear = false;
    document.addEventListener('pointermove', (e) => {
        sidebarPointerNear = e.clientX < 360;
    }, { capture: true, passive: true });

    let appliedSidebarH = 0, lastHeightWriteAt = 0;
    let fitPendingH = 0, fitPendingSince = 0;
    let sidebarHSheet = null;

    /* 高度写进独立 stylesheet：比 inline 持久，React 重渲染清 inline style
       时（诊断里 styleH 从 522px 变成 —）这条规则仍然生效。 */
    function writeSidebarHeight(h) {
        try {
            if (!sidebarHSheet || !sidebarHSheet.isConnected) {
                sidebarHSheet = document.createElement('style');
                sidebarHSheet.id = 'gm-sidebar-height';
                (document.head || document.documentElement).appendChild(sidebarHSheet);
            }
            sidebarHSheet.textContent =
                'html.xydy-sidebar-on #douyin-navigation,' +
                'html.xydy-sidebar-on [data-e2e="douyin-navigation"]{' +
                'height:' + h + 'px !important;}';
        } catch (e) {}
    }

    function fitSidebarHeight() {
        if (!sidebarEnabled() || !sidebarRoot || !sidebarRoot.isConnected) return;
        /* v9.19.2：首屏菜单还没渲染完时量到的是空壳，这时定型会把侧栏
           压成一条，并让 collapseSidebarTopGap 误伤还没出文字的菜单项。 */
        if (!appliedSidebarH && performance.now() < 900) return;
        if (!appliedSidebarH && ((sidebarRoot.textContent || '').trim()).length < 6) return;
        const now = performance.now();
        if (now - lastFitAt < 700) return;
        lastFitAt = now;

        const vh = window.innerHeight;
        let firstTop = Infinity, lastBottom = -Infinity, n = 0;
        let firstItemEl = null;
        // 放宽到 div，靠尺寸过滤排除大容器；遍历上限 400，不再中途 break
        const items = sidebarRoot.querySelectorAll(
            'a, [role="button"], li, div, [data-e2e*="nav"] > div, ' +
            '[class*="nav-item"], [class*="NavItem"]');
        for (let i = 0; i < items.length && i < 400; i++) {
            const el = items[i];
            if (el.offsetParent === null) continue;
            // hover 气泡 / tooltip 带文字又符合尺寸，会让 firstTop / lastBottom
            // 每帧漂移，表现为菜单文字上下跳动
            if (el.closest && el.closest(
                '#gm-settings-panel, [class*="tooltip"], [class*="Tooltip"], ' +
                '[class*="popover"], [class*="Popover"], [role="tooltip"]')) continue;
            // 排除纯空占位块（logo / 图标条），否则 firstTop 会被拉到背景块顶部，
            // 高度里平白多出一大截上方留白
            if (((el.textContent || '').trim()).length < 2) continue;
            const r = el.getBoundingClientRect();
            if (r.height < 20 || r.height > 100 || r.width < 60 || r.width > 230) continue;
            if (r.bottom < 0 || r.top > vh) continue;
            if (r.top < firstTop) firstItemEl = el;
            firstTop = Math.min(firstTop, r.top);
            lastBottom = Math.max(lastBottom, r.bottom);
            n++;
        }
        if (n) {
            collapseSidebarTopGap(firstTop);
            tightenSidebarTop(firstTop, firstItemEl);
        }
        /* 上下留白均衡：量真实菜单项，把上下空隙取平均后写死（不依赖 firstTop），
           所以放在 if (n) 外面，分类页那种量不到的情况也照做。
           改完这一轮先不定型高度，等下一轮拿新的几何再算。 */
        if (balanceSidebarPadding()) {
            fitPendingH = 0; fitPendingSince = 0;
            return;
        }
        /* 不放在 if (n) 里：分类页 / 首屏没量到菜单项时也要能折掉底部占位 */
        if (collapseSidebarBottomGap()) {
            /* 折叠掉底部空块后高度会立刻变矮，本轮先不复用旧测量值 */
            fitPendingH = 0; fitPendingSince = 0;
            return;
        }
        let h = 0;
        /* 菜单上下留白被我们改写后，高度的基准要跟着菜单容器走，
           否则按「首项顶 → 末项底」算出来的高度不含 padding，内容会被截。 */
        const boxEl = sidebarRoot.querySelector('[data-gm-nav-box="1"]');
        if (boxEl) {
            let bx = null;
            try { bx = boxEl.getBoundingClientRect(); } catch (e) {}
            if (bx && bx.height > 60) h = Math.ceil(bx.height + 8);
        }
        if (!h && n && lastBottom > firstTop) h = Math.ceil(lastBottom - firstTop + 16);
        /* scrollHeight 只在「略大于实测内容」时纠正算矮。live 页面内层被
           100vh 撑高时 scrollHeight 会是整屏，无条件采用会把侧栏拉成几乎
           满屏的直角矩形，圆角被拉没——这正是「live 高度没限制」的来源。 */
        const sh = sidebarRoot.scrollHeight || 0;
        // 只允许小幅纠正。1.25 倍的宽松条件会把内层撑高直接变成背景块的
        // 额外留白（实测 436 → 510，上下各多出几十像素）。
        if (sh > h && sh <= h + 20) h = sh;
        if (!h || h < 120) return;
        // v9.37.1：原来硬截 600px（「够 11~12 个菜单项」）。但实测直播间侧栏
        // 内容有 1040px 高，被截到 600 之后整体还垂直居中 → 底边离视口底 219px，
        // 内容溢出却没有背景，就是「侧栏下方留白太多」。改成按视口撑满。
        // 仍然保留一个上限，避免内层被 100vh 撑高时把侧栏拉成整屏直角矩形。
        h = Math.min(h, Math.max(240, vh - 16));
        /* v9.19.2：诊断显示加载期间测量值 289 → 438 → 522 → 600 一直在变，
           任何「立刻写入」都会变成一次可见跳动。改成：
             - 新值必须连续稳定 1.5s（首屏）/ 1.2s（之后）才采纳；
             - 高度写进独立 stylesheet，不走 inline —— React 重渲染不会清掉
               （诊断里 styleH 变空就是 inline 被清了）。 */
        if (Math.abs(h - fitPendingH) > 4) {
            fitPendingH = h; fitPendingSince = Date.now(); return;
        }
        if (!fitPendingSince) { fitPendingSince = Date.now(); return; }
        const needStable = appliedSidebarH ? 1200 : 800;
        if (Date.now() - fitPendingSince < needStable) return;
        if (appliedSidebarH && Math.abs(h - appliedSidebarH) < 6) return;
        if (appliedSidebarH && Date.now() - lastHeightWriteAt < 1200) return;

        const isFirst = !appliedSidebarH;
        appliedSidebarH = h;
        lastHeightWriteAt = Date.now();
        fitPendingSince = Date.now();
        writeSidebarHeight(h);
        const rr = sidebarRoot.getBoundingClientRect();
        /* 上下留白已经交给 balanceSidebarPadding 按卡片实测校正了，
           这里再用「整体位移」去居中会两套控制器打架（来回抖），所以让位。 */
        if (!isFirst && sidebarPadApplied === null) {
            centerSidebarContent(firstTop, lastBottom, rr, firstItemEl);
        }
    }

    /* v9.19.1：主循环 1.5s 对侧栏拟合太慢（React 清掉 height 后要等 1.5s
       才补回来，这段就是可见的跳动）。单独用一个 350ms 定时器驱动，
       函数内部仍按 700ms 节流，等于每 0.7s 定型一次。 */
    setInterval(() => {
        if (!document.hidden) safeRun(fitSidebarHeight);
    }, 350);

    /* 折叠空块后仍可能上下不对称：抖音内层自带 padding / margin，菜单整体
       偏下。这里按「内容中心 vs 背景块中心」给内层一个相对位移，让上下
       留白相等；减去已施加的位移，避免每 800ms 累积。 */
    let innerTopApplied = 0;
    function centerSidebarContent(firstTop, lastBottom, rr, firstItemEl) {
        /* 从第一个可见菜单向上找到 sidebarRoot 的直接子容器。
           旧版写死 firstElementChild，抖音侧栏第一个子元素往往只是空壳，
           给它设 top 根本带不动菜单，于是上下仍不对称。 */
        let inner = firstItemEl;
        while (inner && inner.parentElement && inner.parentElement !== sidebarRoot)
            inner = inner.parentElement;
        if (!inner || inner === sidebarRoot || !inner.parentElement ||
            inner.parentElement !== sidebarRoot)
            inner = sidebarRoot && sidebarRoot.firstElementChild;
        if (!inner || !isFinite(firstTop) || !rr || !rr.height) return;
        const contentCenter = (firstTop + lastBottom) / 2 - innerTopApplied;
        const boxCenter = rr.top + rr.height / 2;
        let delta = Math.round(boxCenter - contentCenter);
        if (!isFinite(delta) || Math.abs(delta) > 140) delta = 0;
        // 8px 迟滞：小抖动不再触发重排
        if (Math.abs(delta - innerTopApplied) < 8) return;
        innerTopApplied = delta;
        markTouched(inner);
        inner.style.setProperty('position', 'relative', 'important');
        inner.style.setProperty('top', delta + 'px', 'important');
    }

    /* 关掉「直播间悬浮侧栏」时把抖音原生侧栏还回来：移除我们加的 class
       和所有 inline 覆盖。开关关闭后 sidebarEnabled() 为 false，各函数不再
       写入，所以刷新页面后也能自然保持原生状态。 */
    function restoreNativeSidebar() {
        const root = sidebarRoot || document.querySelector(
            '#douyin-navigation, [data-e2e="douyin-navigation"]');
        if (!root) return;
        root.classList.remove('xydy-sidebar-root');
        root.removeAttribute('data-gm-nav-tight-done');
        const list = [root].concat(Array.prototype.slice.call(
            root.querySelectorAll('[data-gm-sidebar-touched]')));
        const PROPS = ['height', 'max-height', 'min-height', 'padding-top',
                       'padding-bottom', 'margin-top', 'top', 'position',
                       'transform', 'overflow'];
        for (const el of list) {
            const st = el.style;
            if (st) for (const p of PROPS) st.removeProperty(p);
            if (el.hasAttribute && (el.hasAttribute('data-gm-nav-gap') ||
                el.hasAttribute('data-gm-nav-gap-b'))) {
                if (st) st.removeProperty('display');
                el.removeAttribute('data-gm-nav-gap');
                el.removeAttribute('data-gm-nav-gap-b');
            }
            if (el.removeAttribute) el.removeAttribute('data-gm-sidebar-touched');
            if (el.removeAttribute) el.removeAttribute('data-gm-nav-box');
            if (el.removeAttribute) el.removeAttribute('data-gm-nav-shift');
        }
        sidebarPadApplied = null;
        sidebarGapDbg = '';
        if (sidebarShiftSheet) { try { sidebarShiftSheet.textContent = ''; } catch (e) {} }
        innerTopApplied = 0;
        lastFitAt = 0;
        stableH = 0; stableFirst = 0; stableCount = 0;
        appliedSidebarH = 0; lastHeightWriteAt = 0;
        fitPendingH = 0; fitPendingSince = 0;
        if (sidebarHSheet) { try { sidebarHSheet.textContent = ''; } catch (e) {} }
    }
    function restoreNativeSidebarWhenOff() {
        if (!isLivePage() || !config.enableSidebar || config.liveSidebar) return;
        const root = document.querySelector(
            '#douyin-navigation, [data-e2e="douyin-navigation"]');
        if (!root) return;
        if (!root.classList.contains('xydy-sidebar-root') &&
            !root.hasAttribute('data-gm-sidebar-touched') &&
            !root.querySelector('[data-gm-sidebar-touched]')) return;
        restoreNativeSidebar();
    }

    let wasSuppressed = false;
    function updateSidebarFlag() {
        const enable = sidebarEnabled();
        const liveOff = isLivePage() && !!config.enableSidebar && !config.liveSidebar;
        html.classList.toggle('xydy-live-sidebar-off', liveOff);
        const wasOn = html.classList.contains('xydy-sidebar-on');
        const sup = sidebarSuppressed();
        html.classList.toggle('xydy-sidebar-on', enable);
        if (!enable) html.classList.remove('xydy-sidebar-hidden');
        else if (sup) html.classList.add('xydy-sidebar-hidden');
        else if (wasSuppressed) html.classList.remove('xydy-sidebar-hidden'); // 退出全屏后恢复
        else if (!wasOn) html.classList.add('xydy-sidebar-hidden');
        wasSuppressed = sup;
        refreshSidebarRoot();
    }

    let lastSidebarState = '';
    function syncSidebarHostState(force) {
        const key = sidebarEnabled() + '|' + sidebarSuppressed();
        if (force || key !== lastSidebarState) {
            lastSidebarState = key;
            updateSidebarFlag();
        }
    }

    /* ---- 页面底色 / 侧栏底板：读抖音自己容器的底色，不写死 ----
       v9.45：抖音换过一次配色之后，#161616 和它的底不再是同一个色了。
       v9.47：这个色现在同时给两处用 —— html/body 的兜底底色（直播页底部、
              顶栏左边那几十像素抖音自己没铺到，靠它盖住）和侧栏卡片底板。
       每次（最多 2s 一次）从页面自己那层容器上取当前底色，写进 CSS 变量
       --gm-nav-bg，以后再换配色也不用改脚本。
       读取顺序：
         ① 侧栏根节点的祖先（往上 6 层）—— 抖音给侧栏铺的那层底，
            我们只改了根节点本身，祖先的底色还是抖音原样；
         ② #root / #dark / body / html —— 页面级容器；
       只在「不透明 + 深色」时采用；全是透明或读不到就退回 #161616。
       （不读根节点自己：它的底色已经是 var(--gm-nav-bg)，读它等于读自己，
       会锁死在旧值上；html/body 一旦被我们画上这个变量，也不再回头读它们。） */
    let navBgValue = '', navBgAt = 0;
    function readSurfaceColor() {
        const pick = (el) => {
            if (!el || el.nodeType !== 1) return '';
            let c = '';
            try { c = window.getComputedStyle(el).backgroundColor || ''; } catch (e) { return ''; }
            const m = /^rgba?\(([^)]+)\)$/.exec(c);
            if (!m) return '';
            const p = m[1].split(',').map(Number);
            const a = p.length > 3 ? p[3] : 1;
            if (!(a >= 0.9)) return '';                 // 半透明不算「铺了底」
            const lum = 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
            if (lum > 150) return '';                   // 亮色底不算（页面是深色）
            return 'rgb(' + (p[0] | 0) + ',' + (p[1] | 0) + ',' + (p[2] | 0) + ')';
        };
        let el = (sidebarRoot && sidebarRoot.isConnected) ? sidebarRoot.parentElement : null;
        let d = 0;
        while (el && d++ < 6) {
            const c = pick(el);
            if (c) return c;
            el = el.parentElement;
        }
        for (const sel of ['#root', '#dark', 'body', 'html']) {
            const node = document.querySelector(sel);
            /* 已经用这个变量画上底色了，再读 body/html 只会读回自己 */
            if (navBgValue && (node === document.body || node === document.documentElement)) continue;
            const c = pick(node);
            if (c) return c;
        }
        return '';
    }
    function syncNavBg() {
        const now = Date.now();
        if (now - navBgAt < 2000) return;               // getComputedStyle 不便宜，2s 一次够了
        navBgAt = now;
        const val = readSurfaceColor() || '#161616';    // 读不到就保持原来的固定色
        if (val === navBgValue) return;
        navBgValue = val;
        try { html.style.setProperty('--gm-nav-bg', val); } catch (e) {}
    }
    /* 尽早取一次：底部那条兜底色 / 侧栏底板都等不起第一个 1.5s 的循环 */
    try {
        document.addEventListener('DOMContentLoaded', () => {
            try { syncNavBg(); } catch (e) {}
            /* 底部操作栏别等第一个 1.5s 循环：它一占位播放器就矮 88px，
               等一会儿再收会看到画面「往上跳」一下。 */
            try { setTimeout(() => safeRun(collapseEmptyOpBar), 600); } catch (e) {}
            try { setTimeout(() => safeRun(collapseEmptyOpBar), 2000); } catch (e) {}
            /* 以前误接管的控制条，进来先还原一次 */
            try { setTimeout(() => safeRun(restoreControlBar), 800); } catch (e) {}
        }, { once: true });
    } catch (e) {}
    updateSidebarFlag();
    lastSidebarState = sidebarEnabled() + '|' + sidebarSuppressed();
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(ev => {
        document.addEventListener(ev, () => safeRun(() => syncSidebarHostState(true)));
    });

    let sidebarHideTimer = null;
    let safeTop = -50, safeBottom = 1e9, rectStamp = 0;

    function measureSidebar() {
        const now = performance.now();
        if (now - rectStamp < 600) return;
        rectStamp = now;
        if (!sidebarRoot || !sidebarRoot.isConnected) return;
        const r = sidebarRoot.getBoundingClientRect();
        safeTop = Math.max(-50, r.top - 50);
        safeBottom = Math.min(window.innerHeight + 50, r.bottom + 50);
    }

    function scheduleSidebarHide() {
        if (sidebarHideTimer) { clearTimeout(sidebarHideTimer); sidebarHideTimer = null; }
        sidebarHideTimer = setTimeout(() => {
            sidebarHideTimer = null;
            html.classList.add('xydy-sidebar-hidden');
        }, 300);
    }

    /* 鼠标从窗口左边缘「滑出去」时，最后一次 pointermove 停在 x≈0，
       旧逻辑在 x<=20 分支清掉隐藏计时并直接 return，于是侧栏一直挂着，
       必须等鼠标回到窗口内且离开触发区才会收起。这里补上离开窗口事件。 */
    let pointerOutside = false;
    function onLeaveWindow() {
        pointerOutside = true;
        if (!sidebarEnabled() || sidebarSuppressed()) return;
        if (html.classList.contains('xydy-sidebar-hidden')) return;
        scheduleSidebarHide();
    }
    document.addEventListener('mouseout', (e) => {
        if (!e.relatedTarget) onLeaveWindow();
    }, { passive: true });
    document.addEventListener('pointerout', (e) => {
        if (!e.relatedTarget) onLeaveWindow();
    }, { passive: true });
    try {
        document.documentElement.addEventListener('mouseleave', onLeaveWindow, { passive: true });
        document.documentElement.addEventListener('pointerleave', onLeaveWindow, { passive: true });
    } catch (e) {}
    window.addEventListener('blur', onLeaveWindow, { passive: true });

    let pendingX = 0, pendingY = 0, pointerRaf = false;
    document.addEventListener('pointermove', (e) => {
        pointerOutside = false;
        pendingX = e.clientX;
        pendingY = e.clientY;
        if (pointerRaf || !sidebarEnabled()) return;
        pointerRaf = true;
        requestAnimationFrame(handlePointerMove);
    }, { passive: true });

    function handlePointerMove() {
        pointerRaf = false;
        if (!sidebarEnabled()) return;
        if (sidebarSuppressed()) {
            html.classList.add('xydy-sidebar-hidden');
            return;
        }
        // 离开窗口后可能还有一帧排队的 rAF，别让它把隐藏计时清掉
        if (pointerOutside) { scheduleSidebarHide(); return; }
        const x = pendingX, y = pendingY;

        if (x <= 20) {
            if (sidebarHideTimer) { clearTimeout(sidebarHideTimer); sidebarHideTimer = null; }
            /* v9.20：侧栏滑入之前先把压在它下面的气泡抬起来，否则会先压
               一下再浮上来（看起来像气泡跳了一下）。 */
            if (html.classList.contains('xydy-sidebar-hidden'))
                safeRun(() => liftSidebarOverlays(true));
            html.classList.remove('xydy-sidebar-hidden');
            return;
        }
        if (html.classList.contains('xydy-sidebar-hidden')) return;

        measureSidebar();
        const inZone = (x >= -20 && x <= 190 && y >= safeTop && y <= safeBottom);
        if (inZone) {
            if (sidebarHideTimer) { clearTimeout(sidebarHideTimer); sidebarHideTimer = null; }
        } else if (!sidebarHideTimer) scheduleSidebarHide();
    }

    /* =====================================================================
     * 6. 模拟按键、真实点击与鼠标手势
     * ===================================================================== */
    let startX = 0, startY = 0;
    let isMouseDown = false, isSwiping = false, isLongPressing = false;
    let longPressTimer = null, suppressNextClick = false;
    let hotkeyCapturing = false;
    let hotkeyInput = null;
    let hotkeyTargetKey = 'settingsHotkey';   // 正在改的是哪一项

    const gestureIgnore = [
        'input', 'textarea', 'select', '[contenteditable="true"]', 'button', 'a',
        '[role="button"]', '[role="slider"]', '.xgplayer-controls', '.douyin-player-controls',
        '#videoSideCard', '#gm-settings-panel', '.xydy-cam-detached'
    ].join(', ');
    const panelIgnore = '#gm-settings-panel, input, textarea, select, [contenteditable="true"]';

    /* v9.20.6：脚本自己派发的 click 不能被自己的「单击画面 = 播放/暂停」拦截吞掉。
       否则点卡片上的「不感兴趣」入口会被当成单击画面：抖音收不到这次点击，
       菜单不出现，260ms 后视频反倒被暂停。派发前开一个 80ms 的放行窗口。 */
    let gmSynthClickUntil = 0;
    /* v9.24：双击全屏被拦住之后，仍有一小段时间屏蔽播放器上的 click，
       防止抖音在「第二击之后」才触发点赞。 */
    let likeShieldUntil = 0;
    /* v9.24：给页面自己的监听器用的「这段时间里播放器上的指针事件一律别理」，
       见文件末尾的 installListenerGuard()。 */
    let gmGuardUntil = 0;

    /* v9.20.5：键码表必须覆盖所有功能键。
       旧版只有字母，ArrowDown 走 `key.toUpperCase().charCodeAt(0)` 退化成 65（"A"），
       等于按下的是字母 A —— 方向键从来没生效过。 */
    const KEY_CODES = {
        z: 90, x: 88, r: 82, d: 68, y: 89, ' ': 32,
        ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39,
        Escape: 27, Enter: 13, Tab: 9,
        PageUp: 33, PageDown: 34, Home: 36, End: 35
    };

    function keyTarget() {
        return document.getElementById('root') || document.getElementById('app') ||
               document.getElementById('dark') ||
               (document.body && document.body.firstElementChild) ||
               document.body || document;
    }

    function simulateKey(type, key, code) {
        const kc = KEY_CODES[key] ||
            (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
        // 未知功能键宁可什么都不发，也不能发成一个错误的字母键
        if (!kc) return;
        const ev = new KeyboardEvent(type, {
            key: key, code: code, bubbles: true, cancelable: true, composed: true
        });
        try {
            Object.defineProperty(ev, 'keyCode', { get: () => kc, configurable: true });
            Object.defineProperty(ev, 'which', { get: () => kc, configurable: true });
        } catch (e) {}
        keyTarget().dispatchEvent(ev);
    }

    function tapKey(key, code) {
        simulateKey('keydown', key, code);
        simulateKey('keyup', key, code);
    }

    function isVisibleClickable(el) {
        if (!el || typeof el.click !== 'function') return false;
        const r = el.getBoundingClientRect();
        return r.width > 8 && r.height > 8 && r.right > 0 && r.left < window.innerWidth &&
               r.bottom > 0 && r.top < window.innerHeight;
    }

    /* React 组件常监听 pointerdown/mousedown 链，只调 .click() 会静默失败。
       派发一组完整事件，坐标取元素中心。 */
    function fireClick(el) {
        if (!isVisibleClickable(el)) return false;
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const base = {
            bubbles: true, cancelable: true, composed: true, view: window,
            button: 0, buttons: 1, clientX: cx, clientY: cy,
            screenX: cx, screenY: cy, detail: 1
        };
        const up = Object.assign({}, base, { buttons: 0 });
        gmSynthClickUntil = Date.now() + 80;   // 别被自己的单击拦截吞掉
        try {
            if (typeof PointerEvent === 'function') {
                el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, {
                    pointerId: 1, pointerType: 'mouse', isPrimary: true
                })));
                el.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, up, {
                    pointerId: 1, pointerType: 'mouse', isPrimary: true
                })));
            }
            el.dispatchEvent(new MouseEvent('mousedown', base));
            el.dispatchEvent(new MouseEvent('mouseup', up));
            el.dispatchEvent(new MouseEvent('click', up));
            return true;
        } catch (e) {
            try { el.click(); return true; } catch (e2) { return false; }
        }
    }

    /* ---- 中键：直播间聊天室开关 ----
     * 依据用户 2026-11-11 提供的真实顶栏 DOM（live.douyin.com）：
     *   <div class="sDE_n_gz dmp0TnCf">                        顶栏行
     *     <div class="KH9DQgyz"> SVG(≡→) </div>                 ← 收起按钮（第 1 个子元素）
     *     <div class="NhzYUKSZ">在线观众</div>
     *     <div class="reeOcqF8">·</div>
     *     <div class="ClV317pr" data-e2e="live-room-audience">1万</div>  ← 稳定锚点
     *     <div class="q_8PXGt8">ⓘ</div>
     *     <div class="h60tvMpV"><i class="LvQByUej"></i></div>  ← 右上角图标，不是收起
     *   </div>
     * 用户截图里红箭头指的正是左侧 ≡→ 图标。旧版在顶栏右侧扫「任意小按钮」
     * 才误开粉丝团；v9.4 只认「顶栏行最左 + 含特征箭头 SVG」的元素。 */
    const CHAT_BLOCK = /粉丝团|fans|fangroup|fan_group|守护|贵族|礼物|gift|vip|rank|榜单|贡献|连麦|分享|share|举报|report|充值|钻石|会员|特权/i;
    const TOGGLE_STRONG = 'M12 17.75H4v-1.5h8v1.5zm5.19-6.5';   // ≡→ 收起箭头
    const TOGGLE_LOOSE  = /17\.75H|2\.72-2\.72|13\.19z|7071|29289|M16\.7|M3\.29/;

    function attrSig(el) {
        return [
            el.tagName, el.id,
            (typeof el.className === 'string' ? el.className : ''),
            el.getAttribute('data-e2e') || '', el.getAttribute('aria-label') || '',
            el.getAttribute('title') || '', (el.textContent || '').trim().slice(0, 30)
        ].join(' ');
    }

    function isSmallClickable(el) {
        if (!isVisibleClickable(el)) return false;
        const r = el.getBoundingClientRect();
        return r.width <= 90 && r.height <= 90;
    }

    function chatPanelRect() {
        const cands = document.querySelectorAll(
            '#chatroom, [id*="chatroom"], [class*="chatroom"], [data-e2e*="chatroom"]');
        let best = null, maxArea = 0;
        for (const el of cands) {
            const r = el.getBoundingClientRect();
            if (r.width < 220 || r.width > 620 || r.height < 180) continue;
            if (r.right < window.innerWidth * 0.6) continue;
            const a = r.width * r.height;
            if (a > maxArea) { maxArea = a; best = r; }
        }
        return best;
    }

    function svgPaths(el) {
        if (!el || !el.querySelectorAll) return [];
        return Array.prototype.slice.call(el.querySelectorAll('path'));
    }
    function isToggleIcon(el, loose) {
        for (const p of svgPaths(el)) {
            const d = p.getAttribute('d') || '';
            if (d.indexOf(TOGGLE_STRONG) === 0) return true;
            if (loose && TOGGLE_LOOSE.test(d)) return true;
        }
        return false;
    }

    /* 展开态：用 live-room-audience 锚到顶栏行，取最左的小 SVG 按钮 */
    function chatToggleFromHeader() {
        const anchor = document.querySelector('[data-e2e="live-room-audience"]');
        const row = anchor && anchor.parentElement;
        if (!row) return null;
        const rr = row.getBoundingClientRect();
        if (rr.width > 480 || rr.top > 120 || rr.width < 120) return null;  // 不是顶栏行
        const kids = Array.prototype.slice.call(row.children || []);
        for (const el of kids) {
            if (isSmallClickable(el) && !CHAT_BLOCK.test(attrSig(el)) && isToggleIcon(el, false))
                return el;
        }
        let best = null, bestLeft = Infinity;
        for (const el of kids) {
            if (!isSmallClickable(el) || CHAT_BLOCK.test(attrSig(el))) continue;
            if (!el.querySelector('svg')) continue;
            const b = el.getBoundingClientRect();
            if (b.left < bestLeft) { bestLeft = b.left; best = el; }
        }
        return best;
    }

    /* 收起态：窗口右缘 44px 内、含箭头 SVG 的小按钮；非箭头一律不认 */
    function collapsedEdgeToggle() {
        const limit = window.innerWidth - 44;
        let best = null, bestTop = Infinity;
        for (const svg of document.querySelectorAll('svg')) {
            const r = svg.getBoundingClientRect();
            if (r.width < 8 || r.height < 8 || r.width > 60 || r.height > 60) continue;
            if (r.right < limit || r.right > window.innerWidth + 5) continue;
            let btn = svg.parentElement;
            if (btn && !isSmallClickable(btn) && btn.parentElement && isSmallClickable(btn.parentElement))
                btn = btn.parentElement;
            if (!btn || !isSmallClickable(btn) || CHAT_BLOCK.test(attrSig(btn))) continue;
            if (!isToggleIcon(btn, true)) continue;
            if (r.top < bestTop) { bestTop = r.top; best = btn; }
        }
        return best;
    }

    let cachedToggleClass = '';
    function rememberToggle(el) {
        const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)[0];
        if (cls && /^[A-Za-z][\w-]*$/.test(cls)) cachedToggleClass = cls;
    }

    function findChatroomToggle() {
        // A 自定义选择器：填了就只认它，不再盲猜（避免误触粉丝团等面板）
        const sel = (config.chatroomToggleSelector || '').trim();
        if (sel && sel.length <= 300) {
            try {
                for (const el of document.querySelectorAll(sel)) {
                    if (isSmallClickable(el)) return el;
                }
                return null;
            } catch (e) { return null; }
        }
        // B 精确锚点：顶栏行里 ≡→ 收起按钮
        const fromHeader = chatToggleFromHeader();
        if (fromHeader) { rememberToggle(fromHeader); return fromHeader; }
        // C 收起态：缓存的 class（哈希 class 在一次会话内稳定）
        if (cachedToggleClass) {
            try {
                for (const el of document.querySelectorAll('.' + cachedToggleClass)) {
                    if (isSmallClickable(el) && !CHAT_BLOCK.test(attrSig(el))) return el;
                }
            } catch (e) {}
        }
        // D 全文档按特征箭头 SVG 找（class 改版也能命中）
        for (const svg of document.querySelectorAll('svg')) {
            if (!isToggleIcon(svg, true)) continue;
            let btn = svg.parentElement;
            if (btn && !isSmallClickable(btn) && btn.parentElement && isSmallClickable(btn.parentElement))
                btn = btn.parentElement;
            if (btn && isSmallClickable(btn) && !CHAT_BLOCK.test(attrSig(btn))) {
                rememberToggle(btn);
                return btn;
            }
        }
        // E 收起态右缘兜底
        return collapsedEdgeToggle();
    }

    /* ---- 一键导出聊天室顶栏 DOM（设置面板按钮 / 控制台都能用） ---- */
    function legacyCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
        } catch (e) {}
    }
    function copyText(text) {
        legacyCopy(text);   // 同步执行，处在按钮点击的用户手势内，成功率最高
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).catch(() => {});
            }
        } catch (e) {}
    }

    function dumpChatroomDOM() {
        const lines = [];
        const push = (s) => lines.push(s);
        push('# 抖音直播间聊天室顶栏 DOM');
        push('URL: ' + location.href);
        push('viewport: ' + window.innerWidth + 'x' + window.innerHeight);
        const r = chatPanelRect();
        push('chatPanelRect: ' + (r
            ? [r.left | 0, r.top | 0, r.width | 0, r.height | 0].join(',') : 'null'));

        // 以「在线观众」文案定位顶栏，再向上抬到顶栏容器
        let anchor = null;
        for (const el of document.querySelectorAll('div, span, header, section')) {
            const t = (el.textContent || '').trim();
            if (!/在线观众|聊天室/.test(t) || t.length > 60) continue;
            if (!anchor || t.length < (anchor.textContent || '').trim().length) anchor = el;
        }
        let header = anchor;
        if (header) {
            for (let i = 0; i < 3 && header.parentElement; i++) header = header.parentElement;
            push('\n== 顶栏容器 outerHTML（最多 12000 字符）==');
            push((header.outerHTML || '').slice(0, 12000));
            push('\n== 顶栏内小尺寸元素（含坐标，最多 80 个）==');
            let n = 0;
            for (const el of header.querySelectorAll('*')) {
                const b = el.getBoundingClientRect();
                if (b.width < 6 || b.height < 6 || b.width > 200 || b.height > 200) continue;
                if (++n > 80) break;
                push(JSON.stringify({
                    tag: el.tagName, id: el.id,
                    cls: String(el.className || '').slice(0, 140),
                    e2e: el.getAttribute('data-e2e'), aria: el.getAttribute('aria-label'),
                    title: el.getAttribute('title'),
                    text: (el.textContent || '').trim().slice(0, 30),
                    rect: [b.left | 0, b.top | 0, b.width | 0, b.height | 0],
                    html: (el.outerHTML || '').slice(0, 320)
                }));
            }
        } else {
            push('未找到「在线观众」锚点，改列右半屏小按钮：');
            let n = 0;
            for (const el of document.querySelectorAll('button, [role="button"], [data-e2e]')) {
                const b = el.getBoundingClientRect();
                if (b.width < 6 || b.height < 6 || b.width > 140 || b.height > 140) continue;
                if (b.left < window.innerWidth * 0.5) continue;
                if (++n > 60) break;
                push(JSON.stringify({
                    tag: el.tagName, id: el.id,
                    cls: String(el.className || '').slice(0, 140),
                    e2e: el.getAttribute('data-e2e'), aria: el.getAttribute('aria-label'),
                    rect: [b.left | 0, b.top | 0, b.width | 0, b.height | 0],
                    html: (el.outerHTML || '').slice(0, 320)
                }));
            }
        }
        const text = lines.join('\n');
        try { console.log('[抖音优化] 聊天室顶栏 DOM\n' + text); } catch (e) {}
        copyText(text);
        showTip('已复制聊天室顶栏 DOM，直接粘贴给我即可', 2600);
    }
    window.__DY_OPT_DUMP_CHATROOM__ = dumpChatroomDOM;

    /* 派发到最内层 SVG：冒泡时会依次经过 svg / 外层 div / 更上层，
       无论 React 的 onClick 绑在哪一层都能命中；派发到 div 则只会覆盖外层。 */
    function fireToggleClick(btn) {
        const inner = btn.querySelector('svg') || btn;
        const r = inner.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return fireClick(btn);
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const base = {
            bubbles: true, cancelable: true, composed: true, view: window,
            button: 0, buttons: 1, clientX: cx, clientY: cy,
            screenX: cx, screenY: cy, detail: 1
        };
        const up = Object.assign({}, base, { buttons: 0 });
        try {
            if (typeof PointerEvent === 'function') {
                inner.dispatchEvent(new PointerEvent('pointerdown', Object.assign({}, base, {
                    pointerId: 1, pointerType: 'mouse', isPrimary: true
                })));
                inner.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, up, {
                    pointerId: 1, pointerType: 'mouse', isPrimary: true
                })));
            }
            inner.dispatchEvent(new MouseEvent('mousedown', base));
            inner.dispatchEvent(new MouseEvent('mouseup', up));
            inner.dispatchEvent(new MouseEvent('click', up));
            return true;
        } catch (e) {
            return fireClick(btn);
        }
    }

    let lastMiddleAction = 0;
    /* v9.20：中键在「本来就能打开新标签」的东西上要放行 —— 头像、用户名、
       链接、作者卡片。否则在别人头像上中键想开主页，会被我们拦掉并顺手开关
       一次评论区。判定不只看 a[href]，抖音很多头像/昵称是 div + 点击处理。 */
    const MIDDLE_PASS_SEL = 'a[href], [role="link"], ' +
        '[data-e2e*="avatar"], [data-e2e*="user"], [data-e2e*="author"], ' +
        '[data-e2e*="profile"], [data-e2e*="nickname"], [data-e2e*="account"], ' +
        '[class*="avatar"], [class*="Avatar"], [class*="nickname"], [class*="Nickname"]';

    function middleShouldPass(target) {
        if (!(target instanceof Element)) return false;
        if (target.closest(MIDDLE_PASS_SEL)) return true;
        /* 兜底：沿祖先链看有没有「像用户主页」的链接/属性，
           最多 6 层，避免把整个视频区域都算进去。 */
        let cur = target, d = 0;
        while (cur && d++ < 6) {
            if (cur.tagName === 'A' && (cur.getAttribute('href') || '').trim()) return true;
            const role = cur.getAttribute && cur.getAttribute('role');
            if (role === 'link') return true;
            const title = (cur.getAttribute && (cur.getAttribute('title') || '')) || '';
            const label = (cur.getAttribute && (cur.getAttribute('aria-label') || '')) || '';
            if (/主页|个人主页|头像|作者|@/.test(title + label)) return true;
            cur = cur.parentElement;
        }
        return false;
    }

    function handleMiddleClick(e) {
        if (!config.enableGestures) return;
        const now = Date.now();
        if (now - lastMiddleAction < 300) return;   // mousedown / auxclick 双通道去重
        if (e.target instanceof Element && e.target.closest(panelIgnore)) return;
        if (middleShouldPass(e.target)) return;     // 让浏览器按原生行为开新标签
        lastMiddleAction = now;
        e.preventDefault(); e.stopImmediatePropagation();
        if (isLivePage()) {
            const btn = findChatroomToggle();
            if (btn) fireToggleClick(btn);
            else showTip('未找到聊天室按钮 · 可在设置里「复制聊天室顶栏 DOM」', 2800);
        } else {
            tapKey('x', 'KeyX');
        }
    }

    document.addEventListener('mousedown', (e) => {
        if (!config.enableGestures) return;
        if (e.button === 1) { handleMiddleClick(e); return; }
        if (e.target instanceof Element && e.target.closest(gestureIgnore)) return;
        /* v9.24：弹层（个人主页 / 图片查看器）里长按不该触发 D 键旋转屏幕 */
        if (isLayeredUi(e.target)) return;
        /* v9.30：按住按钮 400ms 也不该被当成「长按画面」（会误触 D 旋转） */
        if (isInteractiveTarget(e.target)) return;

        startX = e.clientX; startY = e.clientY;
        isMouseDown = true; isSwiping = false; isLongPressing = false;

        // D 键「旋转屏幕」只在直播间有，长按手势在直播间一律不启用
        if (e.button === 0 && !isLivePage()) {
            longPressTimer = setTimeout(() => {
                if (isMouseDown && !isSwiping && !isLongPressing) {
                    isLongPressing = true;
                    suppressNextClick = true;
                    simulateKey('keydown', 'd', 'KeyD');
                }
            }, 400);
        }
    }, true);

    document.addEventListener('auxclick', (e) => {
        if (e.button === 1) handleMiddleClick(e);
    }, true);

    document.addEventListener('mousemove', (e) => {
        if (!config.enableGestures || !isMouseDown || isLongPressing || isSwiping) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (Math.abs(dx) <= 50 && Math.abs(dy) <= 50) return;
        // 左右滑动手势已移除：滑动只用于取消长按，不再合成 z / r 按键
        isSwiping = true;
        clearTimeout(longPressTimer);
    }, true);

    document.addEventListener('mouseup', (e) => {
        if (!config.enableGestures || !isMouseDown) return;
        if (e.button === 0) {
            clearTimeout(longPressTimer);
            if (isLongPressing) {
                simulateKey('keyup', 'd', 'KeyD');
                e.preventDefault(); e.stopPropagation();
            }
        }
        isMouseDown = false; isSwiping = false; isLongPressing = false;
        setTimeout(() => { suppressNextClick = false; }, 80);
    }, true);

    /* 窗口失焦时清理手势状态，避免 mouseup 丢失导致长按态残留 */
    window.addEventListener('blur', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
        if (isLongPressing) { try { simulateKey('keyup', 'd', 'KeyD'); } catch (e) {} }
        isMouseDown = false; isSwiping = false; isLongPressing = false;
        suppressNextClick = false;
    });

    /* click(detail>=2) 发生在 dblclick 之前，抖音若靠它点赞必须在这里拦掉，
       才能做到「开启双击全屏后取代原来的双击点赞」。
       v9.19.1：detail=1 也要拦 —— 抖音的单击画面是播放/暂停，第一击就会
       把视频暂停，等 dblclick 再恢复必然看到一次停顿。这里改成「延迟单击」：
       先吞掉，260ms 内没有第二击就手动补一次播放/暂停；有则整段取消。
       这样双击完全不触发单击效果，单击最多晚 260ms。 */
    /* v9.20.2：抖音的右键菜单没有 class / role（实测 <div id="EGfMOP99"> 下三个
       <div id="UizNwYcn"><div class="AdFei9o2">），选择器一个都命中不了。
       改为按几何 + 层级判断：祖先 7 层内有「absolute/fixed + z-index>=50 + 尺寸
       小于 560×560」的小浮层，就认为点在浮层上，不当成单击画面。 */
    function isOverlayClick(el) {
        let cur = el, d = 0;
        while (cur && cur !== document.body && d++ < 7) {
            let st;
            try { st = getComputedStyle(cur); } catch (e) { break; }
            if (st && (st.position === 'absolute' || st.position === 'fixed')) {
                const z = parseInt(st.zIndex, 10) || 0;
                if (z >= 50) {
                    let r = null;
                    try { r = cur.getBoundingClientRect(); } catch (e) {}
                    if (r && r.width > 20 && r.width < 560 && r.height > 20 && r.height < 560)
                        return true;
                }
            }
            cur = cur.parentElement;
        }
        return false;
    }

    /* v9.22：播放器内部的装饰层（xgplayer 的提示层 / 图标层 / 点赞动画容器）
       也是 absolute + 高 z-index + 小尺寸，会被 isOverlayClick 当成「浮层」
       直接放行 —— 第二击的 click 于是照样交给抖音，视频流的点赞特效就出来了。
       这里把「播放器盒子内部」排除在浮层判定之外：真正的右键菜单、通知气泡
       都在播放器盒子外面，不受影响。 */
    function insidePlayerBox(el) {
        return !!(el && el.closest && el.closest(
            '[id^="living_player_container"], .douyin-player, .xgplayer, ' +
            '[data-e2e="feed-active-video"], [data-e2e="video-player"]'));
    }

    /* v9.24：修「主页点 X 返回没反应」「评论图片下方放大镜点不动」。
       根因是 getPlayerContext 在目标没有播放器祖先时会退回到「当前正在播的视频」，
       于是任何落在视频矩形里的点击都被当成「单击画面」吞掉。
       个人主页弹层、评论图片查看器、视频详情页都盖在视频之上，它们的
       关闭按钮 / 缩放按钮 x/y 正好落在视频矩形里 —— 点一次被吞一次。
       这里补两条判定：目标在不在播放器壳里、目标在不在一个大弹层里。
       「在大弹层里、但不在播放器壳里」的点击一律放行。 */
    const SHELL_SEL = '[id^="living_player_container"], .douyin-player, .xgplayer, ' +
        '[data-e2e="feed-active-video"], [data-e2e="video-player"], #sliderVideo';

    function insideShell(el) {
        return !!(el && el.closest && el.closest(SHELL_SEL));
    }
    /* 覆盖大半屏的高层弹层：个人主页、图片查看器、视频详情、登录框 */
    function insideBigOverlay(el) {
        let cur = el, d = 0;
        while (cur && cur !== document.body && d++ < 14) {
            let st;
            try { st = getComputedStyle(cur); } catch (e) { break; }
            if (st && (st.position === 'fixed' || st.position === 'absolute')) {
                const z = parseInt(st.zIndex, 10);
                if (Number.isFinite(z) && z >= 100) {
                    let r = null;
                    try { r = cur.getBoundingClientRect(); } catch (e) {}
                    if (r && r.width >= window.innerWidth * 0.6 &&
                        r.height >= window.innerHeight * 0.6) {
                        /* 播放器自己（网页全屏 / 直播间容器）也可能是 fixed + 满屏，
                           这里排除掉：只要这层里面装着当前那块大视频，就不算弹层，
                           否则单击暂停、双击全屏会被误放行。 */
                        const v = findActiveVideo();
                        if (!v || !cur.contains(v)) return true;
                    }
                }
            }
            cur = cur.parentElement;
        }
        return false;
    }
    /* 弹层里的控件：不当单击画面、不当双击全屏的对象 */
    function isLayeredUi(el) {
        if (!el || !(el instanceof Element)) return false;
        if (insideShell(el)) return false;
        return insideBigOverlay(el);
    }

    /* v9.24：纯图标按钮（只有一个 SVG / IMG、没有文案、尺寸很小）不该被
       当成「单击画面」。详情页、个人主页、图片查看器里大量按钮都是这种
       div+svg 结构，既没有 class 关键词也没有 data-e2e，旧版一个都放行不了，
       于是「点 X 返回没反应」「图片放大镜点不动」。 */
    function isIconButton(el) {
        if (!el || !(el instanceof Element)) return false;
        try {
            let cur = el, d = 0;
            while (cur && cur !== document.body && d++ < 4) {
                const tag = cur.tagName;
                if (tag === 'VIDEO' || tag === 'CANVAS') return false;
                if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT') return true;
                const role = cur.getAttribute && cur.getAttribute('role');
                if (role === 'button' || role === 'link') return true;
                if (cur.querySelector && cur.querySelector(':scope > svg, :scope > img')) {
                    let r = null;
                    try { r = cur.getBoundingClientRect(); } catch (e) {}
                    const txt = ((cur.textContent || '') + '').trim();
                    if (r && r.width <= 76 && r.height <= 76 && txt.length <= 4) return true;
                }
                cur = cur.parentElement;
            }
        } catch (e) {}
        return false;
    }

    /* v9.30：判断「这一下点的是不是可交互控件」。
       旧版是「黑名单猜按钮」：靠 class 里有没有 button / menu / popup 这类词。
       抖音的 class 全是哈希（gZxYAuQb 之类），关注、分享、展开、标签页、
       评论输入框、连麦按钮的单击全被当成「点画面」吞掉了。
       现在换成正向信号，命中任一条就放行（不吞、不参与双击全屏）：
         · 语义标签 / role（button、a、input、contenteditable、menuitem…）
         · data-e2e / aria-label / title（抖音自己给可点元素打的标记）
         · computed cursor: pointer（抖音给按钮设的光标）
         · 自带 svg / img 图标
         · 自身带直接文本（按钮文案、标题、昵称）
       点 <video> / <canvas> 本身就是画面，直接返回 false（该吞就吞）。 */
    const INTERACTIVE_SEL = 'button, a, input, textarea, select, label, summary, option, ' +
        '[contenteditable="true"], [role="button"], [role="link"], [role="tab"], ' +
        '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], ' +
        '[role="switch"], [role="checkbox"], [role="radio"], [role="slider"], ' +
        '[role="dialog"], [role="combobox"], [role="textbox"], [role="tooltip"]';

    function isInteractiveTarget(el) {
        if (!(el instanceof Element)) return false;
        try {
            if (el.closest(INTERACTIVE_SEL)) return true;
            if (el.closest('#gm-settings-panel')) return true;
            let cur = el, d = 0;
            while (cur && cur !== document.body && d++ < 6) {
                const tag = cur.tagName;
                /* 画面本身就是画面：到这一层就停，别被上层的 cursor 骗了 */
                if (tag === 'VIDEO' || tag === 'CANVAS' || tag === 'PICTURE') return false;
                /* 只认「按钮量级」的盒子。播放器外面那层透明点击层同样带
                   data-e2e / cursor:pointer，尺寸却是整块画面 —— 它必须继续
                   往下走（当成点画面 → 暂停），否则单击暂停会被静默吃掉。 */
                let r = null;
                try { r = cur.getBoundingClientRect(); } catch (e) {}
                const small = !!(r && r.width && r.width <= 520 && r.height <= 220);
                if (!small) { cur = cur.parentElement; continue; }
                if (cur.hasAttribute && (cur.hasAttribute('data-e2e') ||
                        cur.hasAttribute('aria-label') || cur.hasAttribute('title')))
                    return true;
                let st = null;
                try { st = getComputedStyle(cur); } catch (e) {}
                /* cursor:pointer 是最靠谱的「这是按钮」信号；但播放器把整块画面
                   也设成 pointer（提示可点击），所以「本身就是画面容器」的祖先不算 */
                if (st && st.cursor === 'pointer' && !cur.matches(SHELL_SEL) &&
                    !(cur.querySelector && cur.querySelector('video'))) return true;
                if (cur.querySelector &&
                    cur.querySelector(':scope > svg, :scope > img, :scope > canvas')) return true;
                let own = '';
                for (const n of cur.childNodes) {
                    if (n.nodeType === 3) own += n.textContent;
                }
                if (own.trim()) return true;      // 自身带文案：按钮 / 标题 / 昵称
                /* 抖音的按钮多是 div > span 文案（「关注」「展开」「推荐」），
                   点在 padding 上时 target 是外层 div，文案在子节点里。
                   这里放宽一层：内部有短文案 + 盒子是按钮量级 → 算控件。 */
                const txt = (cur.textContent || '').trim();
                if (txt && txt.length <= 40) return true;
                cur = cur.parentElement;
            }
        } catch (e) {}
        return false;
    }

    let pendingSingle = null, pendingSingleTimer = null;
    function cancelPendingSingle() {
        if (pendingSingleTimer) { clearTimeout(pendingSingleTimer); pendingSingleTimer = null; }
        pendingSingle = null;
    }
    /* v9.35：单击接管按页面分开 —— 视频流用 clickPause，直播间用 clickPauseLive
       （默认关）。以前只有一个开关，一开直播间也跟着接管，很别扭。 */
    function clickPauseOn() {
        return isLivePage() ? !!config.clickPauseLive : !!config.clickPause;
    }
    function runPendingSingle() {
        pendingSingleTimer = null;
        const p = pendingSingle;
        pendingSingle = null;
        if (!p) return;
        // 260ms 内用户可能把开关关掉了，这时不该再切一次
        if (!clickPauseOn()) return;
        const v = (p.video && p.video.isConnected) ? p.video : findActiveVideo();
        if (!v) return;
        /* 抖音若在 pointerdown / pointerup 上自己切过了，我们再切一次就等于翻回来，
           表现就是「点了像没反应」。这里先比状态：跟点下去那一刻不一样 → 收手。 */
        if (typeof p.wasPlaying === 'boolean' && (!v.paused) !== p.wasPlaying) return;
        try {
            if (v.paused) v.play().catch(() => {});
            else v.pause();
        } catch (e) {}
    }

    /* v9.23：改挂 window 的 capture。捕获顺序是 window → document → 元素，
       挂在 document 时，抖音若把点赞/播放监听挂到 window capture（xgplayer、
       React 的根委托都可能），它会先执行，我们的 stopImmediatePropagation
       拦不住 —— 这就是「双击全屏成功、点赞也一起出」的原因。
       我们是 document-start 注入，window 上的监听天然排在页面脚本之前。 */
    window.addEventListener('click', (e) => {
        if (suppressNextClick) {
            suppressNextClick = false;
            e.preventDefault(); e.stopImmediatePropagation();
            return;
        }
        // 脚本自己派发的点击（菜单项 / 卡片入口 / 聊天室按钮）一律放行
        if (Date.now() < gmSynthClickUntil) return;
        /* v9.24：双击序列刚发生时（400ms 内）落在播放器上的后续 click 一并吞掉。
           抖音的点赞有可能在「第二击之后」才由 click 触发，只拦 detail>=2 会漏，
           表现就是「网页全屏成功、点赞也一起出」。 */
        if (Date.now() < likeShieldUntil && e.target instanceof Element &&
            !e.target.closest('#gm-settings-panel') && insideShell(e.target)) {
            e.preventDefault(); e.stopImmediatePropagation();
            return;
        }
        /* v9.21：单击画面 → 播放/暂停 单独一个开关；
           v9.35：视频流 / 直播间各一个开关（clickPause / clickPauseLive），
           双击全屏仍是另一个（doubleFullScreen），三者互不依赖。 */
        if (hotkeyCapturing) return;
        const takeClick = clickPauseOn();
        if (!config.doubleFullScreen && !takeClick) return;
        if (!(e.target instanceof Element) || e.target.closest(controlSelector)) return;
        /* v9.24：弹层（个人主页 / 图片查看器 / 视频详情）里的按钮不吃「单击画面」 */
        if (isLayeredUi(e.target)) return;
        /* v9.30：可交互控件一律放行（关注 / 分享 / 展开 / 标签页 / 评论框…）。
           旧版这里是一长串 class 关键词，遇到哈希 class 全失效，单击被大面吞掉。 */
        if (isInteractiveTarget(e.target)) return;
        /* 关闭 / 返回类控件特别放行：这类元素通常只有 aria-label、没有 class */
        if (e.target.closest('[data-e2e*="close"], [data-e2e*="back"], ' +
                '[aria-label*="关闭"], [aria-label*="返回"], [title*="关闭"], [title*="返回"]'))
            return;
        if (isOverlayClick(e.target) && !insidePlayerBox(e.target)) return;
        const ctx = getPlayerContext(e.target);
        if (!ctx || !pointInRect(e.clientX, e.clientY, ctx.rect)) return;

        if (e.detail === 1) {
            /* 本页不接管单击（视频流的 clickPause 关了，或直播间没开 clickPauseLive）：
               整下放行，交给抖音自己暂停/播放 —— 以前这里照样吞掉，
               于是「开关关着 = 点一下什么都不发生」。 */
            if (!takeClick) return;
            /* 接管：第一击先吞掉，260ms 后确认不是双击再切，避免双击前抖一下 */
            e.preventDefault(); e.stopImmediatePropagation();
            cancelPendingSingle();
            pendingSingle = {
                video: ctx.video, x: e.clientX, y: e.clientY, at: Date.now(),
                wasPlaying: !ctx.video.paused
            };
            pendingSingleTimer = setTimeout(runPendingSingle, 260);
            return;
        }
        if (e.detail >= 2) {
            if (!config.doubleFullScreen) return;
            e.preventDefault(); e.stopImmediatePropagation();
            cancelPendingSingle();
        }
    }, true);

    /* 第一击之后如果鼠标移开去点别处，就不该再补那次播放/暂停 */
    document.addEventListener('pointerdown', (e) => {
        if (!pendingSingle) return;
        if (Math.abs(e.clientX - pendingSingle.x) > 20 ||
            Math.abs(e.clientY - pendingSingle.y) > 20) cancelPendingSingle();
    }, true);

    /* =====================================================================
     * 7. 需要 JS 处理的功能
     * ===================================================================== */
    function walkText(root, limit, cb) {
        if (!root) return;
        let walker;
        try { walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false); }
        catch (e) { return; }
        let node, i = 0;
        while ((node = walker.nextNode()) !== null && i++ < limit) {
            if (cb(node) === false) break;
        }
    }

    /* ---- 7.1 MutationObserver ---- */
    let observer = null, pendingNodes = [], flushScheduled = false;
    /* v9.19：聊天室过滤改成「有变化才扫」。聊天室静止时每 1.5s 全量
       TreeWalker（上限 5000 文本）纯属空转；这里用新增节点+文本变化置脏，
       并保留 6 秒一次全量兜底。 */
    let chatDirty = true, chatFullAt = 0, chatRootCache = [], chatRootAt = 0;
    /* 通知气泡的判定词。v9.20.3 起气泡在 MutationObserver 里同步提权
       （见 liftBubbleNow），不再需要「置脏 → 等 180ms」。 */
    const NOTICE_WORD_RE = /合集有更新|有更新|更新了|新消息|条消息|通知|提醒/;

    function ensureObserver() {
        if (observer || !document.body) return;
        try {
            observer = new MutationObserver((records) => {
                if (document.hidden) return;
                /* v9.20.3：气泡的提权必须发生在「它第一次被绘制之前」。
                   MutationObserver 回调就在那个窗口里，所以这里同步做完，
                   不攒批、不 setTimeout、不等主循环。 */
                let bubbleChecks = 0;
                const tryBubble = (el) => {
                    if (!el || el.nodeType !== 1 || bubbleChecks >= 10) return;
                    bubbleChecks++;
                    if (liftBubbleNow(el)) return;
                    // 气泡常被包一层壳一起插入，壳本身文本过长会被跳过，往下试一层
                    if (el.childElementCount > 0) {
                        const kids = el.children;
                        for (let i = 0; i < kids.length && i < 6 && bubbleChecks < 10; i++) {
                            bubbleChecks++;
                            liftBubbleNow(kids[i]);
                        }
                    }
                };
                for (const r of records) {
                    for (const n of r.addedNodes) {
                        if (n.nodeType !== 1) continue;
                        tryBubble(n);
                        if (pendingNodes.length < 300) {
                            pendingNodes.push(n);
                            if (chatRootCache.length &&
                                chatRootCache.some(root => root.contains(n))) chatDirty = true;
                        }
                    }
                    // 文案可能被 React 原地改写而不新增节点，补一条 characterData 通道
                    if (r.type === 'characterData' && r.target) {
                        tryBubble(r.target.parentElement);
                        if (pendingNodes.length < 300) {
                            const t = ((r.target.nodeValue || '') + '').trim();
                            if (t && t.length < 80 &&
                                (POPUP_TRIGGER_RE.test(t) || PAUSE_TEXT_RE.test(t)) &&
                                r.target.parentElement) pendingNodes.push(r.target.parentElement);
                            if (t && chatRootCache.some(root => root.contains(r.target))) chatDirty = true;
                        }
                    }
                }
                if (!flushScheduled && pendingNodes.length) {
                    flushScheduled = true;
                    setTimeout(flushMutations, 180);
                }
            });
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        } catch (e) { observer = null; }
    }

    function flushMutations() {
        flushScheduled = false;
        const batch = pendingNodes;
        pendingNodes = [];
        safeRun(refreshSidebarRoot);
        safeRun(() => hideLivePopupsIn(batch, 600));
        safeRun(() => closePausePopup(batch));
        safeRun(muteGiftAudios);
        /* 气泡的即时提权已经在 MutationObserver 回调里同步做完（见 tryBubble），
           这里只做 class 命中与层级清理；全页文本兜底留给主循环。
           v9.20.3 之前的「noticeDirty → 180ms 后全页扫描」已删除：
           那 180ms 正是气泡先被压一帧再跳上去的来源。 */
        safeRun(() => liftSidebarOverlays(false, true));
    }

    /* ---- 7.2 屏蔽展馆 / 送礼浮窗 ---- */
    const POPUP_TRIGGER_RE = /点亮展馆|集星|助力主播|展馆|福袋|口令|抽奖|去送礼|送出了|送出|赠送|送给主播|点亮.*灯牌|加入.*粉丝团|\d+\s*s[^，。]{0,6}去送礼|去送礼[^\d]{0,4}\d+\s*s/;
    const POPUP_SKIP_SELECTOR = '.douyin-player-controls, .xgplayer-controls, ' +
        '[class*="danmaku"], [class*="barrage"], [class*="bullet"], ' +
        '[class*="chatroom"], [class*="chat-room"], [data-e2e*="chatroom"], #gm-settings-panel';
    const POPUP_SETTING_RE = /弹幕|设置|画质|清晰度|音量|倍速|全屏|分享|举报|反馈/;
    /* 「福袋 / 口令 / 抽奖」单独出现时**不是**推广浮窗：直播间的抢福袋入口、
       倒计时图标都带这些字，它们是有用功能，被当成浮窗隐藏就表现为
       「抢福袋的按钮/图标消失了」。只有同时带送礼/展馆类词时才可能是推广。 */
    const PROMO_STRONG_RE = /点亮展馆|集星|助力主播|展馆|去送礼|送出了|赠送|送给主播|灯牌|粉丝团/;
    const LUCKY_WORD_RE = /福袋/;
    const DIALOG_TEXT_SEL = 'input, textarea, [role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"]';

    /* v9.37.1 福袋硬保护：只要文本里出现「福袋」，又没有明确的送礼/展馆动作词，
       一律不隐藏。上一版靠「是否弹窗（含 input / dialog 类名）」二次确认，
       但抢福袋浮层的容器类名本身就带 dialog / modal，于是照样被隐藏 ——
       这就是「福袋图标还是没回来」的原因。宁可不屏蔽一个福袋口令浮窗，
       也不能把抢福袋入口干掉（聊天室那套「藏消息」的过滤 v9.41 已下线，现在只关弹幕）。 */
    function isLuckyProtected(el) {
        const t = el.textContent || '';
        if (t.indexOf('福袋') < 0) return false;
        return !PROMO_STRONG_RE.test(t.length > 600 ? t.slice(0, 600) : t);
    }

    function isPromoPopup(el) {
        const t = (el.textContent || '').trim().slice(0, 160);
        if (!t || t.length > 140 || !POPUP_TRIGGER_RE.test(t)) return false;
        // 弹幕设置 / 画质设置浮层必须放过（v9.1 一闪而过的问题）
        if (POPUP_SETTING_RE.test(t)) return false;
        /* 带「福袋」且无送礼强词 → 直接放过（抢福袋入口 / 倒计时 / 进度条） */
        if (LUCKY_WORD_RE.test(t) && !PROMO_STRONG_RE.test(t)) return false;
        /* 只靠「口令 / 抽奖」命中时，必须再确认它确实是推广弹窗，否则放过 */
        if (!PROMO_STRONG_RE.test(t)) {
            const isDialog = (el.matches && el.matches(DIALOG_TEXT_SEL)) ||
                el.querySelectorAll(DIALOG_TEXT_SEL).length > 0;
            if (!isDialog) return false;
        }
        // 弹幕设置面板同时带这两个开关名，绝不能被当成推广浮层隐藏掉
        if (t.indexOf('送礼信息') >= 0 && t.indexOf('福袋口令') >= 0) return false;
        // 聊天室里也常出现「送出了 / 福袋口令」，绝不能把整块聊天面板隐藏
        if (el.querySelectorAll('[class*="chat"], [class*="Chat"], [data-e2e*="chat"]').length > 2) return false;
        if (el.scrollHeight > el.clientHeight + 40) return false;
        return true;
    }

    let lastPopupFullScan = 0;
    function hideLivePopupsIn(nodes, limit) {
        if (!config.hideLivePopups || !isLivePage()) return;
        const containers = new Set();

        const consider = (el) => {
            if (!el || !el.isConnected || el === document.body || containers.has(el)) return;
            if (el.matches && el.matches(POPUP_SKIP_SELECTOR)) return;
            const st = window.getComputedStyle(el);
            if (st.position !== 'absolute' && st.position !== 'fixed') return;
            const r = el.getBoundingClientRect();
            if (r.width < 80 || r.width > 520 || r.height < 30 || r.height > 620) return;
            if (!isPromoPopup(el)) return;
            // 放过聊天列表 / 复杂面板；福袋口令浮层自带输入框，不再因 input 被排除
            if (el.querySelectorAll('[data-e2e]').length > 12) return;
            if (el.querySelector('[class*="setting"], [class*="Setting"]')) return;
            containers.add(el);
        };

        // 1) 新增节点及其父链
        for (const root of nodes) {
            if (!root || !root.isConnected) continue;
            consider(root);
            let p = root.parentElement, d = 0;
            while (p && p !== document.body && d++ < 5) { consider(p); p = p.parentElement; }
        }
        // 2) 周期全量扫描（定时器传 [document.body]；旧版在这里直接 continue，
        //    导致复用节点 / 纯文案变化的浮窗永远抓不到）
        //    v9.19：全量扫描降到 3 秒一次，DOM 有新增节点时由上面的增量路径补。
        const isFull = !nodes || !nodes.length || nodes.indexOf(document.body) >= 0;
        if (isFull) {
            const now = Date.now();
            if (now - lastPopupFullScan < 3000) return;
            lastPopupFullScan = now;
            const sel = '[role="dialog"], [class*="popup"], [class*="Popup"], [class*="modal"], ' +
                        '[class*="Modal"], [class*="toast"], [class*="Toast"], [class*="banner"], ' +
                        '[class*="Banner"], [class*="gift"], [class*="Gift"], [class*="lucky"], [class*="Lucky"]';
            const list = document.querySelectorAll(sel);
            for (let i = 0; i < list.length && i < 260; i++) consider(list[i]);
            walkText(document.body, limit || 3000, (node) => {
                const t = (node.nodeValue || '').trim();
                if (!t || t.length > 60 || !POPUP_TRIGGER_RE.test(t)) return;
                let p = node.parentElement, d = 0;
                while (p && p !== document.body && d++ < 6) { consider(p); p = p.parentElement; }
            });
        }
        containers.forEach(el => el.setAttribute('data-gm-popup-hidden', '1'));
        document.querySelectorAll('[data-gm-popup-hidden]').forEach(el => {
            if (!el.isConnected || !isPromoPopup(el)) el.removeAttribute('data-gm-popup-hidden');
        });
    }

    /* ---- 7.3 监听并关闭「长时间无操作，已暂停播放」弹窗 ----
     * 优先点「继续播放 / 我知道了」这类按钮（能真正恢复播放），
     * 没有按钮才隐藏弹窗并主动 play()。用可逆 data 属性，不污染源节点。 */
    const PAUSE_TEXT_RE = /长时间无操作|已暂停播放|暂停播放/;
    /* v9.21：只有这两句才是真的「长时间无操作」弹窗。原来的第三项「暂停播放」
       太宽 —— 任何带这三个字的浮层（包括我们自己的设置面板）都会被当成暂停
       弹窗，然后被无条件自动 play()，表现为「打开设置面板后视频自己动」。 */
    const PAUSE_BOX_RE = /长时间无操作|已暂停播放/;
    /* 我们自己的 UI 一律不参与弹窗识别：设置面板里就有「长时间无操作」字样，
       尺寸 320x548 又正好落在暂停弹窗的判定范围里。 */
    const GM_UI_SEL = '#gm-settings-panel, #gm-pause-diag';
    const PAUSE_BTN_RE = /继续播放|继续观看|恢复播放|我知道了|知道了|关闭|确定/;
    let lastPauseAction = 0;

    function closePausePopup(nodes) {
        if (!config.autoClosePausePopup) {
            document.querySelectorAll('[data-gm-pause-hidden]').forEach(el =>
                el.removeAttribute('data-gm-pause-hidden'));
            return;
        }
        const roots = [];
        if (nodes && nodes.length) {
            for (const n of nodes) {
                if (n && n.nodeType === 1 && n.isConnected && n !== document.body) roots.push(n);
            }
        }
        if (!roots.length && document.body) roots.push(document.body);

        const containers = new Set();
        let budget = 1800;
        for (const root of roots) {
            if (budget <= 0) break;
            // 我们自己的面板 / 诊断卡片永远不参与弹窗识别
            if (root.closest && root.closest(GM_UI_SEL)) continue;
            // 新增节点先做一次整块文本快筛，避免对 300 个节点各跑一遍 TreeWalker
            if (root !== document.body &&
                !PAUSE_TEXT_RE.test((root.textContent || '').slice(0, 400))) continue;
            const cap = root === document.body ? 2500 : Math.min(300, budget);
            budget -= cap;
            walkText(root, cap, (node) => {
                const t = (node.nodeValue || '').trim();
                if (!t || t.length > 80 || !PAUSE_TEXT_RE.test(t)) return;
                if (node.parentElement && node.parentElement.closest &&
                    node.parentElement.closest(GM_UI_SEL)) return;
                let p = node.parentElement, d = 0;
                while (p && p !== document.body && d++ < 7) {
                    if (p.closest && p.closest(GM_UI_SEL)) break;
                    const st = window.getComputedStyle(p);
                    const r = p.getBoundingClientRect();
                    if ((st.position === 'absolute' || st.position === 'fixed') &&
                        r.width > 180 && r.width < 800 && r.height > 50 && r.height < 600) {
                        /* 再确认这个容器本身说的是不是「长时间无操作 / 已暂停播放」。
                           只写「暂停播放」四个字的浮层（比如别家脚本的提示、
                           我们自己的说明文字）不再触发自动播放。 */
                        if (PAUSE_BOX_RE.test((p.textContent || '').slice(0, 240)))
                            containers.add(p);
                        break;
                    }
                    p = p.parentElement;
                }
            });
        }

        for (const box of containers) {
            let clicked = false;
            for (const b of box.querySelectorAll('button, [role="button"], a, [class*="btn"], [class*="Btn"]')) {
                if (!PAUSE_BTN_RE.test((b.textContent || '').trim())) continue;
                if (!isVisibleClickable(b)) continue;
                if (fireClick(b)) { clicked = true; break; }
            }
            if (clicked) { lastPauseAction = Date.now(); continue; }
            if (Date.now() - lastPauseAction < 4000) continue;
            lastPauseAction = Date.now();
            const v = findActiveVideo();
            if (v && v.paused) { try { v.play().catch(() => {}); } catch (e) {} }
            box.setAttribute('data-gm-pause-hidden', '1');
        }

        document.querySelectorAll('[data-gm-pause-hidden]').forEach(el => {
            if (!PAUSE_BOX_RE.test((el.textContent || '').slice(0, 300))) {
                el.removeAttribute('data-gm-pause-hidden');
            }
        });
    }

    /* ---- 7.4 侧栏通知 / hover 气泡被压在下层的修复 ----
     * 抖音常把提示气泡 portal 到 #root 内部，且祖先带低 z-index 层叠
     * 上下文；此时只给气泡本身提 z-index 是无效的，仍盖不过侧栏的 1001。
     * 因此：① class 命中不再要求 body 直接子元素；② 用 elementsFromPoint
     * 反查被侧栏压在下层的浮层；③ 沿祖先链把整个层叠上下文提权，
     * 但跳过全屏级容器，避免页面内容反过来盖住侧栏。 */
    const OVERLAY_SEL = '[class*="tooltip"], [class*="Tooltip"], [class*="popover"], ' +
        '[class*="Popover"], [class*="bubble"], [class*="Bubble"], [class*="tips"], ' +
        '[class*="Tips"], [class*="notice"], [class*="Notice"], [class*="badge"], ' +
        '[class*="Badge"], [class*="redPoint"], [class*="red-point"], ' +
        '[class*="toast"], [class*="Toast"], [class*="snackbar"], ' +
        '[class*="notification"], [class*="Notification"], ' +
        '[class*="alert"], [class*="Alert"], ' +
        '[role="tooltip"], [role="status"], [role="alert"], ' +
        '[data-e2e*="tooltip"], [data-e2e*="notice"], [data-e2e*="toast"]';
    const LIFT_Z = '2147483000';

    function liftChain(el, forceRelative) {
        let cur = el, hops = 0;
        while (cur && cur !== document.body && cur !== document.documentElement && hops++ < 8) {
            let st, r;
            try { st = window.getComputedStyle(cur); } catch (e) { break; }
            try { r = cur.getBoundingClientRect(); } catch (e2) { break; }
            if (!st || !r) break;
            // 全屏级容器绝不提权，否则整个页面内容会反过来盖住侧栏
            const big = r.width >= window.innerWidth * 0.85 ||
                        r.height >= window.innerHeight * 0.85;
            if (big) { cur = cur.parentElement; continue; }
            /* 层叠上下文不只由 positioned + z-index 创建。
               transform / opacity / filter / will-change / contain 的 static
               祖先同样会截断提权链（z-index 对 static 元素无效），这正是
               视频流气泡仍被压住、直播间气泡正常的结构差异所在。

               v9.20.3：气泡自己如果是 absolute/fixed，绝不改成 relative
               —— 那会把它从绝对定位点拉回文档流，视觉上就是气泡位置突变。
               祖先这一层本来就已经是绝对定位的包含块（transform 等都会建立
               包含块），补 relative 不会再改变子元素的定位基准，是安全的。 */
            const makesContext = st.position === 'static' && (
                (st.transform && st.transform !== 'none') ||
                (st.opacity && parseFloat(st.opacity) < 1) ||
                (st.filter && st.filter !== 'none') ||
                (st.willChange && st.willChange !== 'auto') ||
                (st.contain && st.contain !== 'none'));
            const needPos = makesContext ||
                (cur === el && forceRelative && st.position === 'static');
            if (needPos) cur.style.setProperty('position', 'relative', 'important');
            if (st.position !== 'static' || needPos)
                cur.style.setProperty('z-index', LIFT_Z, 'important');
            if (cur === el) {
                cur.style.setProperty('white-space', 'nowrap', 'important');
                cur.style.setProperty('max-width', 'none', 'important');
                cur.style.setProperty('overflow', 'visible', 'important');
            }
            cur = cur.parentElement;
        }
    }

    function isFloatBar(el, allowRelative) {
        if (!(el instanceof Element) || el === document.body ||
            el === document.documentElement) return false;
        if (sidebarRoot && sidebarRoot.contains(el)) return false;
        let r, st;
        try { r = el.getBoundingClientRect(); } catch (e) { return false; }
        if (r.width < 40 || r.width > 620 || r.height < 12 || r.height > 170) return false;
        try { st = window.getComputedStyle(el); } catch (e) { return false; }
        if (!st) return false;
        // static 内容块一律不碰：提权后页面内容会反过来盖住侧栏，比遮挡更糟。
        // 几何反查路径额外放行 relative / sticky（气泡经常只是 relative）。
        if (st.position === 'absolute' || st.position === 'fixed') return true;
        if (!allowRelative) return false;
        if (st.position === 'relative' || st.position === 'sticky') return true;
        /* v9.19.1：部分 hover 气泡是 static，只靠祖先 transform 定位，
           之前会被这里直接否掉，表现为「气泡又被侧栏压住」。几何路径
           尺寸已经卡过（40~620 × 12~170），再要求有文字或图标即可。 */
        return !!((el.textContent || '').trim()) ||
            !!el.querySelector('img, svg, [style*="background-image"]');
    }

    let lastNoticeScan = 0;

    /* v9.20.3：气泡必须「一出场就在最上层」，不能先被侧栏压一帧再跳上来。
       MutationObserver 的回调跑在下一次绘制之前的微任务里，所以在这条路径上
       同步提权，浏览器第一次画它时就已经是顶层层级，中间没有任何过渡帧。
       （用户明确说明可以为此牺牲性能，所以这里不再攒批、不再延迟 180ms。） */
    function bubbleBoxOf(start) {
        let cur = start, d = 0;
        while (cur && cur.nodeType === 1 && cur !== document.body && d++ < 5) {
            let r;
            try { r = cur.getBoundingClientRect(); } catch (e) { return null; }
            if (r.width >= 60 && r.width <= 620 && r.height >= 16 && r.height <= 120)
                return cur;
            cur = cur.parentElement;
        }
        return null;
    }
    function pinBubbleTop(box) {
        if (!box || !box.isConnected) return false;
        liftChain(box, true);
        box.classList.add('gm-bubble-top');
        const html = document.documentElement;
        if (!html.classList.contains('xydy-bubble-over'))
            html.classList.add('xydy-bubble-over');
        return true;
    }
    function liftBubbleNow(el) {
        if (!el || el.nodeType !== 1) return false;
        if (!sidebarEnabled()) return false;
        /* 大容器的 textContent 要拼接整棵子树，几千个节点的字符串一旦频繁
           触发就是明显的卡顿。通知气泡那点结构不会超过 60 个子元素。 */
        if (el.childElementCount > 60) return false;
        if (sidebarRoot && (el === sidebarRoot || sidebarRoot.contains(el))) return false;
        if (el.closest && el.closest('#gm-settings-panel')) return false;
        const t = (el.textContent || '').trim();
        if (!t || t.length > 80 || !NOTICE_WORD_RE.test(t)) return false;
        const box = bubbleBoxOf(el);
        if (!box) return false;
        return pinBubbleTop(box);
    }

    /* v9.19.2：www 的通知气泡压不过侧栏时，把它自己抬到 600，同时给 html
       加 xydy-bubble-over 把侧栏降到 500。气泡消失/断连后立即摘掉，
       侧栏恢复 1001。 */
    function syncBubbleLayer() {
        let alive = false;
        document.querySelectorAll('.gm-bubble-top').forEach(el => {
            /* 用「有没有渲染盒」判断可见性：刚插入的气泡在下一帧之前
               getBoundingClientRect 可能还是 0，用宽高判断会把它误摘掉，
               摘掉又提权就是一次可见的层级跳动。 */
            let vis = false;
            try { vis = el.isConnected && el.getClientRects().length > 0; } catch (e) {}
            if (!vis) {
                el.classList.remove('gm-bubble-top');
                return;
            }
            alive = true;
        });
        document.documentElement.classList.toggle('xydy-bubble-over', alive);
    }

    /* v9.20：侧栏隐藏时 rect 在屏外（transform 移走），用它判断气泡重叠
       会全部漏掉。这里按「显示位置」折算一个矩形，让侧栏滑入之前就能
       把气泡先抬上去，避免侧栏先压一下再浮起来的跳变。 */
    function sidebarShownRect(live) {
        const w = live.width || 164;
        const h = live.height || 0;
        const top = Math.max(0, (window.innerHeight - h) / 2);
        return { left: 4, right: 4 + w, top: top, bottom: top + h, width: w, height: h };
    }

    function liftSidebarOverlays(forceNotice, light) {
        if (!document.body) return;
        syncBubbleLayer();
        if (!sidebarEnabled() || !sidebarRoot || !sidebarRoot.isConnected) return;
        const live = sidebarRoot.getBoundingClientRect();
        const hidden = document.documentElement.classList.contains('xydy-sidebar-hidden');
        const sr = hidden ? sidebarShownRect(live) : live;
        if (!sr.width || sr.width < 40 || !sr.height) return;
        let lifted = 0;

        // ① class 命中：贴近侧栏右缘的小浮层就提权
        const byClass = document.querySelectorAll(OVERLAY_SEL);
        for (let i = 0; i < byClass.length && i < 200; i++) {
            const el = byClass[i];
            if (!isFloatBar(el, false)) continue;
            const r = el.getBoundingClientRect();
            if (r.right < sr.right - 40 || r.left > sr.right + 160) continue;
            if (r.bottom < sr.top || r.top > sr.bottom) continue;
            liftChain(el, false); lifted++;
        }

        // ② 几何反查：负 dx 采样侧栏内部，气泡左半常常正压在侧栏下面
        /* v9.19：网格采样每次 84 个点、每个点都强制布局；只有鼠标确实在
           左侧（气泡才可能出现）时才做，平时只走上面的 class 命中。 */
        /* v9.20.1：这里退回 v9.18 的「侧栏可见就扫」。
           v9.19 加的 sidebarPointerNear 限制是回归源 —— 「收藏的合集有更新」
           这类气泡是自动弹出的，鼠标不在左侧，于是几何反查整轮被跳过，
           气泡就被侧栏压住。侧栏隐藏时扫了也没意义，所以用它当开关。 */
        if (!light && typeof document.elementsFromPoint === 'function' && !hidden) {
            const step = Math.max(26, sr.height / 14);
            for (let dy = 16; dy < sr.height - 8 && lifted < 40; dy += step) {
                for (const dx of [-24, -8, 6, 26, 54, 90]) {
                    const x = sr.right + dx, y = sr.top + dy;
                    if (x < 2 || x > window.innerWidth - 2 || y < 0 || y > window.innerHeight - 2) continue;
                    let stack;
                    try { stack = document.elementsFromPoint(x, y); } catch (e) { continue; }
                    if (!stack || !stack.length) continue;
                    let bar = -1;
                    for (let i = 0; i < stack.length; i++) {
                        if (stack[i] === sidebarRoot || sidebarRoot.contains(stack[i])) { bar = i; break; }
                    }
                    if (bar < 0) continue;
                    for (let i = bar + 1; i < Math.min(stack.length, bar + 6); i++) {
                        const el = stack[i];
                        if (!isFloatBar(el, true)) continue;
                        liftChain(el, true); lifted++;
                    }
                }
            }
        }

        /* ③ www 专属：通知气泡经常 portal 到带 transform/opacity 的祖先里，
           既没有可识别的 class，也不在 elementsFromPoint 的采样行上命中。
           按「短通知文案 + 贴在侧栏右缘 + 尺寸像气泡」反查并提权。
           v9.19：全页 6000 文本的兜底降到 5 秒一次，通知气泡不会 1.5s 内
           反复出现，没必要每轮重扫。 */
        /* v9.20.2：回到 9.18 的节奏 —— 侧栏可见时每轮都扫。
           「收藏的合集有更新」可能自动弹出，鼠标不在左侧也要能及时提权。 */
        if (!light && !isLiveHost && typeof document.createTreeWalker === 'function' &&
            (forceNotice || Date.now() - lastNoticeScan > 1200)) {
            lastNoticeScan = Date.now();
            const NOTICE_RE = NOTICE_WORD_RE;
            const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
            let w;
            try { w = document.createTreeWalker(document.body, SHOW_TEXT); }
            catch (e) { w = null; }
            let node, guard = 0;
            while (w && (node = w.nextNode()) && guard++ < 6000 && lifted < 40) {
                const t = (node.nodeValue || '').trim();
                if (!t || t.length > 40 || !NOTICE_RE.test(t)) continue;
                let box = node.parentElement, d = 0;
                while (box && d++ < 4) {
                    let r;
                    try { r = box.getBoundingClientRect(); } catch (e) { break; }
                    if (r.width >= 60 && r.width <= 620 &&
                        r.height >= 16 && r.height <= 120 &&
                        r.left < sr.right + 20 && r.right > sr.right - 130 &&
                        r.bottom > sr.top && r.top < sr.bottom) {
                        liftChain(box, true);
                        // 直接抬到 600，并让侧栏临时降到 500（见 CSS）
                        box.classList.add('gm-bubble-top');
                        lifted++; break;
                    }
                    box = box.parentElement;
                }
            }
        }
    }

    /* =====================================================================
     * 7.4b 直播间侧的三件事：
     *  ① live 顶栏搜索框居中（运行时测量 + translate，不动顶栏布局）
     *  ② 屏蔽「送礼信息 / 福袋口令」= 弹幕设置面板里的两个 Checkbox
     *  ③ 直播间默认最高画质 = localStorage/cookie + qualityHandler
     * ===================================================================== */
    function dyReactProps(el) {
        try {
            const k = Object.keys(el).find(x => x.indexOf('__reactProps$') === 0);
            return k ? el[k] : null;
        } catch (e) { return null; }
    }
    function dyReactFiber(el) {
        try {
            const k = Object.keys(el).find(x =>
                x.indexOf('__reactFiber$') === 0 ||
                x.indexOf('__reactInternalInstance$') === 0);
            return k ? el[k] : null;
        } catch (e) { return null; }
    }

    /* ---- ① live 搜索框居中 ---- */
    const SUPPORTS_TRANSLATE = !!(window.CSS && CSS.supports &&
        CSS.supports('translate', '10px 0px'));
    let searchBoxEl = null, searchShift = 0;
    function clearSearchShift() {
        if (searchBoxEl) {
            try {
                searchBoxEl.style.removeProperty('translate');
                searchBoxEl.removeAttribute('data-gm-search-shift');
            } catch (e) {}
        }
        searchBoxEl = null; searchShift = 0;
    }
    function findSearchBox() {
        const inputs = document.querySelectorAll(
            'input[placeholder*="搜索"], input[type="search"], ' +
            '[data-e2e*="search"] input, input[data-e2e*="search"]');
        for (const input of inputs) {
            const ir = input.getBoundingClientRect();
            if (ir.top < -20 || ir.top > 140 || ir.width < 80) continue;
            let el = input, best = null, d = 0;
            while (el && d++ < 8) {
                const r = el.getBoundingClientRect();
                if (r.top >= -20 && r.top < 140 &&
                    r.width >= 250 && r.width <= 900 &&
                    r.height >= 24 && r.height <= 130) best = el;
                el = el.parentElement;
            }
            if (best) return best;
        }
        return null;
    }
    function applySearchCenter() {
        if (!SUPPORTS_TRANSLATE || !config.liveCenterSearch ||
            !isLiveHost || !html.classList.contains('xydy-sidebar-on') ||
            document.fullscreenElement) {
            clearSearchShift(); return;
        }
        const box = findSearchBox();
        if (!box) { clearSearchShift(); return; }
        if (searchBoxEl && searchBoxEl !== box) clearSearchShift();
        const r = box.getBoundingClientRect();
        const rawCenter = r.left + r.width / 2 - searchShift;
        let shift = Math.round(window.innerWidth / 2 - rawCenter);
        if (!Number.isFinite(shift) || Math.abs(shift) > window.innerWidth * 0.35) shift = 0;
        const cur = box.style.getPropertyValue('translate') || '';
        if (Math.abs(shift - searchShift) < 2 && cur.indexOf(shift + 'px') === 0) return;
        searchBoxEl = box; searchShift = shift;
        box.setAttribute('data-gm-search-shift', String(shift));
        box.style.setProperty('translate', shift + 'px 0px', 'important');
    }

    /* ---- ② 弹幕设置面板：关掉「送礼信息」「福袋口令」两个开关 ----
       之前一直去隐藏聊天室消息行 / 浮层，方向错了：抖音自己就有这两个
       开关，在 [data-e2e="danmaku-setting-icon"] 的 hover 面板里。
       用 React props 的 onMouseEnter 弹面板 → 找文案 span 的相邻
       Checkbox → 从 fiber 里取 checked / onClick → 只在已开启时点掉。 */
    const danmakuDone = { gift: false, lucky: false };
    let danmakuBusy = false, danmakuLastUrl = '';
    let danmakuCooldownUntil = 0, danmakuAttempts = 0, danmakuNote = 'idle';
    const DANMAKU_LABEL = { gift: '送礼信息', lucky: '福袋口令' };
    const danmakuWeak = { gift: 0, lucky: 0 };   // 颜色推导出的「已关闭」需二次确认
    const SWITCH_SEL = '[role="switch"], [aria-checked], input[type="checkbox"], ' +
        '[class*="switch"], [class*="Switch"], [class*="checkbox"], [class*="Checkbox"]';

    function inOurPanel(el) {
        return !!(el && el.closest && el.closest('#gm-settings-panel'));
    }
    function rectOf(el) {
        try { return el.getBoundingClientRect(); } catch (e) { return null; }
    }
    /* 只找文案本身，严格匹配，排除我们自己的设置面板。 */
    function findDanmakuLabelEl(label) {
        const nodes = document.querySelectorAll('span, div, label');
        let fallback = null;
        for (let i = 0; i < nodes.length && i < 3000; i++) {
            const el = nodes[i];
            if (inOurPanel(el) || el.children.length > 2) continue;
            const t = (el.textContent || '').trim();
            if (!(t === label || (t.indexOf(label) >= 0 && t.length <= label.length + 2)))
                continue;
            // 父容器的 textContent 往往也是同一个词，但叶子节点几何最准
            if (el.children.length === 0) return el;
            if (!fallback) fallback = el;
        }
        return fallback;
    }
    /* 按几何配对开关。v9.47 诊断实测的结构：
         文案 <span class="FTgH60Qj"> rect=1299,920,48,20
         行容器 <div class="tvFMszYY"> rect=1299,912,222,36
         开关     <div class="">            rect=1491,921,30,18   ← 两个哈希 class 的 div，
                                                                    既没有 role=switch，
                                                                    也不是 checkbox
       所以「先找行容器、再取容器里最右那个像开关的」比全局扫描稳：
       行容器把范围限死在一行内，不会跨行抢到相邻开关。
       全局扫描保留作兜底（行容器结构再变时还能用）。 */
    function findDanmakuSwitch(label, used) {
        const lab = findDanmakuLabelEl(label);
        if (!lab) { danmakuNote = 'no-label:' + label; return null; }
        const lr = rectOf(lab);
        if (!lr || (lr.width === 0 && lr.height === 0)) {
            danmakuNote = 'label-hidden:' + label; return null;
        }
        const lcy = (lr.top + lr.bottom) / 2;
        /* 像不像开关：比文案窄很多、在同一水平线上、整体在文案右侧 */
        const usable = (el) => {
            if (!el || inOurPanel(el) || (used && used.has(el))) return false;
            const r = rectOf(el);
            if (!r || r.width < 16 || r.width > 96 || r.height < 8 || r.height > 56) return false;
            if (Math.abs((r.top + r.bottom) / 2 - lcy) > 26) return false;
            if (r.left < lr.right - 8) return false;
            return true;
        };

        /* ① 行容器：从文案往上找第一个「高度 24~64、宽度明显大于文案」的块 */
        let row = lab.parentElement, depth = 0;
        while (row && depth++ < 6) {
            const rr = rectOf(row);
            if (rr && rr.height >= 24 && rr.height <= 64 && rr.width >= lr.width * 1.6) break;
            row = row.parentElement;
        }
        let best = null;
        if (row && depth <= 6) {
            let rightEdge = -Infinity;
            let kids;
            try { kids = row.querySelectorAll('*'); } catch (e) { kids = []; }
            for (const el of kids) {
                if (!usable(el)) continue;
                const r = rectOf(el);
                if (r.right > rightEdge) { rightEdge = r.right; best = el; }
            }
        }
        /* ② 兜底：全局找（行容器没认出来时） */
        if (!best) {
            let bestScore = Infinity;
            const switches = document.querySelectorAll(SWITCH_SEL);
            for (let i = 0; i < switches.length && i < 300; i++) {
                const sw = switches[i];
                if (inOurPanel(sw) || (used && used.has(sw))) continue;
                const r = rectOf(sw);
                if (!r || r.width < 14 || r.width > 90 || r.height < 8 || r.height > 56) continue;
                const dy = Math.abs((r.top + r.bottom) / 2 - lcy);
                if (dy > 20 || r.left < lr.left - 10) continue;
                const score = dy + Math.max(0, r.left - lr.left) * 0.06;
                if (score < bestScore) { bestScore = score; best = sw; }
            }
        }
        if (!best) {
            let bestScore = Infinity;
            const all = document.querySelectorAll('div, span, button, label, i');
            for (let i = 0; i < all.length && i < 4000; i++) {
                const c = all[i];
                if (inOurPanel(c) || (used && used.has(c))) continue;
                if ((c.textContent || '').trim()) continue;
                const r = rectOf(c);
                if (!r || r.width < 18 || r.width > 80 || r.height < 10 || r.height > 46) continue;
                const dy = Math.abs((r.top + r.bottom) / 2 - lcy);
                if (dy > 20) continue;
                const dx = r.left - lr.right;
                if (dx < -30 || dx > 500) continue;
                const score = dy + Math.abs(dx) * 0.08;
                if (score < bestScore) { bestScore = score; best = c; }
            }
        }
        danmakuNote = best ? 'sw-found:' + label : 'no-switch:' + label;
        return best;
    }
    /* 抖音开关开启态是红色 #fe2c55，关闭态是深灰。fiber / aria / class
       都拿不到 checked 时用颜色兜底。 */
    function looksOnByColor(el) {
        let c = '';
        try { c = window.getComputedStyle(el).backgroundColor || ''; } catch (e) {}
        const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
        if (!m) return undefined;
        const r = +m[1], g = +m[2], bl = +m[3];
        if (r > 140 && r > g * 1.45 && r > bl * 1.25) return true;
        if (Math.abs(r - g) < 18 && Math.abs(g - bl) < 18 && r < 130) return false;
        return undefined;
    }
    function dyCheckboxHandler(el) {
        const out = { checked: undefined, onClick: null, explicit: false };
        let f = dyReactFiber(el), d = 0;
        while (f && d++ < 12) {
            const p = f.memoizedProps;
            if (p) {
                if (typeof p.checked === 'boolean' && out.checked === undefined) {
                    out.checked = p.checked; out.explicit = true;
                }
                if (typeof p.onClick === 'function' && !out.onClick)
                    out.onClick = p.onClick;
            }
            f = f.child || f.return;
        }
        if (out.checked === undefined) {
            const a = el.getAttribute && el.getAttribute('aria-checked');
            if (a === 'true' || a === 'false') {
                out.checked = a === 'true'; out.explicit = true;
            }
        }
        if (out.checked === undefined) {
            const cl = String(el.className || '');
            if (/(^|[-_ ])(checked|active|open|on)([-_ ]|$)/i.test(cl)) out.checked = true;
            else if (/(^|[-_ ])(unchecked|off|closed)([-_ ]|$)/i.test(cl)) out.checked = false;
        }
        if (out.checked === undefined) out.checked = looksOnByColor(el);
        if (out.checked === undefined && el.querySelectorAll) {
            const kids = el.querySelectorAll('*');
            for (let i = 0; i < kids.length && i < 8; i++) {
                const c = looksOnByColor(kids[i]);
                if (c !== undefined) { out.checked = c; break; }
            }
        }
        return out;
    }
    function dyFireClick(el) {
        try {
            const init = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('pointerdown', init));
            el.dispatchEvent(new MouseEvent('mousedown', init));
            el.dispatchEvent(new MouseEvent('mouseup', init));
            el.dispatchEvent(new MouseEvent('click', init));
        } catch (e) {}
        try { el.click(); } catch (e2) {}
        return true;
    }
    /* v9.47：点完必须复查。
       抖音这两个开关是「两个哈希 class 的 div」，fiber 上能拿到的 onClick 有可能是
       整行容器的（点了只展开、不切换），所以「点了没关」这种事只能靠结果判断：
       点完记时间，600ms 后重新读一次 checked，还是 true 就放开标记重点，
       最多 3 次，第二次改用 fiber 的 onClick。 */
    const danmakuClickAt = { gift: 0, lucky: 0 };
    const danmakuRetry = { gift: 0, lucky: 0 };
    function turnOffDanmaku(key, used) {
        const label = DANMAKU_LABEL[key];
        const sw = findDanmakuSwitch(label, used);
        if (!sw) return false;
        if (used) used.add(sw);           // 同一轮里该开关不再被另一个文案占用
        const h = dyCheckboxHandler(sw);
        if (h.checked === false) {
            /* 颜色 / class 推出来的「已关闭」不够可靠——很可能抢到了相邻
               已点灰的开关。只有 fiber / aria 明确给出 false 才直接认定。 */
            if (!h.explicit) {
                danmakuWeak[key]++;
                if (danmakuWeak[key] < 2) {
                    danmakuNote = 'weak-off:' + label; return false;
                }
            }
            danmakuDone[key] = true; danmakuNote = 'already-off:' + label; return true;
        }
        if (h.checked !== true) { danmakuNote = 'unknown-state:' + label; return false; }
        /* 第一次用真实点击（走 React 事件系统，命中的就是开关自己）；
           复查发现没关掉时才改用 fiber 上的 onClick 再来一次。 */
        if (danmakuRetry[key] > 0 && h.onClick) {
            try {
                h.onClick();
                danmakuDone[key] = true; danmakuClickAt[key] = Date.now();
                danmakuNote = 'fiber-click:' + label;
                return true;
            } catch (e) { danmakuNote = 'fiber-throw:' + label; }
        }
        dyFireClick(sw);
        danmakuDone[key] = true;
        danmakuClickAt[key] = Date.now();
        danmakuNote = 'dom-click:' + label;
        return true;
    }
    /* 复查：上一次点击已经把 done 置真，但开关实际还开着 → 打回重试 */
    function verifyDanmakuOff(key) {
        if (!danmakuDone[key] || !danmakuClickAt[key]) return;
        if (Date.now() - danmakuClickAt[key] < 600) return;
        const label = DANMAKU_LABEL[key];
        const keep = danmakuNote;            // findDanmakuSwitch 会写 note，别污染
        const sw = findDanmakuSwitch(label, null);
        if (!sw) { danmakuNote = keep; return; }
        const h = dyCheckboxHandler(sw);
        if (h.checked !== true) { danmakuNote = keep; return; }   // 读不出 / 已关完事
        if (danmakuRetry[key] >= 4) {
            /* 反复点了还是开着：放弃本轮，别再每隔 1.5s 把面板弹出来烦人。
               换直播间（URL 变）会自动重置。 */
            danmakuDone[key] = true;
            danmakuNote = 'give-up:' + label;
            return;
        }
        danmakuDone[key] = false;
        danmakuRetry[key]++;
        danmakuCooldownUntil = 0;            // 别让 25s 冷却挡住重试
        danmakuNote = 'still-on:' + label + ' retry ' + danmakuRetry[key];
    }
    function openDanmakuPanel(icon, props) {
        try { if (typeof props.onMouseEnter === 'function') props.onMouseEnter(); } catch (e) {}
        // React 的 onMouseEnter 由 mouseover 合成；只调 props 在部分版本不弹面板
        try {
            icon.dispatchEvent(new MouseEvent('mouseover', {
                bubbles: true, cancelable: true, view: window, relatedTarget: document.body
            }));
        } catch (e) {}
        try { icon.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: window })); }
        catch (e) {}
    }
    function closeDanmakuPanel(icon, props) {
        try { if (typeof props.onMouseLeave === 'function') props.onMouseLeave(); } catch (e) {}
        try {
            icon.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
            icon.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
            if (icon.parentElement)
                icon.parentElement.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
        } catch (e) {}
    }
    function applyDanmakuSettings() {
        if (!isLivePage() || danmakuBusy) return;
        /* v9.41：这里是**唯一**的弹幕屏蔽手段 —— 直接去点抖音弹幕设置里的
           「送礼信息」「福袋口令」两个开关。默认不开，在「界面清理 → 特效与弹幕」里打开。 */
        if (!config.danmakuSwitchOff) return;
        if (location.href !== danmakuLastUrl) {
            danmakuLastUrl = location.href;
            danmakuDone.gift = false; danmakuDone.lucky = false;
            danmakuAttempts = 0; danmakuCooldownUntil = 0; danmakuNote = 'idle';
            danmakuWeak.gift = 0; danmakuWeak.lucky = 0;
            danmakuRetry.gift = 0; danmakuRetry.lucky = 0;
            danmakuClickAt.gift = 0; danmakuClickAt.lucky = 0;
        }
        /* v9.41：聊天室的 DOM 过滤下线后，这两项只看 danmakuSwitchOff 本身
           （上面已经 early return 过了，走到这里就是要关这两个开关）。
           以前它们依赖 hideGiftMsg / hideLuckyBag，那两个键删掉后会变成永远 false，
           这个功能就整个失效了。 */
        /* v9.47：以为两个都关掉了，也先复查一遍再收工 —— 点完不一定会变 */
        verifyDanmakuOff('gift');
        verifyDanmakuOff('lucky');
        const needGift = !danmakuDone.gift;
        const needLucky = !danmakuDone.lucky;
        if (!needGift && !needLucky) return;
        // 冷却 25s 后可继续；单房间最多 30 轮（含 v9.47 的复查重试）
        if (Date.now() < danmakuCooldownUntil || danmakuAttempts >= 30) return;
        const icon = document.querySelector('[data-e2e="danmaku-setting-icon"]');
        if (!icon) { danmakuNote = 'no-icon'; return; }
        const props = dyReactProps(icon);
        if (!props || typeof props.onMouseEnter !== 'function') {
            danmakuNote = 'no-props'; return;
        }
        danmakuBusy = true; danmakuAttempts++;
        openDanmakuPanel(icon, props);
        const used = new Set();           // 每个开关本轮只归属一个文案
        let tries = 0;
        const timer = setInterval(() => {
            tries++;
            // 福袋口令先配对，避免被送礼信息抢走同行的开关
            if (needLucky && !danmakuDone.lucky) turnOffDanmaku('lucky', used);
            if (needGift && !danmakuDone.gift) turnOffDanmaku('gift', used);
            const done = (!needGift || danmakuDone.gift) && (!needLucky || danmakuDone.lucky);
            if (done || tries > 24) {
                clearInterval(timer);
                closeDanmakuPanel(icon, props);
                danmakuBusy = false;
                if (!done) danmakuCooldownUntil = Date.now() + 25000;
            }
        }, 150);
    }

    /* ---- ③ 直播间默认最高画质 ----
     * v9.24：旧版有两个硬伤 ——
     *  ① 只认 [data-e2e="quality-selector"] 一个锚点，改版换个名字整条链路就废；
     *  ② DOM 兜底「点任意文本为『原画』的叶子」分不清「弹出的菜单项」和
     *     「控制栏上显示当前画质的标签」。点到标签只是又开一次菜单，代码却
     *     立刻把 qualityDone 置真，永不重试 —— 表现就是「选了最高画质没生效」。
     * 现在：锚点候选化 → 先读当前档位（已是原画/蓝光就直接收工）→ fiber 直调
     * setCurrentQuality → 菜单项必须处在浮层里、按档位排序取最高 → 点完复查。 */
    const QUALITY_SIGN = { auto: 0, ld: 1, sd: 2, hd: 3, uhd: 4, origin: 5 };
    const QUALITY_RANK = { '流畅': 1, '标清': 2, '高清': 3, '超清': 4, '蓝光': 5, '原画': 6 };
    /* v9.40：直播档位等级（1~5，原画最高）。入参可以是播放器标识
       （origin/uhd/hd/sd/ld），也可以是中文档位名。两套写法按同一高低顺序对齐，
       这样「选蓝光」在 handler 路径（只有标识）和 DOM 路径（只有文案）里都能判。 */
    const LIVE_TEXT_LEVEL = [
        [/原画/, 5], [/蓝光/, 4], [/超清/, 3], [/高清/, 2], [/标清/, 1], [/流畅/, 0]
    ];
    function liveLevelOf(x) {
        const s = String(x == null ? '' : x).trim();
        if (!s || s === 'auto') return 0;
        const low = s.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(QUALITY_SIGN, low)) return QUALITY_SIGN[low];
        for (const p of LIVE_TEXT_LEVEL) if (p[0].test(s)) return p[1];
        return 0;
    }
    function liveTargetLevel() {
        for (const t of LIVE_QUALITY_TARGETS) if (t[0] === config.liveQualityTarget) return t[2];
        return 5;
    }
    function liveTargetId() {
        for (const t of LIVE_QUALITY_TARGETS) if (t[0] === config.liveQualityTarget) return t[0];
        return 'origin';
    }
    function liveTargetName() {
        for (const t of LIVE_QUALITY_TARGETS) if (t[0] === config.liveQualityTarget) return t[1];
        return '原画';
    }
    /* 新版档位文案带分辨率后缀：「高清 1080P」「超清 4K」「标清 720P」 */
    const QUALITY_TEXT_RE = /^(原画|蓝光(\s*\d{3,4}\s*[PpMm]?)?|超清|高清|标清|流畅)(\s*\d{3,4}\s*[PpMm]|\s*[248]\s*[Kk]|\s*HDR)?$/;
    const QUALITY_SEL = '[data-e2e="quality-selector"], [data-e2e*="quality"], ' +
        '[data-e2e*="clarity"], [aria-label*="清晰度"], [aria-label*="画质"], ' +
        '[title*="清晰度"], [title*="画质"]';
    const QUALITY_SEL_LOOSE = '[class*="quality"], [class*="Quality"], ' +
        '[class*="clarity"], [class*="Clarity"]';
    let qualityDone = false, qualityLastUrl = '';
    let qualityDomCooldown = 0, qualityDomTries = 0;
    let qualityNote = 'idle';
    /* v9.28：进房间后画质切换偏慢 —— 常规定时器是 1.5s 一轮，而 DOM 兜底还要
       「先悬停开菜单、下一轮再点菜单项」，切一档要 3 秒以上。这里加一段
       「爆发期」：URL 变化 / 首次加载后 8 秒内按 400ms 连打，内部冷却压到 600ms，
       切到原画（qualityDone）就自动停，之后回到常规节奏。 */
    let qualityBurstUntil = 0, qualityBurstTimer = null;
    function kickQualityBurst(ms) {
        if (liveTargetLevel() <= 0) return;      // v9.40：智能档 = 不干预，不用连点
        qualityBurstUntil = Date.now() + (ms || 8000);
        if (qualityBurstTimer) return;
        qualityBurstTimer = setInterval(() => {
            if (Date.now() > qualityBurstUntil || qualityDone) {
                clearInterval(qualityBurstTimer);
                qualityBurstTimer = null;
                return;
            }
            if (document.hidden || !(isLiveHost || isLivePage())) return;
            safeRun(applyMaxQuality);
        }, 400);
    }
    function dySetCookie(name, value) {
        try {
            document.cookie = name + '=' + encodeURIComponent(value) +
                '; path=/; domain=.douyin.com; max-age=31536000';
        } catch (e) {}
    }

    /* 控制栏里那种画质小按钮；不要整个播放器容器。
       先查精确属性，一个都查不到才退到 class 模糊匹配（后者在大页面里很贵）。 */
    function qualityAnchorEls() {
        const out = [];
        const add = (el) => {
            if (!el || out.indexOf(el) >= 0) return;
            if (el.closest('#gm-settings-panel')) return;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { return; }
            if (r.width < 10 || r.height < 8 || r.width > 280 || r.height > 120) return;
            out.push(el);
        };
        for (const el of document.querySelectorAll(QUALITY_SEL)) {
            add(el);
            if (out.length >= 8) break;
        }
        if (!out.length) {
            let n = 0;
            for (const el of document.querySelectorAll(QUALITY_SEL_LOOSE)) {
                add(el);
                if (out.length >= 8 || ++n > 400) break;
            }
        }
        return out;
    }
    function qualityLabel(el) {
        const t = ((el.innerText || el.textContent || '') + '').trim();
        if (QUALITY_TEXT_RE.test(t)) return t;
        const a = (el.getAttribute('aria-label') || '') + ' ' +
                  (el.getAttribute('title') || '');
        const m = a.match(/原画|蓝光|超清|高清|标清|流畅/);
        return m ? m[0] : '';
    }
    /* 档位打分：主档位 ×100，再加分辨率权重（4K > 1080P > 720P） */
    function qualityScore(t) {
        const s = String(t || '');
        const m = /^(原画|蓝光|超清|高清|标清|流畅)/.exec(s);
        if (!m) return 0;
        let score = (QUALITY_RANK[m[1]] || 0) * 100;
        if (/8\s*K/i.test(s)) score += 40;
        else if (/4\s*K|2160/i.test(s)) score += 30;
        else if (/2\s*K|1440/i.test(s)) score += 25;
        else if (/1080/.test(s)) score += 20;
        else if (/720/.test(s)) score += 10;
        return score;
    }
    function qualityIsMaxText(t) {
        const s = String(t || '');
        if (!s) return false;
        if (/原画/.test(s)) return true;
        if (/蓝光/.test(s)) return true;
        if (/超清/.test(s) && /4\s*K|2160/i.test(s)) return true;
        return false;
    }
    /* ---- xgplayer 清晰度插件 ----
       真实抖音播放器的清晰度就是这套：<xg-icon class="xgplayer-playclarity-setting">
       里面一个显示当前档位的标签（「高清 1080P」）+ 真正可选档位列表。
       和倍速那边同一套思路：先看列表开没开，没开就 hover / click / 只 click 轮着试。 */
    let xgClarityStep = 0, xgClarityClicked = 0, xgHoverAt = 0;
    function xgClarityRoots() {
        const out = [];
        let n = 0;
        for (const el of document.querySelectorAll('[class]')) {
            if (++n > 3000) break;
            const cls = el.className;
            if (typeof cls !== 'string') continue;
            if (cls.indexOf('xgplayer-playclarity-setting') < 0) continue;
            if (el.closest && el.closest('#gm-settings-panel')) continue;
            if (out.indexOf(el) >= 0) continue;
            out.push(el);
            if (out.length >= 6) break;
        }
        out.sort((a, b) => (a.tagName === 'XG-ICON' ? 0 : 1) - (b.tagName === 'XG-ICON' ? 0 : 1));
        return out;
    }
    function qualityTextOf(el) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return QUALITY_TEXT_RE.test(t) ? t : '';
    }
    /* 当前档位标签：插件里第一个可见的、文案是档位的叶子节点 */
    function xgClarityLabel() {
        for (const root of xgClarityRoots()) {
            let n = 0;
            for (const el of root.querySelectorAll('*')) {
                if (++n > 80) break;
                if (el.children.length) continue;
                const t = qualityTextOf(el);
                if (!t) continue;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (!r || r.width < 6 || r.height < 6) continue;
                return el;
            }
            if (qualityTextOf(root)) return root;
        }
        return null;
    }
    /* 打开着的档位列表：全页找「至少 2 个不同档位同时可见」 */
    function xgClarityRows() {
        const label = xgClarityLabel();
        const rows = [];
        let n = 0;
        for (const el of document.querySelectorAll('div, span, li, p')) {
            if (++n > 4000) break;
            if (el.children.length) continue;
            if (label && (el === label || label.contains(el))) continue;
            if (el.closest && el.closest('#gm-settings-panel')) continue;
            const t = qualityTextOf(el);
            if (!t) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (!r || r.width < 8 || r.height < 8) continue;
            if (rows.some(x => x.el === el)) continue;
            rows.push({ el: el, text: t, score: qualityScore(t) });
            if (rows.length >= 40) break;
        }
        const distinct = new Set(rows.map(x => x.text));
        return distinct.size >= 2 ? rows : null;
    }
    function tryXgClarity(mode) {
        /* v9.40：mode='live' 时按直播那把尺子（liveLevelOf / liveTargetLevel）量。
           以前直播也走 vqTargetLevel，等于拿「视频流 4K/1080P」去比直播档位，量纲都不对。 */
        const live = mode === 'live';
        const roots = xgClarityRoots();
        if (!roots.length) return '';
        const target = live ? liveTargetLevel() : vqTargetLevel();
        if (target <= 0) return live ? '' : 'max';     // 智能：不干预
        const lvOf = live ? (t => liveLevelOf(t)) : (t => vqLevelOf({ gearName: t }));
        const lb = xgClarityLabel();
        const curTxt = lb ? (lb.textContent || '').replace(/\s+/g, ' ').trim() : '';
        const curLv = curTxt ? lvOf(curTxt) : 0;
        /* 视频流的目标是「下限」：够高就收工。
           直播的目标是「正好这一档」：比目标高说明选大了，要降档，所以只有相等才算达标。 */
        if (curTxt && (live ? curLv === target : curLv >= target)) {
            qualityDone = true;
            qualityNote = 'xgplayer already "' + curTxt + '"';
            return 'max';
        }
        const rows = xgClarityRows();
        if (rows && rows.length >= 2) {
            /* 只点「不超过目标档位」里最高的那一项：目标设成 1080P 时不会去点 4K，
               目标视频没有这一档就由播放器自己逐级下降 */
            const usable = rows.filter(r => {
                const lv = lvOf(r.text);
                return lv > 0 && lv <= target;
            });
            if (!usable.length) {
                /* 直播：列表里没有不高于目标的档位（选了标清但房间只有原画），
                   取最低那档，别死等；已经是它就算达标。 */
                if (!live) return '';
                rows.sort((a, b) => a.score - b.score);
                const low = rows[0];
                if (curTxt && liveLevelOf(low.text) === liveLevelOf(curTxt)) {
                    qualityDone = true;
                    qualityNote = 'xgplayer lowest is "' + curTxt + '"';
                    return 'max';
                }
                activateMenuRow(low.el, 'full');
                qualityNote = 'xgplayer click "' + low.text + '"';
                xgClarityClicked++;
                return 'clicked';
            }
            usable.sort((a, b) => b.score - a.score);
            const best = usable[0];
            /* v9.45：视频流这边**只往上爬，绝不把全局偏好往下拉**。
               点菜单里任何一档，抖音都会把它写进 MANUAL_SWITCH —— 那是全局偏好：
               在「最高只有 720P」的视频上点了一下 720P，后面所有 4K 视频就都起在
               720P 了（用户看到的就是「第一个视频 720，之后全 720」）。
               所以只在这一档比当前偏好更高时才点；不比当前高就直接收工，
               这点画质交给播放器自己按视频能力回退。 */
            if (!live) {
                const prefLv = vqLevelOf(vqParse(vqRead())) || 0;
                if (lvOf(best.text) <= prefLv) {
                    qualityDone = true;
                    qualityNote = 'no tier above pref(' + prefLv + '), keep "' + (curTxt || '-') + '"';
                    return 'max';
                }
            }
            const atBest = live
                ? (curTxt && liveLevelOf(best.text) === liveLevelOf(curTxt))
                : (curTxt && best.score <= qualityScore(curTxt));
            if (atBest) {
                qualityDone = true;
                qualityNote = 'xgplayer best is "' + curTxt + '"';
                return 'max';
            }
            activateMenuRow(best.el, 'full');
            qualityNote = 'xgplayer click "' + best.text + '"';
            xgClarityClicked++;
            return 'clicked';
        }
        /* 列表没开：先把菜单悬停唤出来，隔 420ms 再回来读一次 ——
           抖音的清晰度菜单是 hover 才渲染的，同一个 tick 里读必然是空的，
           以前「悬停 → 立刻点 → 把菜单又关掉」的死循环就是这么来的。 */
        const root = roots[0];
        if (!xgHoverAt || Date.now() - xgHoverAt > 1500) {
            xgHoverAt = Date.now();
            hoverOver(root);
            qualityNote = 'xgplayer hover (wait menu)';
            setTimeout(() => {
                try { live ? applyMaxQuality() : applyVideoMaxQuality(); } catch (e) {}
            }, 420);
            return 'clicked';
        }
        /* 悬停过一轮菜单还是不出来：再补一次完整点击 / 只派发 click */
        xgClarityStep++;
        if (xgClarityStep % 2 === 1) {
            activateMenuRow(root, 'full');
            qualityNote = 'xgplayer click button';
        } else {
            synthClick(root);
            qualityNote = 'xgplayer click only';
        }
        return 'clicked';
    }
    /* 兜底：播放器底栏上显示「当前画质」的那个文本（用于既读不到、也点不到
       属性锚点的改版页面）。只看下半屏，避免命中聊天区里的同名文字。 */
    function controlQualityEl() {
        const shell = document.querySelector('[id^="living_player_container"]') ||
                      document.querySelector('.douyin-player') ||
                      document.querySelector('.xgplayer') || document.body;
        if (!shell) return null;
        let n = 0;
        for (const el of shell.querySelectorAll('div, span')) {
            if (++n > 4000) break;
            if (el.children.length) continue;
            const t = (el.textContent || '').trim();
            if (!QUALITY_TEXT_RE.test(t)) continue;
            if (el.closest('#gm-settings-panel')) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (r.width < 10 || r.height < 8) continue;
            if (r.top < window.innerHeight * 0.55) continue;
            /* 弹出菜单也是浮层：菜单项不能被当成「当前画质」，否则会把
               还没生效的菜单项误判成已切换。控制栏本身也是 absolute，
               靠尺寸区分 —— 菜单是窄小浮层，控制栏是整条长条。 */
            let cur = el.parentElement, d = 0, isMenu = false;
            while (cur && cur !== document.body && d++ < 6) {
                let st;
                try { st = getComputedStyle(cur); } catch (e) { break; }
                if (st && (st.position === 'absolute' || st.position === 'fixed')) {
                    let cr = null;
                    try { cr = cur.getBoundingClientRect(); } catch (e) {}
                    if (cr && cr.width < 320 && cr.height < 480) isMenu = true;
                    break;
                }
                cur = cur.parentElement;
            }
            if (isMenu) continue;
            return el;
        }
        return null;
    }
    function currentQualityText() {
        for (const el of qualityAnchorEls()) {
            const t = qualityLabel(el);
            if (t) return t;
        }
        const fallback = controlQualityEl();
        return fallback ? (fallback.textContent || '').trim() : '';
    }
    /* 弹出的画质菜单项：必须有 absolute/fixed 浮层祖先，且同层有多项。
       这样控制栏上那个「当前画质」标签永远不会被当成菜单项。 */
    function qualityMenuItems() {
        const out = [];
        const nodes = document.querySelectorAll('div, span, li, p, button');
        for (let i = 0; i < nodes.length && i < 2200; i++) {
            const el = nodes[i];
            if (el.children.length) continue;
            const t = (el.textContent || '').trim();
            if (!QUALITY_TEXT_RE.test(t)) continue;
            if (el.closest('#gm-settings-panel')) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (r.width < 10 || r.height < 8) continue;
            if (r.right < 0 || r.bottom < 0 || r.left > window.innerWidth ||
                r.top > window.innerHeight) continue;
            let cur = el.parentElement, d = 0, floating = false;
            while (cur && cur !== document.body && d++ < 6) {
                let st;
                try { st = getComputedStyle(cur); } catch (e) { break; }
                if (st && (st.position === 'absolute' || st.position === 'fixed')) {
                    floating = true; break;
                }
                cur = cur.parentElement;
            }
            if (!floating) continue;
            out.push({ el: el, text: t, top: r.top });
            if (out.length >= 24) break;
        }
        return out;
    }
    function hoverOver(el) {
        let r;
        try { r = el.getBoundingClientRect(); } catch (e) { return false; }
        if (r.width < 2 || r.height < 2) return false;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const base = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: cx, clientY: cy, screenX: cx, screenY: cy
        };
        try {
            if (typeof PointerEvent === 'function') {
                const pe = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
                el.dispatchEvent(new PointerEvent('pointerover',
                    Object.assign({}, base, pe, { button: -1, buttons: 0 })));
                el.dispatchEvent(new PointerEvent('pointerenter',
                    Object.assign({}, base, pe, { button: -1, buttons: 0, bubbles: false })));
            }
            el.dispatchEvent(new MouseEvent('mouseover',
                Object.assign({}, base, { button: 0, buttons: 0 })));
            el.dispatchEvent(new MouseEvent('mouseenter',
                Object.assign({}, base, { button: 0, buttons: 0, bubbles: false })));
            el.dispatchEvent(new MouseEvent('mousemove',
                Object.assign({}, base, { button: 0, buttons: 0 })));
            return true;
        } catch (e) { return false; }
    }

    /* v9.25：只从「画质按钮」往上找 handler 太脆 —— 那个按钮可能 hover 才渲染，
       控制栏本身也会自动隐藏。改成：从播放器根节点出发沿 fiber 往上 40 层，
       对每个 props 做有界深搜（≤4 层 / 260 个对象），找任何带
       setCurrentQuality 的对象 —— 抖音把播放管理器挂在 props 或 store 里。 */
    function scanQualityHandler(root) {
        if (!root || typeof root !== 'object') return null;
        const seen = new WeakSet();
        let budget = 120;
        const stack = [{ o: root, d: 0 }];
        while (stack.length && budget > 0) {
            const it = stack.pop();
            const o = it.o;
            if (!o || typeof o !== 'object' || it.d > 4) continue;
            if (o.nodeType || seen.has(o)) continue;
            seen.add(o);
            budget--;
            if (typeof o.setCurrentQuality === 'function') return o;
            let keys;
            try { keys = Object.keys(o); } catch (e) { continue; }
            for (const k of keys) {
                let v;
                try { v = o[k]; } catch (e) { continue; }
                if (!v || typeof v !== 'object' || v.nodeType) continue;
                if (typeof v.setCurrentQuality === 'function') return v;
                if (it.d < 4) stack.push({ o: v, d: it.d + 1 });
            }
        }
        return null;
    }
    function qualityHandlerNear(el) {
        let f = dyReactFiber(el), d = 0;
        while (f && d++ < 20) {
            const hit = scanQualityHandler(f.memoizedProps) ||
                        scanQualityHandler(f.pendingProps) ||
                        scanQualityHandler(f.alternate && f.alternate.memoizedProps);
            if (hit) return hit;
            f = f.return;
        }
        return null;
    }
    function qualityPlayerRoots() {
        const out = [];
        let n = 0;
        for (const el of document.querySelectorAll(
            '[id^="living_player_container"], [data-e2e="basicPlayer"], .douyin-player, ' +
            '[data-e2e="living-container"], .xgplayer')) {
            if (++n > 6) break;
            out.push(el);
        }
        return out;
    }
    /* 扫 fiber 不便宜：失败后 5 秒内不再重复扫（成功则每轮都能确认）。
       爆发期（刚进房间，播放器还在挂载）压到 700ms，别把七八百毫秒的等待
       变成「画质切得慢」。 */
    let qualityHuntAt = 0, qualityHuntFail = 0;
    function qualityHunt() {
        const now = Date.now();
        const wait = now < qualityBurstUntil ? 700 : 5000;
        if (qualityHuntFail && now - qualityHuntAt < wait) return null;
        qualityHuntAt = now;
        let qh = null, n = 0;
        for (const el of qualityAnchorEls()) { qh = qualityHandlerNear(el); if (qh) break; }
        if (!qh) {
            for (const el of qualityPlayerRoots()) {
                if (++n > 3) break;
                qh = qualityHandlerNear(el);
                if (qh) break;
            }
        }
        qualityHuntFail = qh ? 0 : 1;
        return qh;
    }

    /* v9.25：播放器的画质管理器（qualityHandler）挂在 reactProps 上而不是
       fiber 上，实测这两条路径能拿到：
         锚点  xg-inner-controls xg-right-grid > div:has([data-e2e="quality-selector"])
         handler = props.children.props.children.props.qualityHandler
       另一处入口 #PlayerLayout .douyin-player-controls .QualitySwitchNewPlugin > div，
       其 fiber.return.memoizedProps 上同时有 qualityHandler 与 qualityList。
       只走 fiber 泛扫时如果结构变了就永远找不到，所以这几条都保留。 */
    const QUALITY_ANCHOR_SEL = 'xg-inner-controls xg-right-grid > div, ' +
        '#PlayerLayout .douyin-player-controls .QualitySwitchNewPlugin > div, ' +
        '.douyin-player-controls .QualitySwitchNewPlugin > div, ' +
        '[data-e2e="quality-selector"]';

    function qualityAnchorsKnown() {
        const out = [];
        try {
            for (const el of document.querySelectorAll(QUALITY_ANCHOR_SEL)) {
                if (el.closest('#gm-settings-panel')) continue;
                out.push(el);
                if (out.length >= 6) break;
            }
        } catch (e) {
            for (const el of document.querySelectorAll('[data-e2e="quality-selector"]')) out.push(el);
        }
        return out;
    }
    /* 沿元素的 reactProps 找画质管理器（含它常见的三层嵌套） */
    function propsChainHandler(start) {
        let el = start;
        for (let i = 0; el && i < 4; i++, el = el.parentElement) {
            const p = dyReactProps(el);
            if (!p || typeof p !== 'object') continue;
            const kids = p.children;
            const cands = [
                p.qualityHandler,
                kids && kids.props && kids.props.qualityHandler,
                kids && kids.props && kids.props.children && kids.props.children.props &&
                    kids.props.children.props.qualityHandler,
                p.value && p.value.qualityHandler
            ];
            for (const qh of cands) {
                if (qh && typeof qh.setCurrentQuality === 'function') return { handler: qh, props: p };
            }
        }
        return null;
    }
    function fiberReturnHandler(el) {
        const f = dyReactFiber(el);
        const r = f && f.return && f.return.memoizedProps;
        if (r && r.qualityHandler && typeof r.qualityHandler.setCurrentQuality === 'function')
            return { handler: r.qualityHandler, list: r.qualityList };
        return null;
    }
    function resolveQualityHandler() {
        // ① 页面上的已知锚点：reactProps 链 / fiber.return 两条都试
        for (const el of qualityAnchorsKnown()) {
            const hit = propsChainHandler(el) || fiberReturnHandler(el);
            if (hit) return hit;
        }
        // ② 已经识别到的画质标签（控制栏上的那个）
        for (const el of qualityAnchorEls()) {
            const hit = propsChainHandler(el);
            if (hit) return hit;
        }
        // ③ 泛扫 fiber
        const qh = qualityHunt();
        return qh ? { handler: qh } : null;
    }
    /* 直接调 React 的 onClick —— 抖音的画质菜单对派发的 click 事件经常不理 */
    function reactClick(el) {
        const fake = {
            currentTarget: null, target: null, preventDefault() {},
            stopPropagation() {}, persist() {}, nativeEvent: {}
        };
        let cur = el;
        for (let i = 0; cur && i < 4; i++, cur = cur.parentElement) {
            const p = dyReactProps(cur);
            if (!p || typeof p.onClick !== 'function') continue;
            fake.currentTarget = cur;
            fake.target = el;
            try { p.onClick(fake); return true; } catch (e) {}
            try { p.onClick(); return true; } catch (e) {}
        }
        return false;
    }

    function applyMaxQuality() {
        if (!config.liveMaxQuality || !(isLiveHost || isLivePage())) return;
        if (location.href !== qualityLastUrl) {
            qualityLastUrl = location.href;
            qualityDone = false; qualityDomTries = 0; qualityDomCooldown = 0;
            qualityNote = 'new room';
        }
        if (qualityDone) return;
        /* v9.40：目标档位可选。auto = 完全不干预 —— 连 webcast_local_quality
           都不写，直播画质完全交给抖音自己（之前的「本机偏好」也保持原样）。 */
        const tLv = liveTargetLevel(), tId = liveTargetId();
        if (tLv <= 0) { qualityNote = 'target=auto (no intervene)'; return; }
        /* 本机偏好跟着目标档位走：抖音进房间时读的就是这个键，
           写成目标标识（origin/uhd/hd/sd/ld），它自己找不到就逐级下降。 */
        try { localStorage.setItem('webcast_local_quality', tId); } catch (e) {}
        dySetCookie('webcast_local_quality', tId);
        dySetCookie('live_local_quality', tId);

        // ① 当前已经就是目标档：什么都不用做
        const cur = currentQualityText();
        const curLv = liveLevelOf(cur);
        if (cur && curLv === tLv) { qualityDone = true; qualityNote = 'already ' + cur; return; }
        /* 比目标低要继续升，比目标高要降 —— 两种情况都往下走。
           房间压根没有目标档时，由 handler / 菜单 / xgplayer 三条路径里的
           「可用列表取最优」判定收工，不会在这里死循环。 */

        // ①-b 已删除：原来这里会调 window.player 的 changeDefinition 直接切档，
        // 实测会把点播视频切成 0x0 播不出来（www 页面没有 curDefinition，
        // 既判断不了档位也校验不了结果），整条路径连同设置项一起移除。
        // 画质只走下面的「点档位」路径。

        // ② handler：reactProps 链 → 已知锚点 → fiber 泛扫
        const hit = resolveQualityHandler();
        if (hit) {
            const qh = hit.handler;
            let list = null;
            try {
                if (typeof qh.getCurrentQualityList === 'function')
                    list = qh.getCurrentQualityList();
            } catch (e) {}
            if (!list && Array.isArray(hit.list)) list = hit.list;
            let nowQ = '';
            try { nowQ = String((qh.getCurrentQuality && qh.getCurrentQuality()) || ''); }
            catch (e) {}
            /* 目标标识：列表里有就直接用；没有就取「不高于目标」里最高的一档，
               全都高于目标（房间最低档都比目标高）时退回列表里最低那档。 */
            let target = tId;
            if (Array.isArray(list) && list.length) {
                const known = list.filter(k => liveLevelOf(k) > 0);
                const usable = known.filter(k => liveLevelOf(k) <= tLv)
                    .sort((a, b) => liveLevelOf(a) - liveLevelOf(b));
                if (usable.length) target = usable[usable.length - 1];
                else if (known.length) {
                    known.sort((a, b) => liveLevelOf(a) - liveLevelOf(b));
                    target = known[0];
                }
            }
            if (nowQ && (nowQ === target || liveLevelOf(nowQ) === tLv)) {
                qualityDone = true;
                qualityNote = 'handler already ' + nowQ;
                return;
            }
            try {
                qh.setCurrentQuality(target);
                qualityDone = true;
                qualityNote = 'handler.setCurrentQuality(' + target + ')' +
                    (Array.isArray(list) ? ' list=' + list.join('/') : '');
                return;
            } catch (e) {
                qualityNote = 'handler throw: ' + (e && e.message);
                try {
                    qh.setCurrentQuality(target, true);
                    qualityDone = true;
                    qualityNote = 'handler.setCurrentQuality(' + target + ', true)';
                    return;
                } catch (e2) {}
            }
        }

        // ②-b xgplayer 清晰度插件（新版播放器就是这套，比按 class 猜更准）
        const xgRes = tryXgClarity('live');
        if (xgRes === 'max') return;
        if (xgRes === 'clicked') {
            qualityDomCooldown = Date.now() + (Date.now() < qualityBurstUntil ? 500 : 1200);
            return;
        }

        // ③ DOM 兜底
        if (Date.now() < qualityDomCooldown) return;
        qualityDomTries++;
        /* 爆发期（刚进房间）600ms 一次；之后前 10 次 1.8 秒，再往后 20 秒一次
           但永不彻底放弃 —— 控制栏自动隐藏 / 菜单晚出现时，旧版 12 次用完就
           永久收工，表现就是「这个房间怎么都不生效」。 */
        const burst = Date.now() < qualityBurstUntil;
        qualityDomCooldown = Date.now() + (qualityDomTries <= 10 || burst
            ? (burst ? 600 : 1800) : 20000);
        /* 至少要有两个不同档位的候选才算「菜单真的开着」——
           控制栏上只有一个「当前画质」标签，凑不出两档，就不会被误点。 */
        const distinct = [];
        const seenText = new Set();
        for (const it of qualityMenuItems()) {
            if (seenText.has(it.text)) continue;
            seenText.add(it.text);
            distinct.push(it);
        }
        if (distinct.length >= 2) {
            /* v9.40：只点「不高于目标档位」里最高那一项 —— 选了高清就不该跳到原画，
               选了标清还要往下压一档。全都比目标高时退回最低档（房间没有更低的了）。 */
            const usable = distinct.filter(it => {
                const lv = liveLevelOf(it.text);
                return lv > 0 && lv <= tLv;
            });
            /* 可用列表为空 = 菜单里每一档都比目标高，那就压到最低那档 */
            const pool = usable.length ? usable : distinct.slice();
            pool.sort((a, b) => usable.length
                ? qualityScore(b.text) - qualityScore(a.text)
                : qualityScore(a.text) - qualityScore(b.text));
            const best = pool[0];
            /* 已经就在「可用列表里最优」那一档：收工，别再反复开合菜单 */
            if (curLv && liveLevelOf(best.text) === curLv) {
                qualityDone = true;
                qualityNote = 'best available = ' + best.text;
                return;
            }
            /* 点完要尽快复查「现在是不是目标档」：爆发期也留 1.2 秒，
               免得菜单被反复开合闪得眼花（复查走 ① 读当前档位，不受这里限制） */
            qualityDomCooldown = Date.now() + (burst ? 1200 : 1800);
            /* 菜单项优先调 React 的 onClick —— 抖音的菜单只认这个，退而求其次才是
               完整指针序列 / 派发 click。 */
            if (!reactClick(best.el)) {
                if (!activateMenuRow(best.el, 'full')) {
                    try { fireClick(best.el); } catch (e) {}
                }
            }
            qualityNote = 'clicked menu item "' + best.text + '" (try ' + qualityDomTries + ')';
            /* 不在这里置 qualityDone：下一轮用 ① 复查当前档位，
               没切过去就继续重试。 */
            return;
        }
        const anchor = qualityAnchorEls()[0] || controlQualityEl() ||
            document.querySelector('[data-e2e="quality-selector"]');
        if (!anchor) {
            /* 控制栏自动隐藏时连「画质」标签都不存在：先把鼠标移到画面上
               唤出控制栏，下一轮再找。 */
            const root = qualityPlayerRoots()[0];
            if (root) {
                hoverOver(root);
                qualityNote = 'hover player to reveal controls (try ' + qualityDomTries + ')';
            } else {
                qualityNote = 'no anchor / no player root';
            }
            return;
        }
        /* 抖音的画质菜单多半是 hover 出现：偶数次先只悬停，奇数次再补一次点击。
           点击优先走 React 的 onClick，失败才派发指针序列。 */
        hoverOver(anchor);
        if (qualityDomTries % 2 === 1 && !reactClick(anchor)) fireClick(anchor);
        qualityNote = 'open menu: "' + qualityLabel(anchor) + '" (try ' + qualityDomTries + ')';
    }

    /* ---- ③-b 视频流（www）默认最高画质 ----
     * 抖音播放器把「手动选择的清晰度」以 JSON 存在 sessionStorage.MANUAL_SWITCH，
     * 每次装载视频时读取。这里刻意**不内置任何档位常量**（gearType / qualityType /
     * clarityReal 全是平台内部标识，写死就等着改版失效，也说不清来源）：
     *   第一次   —— 走播放器自己的清晰度菜单切到最高档；
     *   切成功时 —— 抖音会自己把那份对象写进 MANUAL_SWITCH，原样抄进
     *               localStorage.gm_dy_quality_max 当模板；
     *   以后     —— 新视频装载前回放这份模板，一次就起在最高档。
     * 所以档位标识永远来自抖音本身，改版也不会跟丢；视频没有该档位时
     * 由播放器自己的列表逐级回退。
     * 与直播间的 webcast_local_quality 完全独立，两个开关互不影响。 */
    const VQ_KEY = 'MANUAL_SWITCH';
    const VQ_BACKUP_KEY = 'gm_dy_quality_backup';
    const VQ_LEARNED_KEY = 'gm_dy_quality_max';   // 旧版单模板键，仅用于迁移
    let vqUrl = '', vqApplied = false, vqUserOverridden = false, vqWrites = 0;
    /* v9.45：按「视频」而不是按「页面」维护状态。抖音推荐页一直在同一个 URL 上
       滚视频，以前只在 URL 变化时重置 —— 第一个视频爬到的档位会一路带到后面，
       第一个视频最高只有 720P 时，后面的 4K 视频也跟着起在 720P。 */
    let vqVideoId = '';
    let vqWroteRaw = '';   // 我们最后一次写进 MANUAL_SWITCH 的原文，用来区分「用户改的」和「我们写的」
    /* 新版播放器清晰度是 xgplayer 组件，额外走一条「点它自己档位」的路 */
    let vqXgCooldown = 0, vqXgTries = 0, vqXgDone = false, vqNote = '';
    /* 旧版把学到的对象存在单独一个 localStorage 键里；新版改成档位库
       （跟着 config 持久化）。启动时迁移一次，别让已经学到的档位白丢。 */
    try {
        const legacy = localStorage.getItem(VQ_LEARNED_KEY);
        if (legacy) {
            const o = vqParse(legacy);
            if (o && vqTplValid(o)) vqSaveTpl(o);
            localStorage.removeItem(VQ_LEARNED_KEY);
        }
    } catch (e) {}

    function vqRead() {
        try { return sessionStorage.getItem(VQ_KEY); } catch (e) { return null; }
    }
    function vqParse(raw) {
        try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
    }
    /* 学到的模板：抖音自己写出来的那份最高档对象（原样 JSON） */
    /* 模板必须是「播放器认得出的档位对象」才有意义。抖音自己写的那份长这样：
         {done:1, gearName:"高清 1080P", gearClarity:"5", gearType:1, qualityType:1, clarityReal:[…]}
       中文显示名 + gearType + gearClarity 一个都不能少 —— 缺了播放器认不出档位，
       写回去画质也不会变，还白白占着「已应用」的状态不重试。
       所以读到不合格的模板直接清掉，让后面重新学。 */
    function vqTplValid(o) {
        if (!o || typeof o !== 'object') return false;
        if (!vqLabelOf(o)) return false;   // gearName 必须是中文档位名，不能是内部标识
        if (o.gearClarity == null && o.gear_clarity == null) return false;
        if (o.gearType == null && o.gear_type == null) return false;
        return true;
    }
    /* ---- 档位对象库 ----
       抖音自己写 MANUAL_SWITCH 时，把那份对象按「档位名」记下来（哪一档都记）。
       用户选定目标画质后，直接从库里取同档位对象写回去 —— 效果等价于他自己
       在清晰度菜单里点了一下，所以「选了 1080P 之后所有视频最高就 1080P、
       视频达不到该档位就逐级下降」完全是抖音自己的行为，我们只是代办点击。
       库存 config.qualityTpls，跟配置一起持久化（本地存储 + 可选 cookie 镜像）。 */
    function vqTpls() {
        if (!config.qualityTpls || typeof config.qualityTpls !== 'object' ||
            Array.isArray(config.qualityTpls)) {
            config.qualityTpls = {};
        }
        return config.qualityTpls;
    }
    function vqTargetLevel() {
        for (const t of QUALITY_TARGETS) if (t[0] === config.videoQualityTarget) return t[2];
        return 400;
    }
    function vqTargetName() {
        for (const t of QUALITY_TARGETS) if (t[0] === config.videoQualityTarget) return t[1];
        return '超清 4K';
    }
    /* 档位库单独落盘：只写本地配置，不碰 cookie 镜像、也不触发 saveConfig 的副作用
       （saveConfig 里有「关开关就还原清晰度」的逻辑，被抖音写一次就触发一次会打架） */
    function vqPersistTpls() {
        try {
            const json = JSON.stringify(Object.assign({}, config, { __ts: Date.now() }));
            localStorage.setItem(CONFIG_KEY, json);
        } catch (e) {}
    }
    /* 把学到的档位对象塞进库（按档位名归类，同档位只覆盖，数量天然有限） */
    function vqSaveTpl(o) {
        if (!vqTplValid(o)) return false;
        const name = vqLabelOf(o);
        if (!name) return false;
        if (vqLevelOf(o) <= 0) return false;
        const store = vqTpls();
        let raw;
        try { raw = JSON.stringify(o); } catch (e) { return false; }
        if (store[name] && JSON.stringify(store[name]) === raw) return false;
        try { store[name] = JSON.parse(raw); } catch (e) { return false; }
        vqPersistTpls();
        try { console.log('[抖音优化] 已记录档位对象：' + name + ' (lg=' + vqLevelOf(o) + ')'); } catch (e) {}
        return true;
    }
    /* 目标档位该写哪一份：等级不超过目标、且尽量贴近目标的那一份。
       目标视频没有该档位时不用管 —— 播放器自己按 clarityReal 逐级下降。 */
    function vqTplForTarget() {
        const target = vqTargetLevel();
        if (target <= 0) return null;                      // 智能 = 不干预
        const store = vqTpls();
        let best = null, bestLv = -1;
        for (const name of Object.keys(store)) {
            const o = store[name];
            if (!vqTplValid(o)) continue;
            const lv = vqLevelOf(o);
            if (lv <= 0 || lv > target) continue;          // 高过目标的不能用，否则画质会顶回高档
            if (lv > bestLv) { bestLv = lv; best = o; }
        }
        return best ? { obj: best, level: bestLv, name: vqLabelOf(best) } : null;
    }
    /* 档位对象里的「显示名」字段名并不统一：
         · 清晰度列表项 = { key:'20', label:'超清 4K', quality:72, gearName:'adapt_lowest_4_1', gearType:-2 }
           —— label 才是文案，gearName 反而是内部标识（adapt_lowest_4_1 这种）
         · 码率表项     = { gear_name:'…', bit_rate, play_addr, qualityType, … }
       所以不认字段名，只认「长得像档位名的那个字符串」，两种结构都能吃。 */
    /* 中文档位名认不出时，退回看「平台自己的标识符」：
       adapt_lowest_4_1 = 4K、adapt_lowest_1440_1 = 2K、normal_1080_0 = 1080。
       这是从真实标识观察出的命名规律，不是抄来的档位常量表。 */
    function vqIdentMax(o) {
        if (!o || typeof o !== 'object') return 0;
        const ids = [];
        for (const k of ['label', 'gearName', 'gear_name', 'key', 'gearClarity', 'gear_clarity', 'clarity']) {
            let v;
            try { v = o[k]; } catch (e) { continue; }
            if (typeof v === 'string' && v) ids.push(v);
            else if (typeof v === 'number') ids.push(String(v));
        }
        const s = ids.join(' ').toLowerCase();
        if (!s) return 0;
        if (/4k|2160/.test(s)) return 400;
        if (/adapt_lowest_4(_|$)/.test(s)) return 400;
        if (/1440|2k/.test(s)) return 300;
        if (/1080/.test(s)) return 200;
        if (/720/.test(s)) return 100;
        if (/540/.test(s)) return 50;
        return 0;
    }
    function vqLabelOf(o) {
        if (!o || typeof o !== 'object') return '';
        const pref = ['label', 'gear_name', 'gearName', 'name', 'text', 'title'];
        for (const k of pref) {
            const v = o[k];
            if (typeof v !== 'string') continue;
            const t = v.trim();
            if (t && QUALITY_TEXT_RE.test(t)) return t;
        }
        let keys;
        try { keys = Object.keys(o); } catch (e) { return ''; }
        for (let i = 0; i < keys.length && i < 24; i++) {
            const v = o[keys[i]];
            if (typeof v !== 'string') continue;
            const t = v.trim();
            if (t && t.length <= 16 && QUALITY_TEXT_RE.test(t)) return t;
        }
        return '';
    }
    /* 档位等级：400 = 4K，300 = 2K，200 = 1080P… 只在「同一把尺子」下比较。
       注意这是「偏好等级」不是「当前视频实际能播的档位」—— 抖音的 MANUAL_SWITCH
       是全局偏好：写 4K 后遇到只有 2K 的视频，播放器自己逐级下降。
       所以模板必须是 4K 级，写成 2K 会把 4K 视频也锁死在 2K。 */
    function vqLevelOf(o) {
        if (!o || typeof o !== 'object') return 0;
        const lv = vqIdentMax(o);
        const lbl = vqLabelOf(o);
        if (lbl) {
            if (/原画/.test(lbl)) return 600;
            if (/蓝光/.test(lbl)) return 500;
            if (/超清/.test(lbl) && /4\s*K|2160/i.test(lbl)) return 400;
        }
        return lv;
    }
    function vqIsMax(o) {
        if (!o) return false;
        /* 字段残缺的对象播放器读不懂（画质不会真的变高），一律不算「已达标」 */
        if (!vqTplValid(o)) return false;
        const target = vqTargetLevel();
        if (target <= 0) return true;              // 智能：不干预，永远当作「不用动」
        return vqLevelOf(o) >= target;
    }
    /* 学到档位对象就记进库 —— 不拼装、不改写，字段全是平台真值。
       哪一档都记（用户可能把目标设成 1080P），取用时再按目标等级挑。 */
    function vqLearn(raw, o) {
        if (!o) return false;
        return vqSaveTpl(o);
    }
    function vqBackupOnce(raw) {
        try {
            if (localStorage.getItem(VQ_BACKUP_KEY) !== null) return;
            localStorage.setItem(VQ_BACKUP_KEY, raw || '');
        } catch (e) {}
    }
    /* 从播放器的档位表里现拼一份最高档对象（平台真值，脚本里不写死任何档位标识）。
       字段名两套写法都认：label/label 文案、gearType/gear_type、qualityType/quality、
       gearClarity/key、clarityReal/clarity_real。 */
    /* 找档位表的起点：优先播放器实例；它还没挂上时，从清晰度控件自身的
       react props / fiber 摸进去（那边的 config 里同样挂着档位列表）。 */
    /* www 视频流页既没有 xgplayer 的清晰度控件（xgClarityRoots 为空），
       也不一定有 window.player，但 React 树一定在：从 <video> / 播放器容器
       沿 fiber.return 往上爬，把每层的 memoizedProps 都当起点 ——
       播放器配置和视频数据（含各档位）都挂在这条链上。 */
    function vqFiberRoots() {
        const els = [];
        const push = (el) => { if (el && els.indexOf(el) < 0) els.push(el); };
        try { push(document.querySelector('video')); } catch (e) {}
        for (const sel of ['[data-e2e="feed-active-video"]', '.xg-video-container',
                           '.douyin-player', '.xgplayer']) {
            try { push(document.querySelector(sel)); } catch (e) {}
        }
        const out = [];
        for (const el of els) {
            let f = null;
            try { f = dyReactFiber(el); } catch (e) {}
            let d = 0;
            while (f && d++ < 40 && out.length < 90) {
                try {
                    const pr = f.memoizedProps;
                    if (pr && typeof pr === 'object') out.push(pr);
                } catch (e) {}
                try { f = f.return; } catch (e) { break; }
            }
        }
        return out;
    }
    function vqTemplateRoots() {
        const out = [];
        try { if (window.player) out.push(window.player); } catch (e) {}
        try { if (window.nextPlayer) out.push(window.nextPlayer); } catch (e) {}
        try {
            const sel = document.querySelector(
                '[data-e2e="quality-selector"], .QualitySwitchNewPlugin > div');
            if (sel) {
                const pr = dyReactProps(sel); if (pr) out.push(pr);
                const fb = dyReactFiber(sel); if (fb) out.push(fb);
                const wrap = sel.closest('.QualitySwitchNewPlugin');
                if (wrap) { const f2 = dyReactFiber(wrap); if (f2) out.push(f2); }
            }
        } catch (e) {}
        /* 抖音自研的清晰度插件（playclaritysettingplugin）最靠谱：
           中文档位名、gearType、gearClarity 这些「播放器认的字段」都在它内部，
           而 awemeInfo 里的码率表只有 gear_name + quality_type，缺那两个字段。
           所以把插件本身、它的 config、config.awemeInfo 都单独提为起点。 */
        try {
            let pl = null;
            try { pl = window.player && window.player.plugins; } catch (e) {}
            if (pl) {
                const list = Array.isArray(pl) ? pl : Object.keys(pl).map(k => pl[k]);
                for (const p of list) {
                    if (!p || typeof p !== 'object') continue;
                    const nm = String(p.pluginName || p.name || p.PLUGIN_NAME || '');
                    if (!/clarity|definition/i.test(nm)) continue;
                    out.push(p);
                    try { if (p.config) out.push(p.config); } catch (e) {}
                    try { if (p.config && p.config.awemeInfo) out.push(p.config.awemeInfo); } catch (e) {}
                }
            }
        } catch (e) {}
        try {
            for (const r of vqFiberRoots()) out.push(r);
        } catch (e) {}
        return out.filter(o => o && typeof o === 'object');
    }
    function vqTemplateFromPlayer() {
        const roots = vqTemplateRoots();
        if (!roots.length) return null;
        const targetLv = vqTargetLevel();
        if (targetLv <= 0) return null;            // 智能：不干预，不用拼
        const seen = new WeakSet();
        let best = null, bestScore = -1;
        /* 起点可能有几十个（fiber 链上每层一个），预算必须共享，
           否则每个起点各扫 3000 节点会把主线程拖住。 */
        let budget = 9000;
        for (const root of roots) {
        const stack = [{ o: root, d: 0 }];
        while (stack.length && budget > 0) {
            const it = stack.pop(), o = it.o;
            if (!o || typeof o !== 'object' || it.d > 6) continue;
            if (o.nodeType || seen.has(o)) continue;
            seen.add(o); budget--;
            if (Array.isArray(o)) {
                /* 既当「候选档位表」扫一遍，也把元素继续往下钻 ——
                   player.plugins 这种长数组本身不是档位表，
                   真正的清晰度列表往往就在它的某个元素里面。 */
                if (o.length >= 1 && o.length <= 40) {
                    for (const it2 of o) {
                        if (!it2 || typeof it2 !== 'object') continue;
                        const label = vqLabelOf(it2);
                        const lv = vqLevelOf(it2);
                        /* 只要「不超过目标档位」的：目标 1080P 时 4K/2K 候选不要，
                           否则会把画质顶得比用户要的高。 */
                        if (lv <= 0 || lv > targetLv) continue;
                        /* 同档位可能有多个来源：字段越全越好 —— 播放器要的是
                           gearType + gearClarity，只有 gear_name 的码率表项写进去认不出 */
                        const sc = lv * 10 +
                            (it2.gearType != null || it2.gear_type != null ? 6 : 0) +
                            (it2.gearClarity != null || it2.gear_clarity != null ? 5 : 0) +
                            (label ? 3 : 0) +
                            (it2.clarityReal || it2.clarity_real ? 1 : 0);
                        if (sc <= bestScore) continue;
                        bestScore = sc; best = it2;
                    }
                }
                if (it.d < 6) {
                    for (let i = 0; i < o.length && i < 80; i++) {
                        const v = o[i];
                        if (v && typeof v === 'object' && !v.nodeType) {
                            stack.push({ o: v, d: it.d + 1 });
                        }
                    }
                }
                continue;
            }
            let keys;
            try { keys = Object.keys(o); } catch (e) { continue; }
            for (const k of keys) {
                let v;
                try { v = o[k]; } catch (e) { continue; }
                if (!v || typeof v !== 'object' || v.nodeType) continue;
                if (it.d < 6) stack.push({ o: v, d: it.d + 1 });
            }
        }
        if (best) break;               // 这个起点已经找到最高档，不用再试下一个
        }
        if (!best || bestScore <= 0) return null;
        const label = vqLabelOf(best);
        /* 候选本身已经在扫描时按「不超过目标档位」筛过了，这里只兜一道 */
        if (vqLevelOf(best) <= 0 || vqLevelOf(best) > targetLv) return null;
        const out = { done: 1 };
        /* 档位名：有中文名用中文名（播放器按它匹配档位），否则用平台标识原样带上 */
        const gn = label ||
            (typeof best.gearName === 'string' && best.gearName) ||
            (typeof best.gear_name === 'string' && best.gear_name) || '';
        if (gn) out.gearName = gn;
        const gt = best.gearType != null ? best.gearType : best.gear_type;
        if (gt != null) out.gearType = gt;
        let qt = best.qualityType != null ? best.qualityType : best.quality_type;
        if (qt == null) qt = best.quality;
        if (qt != null) out.qualityType = qt;
        const gc = best.gearClarity != null ? best.gearClarity
            : (best.gear_clarity != null ? best.gear_clarity : best.key);
        if (gc != null) out.gearClarity = gc;
        const cr = best.clarityReal || best.clarity_real;
        if (Array.isArray(cr)) out.clarityReal = cr.slice();
        try { return JSON.stringify(out); } catch (e) { return null; }
    }
    let vqTplTryAt = 0;
    function vqEnsureTemplate() {
        if (vqTplForTarget()) return true;         // 库里已经有目标档位，不用再找
        if (vqTargetLevel() <= 0) return false;    // 智能：不干预
        /* 播放器 / React 树都还没挂上时不算一次尝试，否则首个视频会永久错过 */
        if (!vqTemplateRoots().length) return false;
        /* 只做时间节流，不做「一个视频只试一次」：首次探的时候 fiber 可能还没
           把视频数据挂上去，一次性放弃就再也学不到了。 */
        if (Date.now() - vqTplTryAt < 5000) return false;
        vqTplTryAt = Date.now();
        const raw = vqTemplateFromPlayer();
        if (!raw) return false;
        const tpl = vqParse(raw);
        if (!vqTplValid(tpl)) return false;
        if (!vqSaveTpl(tpl)) return false;
        try { console.log('[抖音优化] 已从播放器档位表取到档位：' + raw); } catch (e) {}
        return true;
    }
    /* 抖音自己写 MANUAL_SWITCH 时顺手学一份（用户在菜单里手动选档位就是这条路）。
       只旁听、不拦截：原样转交给原 setItem。 */
    const vqNativeSetItem = Storage.prototype.setItem;
    try {
        Storage.prototype.setItem = function (k, v) {
            const r = vqNativeSetItem.apply(this, arguments);
            try {
                if (k === VQ_KEY && typeof v === 'string') {
                    const o = vqParse(v);
                    if (o) vqLearn(v, o);
                }
            } catch (e) {}
            return r;
        };
    } catch (e) {}
    /* 脚本在 document-start 就跑：库里已经有目标档位的话，这里趁播放器还没
       装载第一个视频就先把 MANUAL_SWITCH 写好 —— 第一个视频也能起在目标档位，
       不用等定时任务的第一拍。 */
    try {
        if (location.hostname === 'www.douyin.com' && config.videoMaxQuality) {
            const pick0 = vqTplForTarget();
            /* v9.45：只有到了目标档位的模板才抢在装载前写。低档模板写进去就是
               全局偏好，会让后面的高档视频也跟着降档。 */
            const lv0 = vqTargetLevel();
            if (pick0 && (lv0 <= 0 || pick0.level >= lv0)) {
                const raw0 = vqRead();
                if (!vqIsMax(vqParse(raw0))) {
                    vqBackupOnce(raw0);
                    const w0 = JSON.stringify(pick0.obj);
                    sessionStorage.setItem(VQ_KEY, w0);
                    vqWroteRaw = w0;
                    vqApplied = true; vqWrites = 1;
                    vqNote = 'early replay ' + pick0.name;
                }
            }
        }
    } catch (e) {}
    /* v9.45：当前视频的 id（用来判断「换视频了」）。
       只读清晰度插件 config 里的 awemeInfo.awemeId，**不拿 <video> 的 src 兜底**：
       同一支视频换档位后 src 也会变，拿它当身份证会把「切档位」误判成「换视频」，
       重置状态后又要重新爬一档 —— 来回循环。读不到就当没换，保持旧行为。 */
    function vqAwemeId() {
        try {
            const pl = window.player && window.player.plugins;
            if (pl) {
                const list = Array.isArray(pl) ? pl : Object.keys(pl).map(k => pl[k]);
                for (const p of list) {
                    if (!p || typeof p !== 'object') continue;
                    let ai = null;
                    try { ai = (p.config && p.config.awemeInfo) || p.awemeInfo; } catch (e) {}
                    if (ai && ai.awemeId) return String(ai.awemeId);
                }
            }
        } catch (e) {}
        return '';
    }

    function applyVideoMaxQuality() {
        if (!config.videoMaxQuality) { restoreVideoQuality(); return; }
        if (isLivePage() || location.hostname !== 'www.douyin.com') return;
        if (location.href !== vqUrl) {
            vqUrl = location.href; vqApplied = false; vqUserOverridden = false; vqWrites = 0;
            vqXgTries = 0; vqXgCooldown = 0; vqXgDone = false; vqNote = '';
            vqTplTryAt = 0; xgHoverAt = 0;
            vqVideoId = '';
        }
        /* ⓪-a v9.45：换了一个视频就把「爬档位」的状态重置一次。
           推荐流一直在同一个 URL 上滚，只看 URL 的话第一个视频的状态会一直沿用：
           第一个视频最高 720P（点完就是"已达标"），后面的 4K 视频再也不会去点。 */
        const vid = vqAwemeId();
        if (vid && vid !== vqVideoId) {
            vqVideoId = vid;
            vqApplied = false; vqUserOverridden = false; vqWrites = 0;
            vqXgTries = 0; vqXgCooldown = 0; vqXgDone = false;
            vqTplTryAt = 0; xgHoverAt = 0;
            vqNote = 'new video, reset';
        }
        /* 〇 已删除：原来先调 window.player.changeDefinition 直接切档。
           实测会把点播视频切成 0x0 播不出来，整条路径已移除。 */
        let raw = vqRead(), cur = vqParse(raw);
        /* ⓿-0 清掉「我们自己以前写进去的残缺档位」：只有内部标识、缺
              gearType/gearClarity 的对象播放器读不懂，留着只会让它卡在这个
              无效档位上。有中文名的则是抖音自己写的，一律不碰。 */
        if (cur && typeof cur === 'object' && cur.done &&
            (cur.gearName || cur.gear_name) && !vqLabelOf(cur) && !vqTplValid(cur)) {
            try { sessionStorage.removeItem(VQ_KEY); } catch (e) {}
            raw = vqRead(); cur = vqParse(raw);
            vqNote = 'cleaned bad switch';
        }
        /* ⓿ 每轮先「学档位」：抖音写的任何一档完整对象都记进库，
              换目标档位时直接取用（用户手动在菜单里点也算）。 */
        if (vqLearn(raw, cur)) vqNote = 'recorded gear: ' + String(cur.gearName || '');
        /* ⓿-b 库里还没有目标档位，就去播放器档位表里现取一份（平台真值，不硬编码） */
        vqEnsureTemplate();

        /* ① 有目标档位对象就回放 —— www 页唯一「不弹菜单、不点按钮」就能生效的路径：
              播放器每次装载视频都会读 MANUAL_SWITCH。
              v9.45：只有「库里这份模板真的到了目标档位」才回放。
              以前是「取库里不超过目标里最高的那份」，库里有 720P 就写 720P ——
              MANUAL_SWITCH 是全局偏好，写了之后连 4K 视频也起在 720P
              （「第一个视频最高 720P，后面全变 720P」就是这么来的）。
              够不到目标时，回放让位给下面的清晰度菜单：点当前视频能吃的最高档，
              抖音自己会写 MANUAL_SWITCH，我们再学进库，库才会往上长。 */
        const pick = vqTplForTarget();
        const targetLv0 = vqTargetLevel();
        const canReplay = !!pick && (targetLv0 <= 0 || pick.level >= targetLv0);
        if (canReplay && !vqIsMax(cur) && !vqUserOverridden && vqWrites <= 4) {
            /* 上一轮我们写过、现在还没到目标档：先分清是谁改的 ——
               · 当前值和我们写的是同一档（抖音只是把 clarityReal 换成了
                 当前视频自己的列表）→ 算生效，不是用户改的；
               · 当前值就是我们写的那份原文 → 播放器没接受，不是用户改的，
                 不能因此永久停手（之前就是这里把 override 置 true，后续全停了）；
               · 当前值被换成了别的档位 → 才认定用户自己在菜单里选了别的。 */
            const sameGear = !!(cur && pick && vqLevelOf(cur) === pick.level &&
                                vqLabelOf(cur) === pick.name);
            if (vqApplied) {
                if (sameGear) {
                    vqApplied = false;
                } else if (raw === vqWroteRaw) {
                    vqApplied = false;
                    /* 同一份对象写两遍都不生效，说明播放器不认，从库里剔掉重学 */
                    if (vqWrites >= 2) {
                        try { delete vqTpls()[pick.name]; vqPersistTpls(); } catch (e) {}
                        vqWrites = 0; vqNote = 'gear rejected, relearn';
                    }
                } else {
                    vqUserOverridden = true;
                }
            } else {
                vqBackupOnce(raw);
                try {
                    /* 对象里没有 clarityReal 时，把当前视频自己的清晰度列表补上 ——
                       播放器靠这个列表找流，缺了它光有 gearName 切不过去 */
                    const tpl = Object.assign({}, pick.obj);
                    if (!Array.isArray(tpl.clarityReal) &&
                        cur && Array.isArray(cur.clarityReal) && cur.clarityReal.length) {
                        tpl.clarityReal = cur.clarityReal.slice();
                    }
                    const written = JSON.stringify(tpl);
                    sessionStorage.setItem(VQ_KEY, written);
                    vqWroteRaw = written;
                    vqApplied = true; vqWrites++;
                    vqNote = 'replayed ' + pick.name;
                } catch (e) {}
            }
        }
        /* ② 顺手看播放器自己的清晰度组件在不在（xgplayer 布局才有）。
             在就切它，切完会自动同步控制栏文案；不在就什么都不做。
             这是「第一次把画质顶到 4K、顺便让抖音自己写出 4K 档位对象」的路：
             悬停唤菜单 → 隔 420ms 回来读菜单项 → 点最高档 → 抖音写 MANUAL_SWITCH
             → 我们旁听学到 4K 模板 → 之后每支视频回放这份模板就起在目标档。 */
        if (!vqUserOverridden && !vqXgDone && Date.now() > vqXgCooldown && vqXgTries < 14) {
            vqXgTries++;
            /* 前几次要快（一气呵成点开菜单并点中档位），之后放慢防抖 */
            vqXgCooldown = Date.now() + (vqXgTries <= 8 ? 200 : 1500);
            const xg = tryXgClarity('video');
            if (xg === 'max') {
                vqXgDone = true;
                /* 播放器自己说「我已是最佳档」——这时抖音通常已经写好
                   MANUAL_SWITCH，下一轮 vqLearn 就会把它收成模板 */
                return;
            }
            if (xg === 'clicked') {
                /* 周期任务 1.5 秒一轮太慢：点完立刻补两次，档位列表一出来就点中 */
                setTimeout(() => { try { applyVideoMaxQuality(); } catch (e) {} }, 260);
                setTimeout(() => { try { applyVideoMaxQuality(); } catch (e) {} }, 620);
                return;
            }
        }
    }
    function restoreVideoQuality() {
        /* 只处理视频流页：直播间/别处调用时不要动这套存储 */
        if (location.hostname !== 'www.douyin.com' || isLivePage()) return;
        let backup = null;
        try { backup = localStorage.getItem(VQ_BACKUP_KEY); } catch (e) {}
        if (backup === null) return;
        if (vqIsMax(vqParse(vqRead()))) {
            try {
                if (backup) sessionStorage.setItem(VQ_KEY, backup);
                else sessionStorage.removeItem(VQ_KEY);
            } catch (e) {}
        }
        try { localStorage.removeItem(VQ_BACKUP_KEY); } catch (e) {}
        /* 学到的模板保留：它只是「怎么拼这份 MANUAL_SWITCH」的缓存，
           本身不改变播放器行为；重开开关可以立刻生效，不用再等学一次。 */
        vqApplied = false; vqUserOverridden = false; vqWrites = 0;
    }
    /* ---- 画质结构探查：一次看清「档位到底能从哪儿拿到」----
       只读、不改任何状态。输出控制在十几行，够定位就行。 */
    function vqProbe() {
        const L = [];
        /* ① 播放器实例：有没有、plugins 里有没有清晰度插件 */
        let p = null;
        try { p = window.player || window.nextPlayer || null; } catch (e) {}
        if (!p || typeof p !== 'object') {
            L.push('player: (无 window.player / nextPlayer)');
        } else {
            let keys = [];
            try { keys = Object.keys(p); } catch (e) {}
            L.push('player: keys(' + keys.length + ')=' + keys.slice(0, 24).join(','));
            let plugs = null;
            try { plugs = p.plugins; } catch (e) {}
            if (plugs && typeof plugs === 'object') {
                let names = [];
                try {
                    if (Array.isArray(plugs)) {
                        names = plugs.map(x => String((x && (x.pluginName || x.name || x.PLUGIN_NAME)) || '?'));
                    } else {
                        names = Object.keys(plugs);
                    }
                } catch (e) {}
                L.push('plugins(' + names.length + '): ' + names.slice(0, 26).join(','));
                /* 清晰度插件里通常挂着 clarityList / definitionList */
                try {
                    const list = Array.isArray(plugs) ? plugs : Object.keys(plugs).map(k => plugs[k]);
                    for (const pl of list) {
                        const nm = String((pl && (pl.pluginName || pl.name || pl.PLUGIN_NAME)) || '');
                        if (!pl || typeof pl !== 'object') continue;
                        let ck = [];
                        try { if (pl.config) ck = Object.keys(pl.config); } catch (e) {}
                        if (ck.length && /clarity|definition|quality/i.test(nm + ' ' + ck.join(' '))) {
                            L.push('  > ' + (nm || '?') + '.config: ' + ck.slice(0, 20).join(','));
                            for (const k of ['clarityList', 'definitionList', 'qualityList']) {
                                let arr = null;
                                try { arr = pl.config[k]; } catch (e) {}
                                if (!Array.isArray(arr)) continue;
                                L.push('  > ' + k + '(' + arr.length + '): ' +
                                    JSON.stringify(arr.slice(0, 4)).slice(0, 420));
                            }
                            /* 档位的中文名 / gearType / gearClarity 到底藏在插件哪一层：
                               · 插件自身（config 之外）的所有键
                               · config.awemeInfo → video 下的每个数组，各打首项 */
                            try {
                                const own = Object.keys(pl).filter(k => k !== 'config');
                                if (own.length) {
                                    L.push('  > ' + nm + '.own: ' + own.slice(0, 26).join(','));
                                }
                                const ai = pl.config && pl.config.awemeInfo;
                                if (ai && typeof ai === 'object') {
                                    L.push('  > awemeInfo: ' + Object.keys(ai).slice(0, 14).join(','));
                                    const vd = ai.video;
                                    if (vd && typeof vd === 'object') {
                                        const vk = Object.keys(vd);
                                        L.push('  > awemeInfo.video: ' + vk.slice(0, 14).join(','));
                                        for (const k2 of vk) {
                                            let arr = null;
                                            try { arr = vd[k2]; } catch (e) {}
                                            if (!Array.isArray(arr) || !arr.length) continue;
                                            L.push('  > video.' + k2 + '(' + arr.length + '): ' +
                                                JSON.stringify(arr[0]).slice(0, 460));
                                        }
                                    }
                                }
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
            }
        }
        /* ② 存储里所有像画质设置的键（比只看 MANUAL_SWITCH 更全） */
        const grab = (store, tag) => {
            const out = [];
            try {
                for (let i = 0; i < store.length && i < 200; i++) {
                    const k = store.key(i);
                    if (!k || !/quality|clarity|definition|gear|manual|bitrate/i.test(k)) continue;
                    const v = store.getItem(k) || '';
                    out.push(tag + '.' + k + '=' + v.slice(0, 90));
                }
            } catch (e) {}
            return out;
        };
        const s1 = grab(sessionStorage, 'S'), s2 = grab(localStorage, 'L');
        L.push('stores: ' + (s1.length + s2.length ? '' : '(无其它画质键)'));
        for (const x of s1.slice(0, 3).concat(s2.slice(0, 3))) L.push('  ' + x);
        /* ③ 当前 clarityReal 里到底有哪些档位（按标识推出最高，和主逻辑同一套规则） */
        const cur = vqParse(vqRead());
        const cr = cur && Array.isArray(cur.clarityReal) ? cur.clarityReal : null;
        if (cr) {
            let bestLv = 0, bestIds = [];
            for (const x of cr) {
                const lv = vqIdentMax({ gear_name: x });
                if (lv > bestLv) { bestLv = lv; bestIds = [x]; }
                else if (lv === bestLv && lv > 0) bestIds.push(x);
            }
            L.push('clarityReal(' + cr.length + '): 最高 lg=' + bestLv + ' 项 ' +
                JSON.stringify(bestIds).slice(0, 120));
        }
        /* ④ 页面上有没有「能点的清晰度入口」 */
        const roots = (function () { try { return xgClarityRoots(); } catch (e) { return []; } })();
        L.push('qualityDom: xgRoots=' + roots.length + ' menuItems=' +
            (function () { try { return qualityMenuItems().length; } catch (e) { return -1; } })() +
            ' curText="' + (function () { try { return currentQualityText(); } catch (e) { return ''; } })() + '"');
        return L.join('\n');
    }
    function videoQualityReport() {
        const raw = vqRead();
        const v = findActiveVideo();
        return [
            'url: ' + location.href,
            'host: ' + location.hostname + ' live=' + isLivePage(),
            'video: ' + (v ? v.videoWidth + 'x' + v.videoHeight + ' paused=' + v.paused : 'none'),
            'MANUAL_SWITCH: ' + (raw || '(empty)'),
            'parsedMax: ' + vqIsMax(vqParse(raw)),
            'target: ' + vqTargetName() + ' (lg=' + vqTargetLevel() + ')' +
                ' / cur lg=' + vqLevelOf(vqParse(raw)),
            'tplLib: ' + (function () {
                const store = vqTpls();
                const names = Object.keys(store);
                if (!names.length) return '(空，还没采集到任何档位对象)';
                return names.map(n => n + '(' + vqLevelOf(store[n]) + ')').join(', ');
            })(),
            'picked: ' + (function () {
                const p = vqTplForTarget();
                return p ? p.name + ' (lg=' + p.level + ')' : '(目标档位还没采集到)';
            })(),
            /* v9.45：这一拍到底会不会回放模板（模板没到目标档就不写，改为点菜单爬档） */
            'canReplay: ' + (function () {
                const p = vqTplForTarget(), t = vqTargetLevel();
                if (!p) return 'no (库里没有可用模板)';
                if (t <= 0 || p.level >= t) return 'yes';
                return 'no (模板 lg=' + p.level + ' < 目标 ' + t + '，改走菜单爬档)';
            })(),
            'videoId: ' + (vqVideoId || '(未读到 awemeId)'),
            'applied: ' + vqApplied + ' override: ' + vqUserOverridden + ' writes: ' + vqWrites,
            'videoDom: xgTries=' + vqXgTries + ' note=' + (vqNote || '-'),
            vqProbe(),
            'backup: ' + (function () {
                try { return localStorage.getItem(VQ_BACKUP_KEY); } catch (e) { return 'n/a'; }
            })()
        ].join('\n');
    }
    function dumpVideoQuality() {
        copyText(videoQualityReport());
        showTip('画质诊断已复制', 1600);
    }

    /* ---- ③-c 直播画质专项诊断 ----
     * 「自动最高画质不生效」要一次看清四件事：有没有锚点、当前档位读到了什么、
     * fiber 里能不能拿到 setCurrentQuality、菜单项在不在。 */
    function dumpLiveQuality() {
        const lines = ['# 抖音优化 · 直播画质诊断', 'URL: ' + location.href];
        lines.push('live: ' + (isLiveHost || isLivePage()) +
                   ' enabled=' + !!config.liveMaxQuality +
                   ' target=' + (config.liveQualityTarget || '-') +
                   '(' + liveTargetName() + '/lv' + liveTargetLevel() + ')' +
                   ' done=' + qualityDone + ' tries=' + qualityDomTries +
                   ' note=' + qualityNote);
        lines.push('curLv=' + liveLevelOf(currentQualityText()) +
                   ' localStorage.webcast_local_quality(目标应写入=' + liveTargetId() + ')');
        lines.push('localStorage.webcast_local_quality = ' +
            (function () { try { return localStorage.getItem('webcast_local_quality'); }
                           catch (e) { return 'n/a'; } })());
        lines.push('currentQualityText() = "' + currentQualityText() + '"');
        const anchors = qualityAnchorEls();
        lines.push('quality anchors (' + anchors.length + '):');
        for (const el of anchors) {
            const r = el.getBoundingClientRect();
            lines.push('  <' + el.tagName.toLowerCase() + '> ' +
                String(el.className || '').slice(0, 60) +
                ' e2e=' + el.getAttribute('data-e2e') +
                ' aria=' + el.getAttribute('aria-label') +
                ' text="' + ((el.innerText || el.textContent || '') + '').trim().slice(0, 24) + '"' +
                ' rect=' + [r.left | 0, r.top | 0, r.width | 0, r.height | 0].join(','));
        }
        const xgRoots2 = xgClarityRoots();
        const xgLb2 = xgClarityLabel();
        const xgRows2 = xgClarityRows();
        lines.push('xgplayer 清晰度: root=' + (xgRoots2.length ? xgRoots2.length + ' 个（首个 <' +
            xgRoots2[0].tagName.toLowerCase() + '>）' : '无') +
            ' | label="' + (xgLb2 ? (xgLb2.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14) : '') +
            '" | 档位列表=' + (xgRows2 ? xgRows2.length + ' 项 → ' +
                xgRows2.map(x => x.text).join(',') : '未打开'));
        const cq = controlQualityEl();
        lines.push('controlQualityEl: ' + (cq
            ? '<' + cq.tagName.toLowerCase() + '> "' +
              ((cq.textContent || '') + '').trim().slice(0, 20) + '"'
            : 'null'));
        const roots = qualityPlayerRoots();
        lines.push('player roots (' + roots.length + '): ' + roots.map(el =>
            '<' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '>').join(' '));
        const known = qualityAnchorsKnown();
        lines.push('known anchors (' + known.length + '):');
        for (const el of known) {
            const r = el.getBoundingClientRect();
            lines.push('  <' + el.tagName.toLowerCase() + '> ' +
                String(el.className || '').slice(0, 56) +
                ' e2e=' + el.getAttribute('data-e2e') +
                ' props=' + !!dyReactProps(el) +
                ' rect=' + [r.left | 0, r.top | 0, r.width | 0, r.height | 0].join(','));
        }
        const hit = resolveQualityHandler();
        if (hit && hit.handler) {
            const h = hit.handler;
            let nowQ = '', list = '';
            try { nowQ = String((h.getCurrentQuality && h.getCurrentQuality()) || ''); } catch (e) {}
            try {
                if (typeof h.getCurrentQualityList === 'function')
                    list = JSON.stringify(h.getCurrentQualityList());
            } catch (e) {}
            if (!list && Array.isArray(hit.list)) list = JSON.stringify(hit.list);
            lines.push('handler: FOUND');
            lines.push('  keys=' + (function () {
                try { return Object.keys(h).slice(0, 24).join(','); } catch (e) { return '?'; }
            })());
            lines.push('  current="' + nowQ + '" list=' + (list || '(n/a)'));
        } else {
            lines.push('handler: NOT FOUND（reactProps / fiber 里都没有 setCurrentQuality）');
        }
        const items = qualityMenuItems();
        lines.push('menu items (' + items.length + '): ' + items.map(x => x.text).join(' / '));
        const text = lines.join('\n');
        try { console.log('[抖音优化] 直播画质诊断\n' + text); } catch (e) {}
        copyText(text);
        showTip('直播画质诊断已复制，直接粘贴给我即可', 2600);
    }
    window.__DY_OPT_DUMP_LIVE_QUALITY__ = dumpLiveQuality;

    /* ---- 7.5 直播间聊天过滤 ---- */
    function getChatMessage(item) {
        const rk = Object.keys(item).find(k =>
            k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0);
        if (!rk) return null;
        let fiber = item[rk], depth = 0;
        while (fiber && depth++ < 12) {
            const mp = fiber.memoizedProps;
            if (mp && mp.message) return mp.message;
            if (mp && mp.children && mp.children.props && mp.children.props.message) {
                return mp.children.props.message;
            }
            fiber = fiber.return;
        }
        return null;
    }

    /* 屏蔽聊天室里的送礼消息 / 福袋口令。
       不再依赖固定哈希 class：先定位聊天室容器，再在容器内按文本特征找
       「最小可隐藏行」，最后才用 fiber 的 method 作精确补充。
       抖音直播的 class 全是随机串，旧版那串 .webcast-chatroom___item /
       [class*="chat-item"] 选择器在改版后一个都命中不了，功能等于空转。 */
    const CHAT_ROOT_SEL = '[data-e2e*="chatroom"], [class*="chatroom"], [class*="ChatRoom"], ' +
        '[data-e2e*="chat-list"], [data-e2e*="chat-item"], [id*="chatroom"], ' +
        '[id*="ChatRoom"], [class*="webcast-chatroom"], [class*="chatroom___"]';
    const GIFT_LINE_RE = /送出了|送出|送给主播|赠送|送了|点亮.*灯牌|加入.*粉丝团|感谢.*送/i;
    const LUCKY_LINE_RE = /福袋|口令|抽奖|参与.*抢|输入.*领|倒计时.*领/i;
    const chatFilterStats = {
        roots: 0, textHits: 0, scanned: 0, hidden: 0, gift: 0, lucky: 0
    };

    let chatRootNote = 'none';
    function findChatRoots() {
        const out = [];
        const all = document.querySelectorAll(CHAT_ROOT_SEL);
        for (let i = 0; i < all.length && i < 120; i++) {
            const el = all[i];
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (r.width < 140 || r.height < 120) continue;
            if (r.width > window.innerWidth * 0.62) continue;
            out.push(el);
        }
        if (out.length) chatRootNote = 'selector';
        const vw0 = window.innerWidth, vh0 = window.innerHeight;
        /* v9.41 兜底 A：结构探测 —— 找「竖向列表容器」。
           旧版这两条兜底都硬性要求「左边界落在右半屏」，直播间换成沉浸式布局后
           聊天室不再贴右，于是一个都挑不出来（诊断里 roots:0、scanned:0，
           功能整体空转）。现在只按尺寸与「可滚动 / 多子节点」筛，不再看左右。 */
        if (!out.length) {
            const cand = document.querySelectorAll('div[class], aside, section');
            let guard0 = 0;
            for (const el of cand) {
                if (++guard0 > 4000) break;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (r.width < 150 || r.width > vw0 * 0.55) continue;
                if (r.height < vh0 * 0.22) continue;
                if (r.top > vh0 * 0.6) continue;
                const scrollable = el.scrollHeight > el.clientHeight + 20;
                if (!scrollable && el.children.length < 3) continue;
                if (el.querySelector('#gm-settings-panel')) continue;
                out.push(el);
                if (out.length >= 6) break;
            }
            if (out.length) chatRootNote = 'layout(A)';
        }
        /* v9.41 兜底 B：文本反查。
           诊断能扫到「赠送」「点亮粉丝团」这些文本节点（说明消息行确实在 DOM 里，
           只是随机 class 全换过、行元素又是 absolute 定位），那就从命中文本往上
           爬到第一个「有实际尺寸」的祖先，把它当聊天室根。 */
        if (!out.length) {
            const SHOW_TEXT0 = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
            let w0 = null;
            try { w0 = document.createTreeWalker(document.body, SHOW_TEXT0); } catch (e) { w0 = null; }
            let node0, guard1 = 0;
            while (w0 && (node0 = w0.nextNode()) && guard1++ < 40000 && out.length < 3) {
                const t0 = (node0.nodeValue || '').trim();
                if (!t0 || t0.length > 80) continue;
                if (!GIFT_LINE_RE.test(t0) && !LUCKY_LINE_RE.test(t0) &&
                    !/点亮粉丝团|加入粉丝团|送出了/.test(t0)) continue;
                let cur = node0.parentElement, d0 = 0;
                while (cur && cur !== document.body && d0++ < 12) {
                    let r;
                    try { r = cur.getBoundingClientRect(); } catch (e) { break; }
                    if (r.width >= 150 && r.width <= vw0 * 0.6 &&
                        r.height >= 120 && r.height <= vh0 * 0.95) {
                        if (!out.some(o => o === cur || o.contains(cur))) out.push(cur);
                        break;
                    }
                    cur = cur.parentElement;
                }
            }
            if (out.length) chatRootNote = 'text(B)';
        }
        if (!out.length) chatRootNote = 'none';
        // 只留最外层，避免父子容器重复扫描
        return out.filter((el, i) =>
            !out.some((o, j) => j !== i && o !== el && o.contains(el))).slice(0, 4);
    }

    function smallestHideable(node, root) {
        let el = node.parentElement, best = null, fallback = null;
        for (let d = 0; el && el !== root && d < 6; d++, el = el.parentElement) {
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { break; }
            if (r.height > 140) break;                 // 已经超出单行范围，停
            if (r.height < 8 || r.width < 60) {
                /* v9.41：虚拟列表的行是 absolute 定位，内层常有 0 尺寸包装层。
                   以前遇到这种层直接 break、整条消息放弃隐藏；现在只记一笔继续往上，
                   真正有尺寸的那层仍然能被选中。 */
                if (!fallback) fallback = el;
                continue;
            }
            best = el;
        }
        return best || fallback;
    }

    function cachedChatRoots(force) {
        const now = Date.now();
        if (force || !chatRootCache.length || now - chatRootAt > 5000) {
            chatRootCache = findChatRoots();
            chatRootAt = now;
        }
        return chatRootCache.filter(el => el.isConnected);
    }

    /* v9.41：**已下线，不再被任何任务调用**（LIVE_TASKS 里已移除）。
       抖音现在的聊天室是虚拟列表（行元素 absolute、高度 0），DOM 藏不干净，
       而且用户要的只是「弹幕层」关掉 —— 那由 danmakuSwitchOff 直接去点抖音自己的开关。
       代码留着是因为下面的诊断还复用它的结构；两个开关键删掉后这里恒为 false。 */
    function filterLiveChat() {
        if ((!config.hideGiftMsg && !config.hideLuckyBag) || !isLivePage()) return;
        /* v9.19：聊天室没有新增消息/文本变化时直接跳过；6 秒一次全量兜底，
           防止 React 复用节点导致漏删。 */
        const nowTs = Date.now();
        const full = nowTs - chatFullAt > 6000;
        if (!chatDirty && !full) return;
        if (full) chatFullAt = nowTs;
        chatDirty = false;
        const roots = cachedChatRoots(full);
        chatFilterStats.roots = roots.length;
        chatFilterStats.textHits = 0;
        chatFilterStats.scanned = 0;
        chatFilterStats.hidden = 0;
        chatFilterStats.gift = 0;
        chatFilterStats.lucky = 0;
        const seen = new Set();
        const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;

        for (const root of roots) {
            let walker;
            try { walker = document.createTreeWalker(root, SHOW_TEXT); }
            catch (e) { continue; }
            let node, guard = 0;
            while ((node = walker.nextNode()) && guard++ < 5000) {
                const t = (node.nodeValue || '').trim();
                if (!t || t.length > 120) continue;
                const isGift = !!config.hideGiftMsg && GIFT_LINE_RE.test(t);
                const isLucky = !!config.hideLuckyBag && LUCKY_LINE_RE.test(t);
                if (!isGift && !isLucky) continue;
                chatFilterStats.textHits++;
                const line = smallestHideable(node, root);
                if (!line || seen.has(line)) continue;
                seen.add(line);
                if (line.querySelector('input, textarea')) continue;
                let box;
                try { box = line.getBoundingClientRect(); } catch (e) { continue; }
                if (box.height > 140 || box.width < 80) continue;
                const full = (line.textContent || '').trim();
                if (full.length > 200) continue;

                let msg = null;
                try { msg = getChatMessage(line); } catch (e) {}
                const payload = (msg && msg.payload) || {};
                const key = msg
                    ? String(msg.method || '') + ':' +
                      String(msg.msg_id || msg.message_id ||
                            (payload.common && payload.common.msg_id) || '')
                    : 'dom:' + full.slice(0, 80);
                if (line.dataset.gmMsg !== key) {
                    line.dataset.gmMsg = key;
                    line.style.removeProperty('display');
                }
                if (line.style.display === 'none') continue;

                let hide = false;
                if (config.hideGiftMsg && msg && msg.method === 'WebcastGiftMessage') hide = true;
                if (!hide && config.hideLuckyBag && msg) {
                    if (msg.method === 'WebcastChatMessage' &&
                        (payload.chat_by === '9' || payload.chat_by === '10')) hide = true;
                    if (msg.method === 'WebcastRoomMessage' &&
                        typeof payload.content === 'string' &&
                        payload.content.indexOf('福袋') >= 0) hide = true;
                }
                if (!hide) {
                    if (isGift && (GIFT_LINE_RE.test(full) ||
                        line.querySelector('[class*="gift"], [class*="Gift"], img[src*="gift"]')))
                        hide = true;
                    if (!hide && isLucky && LUCKY_LINE_RE.test(full)) hide = true;
                }
                chatFilterStats.scanned++;
                if (hide) {
                    line.style.setProperty('display', 'none', 'important');
                    chatFilterStats.hidden++;
                    if (isGift) chatFilterStats.gift++;
                    else chatFilterStats.lucky++;
                }
            }
        }
    }

    /* v9.47：弹幕开关专项诊断。
       现象是「面板能弹出来，但两个开关没被点掉」，所以排查点只有三个：
       文案找不找得到 / 开关配不配得上 / 状态读不读得出。这里自己把面板弹出来，
       把这三步的中间结果全部打印，一次就能看出卡在哪。
       面板是 hover 出来的，合成事件在某些版本弹不出来 —— 真弹不出来就先手动
       把鼠标移到播放器右下角的弹幕按钮上，再点这个按钮。 */
    function dumpDanmakuSwitch() {
        const icon = document.querySelector('[data-e2e="danmaku-setting-icon"]');
        if (!icon) {
            copyText('# 弹幕开关诊断\n没有找到 [data-e2e="danmaku-setting-icon"]');
            showTip('没找到弹幕设置图标', 2000);
            return;
        }
        const props = dyReactProps(icon);
        const canHover = !!(props && typeof props.onMouseEnter === 'function');
        if (canHover) openDanmakuPanel(icon, props);
        /* 面板是 hover 出来的：点按钮时鼠标必然离开播放器，面板会跟着收起。
           所以留 3 秒窗口，让用户把鼠标挪回弹幕按钮上把面板重新hover出来。 */
        showTip('请把鼠标移到右下角弹幕按钮上，面板一出现就自动抓取', 3200);
        const collect = () => {
            const lines = [];
            const p = (x) => lines.push(x);
            const box = (el) => {
                let r = null; try { r = el.getBoundingClientRect(); } catch (e) {}
                return r ? [r.left, r.top, r.width, r.height].map(n => Math.round(n)).join(',') : '(无)';
            };
            const cls = (el) => {
                const c = String((el && el.className) || '');
                return c.length > 46 ? c.slice(0, 46) + '…' : c;
            };
            const bg = (el) => {
                try { return window.getComputedStyle(el).backgroundColor || ''; } catch (e) { return ''; }
            };
            p('# 抖音优化 · 弹幕开关诊断');
            p('url: ' + location.href);
            /* 这一行最关键：false 就代表功能整个没启动，后面几段再完美也不会动。
               同时把 localStorage 里的原值也打出来，分清是「没开」还是「没存进去」。 */
            let stored = '(读不到)';
            try {
                const raw = localStorage.getItem(CONFIG_KEY);
                const obj = raw ? JSON.parse(raw) : null;
                if (obj && Object.prototype.hasOwnProperty.call(obj, 'danmakuSwitchOff'))
                    stored = String(obj.danmakuSwitchOff) + ' (v=' + (obj.__v == null ? '?' : obj.__v) + ')';
                else if (obj) stored = '(存档里没有这个键 → 走默认 false)';
            } catch (e) { stored = '(解析失败)'; }
            p('config.danmakuSwitchOff: ' + config.danmakuSwitchOff +
              (config.danmakuSwitchOff ? '' : '   ← 功能是关着的，不会执行任何点击'));
            p('localStorage.danmakuSwitchOff: ' + stored + ' | crossDomainSync=' + config.crossDomainSync);
            p('icon: rect=' + box(icon) + ' | props=' + (props ? 'yes' : 'no') +
              ' | onMouseEnter=' + canHover);
            p('state: done=' + JSON.stringify(danmakuDone) +
              ' busy=' + danmakuBusy + ' attempts=' + danmakuAttempts +
              ' cooldownMs=' + Math.max(0, danmakuCooldownUntil - Date.now()) +
              ' note=' + danmakuNote);
            p('');

            /* ① 文案：不限定层级，凡是文字里含这两个词的元素都列出来 */
            const labels = ['送礼信息', '福袋口令'];
            const found = {};
            const allEls = document.querySelectorAll('div,span,label,i,em,p,button,strong');
            const cap = Math.min(allEls.length, 9000);
            for (const lab of labels) {
                const hits = [];
                for (let i = 0; i < cap; i++) {
                    const el = allEls[i];
                    if (inOurPanel(el)) continue;
                    const t = (el.textContent || '').trim();
                    if (t !== lab) continue;            // 只认完全等于文案的节点
                    const r = el.getBoundingClientRect();
                    if (!r.width && !r.height) continue;
                    hits.push({ el: el, r: r });
                }
                /* 同一行会有多个祖先都「textContent === 文案」，只保留最小（叶子）那个 */
                hits.sort((a, b) => (a.el.querySelectorAll('*').length - b.el.querySelectorAll('*').length));
                found[lab] = hits;
                p('## 文案「' + lab + '」命中 ' + hits.length + ' 个（按子元素数排序，第 1 个是最叶子）');
                hits.slice(0, 4).forEach((h, i) => {
                    p('  [' + i + '] <' + h.el.tagName.toLowerCase() + '> class="' + cls(h.el) +
                      '" rect=' + box(h.el) + ' kids=' + h.el.querySelectorAll('*').length +
                      ' bg=' + bg(h.el));
                    p('       父: <' + (h.el.parentElement ? h.el.parentElement.tagName.toLowerCase() : '-') +
                      '> class="' + (h.el.parentElement ? cls(h.el.parentElement) : '') + '"');
                });
                if (!hits.length) p('  (没有) —— 面板可能没弹出来，先把鼠标移到弹幕按钮上再试');
                p('');
            }

            /* ② 每个文案右侧的候选：开关到底长什么样、状态读成什么 */
            for (const lab of labels) {
                const first = (found[lab] || [])[0];
                if (!first) continue;
                const lr = first.r;
                const lcy = (lr.top + lr.bottom) / 2;
                const cands = [];
                for (let i = 0; i < cap; i++) {
                    const el = allEls[i];
                    if (inOurPanel(el) || el === first.el) continue;
                    if (el.contains(first.el) || first.el.contains(el)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 12 || r.width > 120 || r.height < 8 || r.height > 56) continue;
                    const cy = (r.top + r.bottom) / 2;
                    if (Math.abs(cy - lcy) > 26) continue;          // 同一行
                    if (r.left < lr.left - 6) continue;             // 在右侧
                    if (r.left - lr.right > 420) continue;          // 别太远
                    cands.push({ el: el, r: r, d: Math.abs(cy - lcy) + (r.left - lr.right) * 0.05 });
                }
                cands.sort((a, b) => a.d - b.d);
                p('## 「' + lab + '」右侧同行候选（按距离排序）');
                if (!cands.length) p('  (没有候选 —— 阈值内一个都没匹配上)');
                cands.slice(0, 8).forEach((c, i) => {
                    const a = c.el.getAttribute ? (c.el.getAttribute('aria-checked') || '') : '';
                    const role = c.el.getAttribute ? (c.el.getAttribute('role') || '') : '';
                    const h = dyCheckboxHandler(c.el);
                    p('  [' + i + '] <' + c.el.tagName.toLowerCase() + '> class="' + cls(c.el) +
                      '" rect=' + box(c.el) + ' role=' + (role || '-') + ' aria=' + (a || '-') +
                      ' bg=' + bg(c.el));
                    p('       checked=' + String(h.checked) + ' explicit=' + h.explicit +
                      ' onClick=' + (typeof h.onClick === 'function' ? 'yes' : 'no'));
                });
                p('');
            }

            /* ③ SWITCH_SEL 全局命中：如果上面候选全是普通 div，这里能看出真正的开关类名 */
            let switches = [];
            try { switches = Array.from(document.querySelectorAll(SWITCH_SEL)); } catch (e) {}
            p('## SWITCH_SEL 全局命中 ' + switches.length + ' 个（列表前 20，只取视口内的）');
            let shown = 0;
            for (const sw of switches) {
                if (shown >= 20) break;
                const r = sw.getBoundingClientRect();
                if (!r.width || !r.height) continue;
                shown++;
                const h = dyCheckboxHandler(sw);
                p('  <' + sw.tagName.toLowerCase() + '> class="' + cls(sw) + '" rect=' + box(sw) +
                  ' bg=' + bg(sw) + ' checked=' + String(h.checked) + ' explicit=' + h.explicit);
            }
            if (!shown) p('  (一个都没命中)');
            p('');
            p('# 说明：note 显示 no-label / no-switch / unknown-state / weak-off 时，');
            p('#       对照上面三段就能知道是「文案没找到」「右侧没候选」还是「状态读不出」。');

            copyText(lines.join('\n'));
            showTip('弹幕开关诊断已复制', 1600);
            try { closeDanmakuPanel(icon, props); } catch (e) {}
        };
        /* 面板一出现就抓，最多等 6 秒。中途手动悬停、合成 hover 成功都能救回来。 */
        let waited = 0;
        const tick = () => {
            waited++;
            const ready = !!findDanmakuLabelEl('送礼信息') || !!findDanmakuLabelEl('福袋口令');
            if (ready || waited > 15) { collect(); return; }
            setTimeout(tick, 400);
        };
        setTimeout(tick, 400);
    }

    /* 排障：导出聊天室结构、命中文本与元素父链，一次定位选择器/文案问题。 */
    function dumpLiveFilter() {
        const lines = [];
        const push = (x) => lines.push(x);
        push('# 抖音优化 · 消息过滤诊断');
        push('URL: ' + location.href);
        push('time: ' + new Date().toISOString());
        push('config: danmakuSwitchOff=' + config.danmakuSwitchOff +
             ' hideLivePopups=' + config.hideLivePopups +
             ' hideEffects=' + config.hideEffects);
        push('stats: ' + JSON.stringify(chatFilterStats));
        const dIcon = document.querySelector('[data-e2e="danmaku-setting-icon"]');
        push('danmaku settings: icon=' + !!dIcon +
             ' props=' + (dIcon ? !!dyReactProps(dIcon) : false) +
             ' done=' + JSON.stringify(danmakuDone) + ' busy=' + danmakuBusy +
             ' attempts=' + danmakuAttempts +
             ' cooldownMs=' + Math.max(0, danmakuCooldownUntil - Date.now()) +
             ' labelGift=' + !!findDanmakuLabelEl('送礼信息') +
             ' labelLucky=' + !!findDanmakuLabelEl('福袋口令') +
             ' switches=' + document.querySelectorAll(SWITCH_SEL).length +
             ' note=' + danmakuNote);
        push('max quality: done=' + qualityDone + ' currentUrl=' +
             (qualityLastUrl === location.href) + ' domTries=' + qualityDomTries +
             ' target=' + config.liveQualityTarget + '/' + liveTargetLevel() +
             ' curLv=' + liveLevelOf(currentQualityText()) +
             ' note=' + qualityNote +
             ' current="' + currentQualityText() + '"' +
             ' anchors=' + qualityAnchorEls().length +
             ' menuItems=' + qualityMenuItems().length);
        try {
            const av = mainLiveVideo();
            push('audio: resumeAudio=' + config.resumeAudio +
                 ' video=' + !!av + ' muted=' + (av ? av.muted : '-') +
                 ' paused=' + (av ? av.paused : '-') +
                 ' volume=' + (av ? av.volume : '-') +
                 ' manualMute=' + userMutedManually +
                 ' resumeGuardMs=' + Math.max(0, resumeGuardUntil - Date.now()));
        } catch (e) { push('audio: n/a'); }
        push('sidebar: topApplied=' + innerTopApplied +
             ' liveSidebar=' + config.liveSidebar +
             ' touched=' + document.querySelectorAll('[data-gm-sidebar-touched]').length +
             ' folded=' + document.querySelectorAll('[data-gm-nav-gap], [data-gm-nav-gap-b]').length);
        /* v9.37.7：侧栏上下留白单独一行 —— 量的是图标/文字真实边界到卡片上下边 */
        push('  sidebar gap: ' + (sidebarGapDbg || '未测量（菜单项没匹配到）') +
             ' | 已写 shift=' + (sidebarPadApplied || '-'));
        /* v9.37.2：把侧栏内层的直接子块逐个打出来 —— 底部那块占位到底有没有文字、
           有没有被折掉，一眼就能看出来 */
        (function () {
            const root = document.querySelector('.xydy-sidebar-root') ||
                document.querySelector('[data-e2e="douyin-navigation"]');
            if (!root) { push('  inner: 无侧栏'); return; }
            const inner = root.querySelector('[data-e2e="douyin-navigation"]') || root;
            const kids = Array.prototype.slice.call(inner.children || [], 0, 6);
            const out = kids.map((k, i) => {
                let r;
                try { r = k.getBoundingClientRect(); } catch (e) { return '#' + i + ' ?'; }
                let cs;
                try { cs = window.getComputedStyle(k); } catch (e) { cs = {}; }
                const el2 = k;
                return '#' + i + ' ' + k.tagName.toLowerCase() +
                    '.' + String(k.className || '').trim().split(/\s+/).slice(0, 2).join('.') +
                    ' ' + (r.width | 0) + 'x' + (r.height | 0) + '@' + (r.top | 0) +
                    ' disp=' + (cs.display || '?') +
                    ' txt=' + ((el2.textContent || '').trim().length) +
                    ' mark=' + (k.hasAttribute('data-gm-nav-gap') ? 'Y' :
                               (k.hasAttribute('data-gm-nav-gap-b') ? 'B' : 'N'));
            });
            push('  inner kids(' + kids.length + '): ' + out.join(' | '));
        })();
        push('hidden chat rows: ' +
             document.querySelectorAll('[data-gm-msg][style*="display: none"]').length);
        push('hidden popups: ' + document.querySelectorAll('[data-gm-popup-hidden]').length);
        /* v9.37.1：ShortTouch 挂件（左上角「抢福袋」这类）是 Lynx 渲染的，
           文字扫不到，只能看元素本身在不在、有没有被隐藏 */
        (function () {
            const st = document.querySelectorAll(
                'pace-island, [id^="ShortTouchLayout"], [class*="ShortTouchContainer"]');
            let shown = 0;
            const brief = [];
            st.forEach((e, i) => {
                const cs = window.getComputedStyle(e);
                const r = e.getBoundingClientRect();
                if (cs.display !== 'none' && r.width > 2 && r.height > 2) shown++;
                if (i < 8) brief.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
                    ' ' + (r.width | 0) + 'x' + (r.height | 0) + ' disp=' + cs.display);
            });
            push('short-touch: ' + st.length + ' 个，可见 ' + shown +
                 (brief.length ? ' → ' + brief.join(' | ') : ''));
        })();
        /* v9.37.1：谁被我们隐藏了、为什么 —— 福袋图标消失时一眼能看出来是不是我们干的 */
        document.querySelectorAll('[data-gm-popup-hidden]').forEach((el, i) => {
            if (i >= 12) return;
            const b = el.getBoundingClientRect();
            push('  [hidden] ' + el.tagName.toLowerCase() +
                 '.' + String(el.className || '').trim().split(/\s+/).slice(0, 3).join('.') +
                 ' rect=' + [b.left | 0, b.top | 0, b.width | 0, b.height | 0].join(',') +
                 ' text="' + (el.textContent || '').trim().slice(0, 60) + '"');
        });
        /* 福袋元素普查：文本含「福袋」的元素，逐层报告可见性与是否被我们标记 */
        push('lucky elements (text 含 福袋):');
        (function () {
            const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
            let w2 = null, node2, n2 = 0, guard2 = 0;
            try { w2 = document.createTreeWalker(document.body, SHOW_TEXT); } catch (e) { return; }
            const seen = new Set();
            while ((node2 = w2.nextNode()) && guard2++ < 30000 && n2 < 14) {
                const tx = (node2.nodeValue || '').trim();
                if (!tx || tx.length > 40 || tx.indexOf('福袋') < 0) continue;
                let el2 = node2.parentElement, d2 = 0, hit = null;
                while (el2 && d2++ < 6) {
                    if (el2.hasAttribute && el2.hasAttribute('data-gm-popup-hidden')) { hit = el2; break; }
                    el2 = el2.parentElement;
                }
                const root2 = hit || node2.parentElement;
                if (!root2 || seen.has(root2)) continue;
                seen.add(root2);
                const bb = root2.getBoundingClientRect();
                let st2 = { display: '', visibility: '', position: '' };
                try { st2 = window.getComputedStyle(root2); } catch (e3) {}
                push('  "' + tx.slice(0, 28) + '" -> ' + root2.tagName.toLowerCase() +
                     '.' + String(root2.className || '').trim().split(/\s+/).slice(0, 3).join('.') +
                     ' rect=' + [bb.left | 0, bb.top | 0, bb.width | 0, bb.height | 0].join(',') +
                     ' disp=' + st2.display + ' vis=' + st2.visibility + ' pos=' + st2.position +
                     (hit ? '  ★被本脚本隐藏' : ''));
                n2++;
            }
        })();
        const roots = findChatRoots();
        push('chat roots (' + roots.length + ') 来源=' + chatRootNote + ':');
        for (const r of roots) {
            const b = r.getBoundingClientRect();
            push('  ' + r.tagName.toLowerCase() + (r.id ? '#' + r.id : '') +
                 '.' + String(r.className || '').slice(0, 100) +
                 ' rect=' + [b.left | 0, b.top | 0, b.width | 0, b.height | 0].join(',') +
                 ' children=' + r.children.length);
        }
        /* v9.41：根节点候选（不看左右半屏，只按尺寸与可滚动/多子节点筛），
           以后 roots 又变成 0 时，直接从这几条里挑真身。 */
        (function () {
            const vw = window.innerWidth, vh = window.innerHeight;
            const cands = [];
            const list = document.querySelectorAll('div[class], aside, section');
            let g = 0;
            for (const el of list) {
                if (++g > 4000 || cands.length >= 8) break;
                if (el.closest && el.closest('#gm-settings-panel')) continue;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (r.width < 140 || r.width > vw * 0.6) continue;
                if (r.height < vh * 0.2) continue;
                const scr = el.scrollHeight > el.clientHeight + 20;
                if (!scr && el.children.length < 3) continue;
                cands.push(el);
            }
            push('root probe (' + cands.length + '):');
            for (const el of cands) {
                const b = el.getBoundingClientRect();
                push('  ' + el.tagName.toLowerCase() +
                     '.' + String(el.className || '').trim().split(/\s+/).slice(0, 3).join('.') +
                     ' rect=' + [b.left | 0, b.top | 0, b.width | 0, b.height | 0].join(',') +
                     ' kids=' + el.children.length +
                     ' scroll=' + (el.scrollHeight > el.clientHeight + 20) +
                     ' rows=' + el.querySelectorAll('div').length);
            }
        })();
        const kw = /送出了|送出|赠送|送给主播|福袋|口令|抽奖|去送礼|展馆|集星|点亮/;
        push('keyword text nodes (max 50):');
        const SHOW_TEXT = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4;
        let n = 0, guard = 0, node;
        let w;
        try { w = document.createTreeWalker(document.body, SHOW_TEXT); } catch (e) { w = null; }
        while (w && (node = w.nextNode()) && guard++ < 30000 && n < 50) {
            const t = (node.nodeValue || '').trim();
            if (!t || t.length > 160 || !kw.test(t)) continue;
            const el = node.parentElement;
            if (!el) continue;
            const b = el.getBoundingClientRect();
            const chain = [];
            let p = el, d = 0;
            while (p && d++ < 4) {
                let st;
                try { st = window.getComputedStyle(p); } catch (e2) { break; }
                chain.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') +
                    '.' + String(p.className || '').trim().split(/\s+/).slice(0, 2).join('.') +
                    '[' + st.position + '/z' + st.zIndex + '/' +
                    (b.width | 0) + 'x' + (b.height | 0) + ']');
                p = p.parentElement;
            }
            push('  "' + t.slice(0, 90) + '"  <- ' + chain.join(' < '));
            n++;
        }
        const text = lines.join('\n');
        try { console.log('[抖音优化] 消息过滤诊断\n' + text); } catch (e) {}
        copyText(text);
        showTip('已复制消息过滤诊断，直接粘贴给我即可', 2800);
    }
    window.__DY_OPT_DUMP_LIVE_FILTER__ = dumpLiveFilter;

    /* ---- 7.6 真实在线人数 ----
     * v9.5：v9.4 仍然静默失败，因为整条链路「读不到精确数字就不渲染」。
     * 抖音的实时人数由接口 / WS 写进内部 store，DOM 只给「1万」这种缩写，
     * React props 里往往没有精确值。现在改成五条独立通道 + 量级校验：
     *   A 页面自身 fetch / XHR 响应（document-start 挂钩，只读 clone）
     *   B React fiber 全链（WeakSet 防环）
     *   C window 上的全局 store / SSR 对象
     *   D 内联 script（含转义 / URL 编码 JSON）
     *   E 已缓存值（读不到时沿用上次结果，不清空显示） */
    let realCountCache = null, lastCountReadAt = 0, scaleCache = null, scaleAt = 0;
    let smallCountStreak = 0;      // 连续出现「疑似别的房间小值」的次数
    let pollFail = 0, pollApiIdx = 0, lastPollAt = 0, pollNote = 'idle', nativeFetchRef = null;
    /* v9.43：人数刷新的「事件驱动」闸门 —— 网络/WS 一抓到新值就 80ms 后刷一次，
       不用干等下一个定时器，也不至于一条消息一刷把 DOM 写爆。 */
    let countRefreshTimer = 0, countRefreshDue = 0;
    /* 页面自己的人数文本往前走了 → 下一拍立刻主动轮询，不等完整间隔。 */
    let pollUrgent = false;

    const COUNT_KEY_RE  = /display_value|display_long|user_count|online_user|total_user|viewer_count|watch_count|audience_count|room_user|real_count|online_count|visitor_count|view_count|user_num|user_total|room_view_stats/i;
    const COUNT_WEAK_RE = /count|user|view|audience|online|watch|total|num|people/i;
    const COUNT_TEXT_RE = /display_value|display_long|user_count|total_user|room_view_stats|online_user|viewer_count|watch_count|audience|user_num|user_total|room_user|user_count_str/i;
    const COUNT_FIELD_RE = /"(display_value|display_long|user_count|total_user|online_user_count|viewer_count|watch_count|audience_count|room_user_count|real_count|online_count|visitor_count|view_count|user_num|user_total|room_view_stats)"\s*:\s*"?([0-9][0-9,]{0,12})"?/g;
    /* v9.41：这些键虽然带 count 字样，但全是 AB 实验阈值 / 组件内部计数，
       跟在线人数毫无关系。诊断里 `familiarRecommendEntranceCountLabelCondition: 1000`
       就是被当成人数写上去的那个 —— 用户看到「人数固定在 1000」。
       与其在打分阶段补救，不如在入口就丢掉。 */
    const COUNT_NOISE_RE = /(?:^count$|countlabel|countlimit|count_threshold|threshold|prefetch|reconnect|retrycount|corecount|itemcount|channelcount|unbounddeps|defaultcount|cold_start|staticitem|slidingwindow|danmaku|survey|useredit|selecttab|abtest)/i;
    const COUNT_STRONG_KEY_RE = /display_value|display_long|room_view_stats|user_count|total_user|online_user|viewer_count|watch_count|audience_count/i;
    const countHints = [];                 // 网络通道捕获到的候选（跨轮询保留）
    const countApis = new Map();           // 曾返回过人数字段的同源接口，供主动复取
    /* 人数越过旧量级时把参照区间跟着抬/降，避免 DOM 的「1万」把后续
       更大/更小的真实人数全部判成越界，显示永久冻在一个数字上。 */
    function widenScale(v) {
        if (!(v > 0)) return;
        if (!scaleCache || v > scaleCache[1] || v < scaleCache[0])
            scaleCache = [Math.max(1, v * 0.4), v * 2.5];
        scaleAt = Date.now();
    }
    /* v9.45：只把「房间级」接口记进复取清单，并且只认它。
       之前把 `/webcast/web/feed/follow/`（推荐流）也记下来了：轮询它
       每次回来的是**几十个房间**的人数（120~500 那一堆），全被当成
       「新鲜候选」。真实房间那 2 万在打分里被这批小数压掉，显示就锁在
       小房间的数字上了 —— 诊断里显示 429、量级 [134,837.5] 就是这么来的。 */
    const ROOM_API_RE = /\/webcast\/room\/(web\/enter|info|web\/info|stats|info_by_scene|web\/stats)/i;
    const FEED_API_RE = /\/(feed|recommend|hot|rank|ranklist)\//i;
    function rememberApi(url, maxVal) {
        if (!url || !/^https?:/.test(url) || !(maxVal >= 100)) return;
        if (!ROOM_API_RE.test(url) || FEED_API_RE.test(url)) return;
        if (countApis.has(url)) countApis.delete(url);
        countApis.set(url, { max: maxVal, at: Date.now() });
        while (countApis.size > 8) countApis.delete(countApis.keys().next().value);
    }
    function bestApiUrl() {
        let best = null, bestDiff = Infinity;
        const ref = realCountCache || 0;
        for (const entry of countApis) {
            if (!ROOM_API_RE.test(entry[0])) continue;      // 只轮询房间级接口
            const diff = ref ? Math.abs(entry[1].max - ref) / ref : -entry[1].max;
            if (diff < bestDiff) { bestDiff = diff; best = entry[0]; }
        }
        return best;
    }

    function toCount(v) {
        if (typeof v === 'number')
            return Number.isFinite(v) && v >= 1 && v <= 1e8 && Math.floor(v) === v ? v : null;
        if (typeof v === 'string') {
            const t = v.replace(/,/g, '').trim();
            if (!/^\d{1,9}$/.test(t)) return null;
            const n = Number(t);
            return n >= 1 && n <= 1e8 ? n : null;
        }
        return null;
    }
    function pushHint(src, key, value) {
        if (COUNT_NOISE_RE.test(key)) return;
        const n = toCount(value);
        if (n == null) return;
        const now = Date.now();
        // v9.6：同一个 (key,value) 再次上报时只刷新时间戳；不同值一律新增，
        // 不再因为「值出现过」就丢弃，否则后续人数变化永远进不了候选池。
        const old = countHints.find(h => h.value === n && h.key === key);
        if (old) { old.at = now; return; }
        countHints.push({ src: src, key: key, value: n, at: now });
        if (countHints.length > 80) countHints.shift();
        /* v9.43：新数值一到就催一次刷新 —— 以前要等主循环 1.5s 那一拍，
           现在推送落地后 ~80ms 就能写进页面。 */
        if (n !== realCountCache) scheduleCountRefresh(80);
    }
    function pushHit(hits, src, key, value, strong) {
        if (COUNT_NOISE_RE.test(key)) return;
        const n = toCount(value);
        if (n == null) return;
        hits.push({ src: src, key: key, value: n, strong: !!strong });
    }
    /* v9.19：直播页的 JSON 响应很密集，旧版每个响应都 clone 一份再全文正则，
       内存与 CPU 都翻倍。这里加一个每秒 6 次的预算，超出直接跳过本轮扫描
       （fiber / DOM 两条通道仍在，不会断更）。 */
    /* v9.41：进房那一波请求里，真正带人数的接口（/webcast/room/web/enter/ 之类）
       往往和一堆埋点挤在同一秒，被每秒 6 次的预算挤掉就再也抓不到了。
       这里给「像人数接口」的 URL 开个优先通道，不受预算限制。
       同时把请求 URL 记进诊断，方便一眼看出人数到底走哪个接口。 */
    const COUNT_PRIO_RE = /webcast|\/room\/|enter|stats|audience/i;
    const reqLog = [];
    function logReq(url) {
        if (!url) return;
        let u = String(url).split('#')[0];
        if (u.length > 200) u = u.slice(0, 200);
        if (reqLog.indexOf(u) >= 0) return;
        reqLog.push(u);
        if (reqLog.length > 60) reqLog.shift();
    }
    let countScanWindow = 0, countScanCount = 0;
    function countScanBudget() {
        if (!config.showViewerCount) return false;
        const now = Date.now();
        if (now - countScanWindow > 1000) { countScanWindow = now; countScanCount = 0; }
        return ++countScanCount <= 6;
    }
    function scanJsonForCount(text, src, hits, url) {
        if (!text || typeof text !== 'string' || text.length > 1500000) return;
        if (!COUNT_TEXT_RE.test(text)) return;
        let maxVal = 0, guard = 0, m;
        /* v9.45：先单独捞「本房间」的那份 room_view_stats。
           直播接口的响应里除了当前房间，还可能夹着推荐位 / 关联房间的数据，
           它们同样叫 display_value。room_view_stats 只属于当前房间，
           单拎出来打高分，避免跟别的房间的数字混在一锅里比。 */
        if (text.indexOf('room_view_stats') >= 0) {
            const RVS_RE = /"room_view_stats"\s*:\s*\{[^{}]{0,400}?"display_(?:value|long)"\s*:\s*"?([0-9][0-9,]{0,12})/g;
            let rv, g2 = 0;
            while ((rv = RVS_RE.exec(text)) !== null && g2++ < 8) {
                const n = toCount(rv[1]);
                if (n == null) continue;
                if (n > maxVal) maxVal = n;
                if (hits) pushHit(hits, src, 'room_view_stats', rv[1], true);
                else pushHint(src, 'room_view_stats', rv[1]);
            }
        }
        COUNT_FIELD_RE.lastIndex = 0;
        while ((m = COUNT_FIELD_RE.exec(text)) !== null && guard++ < 120) {
            const n = toCount(m[2]);
            if (n != null && n > maxVal) maxVal = n;
            if (hits) pushHit(hits, src, m[1], m[2], true);
            else pushHint(src, m[1], m[2]);
        }
        // 缩写值（"1w+" / "1.2万"）不入候选池，避免把估算值当精确人数显示
        if (!hits && url && maxVal) rememberApi(url, maxVal);
    }

    /* document-start 同步挂钩：只读 clone / 附加一个独立的 load 监听，
       不消费响应体、不替换页面自己的回调，对页面行为零影响。 */
    function installCountHooks() {
        try {
            nativeFetchRef = window.fetch;
            const nativeFetch = nativeFetchRef;
            if (typeof nativeFetch === 'function' && !nativeFetch.__dyCountHooked) {
                const hooked = function () {
                    let reqUrl = '';
                    try {
                        const a = arguments[0];
                        reqUrl = typeof a === 'string' ? a : (a && a.url) || '';
                    } catch (e) {}
                    const p = nativeFetch.apply(this, arguments);
                    try {
                        if (p && typeof p.then === 'function') {
                            p.then(function (res) {
                                try {
                                    if (!res || typeof res.clone !== 'function') return;
                                    const get = res.headers && res.headers.get &&
                                                res.headers.get.bind(res.headers);
                                    const ct = get ? (get('content-type') || '') : '';
                                    if (/image|video|audio|font|octet-stream|protobuf|wasm/i.test(ct)) return;
                                    const len = get ? Number(get('content-length')) : 0;
                                    if (len > 2000000) return;
                                    const scanUrl = String(res.url || reqUrl || '');
                                    logReq(scanUrl);
                                    if (!config.showViewerCount) return;
                                    /* v9.45：推荐流 / 榜单类的响应不扫 —— 里面装的是
                                       一堆别的房间的人数，扫进来就是给打分喂噪声。 */
                                    if (FEED_API_RE.test(scanUrl)) return;
                                    if (!COUNT_PRIO_RE.test(scanUrl) && !countScanBudget()) return;
                                    res.clone().text().then(function (t) {
                                        scanJsonForCount(t, 'fetch', null, scanUrl);
                                    }).catch(function () {});
                                } catch (e) {}
                            }).catch(function () {});
                        }
                    } catch (e) {}
                    return p;
                };
                hooked.__dyCountHooked = true;
                window.fetch = hooked;
            }
        } catch (e) {}
        try {
            const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
            if (XP && !XP.__dyCountHooked) {
                const nativeAdd = XP.addEventListener, nativeSend = XP.send, nativeOpen = XP.open;
                if (nativeOpen) XP.open = function (method, url) {
                    try {
                        this.__dyUrl = String(url || '');
                        logReq(this.__dyUrl);
                    } catch (e) {}
                    return nativeOpen.apply(this, arguments);
                };
                XP.send = function () {
                    const self = this;
                    try {
                        if (nativeAdd) nativeAdd.call(this, 'load', function () {
                            try {
                                if (!config.showViewerCount) return;
                                const u = String(self.__dyUrl || '');
                                if (FEED_API_RE.test(u)) return;      // v9.45：推荐流不扫
                                if (!COUNT_PRIO_RE.test(u) && !countScanBudget()) return;
                                scanJsonForCount(self.responseText, 'xhr', null, u);
                            } catch (e) {}
                        });
                    } catch (e) {}
                    return nativeSend.apply(this, arguments);
                };
                XP.__dyCountHooked = true;
            }
        } catch (e) {}
        installWebSocketHook();
    }

    /* WebSocket 只接文本 / JSON 消息，不猜二进制 protobuf，
       避免把随机字节当成人数显示出来。 */
    /* v9.41：诊断用统计。抖音直播的人数推送走 protobuf 二进制，
       旧的 scanWsMessage 只认字符串/Blob，二进制直接丢掉 —— 于是
       「网络通道 0 条」看着像是没收到消息，其实收到了只是没解。
       这里只做计数和留样（把前几条含「万/观看/人数」的消息解成可读文本），
       不猜结构、不产出数字；前 200 条之后只计数，避免拖慢直播页。 */
    const wsStats = { text: 0, bin: 0, jsonHits: 0, samples: [], hex: [] };
    function hexHead(buf, n) {
        let out = '';
        try {
            const u = new Uint8Array(buf, 0, Math.min(n, buf.byteLength));
            for (let i = 0; i < u.length; i++)
                out += (u[i] < 16 ? '0' : '') + u[i].toString(16) + ' ';
        } catch (e) { out = '?'; }
        return out.trim();
    }
    function scanWsMessage(data) {
        if (!data) return;
        if (typeof data === 'string') {
            wsStats.text++;
            if (COUNT_TEXT_RE.test(data)) wsStats.jsonHits++;
            scanJsonForCount(data, 'ws', null);
            return;
        }
        if (typeof Blob !== 'undefined' && data instanceof Blob && data.size < 300000) {
            wsStats.bin++;
            try { data.text().then(t => scanJsonForCount(t, 'ws', null)).catch(() => {}); } catch (e) {}
            return;
        }
        if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
            wsStats.bin++;
            if (wsStats.bin <= 200 && data.byteLength && data.byteLength < 400000) {
                /* 留地条 hex：一眼看出是 protobuf（开头 0x08/0x0a 之类）还是
                   已经被 gzip（1f 8b）、要不要解压。只取前 24 字节，几乎零开销。 */
                if (wsStats.hex.length < 4 && data.byteLength >= 8) {
                    wsStats.hex.push(data.byteLength + 'B ' + hexHead(data, 24));
                }
                try {
                    const txt = new TextDecoder('utf-8').decode(new Uint8Array(data));
                    if (wsStats.samples.length < 6 && /万|观看|人数|在线/.test(txt)) {
                        wsStats.samples.push(data.byteLength + 'B :: ' +
                            txt.replace(/[^\x20-\x7e\u4e00-\u9fa5]+/g, '·').slice(0, 220));
                    }
                } catch (e) {}
            }
        }
    }
    function installWebSocketHook() {
        try {
            const Orig = window.WebSocket;
            if (!Orig || Orig.__dyWrapped) return;
            // 只额外挂一个只读监听，不改页面自己的监听器（removeEventListener 仍有效）
            const Wrapped = function (url, protocols) {
                const ws = protocols === undefined ? new Orig(url) : new Orig(url, protocols);
                try {
                    ws.addEventListener('message', function (ev) {
                        try { scanWsMessage(ev && ev.data); } catch (e) {}
                    });
                } catch (e) {}
                return ws;
            };
            Wrapped.prototype = Orig.prototype;
            ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(k => {
                try { Object.defineProperty(Wrapped, k, {
                    value: Orig[k], enumerable: true, writable: true, configurable: true
                }); } catch (e) {}
            });
            Wrapped.__dyWrapped = true;
            window.WebSocket = Wrapped;
        } catch (e) {}
    }

    /* 页面进房后往往不再请求人数接口，候选池就一直停在加载瞬间那一批。
       这里用已捕获的同源 GET 地址定时复取一次，让候选持续有新鲜值。
       走未挂钩的原生 fetch，不递归、不改页面自己的请求。 */
    /* 首选与当前人数最接近的接口；连续失败时轮到下一个，避免一个
       带签名时效的 URL 把整条轮询链路卡死。 */
    function pickPollUrl() {
        const best = bestApiUrl();
        if (!best) return null;
        if (pollApiIdx === 0) return best;
        const ordered = [best].concat([...countApis.keys()].filter(u => u !== best));
        return ordered[pollApiIdx % ordered.length];
    }
    function pollViewerCount() {
        if (!config.showViewerCount || !config.pollViewerCount || !isLivePage()) return;
        const now = Date.now();
        /* v9.43：下限 2s → 1s。这个间隔是「两次主动复取之间」的最小间隔，
           实际由 1s 的轮询定时器驱动，所以 1s 的配置是真的 1s。
           页面自己的人数值刚变过时（pollUrgent）只等 400ms，尽快拿到新精确值。 */
        const gap = pollUrgent ? 400
            : Math.max(1000, (Number(config.countPollSec) || 2) * 1000);
        if (pollFail >= 6) {
            if (now - lastPollAt < 30000) return;
            pollFail = 3;                       // 半恢复，继续试
        }
        const url = pickPollUrl();
        if (!url || now - lastPollAt < gap) return;
        lastPollAt = now;
        pollUrgent = false;
        const f = nativeFetchRef || window.fetch;
        const ok = () => { pollFail = 0; pollApiIdx = 0; };
        const bad = (msg) => {
            pollFail++; pollApiIdx++;
            pollNote = msg + ' | gap=' + config.countPollSec + 's | url=' + String(url).slice(0, 90);
        };
        try {
            f(url, { method: 'GET', credentials: 'include', cache: 'no-store' })
                .then(function (res) {
                    if (!res || !res.ok) { bad('HTTP ' + (res && res.status)); return null; }
                    return res.text();
                })
                .then(function (t) {
                    if (typeof t !== 'string') return;
                    const before = countHints.length;
                    scanJsonForCount(t, 'fetch:poll', null, '');
                    const fresh = countHints.slice(before);
                    let maxFresh = 0;
                    for (const h of fresh) if (h && h.value > maxFresh) maxFresh = h.value;
                    /* 复取到的全是推荐位/其它房间的小值时（诊断里 657/214/500
                       那一批），丢掉这批 hint 并换接口，别让它污染候选池。 */
                    if (realCountCache != null && maxFresh > 0 &&
                        maxFresh < realCountCache * 0.4) {
                        countHints.length = before;
                        pollFail++; pollApiIdx++;
                        pollNote = 'foreign-room hints dropped | gap=' + config.countPollSec + 's';
                        return;
                    }
                    ok();
                    pollNote = 'ok, +' + (countHints.length - before) +
                               ' hints | gap=' + config.countPollSec + 's';
                })
                .catch(function (e) { bad('err ' + String(e && e.message || e)); });
        } catch (e) { bad('throw ' + e); }
    }
    /* v9.43：页面自己的人数值刚变过（MutationObserver 里发现）时把这面旗子立起来，
       下一次 1s 轮询不再等满间隔，400ms 就走。 */
    function requestPollNow() {
        if (!config.pollViewerCount) return;
        pollUrgent = true;
    }
    installCountHooks();

    /* 有界递归：WeakSet 防 fiber 环，budget 限制总对象数。 */
    function collectNumbers(obj, src, depth, budget, hits, seen) {
        if (!obj || typeof obj !== 'object' || depth > 6 || budget.n <= 0) return;
        if (obj.nodeType || obj === window || obj === document || seen.has(obj)) return;
        seen.add(obj);
        budget.n--;
        let keys;
        try { keys = Object.keys(obj); } catch (e) { return; }
        for (const k of keys) {
            let v;
            try { v = obj[k]; } catch (e) { continue; }
            if (v && typeof v === 'object' && !v.nodeType) {
                collectNumbers(v, src, depth + 1, budget, hits, seen);
                continue;
            }
            const strong = COUNT_KEY_RE.test(k);
            if (!strong && !COUNT_WEAK_RE.test(k)) continue;
            pushHit(hits, src, k, v, strong);
            if (hits.length > 400) return;
        }
    }

    function fiberOf(el) {
        try {
            const k = Object.keys(el).find(x =>
                x.indexOf('__reactFiber$') === 0 || x.indexOf('__reactInternalInstance$') === 0);
            return k ? el[k] : null;
        } catch (e) { return null; }
    }
    function collectFromFibers(hits) {
        const budget = { n: 1500 }, seen = new WeakSet();
        const anchors = document.querySelectorAll(
            '[data-e2e="live-room-audience"], [data-e2e="live-room-header"], ' +
            '[data-e2e*="audience"], [class*="audience"]');
        let n = 0;
        for (const el of anchors) {
            if (++n > 8 || budget.n <= 0) break;
            let f = fiberOf(el), d = 0;
            while (f && d++ < 24) {
                collectNumbers(f.memoizedProps, 'fiber:props', 0, budget, hits, seen);
                collectNumbers(f.pendingProps, 'fiber:props', 0, budget, hits, seen);
                /* v9.24：React 双缓存 —— 新值经常只落在 alternate 上 */
                if (f.alternate) {
                    collectNumbers(f.alternate.memoizedProps, 'fiber:props', 0, budget, hits, seen);
                    collectNumbers(f.alternate.memoizedState, 'fiber:state', 0, budget, hits, seen);
                }
                collectNumbers(f.memoizedState, 'fiber:state', 0, budget, hits, seen);
                if (f.stateNode && typeof f.stateNode === 'object')
                    collectNumbers(f.stateNode.store || f.stateNode.props || f.stateNode,
                                   'fiber:node', 0, budget, hits, seen);
                f = f.return;
            }
        }
    }
    function collectFromGlobals(hits) {
        let names;
        try { names = Object.getOwnPropertyNames(window); } catch (e) { return; }
        const nameRe = /store|state|data|room|initial|render|pace|webcast|live|app|global|context|__/i;
        const budget = { n: 1800 }, seen = new WeakSet();
        let used = 0;
        for (const name of names) {
            if (!nameRe.test(name)) continue;
            if (++used > 110 || budget.n <= 0) break;
            let v;
            try { v = window[name]; } catch (e) { continue; }
            if (!v || typeof v !== 'object' || v.nodeType) continue;
            collectNumbers(v, 'global:' + name, 0, budget, hits, seen);
        }
    }
    function collectFromScripts(hits) {
        const scripts = document.querySelectorAll('script');
        for (let i = 0; i < scripts.length && i < 200; i++) {
            let t = '';
            try { t = scripts[i].textContent || ''; } catch (e) { continue; }
            if (!t || t.length > 2000000 || !COUNT_TEXT_RE.test(t)) continue;
            const variants = [t];
            try {
                const u = t.replace(/\\"/g, '"').replace(/\\\//g, '/');
                if (u !== t) variants.push(u);
            } catch (e) {}
            try {
                const d = decodeURIComponent(t);
                if (d !== t && variants.indexOf(d) < 0) variants.push(d);
            } catch (e) {}
            for (const v of variants) {
                scanJsonForCount(v, 'script', hits);
                if (v.length < 400000 && v.indexOf('{') >= 0) {
                    try {
                        collectNumbers(JSON.parse(v), 'script:json', 0, { n: 700 }, hits, new WeakSet());
                    } catch (e) {}
                }
            }
        }
    }
    let scriptHitsCache = null, lastScriptScanAt = 0;
    let globalHitsCache = null, lastGlobalScanAt = 0;
    function collectAllCountHits(force) {
        const hits = [], now = Date.now();
        // v9.6：把网络候选的时间戳带进打分（旧版在这里丢掉了 at，
        // 于是历史最大值永远压住新值，人数看起来「不会更新」）。
        for (const h of countHints)
            hits.push({ src: h.src, key: h.key, value: h.value, strong: true,
                        at: h.at, fresh: (now - (h.at || 0)) < 8000 });
        // fiber 每轮都扫（人数会随推送更新）；全局对象做时间缓存，
        // 但只有「值真的变了」的人数字段才标新鲜，静态 SSR 快照继续降权。
        try { collectFromFibers(hits); } catch (e) {}
        if (force || !globalHitsCache || now - lastGlobalScanAt > 3000) {
            const g = [];
            try { collectFromGlobals(g); } catch (e) {}
            const prev = new Set((globalHitsCache || []).map(x => x.src + '|' + x.key + '|' + x.value));
            const strongKey = /display_value|display_long|user_count|total_user|room_view_stats/i;
            globalHitsCache = g.map(x => {
                const changed = prev.size > 0 && strongKey.test(x.key) &&
                    !prev.has(x.src + '|' + x.key + '|' + x.value);
                return changed ? Object.assign({}, x, { at: now, fresh: true }) : x;
            });
            lastGlobalScanAt = now;
        }
        for (const h of globalHitsCache || [])
            hits.push(Object.assign({}, h, h.fresh ? {} : { stale: true }));
        if (force || !scriptHitsCache || now - lastScriptScanAt > 20000) {
            const s = [];
            try { collectFromScripts(s); } catch (e) {}
            scriptHitsCache = s; lastScriptScanAt = now;
        }
        for (const h of scriptHitsCache || []) hits.push(Object.assign({}, h, { stale: true }));
        return hits;
    }

    /* v9.8：网页全屏 / 聊天室收起后，抖音会把人数条换成没有 data-e2e 的
       纯数字节点；旧版只认 live-room-audience，于是紧凑布局下彻底停更。
       这里先收带标记的短数字叶子，没有时再按「顶栏短数字」兜底找，
       并做 800ms 缓存避免每轮全量扫文本节点。 */
    let countAnchorCache = [], countAnchorAt = 0;
    function findCountAnchors(force) {
        const now = Date.now();
        if (!force && now - countAnchorAt < 800) return countAnchorCache;
        countAnchorAt = now;
        const out = [], seen = new Set();
        const add = (el) => {
            if (!el || el.nodeType !== 1 || !el.isConnected || seen.has(el)) return;
            seen.add(el); out.push(el);
        };
        for (const el of document.querySelectorAll(
            '[data-e2e="live-room-audience"], [data-e2e*="audience"], [data-gm-real-count]')) {
            const t = ((el.textContent || '') + '').trim();
            // 只收「1万 / 21146」这类短数字叶子，别把整个观众列表容器改掉
            if (el.hasAttribute('data-gm-real-count') ||
                (t.length <= 14 && !/[\u4e00-\u9fa5]{2,}/.test(t))) add(el);
        }
        if (!out.length && document.body) {
            walkText(document.body, 2000, (node) => {
                const t = (node.nodeValue || '').trim();
                if (!/^\d{3,8}(,\d{3})*\+?$/.test(t) && !/^\d+(\.\d+)?万\+?$/.test(t)) return;
                const p = node.parentElement;
                if (!p || p.hasAttribute('data-e2e') || p.closest('#gm-settings-panel')) return;
                if (((p.textContent || '') + '').trim().length > 14) return;
                const r = p.getBoundingClientRect();
                if (!r.width || r.width > 160 || r.top < 0 || r.top > 160) return;
                const up = p.parentElement, gp = up && up.parentElement;
                const ctx = String((up && up.className) || '') + ' ' +
                            String((gp && gp.className) || '');
                if (!/audience|online|user|viewer|count|room|header|top|rank/i.test(ctx)) return;
                add(p);
            });
        }
        countAnchorCache = out;
        return out;
    }

    /* v9.45：量级参照只认「人数条那个节点」本身。
       上一版直接拿 findCountAnchors()[0]，而这个列表里混着顶栏上别的「x万」：
       之前一次误写就把主播粉丝数（9.6万）、地点热度（3.1万）一起改写成了
       人数，量级于是按那些节点算 —— 诊断里 scale:[134,837.5] 就是这么来的，
       真实人数 2 万反而被判越界，显示锁死在 429。
       现在优先取 [data-e2e="live-room-audience"]，取不到才退回列表首项。 */
    function primaryCountEl() {
        let list = document.querySelectorAll('[data-e2e="live-room-audience"]');
        if (!list.length) list = document.querySelectorAll('[data-e2e*="audience"]');
        for (const el of list) {
            const raw = el.getAttribute('data-gm-orig-count');
            const t = ((raw != null ? raw : (el.innerText || el.textContent || '')) + '')
                .trim().replace(/[,\s]/g, '');
            if (/^[\d.]+万\+?$/.test(t) || /^\d{2,9}\+?$/.test(t)) return el;
        }
        return null;
    }

    /* 用页面自己显示的「1万」反推合理量级，防止把时间戳 / 礼物数 / 榜单数
       误当成在线人数；解析成功后缓存，避免 CSS 隐藏原文本后读不到。 */
    function displayedScale() {
        const now = Date.now();
        // v9.6：量级参照不再永久缓存。旧版 scaleCache 一旦算出就永不清空，
        // 页面模糊值从「1万」涨到「2万」后，新值全被判超出量级 → 数字冻结。
        if (scaleCache && now - scaleAt < 2000) return scaleCache;
        const el = primaryCountEl() || findCountAnchors()[0];
        if (!el) return null;
        let t = '';
        try {
            // 优先用备份的原始文本「1万」，避免文本被改成精确值后量级漂移
            const raw = el.getAttribute('data-gm-orig-count');
            t = ((raw != null ? raw : (el.innerText || el.textContent || '')) + '')
                .trim().replace(/[,\s]/g, '');
        } catch (e) {}
        let lo = 0, hi = 0;
        if (/^[\d.]+万/.test(t)) {
            const w = parseFloat(t) * 10000;
            lo = Math.max(1, w * 0.4); hi = w * 2.5;
        } else if (/^\d{2,9}\+?$/.test(t)) {
            const n = parseInt(t, 10);
            lo = n * 0.5; hi = n * 2;
        }
        if (!(hi > lo)) return null;
        scaleCache = [lo, hi];
        scaleAt = now;
        return scaleCache;
    }
    function pickCount(hits) {
        if (!hits || !hits.length) return null;
        const scale = displayedScale();
        const now = Date.now();
        /* v9.45：有量级参照时先**硬过滤**，越界的候选一律不参与打分。
           上一版是「越界只扣 100 分」，配上「新鲜的明确字段可以突破量级」
           这条豁免，一个别的小房间的数字（429）就能赢过真实人数，
           赢了之后还会 widenScale 把量级一起带偏 —— 之后越错越离谱。
           现在：宁可这一拍不改，也不写一个明显不在量级里的数。 */
        const pool = scale
            ? hits.filter(h => h.value >= scale[0] && h.value <= scale[1])
            : hits;
        if (!pool.length) return null;
        const score = (h) => {
            let s = h.strong ? 100 : 20;
            /* v9.45：room_view_stats 是「本房间」的在线统计，比泛泛的
               display_value 可信得多，单独给一档更高的分。 */
            if (h.key === 'room_view_stats') s += 130;
            else if (/display_value|display_long/.test(h.key)) s += 70;
            else if (COUNT_KEY_RE.test(h.key)) s += 45;
            if (h.src.indexOf('fetch') === 0 || h.src.indexOf('xhr') === 0) s += 40;
            /* v9.6：新鲜度优先于数值大小；静态 SSR / 内联 script 只作兜底。
               v9.43：原来只有一个「8 秒内 = 新鲜 +260」的粗档 —— 8 秒前的旧值
               和刚到手的新值同分，排序退回「谁大谁赢」，人数就看着像不动。
               这里按年龄分档，最新的一档永远压住旧值。 */
            if (h.fresh) {
                const age = h.at ? now - h.at : 9999;
                if (age < 1500) s += 300;        // 刚抓到的推送
                else if (age < 3500) s += 240;
                else s += 160;                   // 3.5~8s 的还能用，但压不过新的
            } else if (h.at) s -= 80;
            if (h.stale) s -= 140;
            if (h.value > 1e9) s -= 120;      // unix 秒 / 毫秒时间戳
            if (h.value < 20) s -= 120;       // 榜单、礼物等零星计数
            return s;
        };
        // 同分时取「更新的」而不是「更大的」，人数下降也能跟着变
        const sorted = pool.slice().sort((a, b) =>
            (score(b) - score(a)) || ((b.at || 0) - (a.at || 0)) || (b.value - a.value));
        if (!sorted.length) return null;
        const best = sorted[0];
        /* v9.41：页面还没显示模糊值（scale 为空）时没有任何参照，
           这时只认字段名明确的候选 —— 否则 AB 阈值、组件计数会被当成人数，
           显示出来就是「固定 1000」这种明显不对的数字。 */
        if (!scale && !COUNT_STRONG_KEY_RE.test(best.key)) return null;
        return best.value;
    }

    /* v9.41：人数来源探查 —— 精确值到底藏在哪。
       人数条元素的 fiber 链逐层打印「组件名 + props/state 顶层键名」，
       真有一份 roomStore 挂着，扫一遍就能看见它在第几层。 */
    function fiberProbe(el) {
        const out = [];
        let f = null;
        try { f = dyReactFiber(el); } catch (e) { f = null; }
        let d = 0;
        while (f && d++ < 18) {
            const t = f.type;
            let name;
            if (typeof t === 'string') name = t;
            else if (typeof t === 'function') name = t.displayName || t.name || 'fn';
            else if (t && t.displayName) name = t.displayName;
            else name = 'tag' + f.tag;
            const bits = [];
            try {
                const mp = f.memoizedProps;
                if (mp && typeof mp === 'object') {
                    const ks = Object.keys(mp).slice(0, 12);
                    if (ks.length) bits.push('p[' + ks.join(',') + ']');
                }
            } catch (e) {}
            try {
                const ms = f.memoizedState;
                if (ms && typeof ms === 'object') {
                    const ks = Object.keys(ms).filter(k =>
                        k !== 'next' && k !== 'baseState' && k !== 'baseQueue' &&
                        k !== 'queue' && k !== 'memoizedState' && k !== 'deps').slice(0, 12);
                    if (ks.length) bits.push('s[' + ks.join(',') + ']');
                }
            } catch (e) {}
            out.push(d + '. ' + name + (bits.length ? '  ' + bits.join(' ') : ''));
            f = f.return;
        }
        return out;
    }

    /* 排障：一次导出所有候选值、数据源、script 片段、全局对象名。 */
    function dumpViewerCount() {
        const lines = [];
        const push = (s) => lines.push(s);
        push('# 抖音优化 · 真实人数诊断');
        push('URL: ' + location.href);
        push('time: ' + new Date().toISOString());
        const anchors = findCountAnchors(true);
        const el = anchors[0];
        push('anchors (' + anchors.length + '): ' + anchors.slice(0, 4)
            .map(a => (a.outerHTML || '').slice(0, 220)).join(' || '));
        push('anchor: ' + (el ? (el.outerHTML || '').slice(0, 800) : 'NOT FOUND'));
        push('anchor text: ' + (el ? ((el.innerText || el.textContent || '') + '').trim() : '-'));
        push('scale: ' + JSON.stringify(displayedScale()));
        push('precise(fiber room_view_stats): ' + preciseCountFromFiber() +
             ' | lastPreciseAgo=' + (lastPreciseAt ? (Date.now() - lastPreciseAt) + 'ms' : 'never'));
        push('cached value: ' + realCountCache + ' | smallStreak=' + smallCountStreak);
        push('count apis (' + countApis.size + '): ' + JSON.stringify(
            [...countApis].map(x => ({ url: String(x[0]).slice(0, 220), max: x[1].max }))));
        push('poll: ' + pollNote + ' | fails=' + pollFail + ' | gap=' + config.countPollSec + 's' +
             ' | last=' + (lastPollAt ? new Date(lastPollAt).toISOString() : 'never'));
        /* v9.43：节奏诊断 —— 快通道 350ms，重通道 1.8s，事件驱动 80ms 防抖 */
        const nowMs = Date.now();
        push('refresh: fast=350ms | heavyAgo=' +
             (lastHeavyCountAt ? (nowMs - lastHeavyCountAt) + 'ms' : 'never') +
             ' | scoreAgo=' + (lastScoreAt ? (nowMs - lastScoreAt) + 'ms' : 'never') +
             ' | fiberMiss=' + fiberMiss + '/' + fiberTicks);
        push('network hints (' + countHints.length + '): ' + JSON.stringify(countHints.slice(-30)));
        const hits = collectAllCountHits(true);
        push('all candidates (' + hits.length + '): ');
        for (const h of hits.slice(0, 80)) push('  ' + JSON.stringify(h));
        push('picked: ' + pickCount(hits));
        let n = 0;
        for (const s of document.querySelectorAll('script')) {
            const t = s.textContent || '';
            if (!COUNT_TEXT_RE.test(t)) continue;
            if (++n > 8) break;
            const i = t.search(COUNT_TEXT_RE);
            push('script#' + (s.id || s.type || 'anon') + ': ' +
                 t.slice(Math.max(0, i - 160), i + 280).replace(/\s+/g, ' ').slice(0, 460));
        }
        push('script snippets: ' + n);
        let globals = [];
        try {
            globals = Object.getOwnPropertyNames(window)
                .filter(x => /store|state|data|room|initial|render|pace|webcast|live|app|global|__/i.test(x))
                .slice(0, 100);
        } catch (e) {}
        push('page: isLivePage=' + isLivePage() + ' isLiveHost=' + isLiveHost +
             ' path=' + location.pathname);
        push('ws: text=' + wsStats.text + ' bin=' + wsStats.bin +
             ' jsonHits=' + wsStats.jsonHits);
        push('requests (' + reqLog.length + '):');
        for (const u of reqLog.slice(-40)) push('  ' + u);
        for (const sp of wsStats.samples) push('  ws sample: ' + sp);
        for (const hx of wsStats.hex) push('  ws hex: ' + hx);
        push('fiber chain (从人数条往上):');
        try {
            const chain = el ? fiberProbe(el) : [];
            if (!chain.length) push('  (没有锚点或拿不到 fiber)');
            else for (const l of chain) push('  ' + l);
        } catch (e) { push('  (探测失败 ' + e + ')'); }
        push('global names: ' + globals.join(', '));
        push('chat filter: ' + JSON.stringify(chatFilterStats));
        const text = lines.join('\n');
        try { console.log('[抖音优化] 真实人数诊断\n' + text); } catch (e) {}
        copyText(text);
        showTip('已复制人数诊断，直接粘贴给我即可', 2800);
    }
    window.__DY_OPT_DUMP_COUNT__ = dumpViewerCount;

    /* 显示：直接改文本节点，不再依赖 ::before 伪元素。
       只观察人数节点本身，React 回写「1万」时立刻改回精确值；
       因为写回的是同一个值，不会形成 MutationObserver 死循环。 */
    let countObserver = null;
    const countObserved = new WeakSet();

    function firstTextNode(el) {
        try {
            return document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false).nextNode();
        } catch (e) { return null; }
    }
    /* v9.43：允许外部传入已算好的锚点，快通道里就不用再查一遍 DOM。
       v9.45：人数条本体（data-e2e="live-room-audience"）在的时候只改它一个。
       顶栏上还有主播粉丝数 / 地点热度、右侧还有推荐位的观众数，它们同样是
       「x万」短文本，之前会被 findCountAnchors 收进来一起改写 —— 显示看着就是
       「一堆数字乱跳」，量级参照也跟着错。 */
    function applyCountText(text, anchors) {
        let list = anchors || findCountAnchors();
        const primary = document.querySelector('[data-e2e="live-room-audience"]');
        if (primary) {
            const pt = ((primary.textContent || '') + '').trim();
            // 只有「它本来就装着一个短数值」时才独占，别把整块容器写成数字
            if (primary.hasAttribute('data-gm-real-count') ||
                (pt.length <= 14 && /^[\d.,]+\s*(万|w|W)?\+?$/.test(pt))) list = [primary];
        }
        for (const el of list) {
            if (!el.isConnected) continue;
            if (!el.hasAttribute('data-gm-orig-count'))
                el.setAttribute('data-gm-orig-count', (el.textContent || '').trim());
            if (el.getAttribute('data-gm-real-count') !== text)
                el.setAttribute('data-gm-real-count', text);
            const node = firstTextNode(el);
            if (node) { if (node.nodeValue !== text) node.nodeValue = text; }
            else if (el.textContent !== text) el.textContent = text;
        }
    }
    function restoreCountText() {
        for (const el of document.querySelectorAll('[data-gm-real-count]')) {
            const orig = el.getAttribute('data-gm-orig-count');
            el.removeAttribute('data-gm-real-count');
            el.removeAttribute('data-gm-orig-count');
            if (orig == null) continue;
            const node = firstTextNode(el);
            if (node) node.nodeValue = orig;
            else el.textContent = orig;
        }
    }
    /* v9.45：只还原「不是人数条本体」却被我们改过文案的节点。
       旧版的顶栏补扫会把主播粉丝数（9.6万）、地点热度（3.1万）这些同样是
       「x万」的短文本一起改成人数；节点上留着 data-gm-real-count，不还原
       就会一直是错的数字，而且还会被 findCountAnchors 当锚点、把量级带偏。
       人数条本体（live-room-audience）在的话才还原 —— 紧凑布局下可能就是
       靠补扫写的那一个节点，那时不能动它。 */
    function restoreStrayCountText() {
        if (!document.querySelector('[data-e2e="live-room-audience"]')) return;
        let dirty = false;
        for (const el of document.querySelectorAll('[data-gm-real-count]')) {
            if (el.matches('[data-e2e="live-room-audience"], [data-e2e*="audience"]')) continue;
            const orig = el.getAttribute('data-gm-orig-count');
            el.removeAttribute('data-gm-real-count');
            el.removeAttribute('data-gm-orig-count');
            dirty = true;
            if (orig == null) continue;
            const node = firstTextNode(el);
            if (node) { if (node.nodeValue !== orig) node.nodeValue = orig; }
            else el.textContent = orig;
        }
        if (dirty) countAnchorAt = 0;      // 锚点列表里有被清掉的节点，下一拍重新找
    }
    function watchCountNodes() {
        if (!countObserver) {
            try {
                countObserver = new MutationObserver(() => {
                    if (realCountCache == null || !config.showViewerCount) return;
                    // React 回写新的模糊值（1万 → 1.2万 → 2万）时先记录下来：
                    // 旧版把原文本永久劫持成精确值，orig-count 永远停在首次值，
                    // 量级校验因此把后来的新人数全部挡掉。只认带「万/+」的模糊值，
                    // 纯数字是我们自己写的精确值，不作参照。
                    let advanced = false;
                    /* v9.45：人数条本体在时只看它一个。顶栏别的「x万」被还原后
                       也会有文本变化，跟着它们催轮询就是白跑。 */
                    const primNow = document.querySelector('[data-e2e="live-room-audience"]');
                    for (const el of (primNow ? [primNow] : findCountAnchors(true))) {
                        const cur = ((el.textContent || '') + '').trim();
                        if (cur && cur !== String(realCountCache) && /^[\d.]+(万\+?|\+)$/.test(cur)) {
                            el.setAttribute('data-gm-orig-count', cur);
                            scaleCache = null;
                            advanced = true;
                        }
                    }
                    /* v9.43：抖音自己那一行「1.2万」都往前走了，说明我们手上的
                       精确值是旧的 —— 立刻重读一次 fiber，并催一发主动轮询，
                       别让新数字干等 2 秒的轮询间隔。 */
                    if (advanced) {
                        scheduleCountRefresh(0);
                        requestPollNow();
                    }
                    applyCountText(String(realCountCache));
                });
            } catch (e) { return; }
        }
        for (const el of findCountAnchors()) {
            if (countObserved.has(el)) continue;
            countObserved.add(el);
            try { countObserver.observe(el, { childList: true, characterData: true, subtree: true }); }
            catch (e) {}
        }
    }

    /* ---- 7.6b 精确人数：直接沿 fiber 取 room_view_stats.display_value ----
     * v9.24：这条路径来自用户自己验证过的旧脚本（1.4），实测不会认错、
     * 并随直播推送实时更新。旧版把它埋在通用递归里，有两个致命点：
     *   ① memoizedProps → value.store.roomStore.roomInfo.room.room_view_stats
     *      → display_value 的深度超过递归上限（6 层），根本到不了；
     *   ② React 双缓存：新值经常只在 f.alternate 上，旧版不查 alternate。
     * 于是只能退回「打分」，一旦挑中 SSR 静态快照就会永久冻在一个数上。
     * 现在把它提成首选通道，抓到就直接用，不再参与打分。 */
    function statsFromStore(store) {
        try {
            const room = store && store.roomStore && store.roomStore.roomInfo &&
                         store.roomStore.roomInfo.room;
            return (room && room.room_view_stats) || null;
        } catch (e) { return null; }
    }
    function roomStatsOf(obj) {
        if (!obj || typeof obj !== 'object') return null;
        let vs = statsFromStore(obj.value && obj.value.store);
        if (!vs) vs = statsFromStore(obj.value);
        if (!vs) vs = statsFromStore(obj.store);
        if (!vs) {
            const cands = [obj.roomStore, obj.roomInfo, obj.room, obj.roomData,
                           obj.data, obj.state];
            for (const c of cands) {
                if (!c || typeof c !== 'object') continue;
                if (c.room_view_stats) { vs = c.room_view_stats; break; }
                if (c.roomInfo && c.roomInfo.room && c.roomInfo.room.room_view_stats) {
                    vs = c.roomInfo.room.room_view_stats; break;
                }
                if (c.room && c.room.room_view_stats) { vs = c.room.room_view_stats; break; }
                const s = statsFromStore(c);
                if (s) { vs = s; break; }
            }
        }
        if (!vs || typeof vs !== 'object') return null;
        return toCount(vs.display_value) || toCount(vs.display_long) ||
               toCount(vs.online_user_count) || toCount(vs.user_count) || null;
    }
    function fiberRoomStats(fiber) {
        let f = fiber, d = 0;
        while (f && d++ < 30) {
            for (const src of [f, f.alternate]) {
                if (!src) continue;
                const v = roomStatsOf(src.memoizedProps) || roomStatsOf(src.pendingProps);
                if (v != null) return v;
            }
            f = f.return;
        }
        return null;
    }
    function preciseCountFromFiber() {
        /* 只认「当前房间顶部的人数节点」：右侧推荐位的房间卡也是
           *audience* 结构，把它们算进来就会读到别的房间的人数。 */
        let anchors = document.querySelectorAll(
            '[data-e2e="live-room-audience"], [data-e2e*="audience"]');
        if (!anchors.length) {
            anchors = document.querySelectorAll(
                '[id^="living_player_container"], #douyin-header, [id^="douyin-header"]');
        }
        let n = 0;
        for (const el of anchors) {
            if (++n > 10) break;
            const v = fiberRoomStats(dyReactFiber(el));
            if (v != null) return v;
        }
        return null;
    }

    let lastCountUrl = '';
    let lastPreciseAt = 0, lastCountAcceptAt = 0;
    /* v9.43：人数刷新改成「快通道 + 重通道」两档节奏。
       旧版整条链路挂在 1.5s 主循环里，内部再节流 1s，轮询最低还要 2s：
       抖音这边人数推送已经到了，页面上的数字却要 2~4 秒才动一下，
       肉眼看就是「人数半天不更新」。现在：
         快通道 350ms —— 只读 fiber 里的精确值 + 改文本，开销极小；
         重通道 ~1.8s —— 打分兜底、观察器、顶栏其它「x万」补扫；
         事件驱动 —— 网络 / WS 抓到新数值立刻催一次（80ms 防抖）。 */
    let lastHeavyCountAt = 0, lastScoreAt = 0, fiberMiss = 0, fiberTicks = 0;

    /* 事件驱动的刷新闸门：只保留最近的那一次，never 堆积任务。 */
    function scheduleCountRefresh(delay) {
        if (!config.showViewerCount) return;
        const now = Date.now();
        const due = now + (delay == null ? 80 : delay);
        if (countRefreshTimer && due >= countRefreshDue) return;   // 已有更早的排队
        countRefreshDue = due;
        clearTimeout(countRefreshTimer);
        countRefreshTimer = setTimeout(function () {
            countRefreshTimer = 0;
            try { updateViewerCount(true); } catch (e) {}
        }, Math.max(0, due - now));
    }

    /* 缓存的锚点被 React 换掉时立刻重找，别往已经摘掉的节点里写文本。 */
    function countAnchorsFast() {
        if (!countAnchorCache.length) return findCountAnchors(true);
        for (const el of countAnchorCache) if (!el.isConnected) return findCountAnchors(true);
        return findCountAnchors();
    }

    /* 顶栏里还有别的「1.2万」短文本（不是人数条本身），一起改成精确值。
       v9.45：只在「找不到人数条本体」时才做这层补扫 —— 顶栏上还有主播粉丝数
       （9.6万）、地点热度（3.1万）这些同样是「x万」的短文本，以前会被一起
       改写成人数，显示出来就是一堆不该变的数字在乱跳，量级参照也被带偏。 */
    function paintTopCountText(text) {
        if (document.querySelector('[data-e2e="live-room-audience"]')) return;
        const countRe = /^\d+(\.\d+)?万\+?$/;
        let found = 0;
        /* v9.19：先扫顶栏容器，别每轮全页过 4000 个文本节点。
           顶栏找不到（改版/全屏）再退回 body。 */
        const topRoot = document.querySelector(
            '#douyin-header, [id^="douyin-header"], [data-e2e*="header"], [class*="header"]') ||
            document.body || document;
        const scan = (root, cap) => walkText(root, cap, (node) => {
            if (found >= 3) return false;
            const t = (node.nodeValue || '').trim();
            if (!countRe.test(t)) return;
            const parent = node.parentElement;
            if (!parent || parent.hasAttribute('data-gm-real-count')) return;
            if (parent.hasAttribute('data-e2e')) return;
            const r = parent.getBoundingClientRect();
            if (r.top < 0 || r.top >= 150) return;
            const pt = parent.innerText || '';
            const gt = (parent.parentElement && parent.parentElement.innerText) || '';
            if (/点赞|粉丝|关注|本场|贡献/.test(pt + gt)) return;
            if (!parent.hasAttribute('data-gm-orig-count'))
                parent.setAttribute('data-gm-orig-count', t);
            parent.setAttribute('data-gm-real-count', text);
            node.nodeValue = text;
            found++;
        });
        scan(topRoot, 1200);
        if (!found && topRoot !== document.body) scan(document.body || document, 2000);
    }

    function updateViewerCount(force) {
        if (location.href !== lastCountUrl) {       // 切换直播间时作废旧缓存
            lastCountUrl = location.href;
            realCountCache = null; scaleCache = null;
            countHints.length = 0;
            countApis.clear(); pollFail = 0; lastPollAt = 0; pollNote = 'idle';
            scriptHitsCache = null; globalHitsCache = null;
            smallCountStreak = 0; lastPreciseAt = 0; lastCountAcceptAt = 0;
            lastScoreAt = 0; lastHeavyCountAt = 0; fiberMiss = 0;
            pollUrgent = false;
            if (countRefreshTimer) { clearTimeout(countRefreshTimer); countRefreshTimer = 0; }
        }
        if (!config.showViewerCount) {
            if (document.querySelector('[data-gm-real-count]')) restoreCountText();
            realCountCache = null; scaleCache = null;
            return;
        }
        if (!isLivePage()) return;              // 视频流页不做人数扫描，避免误伤其它「x万」文本
        const now = Date.now();
        if (!force && now - lastCountReadAt < 300) return;   // 定时器 350ms，正常不会被挡
        lastCountReadAt = now;

        /* ① 首选：内部 store 的精确人数（实时，不会认错）。
           连续 8 拍读不到就降到每 4 拍试一次，别在没有 room_store 的页面上白跑链路。 */
        let precise = null;
        fiberTicks++;
        if (fiberMiss < 8 || fiberTicks % 4 === 0) {
            try { precise = preciseCountFromFiber(); } catch (e) {}
        }
        if (precise != null) {
            fiberMiss = 0;
            lastPreciseAt = now;
            /* v9.43：现在 350ms 读一次，比原来勤得多 —— 右侧推荐位的房间卡
               万一被读进来，数字会一闪一闪。真骤降（< 上次 45%）先挂一拍，
               连拍两次才认；回退最多 350ms，肉眼无感。 */
            let accept = true;
            if (realCountCache != null && precise < realCountCache * 0.45) {
                smallCountStreak++;
                accept = smallCountStreak >= 2;
            } else {
                smallCountStreak = 0;
            }
            if (accept) {
                realCountCache = precise;
                smallCountStreak = 0;
                lastCountAcceptAt = now;
                widenScale(precise);      // 人数涨过旧量级时把参照区间抬上去
            }
        } else {
            fiberMiss++;
            /* ② 兜底：网络 / fiber / 全局 / script 打分。
               这是重活，平时 1.5s 才跑一次；被事件催的时候放宽到 450ms，
               让刚抓到的数值尽快生效。 */
            const scoreGap = force ? 450 : 1500;
            if (now - lastScoreAt >= scoreGap) {
                lastScoreAt = now;
                const real = pickCount(collectAllCountHits());
                if (real != null) {
                    lastCountAcceptAt = now;
                    /* 在线人数不会在几秒内腰斩成三位数。突降到上次值 45% 以下时
                       先沿用旧值，连续两次都这么小才接受，避免长时间后被
                       推荐房间的小值带偏（刷新后又正常的那个现象）。 */
                    if (realCountCache != null && real < realCountCache * 0.45) {
                        smallCountStreak++;
                        if (smallCountStreak >= 2) {
                            realCountCache = real; smallCountStreak = 0;
                        }
                    } else {
                        realCountCache = real; smallCountStreak = 0;
                    }
                } else if (realCountCache != null && now - lastCountAcceptAt > 20000) {
                    /* 精确源 20 秒没更新、打分也拿不到：把显示还给抖音自己。
                       宁可显示「1.2万」这种模糊值，也不要冻在一个错的数字上。 */
                    restoreCountText();
                    realCountCache = null; scaleCache = null; lastPreciseAt = 0;
                    return;
                }
            }
        }
        if (realCountCache == null) return;
        const text = String(realCountCache);
        applyCountText(text, countAnchorsFast());   // 快通道：只写文本，350ms 一次

        /* ③ 重通道：锚点重建 + 观察器 + 顶栏补扫，1.8s 一次足够 */
        if (now - lastHeavyCountAt > 1800) {
            lastHeavyCountAt = now;
            findCountAnchors(true);                 // 全屏/收起切换后锚点会被 React 换掉
            applyCountText(text);
            watchCountNodes();
            paintTopCountText(text);
            restoreStrayCountText();               // v9.45：把误改的顶栏数字还回去
        }
    }

    /* ---- 7.7 评论区「点一下会触发抖音搜索」的词高亮 ----
     * 抖音给评论区里那些可点击发起搜索的词旁边配了一个很小的放大镜 /
     * 搜索 SVG。以这个小图标为锚点，给最近的 span/a/div 文字染青色。
     * 不做关键词匹配、不扫描整段评论文本、不给整条评论加底框。 */
    const COMMENT_ITEM_SEL = '[data-e2e="comment-item"], .comment-item, ' +
        '[data-e2e="comment-mainContent"], [data-e2e*="comment-item"], ' +
        '[class*="comment-item"], [class*="CommentItem"], [id*="comment-item"], ' +
        '[data-e2e="comment-list"], [class*="comment-list"], ' +
        '[class*="CommentList"], [class*="commentList"], [id*="comment-list"]';
    const HIGHLIGHT_SKIP = /回复|分享|展开|收起|作者赞过|点赞|置顶|举报|更多/;
    // 小 SVG 之外的补充证据：评论区里直接带搜索链接 / 标记为搜索词的短元素
    const SEARCH_LINK_SEL = 'a[href*="search"], [data-e2e*="search-word"], ' +
        '[class*="search-word"], [class*="SearchWord"]';

    function paint(el, container) {
        if (!el || el === container || el.closest('#gm-settings-panel')) return;
        if (el.closest('.gm-search-word-highlight')) return;
        const text = ((el.innerText || el.textContent || '') + '').trim();
        if (!text || text.length > 25) return;
        if (HIGHLIGHT_SKIP.test(text) || /^\d+(\.\d+)?[万wW]?$/.test(text)) return;
        el.classList.add('gm-search-word-highlight');
    }

    function highlightSearchWords() {
        const clear = () => document.querySelectorAll('.gm-search-word-highlight')
            .forEach(el => el.classList.remove('gm-search-word-highlight'));
        if (!config.highlightSearch) { clear(); return; }
        const containers = document.querySelectorAll(COMMENT_ITEM_SEL);
        for (const container of containers) {
            /* v9.19：评论内容没变就直接跳过。旧版每 1.5s 把所有评论重新遍历、
               每个小 svg 再量一次尺寸，已染色的也重复进循环。 */
            let stamp = '';
            try { stamp = (container.innerText || '').slice(0, 120); } catch (e) {}
            if (stamp && container.dataset.gmHl === stamp) continue;
            if (stamp) container.dataset.gmHl = stamp;
            // 主锚点：可搜索词旁边那个小放大镜 / 搜索 SVG
            for (const svg of container.querySelectorAll('svg')) {
                if (svg.closest('.gm-search-word-highlight')) continue;
                const r = svg.getBoundingClientRect();
                if (r.width === 0 || r.width > 30 || r.height > 30) continue;
                paint(svg.closest('span, a, div'), container);
            }
            // 补充：评论区里明确带搜索链接的短元素
            for (const el of container.querySelectorAll(SEARCH_LINK_SEL)) paint(el, container);
        }
    }

    /* ---- 7.8 自定义视频黑名单 ----
     * v9.24：旧版只认 [data-e2e="video-desc"] 和 [data-e2e="feed-video-nickname"]，
     * 这两个标记改版后经常不存在 —— 取到空串就直接 return，于是「设了黑名单
     * 完全不生效」，而且完全没有提示，看不出是没匹配上还是功能没跑。
     * 现在：候选选择器逐个试 → 都空就退到当前卡片自身文本；
     * 卡片身份优先用视频 id / src，文本只作次选；命中后给出关键词提示。 */
    let lastFilteredKey = '';

    const FILTER_DESC_SEL = '[data-e2e="video-desc"], [data-e2e*="video-desc"], ' +
        '[data-e2e*="desc"], [data-e2e="detail-video-title"], [data-e2e*="video-title"], ' +
        '[class*="video-title"], [class*="VideoTitle"], [class*="videoTitle"], ' +
        '[class*="desc"], [class*="Desc"]';
    const FILTER_AUTHOR_SEL = '[data-e2e="feed-video-nickname"], [data-e2e*="nickname"], ' +
        '[data-e2e*="author"], [data-e2e="video-avatar"], ' +
        '[class*="author"], [class*="Author"], [class*="nickname"], [class*="Nickname"], ' +
        'a[href*="/user/"]';

    function activeCardEl() {
        return document.querySelector('[data-e2e="feed-active-video"]') ||
               document.querySelector('[data-e2e="video-detail"]') ||
               document.querySelector('.douyin-player') ||
               document.querySelector('[data-e2e="video-player"]') || null;
    }
    /* 在卡片范围内按候选选择器取第一个非空文本；卡片里找不到再全页找 */
    function firstSelectorText(sel, root) {
        const scopes = [root, document];
        for (const scope of scopes) {
            if (!scope || !scope.querySelectorAll) continue;
            let n = 0;
            for (const el of scope.querySelectorAll(sel)) {
                if (++n > 60) break;
                if (el.closest('#gm-settings-panel')) continue;
                const t = ((el.innerText || el.textContent || '') + '').trim();
                if (t) return t;
            }
        }
        return '';
    }
    function videoFilterText() {
        const card = activeCardEl();
        let desc = firstSelectorText(FILTER_DESC_SEL, card);
        let author = firstSelectorText(FILTER_AUTHOR_SEL, card);
        if (desc || author) return { desc: desc, author: author, text: desc + '\n' + author };
        /* 兜底：当前卡片自身文本。抖音改版后标题/作者可能一个选择器都不命中，
           这一步保证「设了黑名单至少还能匹配上」。 */
        let t = '';
        try { t = ((card || document.body).innerText || '').slice(0, 600); } catch (e) {}
        return { desc: t, author: '', text: t };
    }
    function getVideoKey(card) {
        const m = location.href.match(/\/video\/(\d+)/) ||
                  location.href.match(/[?&]modal_id=(\d+)/);
        if (m) return 'id:' + m[1];
        const k = feedCardVid(card || activeCardEl());
        if (k) return k;
        const t = videoFilterText();
        return t.text ? 'txt:' + t.text.replace(/\s+/g, '').slice(0, 120) : '';
    }

    function checkVideoFilter() {
        if (!config.filterKeywords || !config.filterKeywords.length) return;
        if (isLivePage()) return;
        const card = activeCardEl();
        const key = getVideoKey(card);
        if (!key || key === lastFilteredKey) return;
        const info = videoFilterText();
        const text = (info.text || '').toLowerCase();
        if (!text.trim()) return;
        let hit = '';
        for (const k of config.filterKeywords) {
            const kw = String(k || '').trim().toLowerCase();
            if (kw && text.indexOf(kw) >= 0) { hit = String(k).trim(); break; }
        }
        if (!hit) return;
        lastFilteredKey = key;
        /* v9.39：黑名单命中后也支持两种处理——只划走 / 点不感兴趣。
           走 skipFeed 复用它的节流、重试兜底和统一的 key 去重；
           forceAction 传黑名单自己的配置，不影响广告/直播的跳过方式。 */
        skipFeed('黑名单视频：' + hit, key, config.filterSkipAction || 'next');
    }

    /* ---- 7.11 推荐流自动跳过广告 / 直播 ----
     * 只看 DOM 判定、不碰接口响应（碰响应容易触发抖音自己的校验）：
     *   广告 = 当前激活卡片的标签区出现独立的「广告」叶子文本，或带 ad 标记；
     *   直播 = 已经刷到 feed-live 卡片、没有激活视频卡片。
     * 跳走方式统一走 nextFeed()：先点「下一条」按钮，点不到才用 r 键。 */
    let lastFeedCheck = 0, lastSkipKey = '', lastSkipAt = 0;
    let adCheckVid = '', adCheckCount = 0;
    const AD_LEAF_RE = /^(广告|广告[·・].*|.*[·・]广告)$/;

    /* ---- 直播卡片的「不感兴趣」菜单 ----
     * 这个菜单是抖音自带的快捷菜单，三段固定为
     *   不感兴趣 / 举报 / 在新标签页打开直播间
     * 它不会自己出现：必须先按 r（或点卡片上的「不感兴趣」）唤出，再点第一项，
     * 才算真的屏蔽。所以流程是「唤出 → 点第一项 → 校验菜单是否消失」。
     *
     * 结构（用户 2026-11-13 实测）：
     *   <div id="EGfMOP99" style="top:262px;left:553px">   ← 容器：无 class/role，absolute，224x104
     *     <div id="UizNwYcn"><div class="AdFei9o2">不感兴趣</div></div>
     *     <div id="UizNwYcn"><div class="AdFei9o2">举报</div></div>
     *     <div id="UizNwYcn"><div class="AdFei9o2">在新标签页打开直播间</div></div>
     *   </div>
     * 容器 id 是随机串、class 是编译 hash，都不可靠。
     * v9.20.5：定位加二级兜底 —— 文本改版或层级多包一层时也还能找到。
     */
    let liveSkipLog = [];

    /* 形状像「操作菜单」的绝对定位小浮层：2~8 个直接子项、层级 >=50、
       尺寸 100~500 × 30~600、子项都是短文本。这个菜单第一项恒为「不感兴趣」。 */
    function menuLikeBox() {
        const all = document.querySelectorAll('body div');
        for (let i = 0; i < all.length && i < 8000; i++) {
            const el = all[i];
            const n = el.childElementCount;
            if (n < 2 || n > 8) continue;
            let st, r;
            try { st = window.getComputedStyle(el); } catch (e) { continue; }
            if (st.position !== 'absolute' && st.position !== 'fixed') continue;
            if ((parseInt(st.zIndex, 10) || 0) < 50) continue;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (r.width < 100 || r.width > 500 || r.height < 30 || r.height > 600) continue;
            let short = 0;
            for (const k of el.children) {
                const t = (k.textContent || '').trim();
                if (t && t.length <= 16) short++;
            }
            if (short >= 2) return el;
        }
        return null;
    }

    /* 返回菜单里「不感兴趣」那一行（要点的元素） */
    function findMenuRow() {
        if (!document.body) return null;
        // ① 文本精确：不感兴趣 + 同容器里有「举报」
        if (typeof document.evaluate === 'function') {
            let snap = null;
            try {
                snap = document.evaluate(
                    "//*[self::div or self::span][normalize-space(text())='不感兴趣']",
                    document.body, null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
            } catch (e) { snap = null; }
            const n = snap ? snap.snapshotLength : 0;
            for (let i = 0; i < n && i < 12; i++) {
                const row = snap.snapshotItem(i);
                let p1 = row.parentElement, p2 = p1 && p1.parentElement;
                // 菜单可能多包一层，往上试三层
                for (let up = 0; up < 3 && p2; up++) {
                    const txt = p2.textContent || '';
                    let r;
                    try { r = p2.getBoundingClientRect(); } catch (e) { r = null; }
                    if (r && r.width >= 60 && r.width <= 520 &&
                        r.height >= 30 && r.height <= 640 &&
                        txt.length <= 200 && txt.indexOf('举报') >= 0) return row;
                    p1 = p2; p2 = p2.parentElement;
                }
            }
        }
        // ② 文本改版：按形状找菜单，取第一个短文本子项
        const box = menuLikeBox();
        if (box) {
            for (const k of box.children) {
                const t = (k.textContent || '').trim();
                if (t && t.length <= 16) return k;
            }
        }
        return null;
    }

    /* 菜单行的点击，四种方式轮换 —— 抖音这个菜单不吃某一种时还有别的：
     *   full   完整指针序列（over/move + down/up + down/up + click）
     *   native 只派发 click
     *   parent 点父级（有的实现把 onClick 绑在行容器上）
     *   hit    elementFromPoint 取中心点最上层元素再点（有遮罩层时用）
     *
     * v9.20.6：一律用「派发 click」而不是 el.click()。
     * el.click() 会执行浏览器的默认行为 —— 目标落在 <a href> 上就是一次跳转，
     * 表现正是「跳过直播后页面像刷新了一次」。React 的 onClick 监听的是 click
     * 事件本身，派发同样能触发，但不会再跳转。 */
    function synthClick(target) {
        if (!target) return false;
        let r;
        try { r = target.getBoundingClientRect(); } catch (e) { return false; }
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        gmSynthClickUntil = Date.now() + 80;
        try {
            target.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, composed: true, view: window,
                clientX: cx, clientY: cy, screenX: cx, screenY: cy,
                button: 0, detail: 1
            }));
            return true;
        } catch (e) { return false; }
    }

    function activateMenuRow(el, mode) {
        if (!el || !el.isConnected) return false;
        let target = el;
        if (mode === 'parent') target = el.parentElement || el;
        if (mode === 'hit') {
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { r = null; }
            if (r) {
                try {
                    const hit = document.elementFromPoint(
                        r.left + r.width / 2, r.top + r.height / 2);
                    if (hit && hit !== el) target = hit;
                } catch (e) {}
            }
        }
        if (mode !== 'full') return synthClick(target);
        gmSynthClickUntil = Date.now() + 80;
        let r;
        try { r = target.getBoundingClientRect(); } catch (e) { return false; }
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const base = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: cx, clientY: cy, screenX: cx, screenY: cy
        };
        const fire = (type, Ctor, extra) => {
            try { target.dispatchEvent(new Ctor(type, Object.assign({}, base, extra))); }
            catch (e) {}
        };
        if (typeof PointerEvent === 'function') {
            const pe = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
            fire('pointerover', PointerEvent, Object.assign({ button: -1, buttons: 0 }, pe));
            fire('pointermove', PointerEvent, Object.assign({ button: -1, buttons: 0 }, pe));
            fire('pointerdown', PointerEvent, Object.assign({ button: 0, buttons: 1 }, pe));
            fire('pointerup', PointerEvent, Object.assign({ button: 0, buttons: 0 }, pe));
        }
        fire('mouseover', MouseEvent, { button: 0, buttons: 0 });
        fire('mousemove', MouseEvent, { button: 0, buttons: 0 });
        fire('mousedown', MouseEvent, { button: 0, buttons: 1 });
        fire('mouseup', MouseEvent, { button: 0, buttons: 0 });
        fire('click', MouseEvent, { button: 0, buttons: 0, detail: 1 });
        return true;
    }

    /* 卡片自带的「不感兴趣」入口。点它也会弹出同一个菜单，
       但不会像 r 键那样把整批推荐换掉（那就是用户说的「刷新一次页面」）。
       ① 卡片里直接有「不感兴趣」文本的入口 → 点它
       ② 没有就点「…」更多按钮，由它弹出同一个菜单
       都找不到返回 null，由调用方决定退回 r 还是直接划走。 */
    function findCardEntry(card) {
        const root = card || document.querySelector('[data-e2e="feed-live"]');
        if (!root) return null;
        const nodes = root.querySelectorAll('div, span, button, a, [role="button"]');
        for (let i = 0; i < nodes.length && i < 500; i++) {
            const el = nodes[i];
            if (el.children.length) continue;
            if ((el.textContent || '').trim() !== '不感兴趣') continue;
            if (el.closest('#gm-settings-panel')) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (r.width < 20 || r.height < 10) continue;
            return el;
        }
        // ② 「…」更多按钮：点它弹出同一个菜单
        const more = root.querySelector(
            '[data-e2e="video-play-more"], [data-e2e*="play-more"], ' +
            '[data-e2e*="more-panel"], [aria-label*="更多"]');
        if (more) {
            let r;
            try { r = more.getBoundingClientRect(); } catch (e) { r = null; }
            if (r && r.width > 12 && r.height > 12) return more;
        }
        return null;
    }

    /* 「唤出 → 点」的重试链。
     * 唤出优先用卡片自带的「不感兴趣」入口 —— 它只会弹菜单，不动推荐流。
     * 找不到入口才按 r，而且最多两次：r 在首页是「换一批推荐」，
     * 连按就会把整批卡片换掉，那就是用户看到的「页面刷新了一次」。
     * 点完 480ms 复查菜单是否消失；四种点法都无效才改用键盘。 */
    const LIVE_SKIP_MODES = ['full', 'native', 'parent', 'hit'];
    const LIVE_SKIP_DEADLINE = 6000;      // 整个跳过流程最多 6 秒
    let liveSkipTimer = null, liveSkipTries = 0, liveSkipClicked = false;
    let liveSkipSummon = 0, liveSkipUntil = 0, liveSkipCardEl = null;
    let liveSkipAllowR = true;
    function stopLiveSkip() {
        if (liveSkipTimer) { clearTimeout(liveSkipTimer); liveSkipTimer = null; }
        liveSkipTries = 0;
        liveSkipClicked = false;
        liveSkipSummon = 0;
        liveSkipUntil = 0;
        liveSkipCardEl = null;
        liveSkipAllowR = true;
    }
    function liveSkipNote(msg) {
        liveSkipLog.push(new Date().toTimeString().slice(0, 8) + ' ' + msg);
        if (liveSkipLog.length > 40) liveSkipLog.shift();
    }
    function liveSkipStep() {
        liveSkipTimer = null;
        if (liveSkipUntil && Date.now() > liveSkipUntil) {
            liveSkipNote('超时 → 收工');
            stopLiveSkip();
            return;
        }
        // 卡片已经被换掉（不管是入口、菜单还是别的什么起作用）
        if (liveSkipCardEl && !liveSkipCardEl.isConnected) {
            liveSkipNote('卡片已切换 → 收工');
            stopLiveSkip();
            return;
        }
        const row = findMenuRow();
        if (row) {
            const mode = LIVE_SKIP_MODES[Math.min(liveSkipTries, LIVE_SKIP_MODES.length - 1)];
            liveSkipNote('点 row[' + mode + '] <' + row.tagName.toLowerCase() + '> ' +
                String(row.className || '(no class)').slice(0, 24) + ' 「' +
                (row.textContent || '').trim().slice(0, 12) + '」');
            activateMenuRow(row, mode);
            liveSkipClicked = true;
            liveSkipTries++;
            if (liveSkipTries < LIVE_SKIP_MODES.length) {
                liveSkipTimer = setTimeout(liveSkipStep, 480);
                return;
            }
            /* 四种点法都没关掉菜单：菜单只吃真实输入。用方向键选中 + 回车，
               菜单开着时焦点就在菜单里，这两个键是它的标准操作。 */
            liveSkipNote('点击全部无效 → 键盘选中');
            stopLiveSkip();
            tapKey('ArrowDown', 'ArrowDown');
            setTimeout(() => tapKey('Enter', 'Enter'), 180);
            showTip('点不动「不感兴趣」，已改用键盘选中', 2400);
            return;
        }
        // 菜单消失：点过就是成功，没点过就是还没唤出来
        if (liveSkipClicked) { liveSkipNote('菜单已关闭 → 收工'); stopLiveSkip(); return; }

        liveSkipSummon++;
        if (liveSkipSummon === 1) {
            const entry = findCardEntry(liveSkipCardEl);
            if (entry) {
                liveSkipNote('点卡片「不感兴趣」入口（不动推荐流）');
                synthClick(entry);
            } else if (liveSkipAllowR) {
                liveSkipNote('没有入口，按一次 r');
                tapKey('r', 'KeyR');
            } else {
                /* 广告卡片没有入口、也不能按 r（r 在视频上是「下一个」，
                   不会弹菜单），直接退化成划走。 */
                liveSkipNote('卡片没有入口且不允许 r → 直接划走');
                stopLiveSkip();
                tapKey('ArrowDown', 'ArrowDown');
                return;
            }
            liveSkipTimer = setTimeout(liveSkipStep, 480);
            return;
        }
        if (liveSkipSummon === 2 && liveSkipAllowR) {
            liveSkipNote('再按一次 r');
            tapKey('r', 'KeyR');
            liveSkipTimer = setTimeout(liveSkipStep, 480);
            return;
        }
        liveSkipNote('唤不出菜单 → 方向键切走');
        showTip('没能唤出菜单，已用方向键切走', 2200);
        stopLiveSkip();
        tapKey('ArrowDown', 'ArrowDown');
    }
    /* 点「不感兴趣」跳过。allowR 只有直播卡片可以给 true：
       直播卡上 r 会弹出操作菜单，视频卡上 r 只是「下一个」。 */
    function skipByDislike(allowR, cardEl) {
        stopLiveSkip();
        liveSkipCardEl = cardEl || null;
        liveSkipAllowR = !!allowR;
        liveSkipUntil = Date.now() + LIVE_SKIP_DEADLINE;
        liveSkipStep();
    }

    function dumpLiveSkip() {
        const row = findMenuRow();
        const box = menuLikeBox();
        const lines = [
            '# 直播跳过诊断',
            'url: ' + location.href,
            '开关: skipAds=' + !!config.skipAds + ' skipLiveFeed=' + !!config.skipLiveFeed,
            '方式: 广告=' + (config.adSkipAction || 'next') +
                ' 直播=' + (config.liveSkipAction || 'block') +
                ' 黑名单=' + (config.filterSkipAction || 'next'),
            '当前菜单行: ' + (row ? '<' + row.tagName.toLowerCase() + '> ' +
                String(row.className || '(no class)') + ' 「' +
                (row.textContent || '').trim().slice(0, 20) + '」' : 'null'),
            '形状像菜单的容器: ' + (box ? '<' + box.tagName.toLowerCase() + '> ' +
                String(box.className || '(no class)') + ' 子项=' + box.childElementCount +
                ' 文本=' + (box.textContent || '').trim().slice(0, 40) : 'null'),
            '卡片「不感兴趣」入口: ' + (function () {
                const e = findCardEntry();
                if (!e) return 'null（会退回按 r，可能换一批推荐）';
                const r = e.getBoundingClientRect();
                return '<' + e.tagName.toLowerCase() + '> ' + String(e.className || '(no class)') +
                    ' rect=' + [r.left | 0, r.top | 0, r.width | 0, r.height | 0].join(',');
            })(),
            '--- 最近记录 ---'
        ];
        if (!liveSkipLog.length) lines.push('(还没有记录，请先让它跳一次直播)');
        else lines.push.apply(lines, liveSkipLog);
        return lines.join('\n');
    }

    /* 只划走：不点任何菜单，直接切下一条。
       「下一条」按钮优先；直播卡片上没有这个按钮，用方向键下
       （直播卡上 r 会弹操作菜单，所以绝不能用 r）。 */
    function nextFeed(isLiveCard) {
        const btn = document.querySelector(
            '.xgplayer-playswitch-next, [data-e2e="video-switch-next"], [data-e2e*="switch-next"]');
        if (btn && !isLiveCard) {
            try { btn.click(); return true; } catch (e) {}
        }
        if (isLiveCard) { tapKey('ArrowDown', 'ArrowDown'); return false; }
        tapKey('r', 'KeyR');
        return false;
    }

    function feedCardVid(box) {
        if (box && box.dataset && box.dataset.e2eVid) return 'vid:' + box.dataset.e2eVid;
        const v = box && box.querySelector('video');
        const src = (v && (v.currentSrc || v.src)) || '';
        if (src) return 'src:' + src.slice(-48);
        const m = location.href.match(/\/video\/(\d+)/);
        return m ? 'url:' + m[1] : '';
    }

    function adMarkOf(box) {
        try {
            if (box.matches('[data-e2e*="ad-tag"], [data-e2e*="ad-mark"], ' +
                    '[class*="is-ad"], [class*="isAd"]')) return '广告';
            if (box.querySelector('[data-e2e*="ad-tag"], [class*="ad-tag"], ' +
                    '[class*="adTag"], [class*="is-ad"]')) return '广告';
            /* v9.20.7：抖音把「广告」两个字画成 SVG 角标（30×16），
               这种卡片文案里没有「广告」二字，只靠文本会漏。
               属性选择器对 SVG 的 viewBox 大小写敏感，两种写法都试。 */
            if (box.querySelector('svg[viewBox="0 0 30 16"], svg[viewbox="0 0 30 16"]'))
                return '广告';
        } catch (e) {}
        let hit = '';
        walkText(box, 1500, (node) => {
            const t = (node.nodeValue || '').trim();
            if (!t || t.length > 10) return;
            if (AD_LEAF_RE.test(t)) { hit = t; return false; }
        });
        return hit;
    }

    function stillOnKey(key) {
        if (!key) return false;
        if (key.indexOf('live|') === 0) {
            const live = document.querySelector('[data-e2e="feed-live"]');
            return !!live && ('live|' + (live.innerText || '').slice(0, 30)) === key;
        }
        const box = document.querySelector('[data-e2e="feed-active-video"]');
        return !!box && ('ad|' + feedCardVid(box)) === key;
    }

    function skipFeed(reason, key, forceAction) {
        const now = Date.now();
        // 两个跳过任务（黑名单 / 广告）可能同时命中，1.2s 内只跳一次
        if (now - lastSkipAt < 1200) return;
        if (key && key === lastSkipKey && now - lastSkipAt < 5000) return;
        lastSkipKey = key; lastSkipAt = now;
        const isLiveCard = key.indexOf('live|') === 0;
        /* 两种跳过方式（面板可分别设置）：
           block = 点「不感兴趣」，不再推荐这类内容，代价是流程长；
           next  = 只按一下键划走，不改变推荐偏好，想看的还能划回来。 */
        const action = forceAction || (isLiveCard
            ? (config.liveSkipAction || 'block')
            : (config.adSkipAction || 'next'));
        if (action === 'block') {
            const cardEl = isLiveCard
                ? document.querySelector('[data-e2e="feed-live"]')
                : document.querySelector('[data-e2e="feed-active-video"]');
            skipByDislike(isLiveCard, cardEl);
        } else {
            nextFeed(isLiveCard);
        }
        /* 「下一条」按钮是 display:none 的，click() 偶尔不被 React 接住；
           320ms 后还停在同一张卡片就补一次，别在原地卡死。 */
        setTimeout(() => {
            if (!stillOnKey(key)) return;
            if (action === 'block') {
                // 重试链由 liveSkipStep 自己负责，这里只补一次菜单行的点击
                const row = findMenuRow();
                if (row) activateMenuRow(row, 'native');
                else if (!isLiveCard) nextFeed(false);
            } else {
                nextFeed(isLiveCard);
            }
        }, 320);
        showTip('已跳过' + reason, 1200);
    }

    function checkFeedSkip() {
        if (!config.skipAds && !config.skipLiveFeed) return;
        if (isLivePage()) return;
        const now = Date.now();
        if (now - lastFeedCheck < 700) return;
        lastFeedCheck = now;

        const box = document.querySelector('[data-e2e="feed-active-video"]');
        if (!box) {
            if (!config.skipLiveFeed) return;
            // 「唤出菜单 → 点不感兴趣」的重试链还在跑，别打断它
            if (liveSkipTimer) return;
            const live = document.querySelector('[data-e2e="feed-live"]');
            if (!live) return;
            // 只认占住主区域的直播卡片，别把右侧推荐里的小卡当当前视频
            let r;
            try { r = live.getBoundingClientRect(); } catch (e) { return; }
            if (r.width < 240 || r.height < 200) return;
            if (r.left > window.innerWidth * 0.5) return;
            skipFeed('直播', 'live|' + (live.innerText || '').slice(0, 30));
            return;
        }
        if (!config.skipAds) return;
        /* 同一张卡片最多扫 3 次：标签区可能比视频晚渲染，第一次没命中要重试，
           但没必要每 1.5s 把 1500 个文本节点过一遍。 */
        const vid = feedCardVid(box);
        if (vid && vid === adCheckVid) {
            if (adCheckCount >= 3) return;
            adCheckCount++;
        } else {
            adCheckVid = vid; adCheckCount = 1;
        }
        const mark = adMarkOf(box);
        if (mark) skipFeed('广告', 'ad|' + vid);
    }

    let resumeGuardUntil = 0;
    let userMutedManually = false, resumeLastUrl = location.href;
    /* v9.35：最近一次用户操作的时间。用来区分「手动静音」和「抖音自己静音」——
       旧版只要看到静音就开守护，等于「你一静音，我就把你解掉」。 */
    let lastUserInputAt = 0;
    ['pointerdown', 'keydown'].forEach(t =>
        document.addEventListener(t, () => { lastUserInputAt = Date.now(); }, true));

    /* ---- 7.9 静默礼物声音（幂等、只静音不阻断） ----
     * v9.19：先判开关与页面，不满足直接原样 play()。旧版每个 play 都做一次
     * getBoundingClientRect，直播礼物音效密集时等于每秒几十次强制布局。 */
    if (!HTMLMediaElement.prototype.play.__gmWrapped) {
        const originalPlay = HTMLMediaElement.prototype.play;
        function wrappedPlay() {
            if (config.hideGiftAudio && isLivePage()) {
                try {
                    let big = false;
                    try {
                        const r = this.getBoundingClientRect && this.getBoundingClientRect();
                        big = this.tagName === 'VIDEO' && r && r.width > 300;
                    } catch (e) {}
                    if (big || (Date.now() < resumeGuardUntil && this.tagName === 'VIDEO')) {
                        // 主视频永远不被礼物静音逻辑压回静音
                    } else {
                        const src = this.src || this.currentSrc || '';
                        if (this.tagName === 'AUDIO' || /gift|effect|\.aac|\.mp3/i.test(src))
                            this.muted = true;
                    }
                } catch (e) {}
            }
            return originalPlay.apply(this, arguments);
        }
        wrappedPlay.__gmWrapped = true;
        HTMLMediaElement.prototype.play = wrappedPlay;
    }

    function muteGiftAudios() {
        if (!config.hideGiftAudio || !isLivePage()) return;
        document.querySelectorAll('audio').forEach(a => {
            const src = a.src || a.currentSrc || '';
            if (/gift|effect|\.aac|\.mp3/i.test(src)) a.muted = true;
        });
    }

    /* ---- 7.10 URL 变化 ---- */
    let currentUrl = location.href;
    function checkUrlChange() {
        if (location.href !== currentUrl) {
            currentUrl = location.href;
            lastFilteredKey = '';
            document.querySelectorAll('[data-gm-real-count]').forEach(el =>
                el.removeAttribute('data-gm-real-count'));
            /* 换了房间：立刻开画质爆发期（SPA 跳转不会重载脚本） */
            if (isLiveHost || isLivePage()) safeRun(() => kickQualityBurst(8000));
        }
    }

    /* ---- 7.12 聊天室上方的摄像头小窗：独立浮出 + 自由拖动 ----
     * 直播间的「主播摄像头 / 连麦 / 观众连麦」小窗平时挤在聊天室顶部，
     * 想看清楚或者让开弹幕都很别扭。这里把它从原位置「浮」出来：
     * 只改 position / left / top（不重新挂载 DOM —— 把 React 管的节点搬走，
     * 卸载时会抛 NotFoundError 把整个聊天室搞崩），拖动后的位置存 localStorage，
     * 下次进直播间沿用；双击「复位」按钮回原位。
     * 自动识别失败时，可在设置面板里填 CSS 选择器，或点「复制候选」发我。 */
    const CAM_POS_KEY = 'gm_dy_cam_pos';
    const CAM_CLASS = 'xydy-cam-detached';
    const CAM_PROPS = ['position', 'left', 'top', 'width', 'height', 'right', 'bottom',
        'margin', 'transform', 'transform-origin', 'z-index', 'cursor', 'user-select',
        'box-shadow', 'border-radius', 'overflow', 'transition', 'resize', 'background',
        'max-width', 'max-height', 'min-width', 'min-height', 'clip-path'];
    let camEl = null;
    let camDrag = null;

    function camPosRead() {
        try {
            const o = JSON.parse(localStorage.getItem(CAM_POS_KEY) || 'null');
            return (o && typeof o === 'object') ? o : null;
        } catch (e) { return null; }
    }
    let camSavedSig = '';
    function camPosSave(o) {
        const sig = JSON.stringify(o);
        if (sig === camSavedSig) return;      // 每 1.5s 一次轮询，内容没变就不写盘
        camSavedSig = sig;
        try { localStorage.setItem(CAM_POS_KEY, sig); } catch (e) {}
    }
    function camSetProps(el, map) {
        for (const k of Object.keys(map))
            el.style.setProperty(k, map[k], 'important');
    }
    /* fixed 的参照物不一定是视口：祖先里只要有 transform / filter / contain /
       will-change，它就成了 fixed 的包含块，left/top 必须减去它的视口原点，
       否则浮窗会整体偏移（抖音的播放器/聊天列大量用 transform，这个坑必踩）。 */
    function camContainingOffset(el) {
        let cur = el && el.parentElement, d = 0;
        while (cur && cur !== document.body && d++ < 20) {
            let st;
            try { st = getComputedStyle(cur); } catch (e) { break; }
            if (!st) break;
            const hasBlock = (st.transform && st.transform !== 'none') ||
                (st.perspective && st.perspective !== 'none') ||
                (st.filter && st.filter !== 'none') ||
                (st.backdropFilter && st.backdropFilter !== 'none') ||
                /paint|layout|strict|content/.test(st.contain || '') ||
                /transform|perspective|filter/.test(st.willChange || '');
            if (hasBlock) {
                const r = cur.getBoundingClientRect();
                return { x: r.left + (cur.clientLeft || 0), y: r.top + (cur.clientTop || 0) };
            }
            cur = cur.parentElement;
        }
        return { x: 0, y: 0 };
    }
    /* 原始尺寸（还没被我们缩放时的壳子大小）：
       一加上 transform，getBoundingClientRect 给的就是放大后的尺寸，
       不能再当基准，所以在「第一次动手」时记下来。 */
    /* 壳子里「真正要显示的画面」占到多大。
       抖音先把小窗按 16:9 占位（448×252），摄像头流进来之后再把里面的
       #double_screen 撑成真实比例（448×360），壳子高度不跟着长，靠
       overflow 把下半截裁掉。照抄壳子高度浮出去，画面就被裁掉一截
       （只剩脸、下巴和肩膀没了）。所以这里量子节点实际占到的外框，
       比壳子大就以它为准。 */
    function camContentSize(el) {
        let w = 0, h = 0;
        for (const c of el.children) {
            if (!c || c.nodeType !== 1) continue;
            const cw = c.offsetWidth || 0, ch = c.offsetHeight || 0;
            if (cw < 40 || ch < 30) continue;
            const same = (c.offsetParent === el);
            w = Math.max(w, (same ? (c.offsetLeft || 0) : 0) + cw);
            h = Math.max(h, (same ? (c.offsetTop || 0) : 0) + ch);
        }
        return { w: w, h: h };
    }
    function camNatSize(el) {
        if (!el.__gmCamNat) {
            let w = 0, h = 0;
            try {
                const r = el.getBoundingClientRect();
                w = Math.round(r.width); h = Math.round(r.height);
            } catch (e) {}
            if (w < 40 || h < 30) {
                w = el.offsetWidth || w; h = el.offsetHeight || h;
            }
            el.__gmCamNat = { w: Math.max(40, w), h: Math.max(30, h) };
        }
        /* 只许长大，不许缩回：16:9 占位 → 真实比例、换摄像头都会变高。
           给个上限（不超过宽度的 2 倍）防止跟着自己写的 height 无限长。 */
        const content = camContentSize(el);
        if (content.w > el.__gmCamNat.w + 2)
            el.__gmCamNat.w = Math.round(Math.min(content.w, el.__gmCamNat.w * 2));
        if (content.h > el.__gmCamNat.h + 2)
            el.__gmCamNat.h = Math.round(Math.min(content.h, el.__gmCamNat.w * 2));
        return el.__gmCamNat;
    }

    /* 浮窗定位 = 固定定位 + translate 平移 + scale 等比放大。
       不再给 width/height 设「想显示多大」，而是保持原尺寸再缩放 ——
       这样内层写死的像素（#double_screen 的 224px 之类）连同视频画面
       一起被等比放大，绝不会出现「外壳大了、画面还缩在角落」。 */
    /* 摄像头小窗是独立的一个 <video>，自带音轨：主播放器音量拖到 0 之后
       还能听到声音，多半就是它。浮出时静音它，关掉浮出时还原。 */
    const camAudioState = new WeakMap();
    function camSilenceVideo(el) {
        for (const v of el.querySelectorAll('video')) {
            if (!camAudioState.has(v)) camAudioState.set(v, !!v.muted);
            if (!v.muted) { try { v.muted = true; } catch (e) {} }
        }
    }
    function camRestoreAudio(el) {
        for (const v of el.querySelectorAll('video')) {
            if (!camAudioState.has(v)) continue;
            try { v.muted = camAudioState.get(v); } catch (e) {}
            camAudioState.delete(v);
        }
    }

    function applyCamBox(el, pos) {
        if (!el.__gmCamCss) {
            const m = {};
            for (const k of CAM_PROPS)
                m[k] = el.style.getPropertyValue(k) +
                    (el.style.getPropertyPriority(k) ? '!' : '');
            el.__gmCamCss = m;
        }
        el.classList.add(CAM_CLASS);
        const nat = camNatSize(el);
        /* 底色：原壳子本来就是透明的话（聊天列里看不出来），浮到视频上就会
           透出后面的画面，补一块黑底；本来有底色就沿用页面自己的。 */
        if (!el.__gmCamBg) {
            let bg = '';
            try { bg = getComputedStyle(el).backgroundColor || ''; } catch (e) {}
            el.__gmCamBg = (!bg || /^transparent$|rgba\(0,\s*0,\s*0,\s*0\)/.test(bg))
                ? '#000' : bg;
        }
        const dw = Math.max(90, Math.round(pos.w || nat.w));
        const dh = Math.max(60, Math.round(pos.h || nat.h));
        /* 取两个方向里较大的比例：无论往右下拖宽还是拖高，整个窗都跟着长 */
        const k = Math.max(dw / nat.w, dh / nat.h);
        const off = camContainingOffset(el);
        /* v9.31：不再裁剪。裁剪会把画面切成一条窄带（放大过头的那种效果），
           浮出后应当和原来那个小窗看到的完全一样，只是位置能拖。 */
        const vw = nat.w, vh = nat.h, ox = 0, oy = 0;
        camSetProps(el, {
            'position': 'fixed',
            'left': '0px', 'top': '0px',
            'width': nat.w + 'px',
            'height': nat.h + 'px',
            'right': 'auto', 'bottom': 'auto', 'margin': '0',
            'min-width': '0', 'min-height': '0',
            'max-width': 'none', 'max-height': 'none',
            'transform-origin': '0 0',
            'transform': 'translate(' + Math.round(pos.left - ox * k - off.x) + 'px,' +
                         Math.round(pos.top - oy * k - off.y) + 'px) scale(' + k.toFixed(4) + ')',
            'clip-path': 'none',
            'z-index': '2147482000',
            'cursor': 'move', 'user-select': 'none',
            'box-shadow': '0 10px 30px rgba(0,0,0,.6)',
            'border-radius': '10px', 'overflow': 'hidden',
            'background': el.__gmCamBg || '#000',
            'transition': 'none', 'resize': 'none'
        });
        /* 记住「视觉尺寸」，拖动/改大小/复位都以它为准。
           注意 reqW/reqH 是「裁剪前」的请求尺寸，改大小时按比例换算，
           不能拿裁剪后的尺寸当基准（否则每轮都会被自己的裁剪再缩一次）。 */
        el.__gmCamView = { left: pos.left, top: pos.top,
                           w: Math.round(vw * k), h: Math.round(vh * k),
                           k: k, reqW: dw, reqH: dh };
        camSilenceVideo(el);             // 别让摄像头小窗自己出声
    }
    function clearCamBox(el) {
        if (!el) return;
        el.classList.remove(CAM_CLASS);
        const m = el.__gmCamCss;
        if (!m) return;
        for (const k of CAM_PROPS) {
            const v = m[k] || '';
            try {
                if (!v) el.style.removeProperty(k);
                else if (v.slice(-1) === '!')
                    el.style.setProperty(k, v.slice(0, -1).trim(), 'important');
                else el.style.setProperty(k, v);
            } catch (e) {}
        }
        camRestoreAudio(el);
        delete el.__gmCamCss;
        delete el.__gmCamNat;
        delete el.__gmCamView;
        delete el.__gmCamBg;
    }

    /* 从 <video> 往上找「紧贴画面的外壳」：容器比画面大太多就不是小窗外壳了。
       v9.26：已经浮出去的那层优先返回 —— 放大后外层比内层大，否则会误判成
       内层才是外壳，React 重建节点时就会把内层搬出来、外层剩个空壳。 */
    function camBoxOf(video) {
        let el = video;
        for (let d = 0; d < 5; d++) {
            const p = el.parentElement;
            if (!p || p === document.body) break;
            if (p.classList && p.classList.contains(CAM_CLASS)) return p;
            const pr = p.getBoundingClientRect(), cr = el.getBoundingClientRect();
            if (pr.width < 80 || pr.height < 60) break;
            if (pr.width > cr.width * 1.4 || pr.height > cr.height * 1.6) break;
            el = p;
        }
        return el;
    }
    function camSelectorEl() {
        const sel = (config.camSelector || '').trim();
        if (!sel || sel.length > 300) return null;
        try {
            for (const el of document.querySelectorAll(sel)) {
                if (el.closest('#gm-settings-panel')) continue;
                const r = el.getBoundingClientRect();
                if (r.width > 60 && r.height > 40) return el;
            }
        } catch (e) {}
        return null;
    }
    /* 自动识别「聊天室上方那块摄像头小窗」。
     * v9.24.1：按用户实测 DOM 修正判据 —— 现场是
     *   chatPanelRect = [1501, 0, 398, 950]   整条右列（top 就是 0）
     *   video         = [1501, -340, 598, 565]  画面被放大 + 超出壳子
     *   壳子          = div.iUPxPrkx  [1501, 0, 398, 224]
     * 旧判据「箱体必须在聊天室上沿之上」把小窗自己筛掉了（它就在那一列里），
     * 而按 video 尺寸判定也会因为画面比壳子大而漏。现在一律以「壳子」为准：
     * 尺寸合理、面积远小于主画面、落在聊天室那一列、且靠这一列的上部。 */
    function camAutoEl() {
        const main = findActiveVideo();
        let mainArea = 0;
        if (main) {
            const mr = main.getBoundingClientRect();
            mainArea = mr.width * mr.height;
        }
        const chat = chatPanelRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        let best = null, bestScore = -1;
        for (const v of document.querySelectorAll('video')) {
            if (v === main) continue;
            /* v9.37.10：直播列表页的卡片（`a.LiveLinkA`）里也有小 video，
               不能当主播摄像头浮出来 */
            if (v.closest && v.closest('a[href*="show_type"], .LiveLinkA, ' +
                '[data-e2e*="livecard"], [data-e2e*="live-card"]')) continue;
            const box = camBoxOf(v);
            if (!box || !box.getBoundingClientRect) continue;
            if (main && box.contains(main)) continue;      // 主播放器自己的壳子
            const detAnc = box.closest('.' + CAM_CLASS);   // 已经在某个浮窗里面了
            /* 已经是浮窗：位置早就被拖走了，不能再拿「在右列 / 靠上沿」去打分 */
            if (detAnc) return detAnc;
            const br = box.getBoundingClientRect();
            if (br.width < 90 || br.height < 50) continue;
            if (br.width > 900 || br.height > 700) continue;
            if (br.width * br.height > vw * vh * 0.35) continue;
            if (mainArea && br.width * br.height > mainArea * 0.5) continue;
            if (br.right < 0 || br.bottom < 0 || br.left > vw || br.top > vh) continue;

            let score = 0;
            if (chat) {
                if (br.left >= chat.left - 60) score += 4;                 // 在右列
                if (Math.abs(br.width - chat.width) <= Math.max(48, chat.width * 0.35))
                    score += 2;                                            // 宽度接近聊天室
                if (br.top <= chat.top + chat.height * 0.4) score += 3;    // 靠这一列上部
                if (br.left >= chat.left - 60 && br.top >= chat.top - 20) score += 1;
            } else {
                if (br.left > vw * 0.55) score += 3;
                if (br.top < vh * 0.5) score += 2;
            }
            if (score >= 5 && score > bestScore) { bestScore = score; best = box; }
        }
        return best;
    }

    function applyCamDetach() {
        if (!(isLiveHost || isLivePage())) return;
        if (camDrag || camResize) return;    // 拖动/改大小中别毎 1.5s 把它掰回去
        /* v9.37.10：只在**真正的直播间**里浮出摄像头小窗。
           live.douyin.com 首页/分类页是一堆直播卡片（`a.LiveLinkA`），
           里面也有小 video，之前会被当成「主播摄像头」整块浮出来。
           真正的直播间一定有 living-container（`data-e2e="living-container"`）。 */
        if (!document.querySelector('[data-e2e="living-container"]')) {
            if (camEl) { clearCamBox(camEl); camEl = null; }
            document.querySelectorAll('.' + CAM_CLASS).forEach(clearCamBox);
            return;
        }
        if (!config.detachCam) {
            if (camEl) { clearCamBox(camEl); camEl = null; }
            document.querySelectorAll('.' + CAM_CLASS).forEach(clearCamBox);
            return;
        }
        let el = camSelectorEl();
        if (!el && camEl && camEl.isConnected) el = camEl;
        if (!el) el = camAutoEl();
        if (!el) { camEl = null; return; }
        if (el !== camEl) {
            if (camEl && camEl.isConnected) clearCamBox(camEl);
            camEl = el;
        }
        /* React 重渲染会抹掉 inline 样式：每轮补一次（1500ms 一次，肉眼无感） */
        const nat = camNatSize(el);
        let r = null;
        try { r = el.getBoundingClientRect(); } catch (e) {}
        let pos = camPosRead() || {};
        /* 旧记录 / 自然尺寸变了（16:9 占位 → 真实比例）：位置和缩放倍数留着，尺寸重算 */
        if (pos.v !== 2 || !pos.natW || Math.abs(pos.natW - nat.w) > 2 ||
            (pos.natH && Math.abs(pos.natH - nat.h) > 2)) {
            pos = { left: pos.left, top: pos.top, k: pos.k };
        }
        /* 尺寸一律由「自然尺寸 × 缩放倍数」算出来，不再存裁剪后的宽高 */
        let k = (pos.k && pos.k > 0.05 && pos.k < 12) ? pos.k : 1;
        if (!pos.k && pos.w) k = pos.w / nat.w;          // 更老的记录只有宽
        const w = Math.max(90, Math.round(nat.w * k));
        const h = Math.max(60, Math.round(nat.h * k));
        if (!Number.isFinite(pos.left)) pos.left = r ? r.left : 24;
        if (!Number.isFinite(pos.top)) pos.top = r ? r.top : 24;
        pos.left = Math.max(-w + 80, Math.min(pos.left, window.innerWidth - 80));
        pos.top = Math.max(0, Math.min(pos.top, window.innerHeight - 60));
        applyCamBox(el, { left: pos.left, top: pos.top, w: w, h: h });
        const view = el.__gmCamView || {};
        camPosSave({ v: 2, left: Math.round(pos.left), top: Math.round(pos.top),
                     k: Number((view.k || k).toFixed(4)),
                     natW: nat.w, natH: nat.h });
    }

    /* v9.33：缩放改成「拖四个角」—— 不再放那个小方块把手。
       按住哪个角，对角就固定不动；窗口内部拖动 = 移动。 */
    let camResize = null;
    const CAM_CORNER = 20;          // 角的感应半径（px）
    function camCornerAt(v, x, y) {
        if (!v) return null;
        const nearL = Math.abs(x - v.left) <= CAM_CORNER;
        const nearR = Math.abs(x - (v.left + v.w)) <= CAM_CORNER;
        const nearT = Math.abs(y - v.top) <= CAM_CORNER;
        const nearB = Math.abs(y - (v.top + v.h)) <= CAM_CORNER;
        if (nearL && nearT) return { cx: -1, cy: -1 };
        if (nearR && nearT) return { cx: 1, cy: -1 };
        if (nearL && nearB) return { cx: -1, cy: 1 };
        if (nearR && nearB) return { cx: 1, cy: 1 };
        return null;
    }
    function camCursorFor(c) {
        if (!c) return 'move';
        return (c.cx === c.cy) ? 'nwse-resize' : 'nesw-resize';
    }

    function camResizeMove(e) {
        if (!camResize || !camEl) return;
        const dx = e.clientX - camResize.x, dy = e.clientY - camResize.y;
        if (!camResize.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
        camResize.moved = true;
        const c = camResize.corner;
        /* 以「对角」为锚：从锚点算出来的宽高，等比取较大的那个 */
        const w = Math.abs(e.clientX - camResize.ax);
        const h = Math.abs(e.clientY - camResize.ay);
        const r = Math.max(w / camResize.w, h / camResize.h);
        const lo = 160 / Math.max(camResize.w, camResize.h);
        const rr = Math.max(r, lo);
        const newW = Math.max(160, Math.round(camResize.w * rr));
        const newH = Math.max(100, Math.round(camResize.h * rr));
        const left = c.cx > 0 ? camResize.ax : camResize.ax - newW;
        const top = c.cy > 0 ? camResize.ay : camResize.ay - newH;
        applyCamBox(camEl, { left: left, top: top, w: newW, h: newH });
        e.preventDefault();
    }
    function camResizeEnd() {
        if (!camResize) return;
        const st = camResize;
        camResize = null;
        if (!st.moved || !camEl) return;
        suppressNextClick = true;
        const v = camEl.__gmCamView;
        if (!v) return;
        camPosSave({ v: 2, left: Math.round(v.left), top: Math.round(v.top),
                     k: Number((v.k || 1).toFixed(4)),
                     natW: (camNatSize(camEl) || {}).w,
                     natH: (camNatSize(camEl) || {}).h });
        showTip('摄像头小窗：' + Math.round(v.w) + '×' + Math.round(v.h), 1200);
    }

    function camResetPos() {
        try { localStorage.removeItem(CAM_POS_KEY); } catch (e) {}
        camSavedSig = '';
        if (camEl) {
            clearCamBox(camEl);
            camEl = null;
        }
        document.querySelectorAll('.' + CAM_CLASS).forEach(clearCamBox);
        showTip('摄像头小窗已复位（会回到聊天室上方）', 1800);
    }

    /* 按住画面拖动；按在四个角上则是缩放 */
    function camDragStart(e) {
        if (!config.detachCam || !camEl || e.button !== 0) return;
        const t = e.target;
        if (!(t instanceof Element) || !camEl.contains(t)) return;
        if (t.closest('#gm-settings-panel')) return;
        const v = camEl.__gmCamView;
        if (!v) return;
        const corner = camCornerAt(v, e.clientX, e.clientY);
        if (corner) {
            camResize = {
                x: e.clientX, y: e.clientY, corner: corner,
                /* 对角的固定点：按右下角就锚左上角 */
                ax: corner.cx > 0 ? v.left : v.left + v.w,
                ay: corner.cy > 0 ? v.top : v.top + v.h,
                w: v.w, h: v.h, moved: false, id: e.pointerId
            };
            camDrag = null;
            e.preventDefault();
            try { camEl.setPointerCapture && camEl.setPointerCapture(e.pointerId); } catch (err) {}
            return;
        }
        camDrag = {
            x: e.clientX, y: e.clientY, left: v.left, top: v.top,
            w: v.w, h: v.h, moved: false, id: e.pointerId
        };
        try { camEl.setPointerCapture && camEl.setPointerCapture(e.pointerId); } catch (err) {}
    }
    function camDragMove(e) {
        if (!camDrag || !camEl) return;
        const dx = e.clientX - camDrag.x, dy = e.clientY - camDrag.y;
        if (!camDrag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        camDrag.moved = true;
        const left = Math.max(-camDrag.w + 80,
            Math.min(camDrag.left + dx, window.innerWidth - 80));
        const top = Math.max(0, Math.min(camDrag.top + dy, window.innerHeight - 60));
        applyCamBox(camEl, { left: left, top: top, w: camDrag.w, h: camDrag.h });
        e.preventDefault();
    }
    function camDragEnd() {
        const st = camDrag;
        camDrag = null;
        if (!st) return;
        try {
            if (camEl && camEl.releasePointerCapture && st.id != null)
                camEl.releasePointerCapture(st.id);
        } catch (e) {}
        if (!st.moved || !camEl) return;
        suppressNextClick = true;       // 拖完别顺带把播放/暂停点出来
        const v = camEl.__gmCamView;
        if (!v) return;
        camPosSave({ v: 2, left: Math.round(v.left), top: Math.round(v.top),
                     k: Number((v.k || 1).toFixed(4)),
                     natW: (camNatSize(camEl) || {}).w,
                     natH: (camNatSize(camEl) || {}).h });
    }
    /* 悬停在四角时换个光标，告诉用户「这里能缩放」 */
    function camHoverCursor(e) {
        if (!config.detachCam || !camEl || camDrag || camResize) return;
        const v = camEl.__gmCamView;
        if (!v) return;
        if (e.clientX < v.left - CAM_CORNER || e.clientX > v.left + v.w + CAM_CORNER ||
            e.clientY < v.top - CAM_CORNER || e.clientY > v.top + v.h + CAM_CORNER) {
            if (camEl.__gmCamCursor !== 'move') {
                camEl.__gmCamCursor = 'move';
                camEl.style.setProperty('cursor', 'move', 'important');
            }
            return;
        }
        const cur = camCursorFor(camCornerAt(v, e.clientX, e.clientY));
        if (camEl.__gmCamCursor === cur) return;
        camEl.__gmCamCursor = cur;
        camEl.style.setProperty('cursor', cur, 'important');
    }
    window.addEventListener('pointerdown', camDragStart, true);
    window.addEventListener('pointermove', camDragMove, true);
    window.addEventListener('pointermove', camResizeMove, true);
    window.addEventListener('pointermove', camHoverCursor, true);
    window.addEventListener('pointerup', camDragEnd, true);
    window.addEventListener('pointerup', camResizeEnd, true);
    window.addEventListener('pointercancel', camDragEnd, true);
    window.addEventListener('pointercancel', camResizeEnd, true);

    /* 排障：列出所有可能是「摄像头小窗」的候选，自动识别失败时用它定位 */
    function dumpCamBoxes() {
        const lines = ['# 抖音优化 · 摄像头小窗候选', 'URL: ' + location.href];
        const main = findActiveVideo();
        const chat = chatPanelRect();
        lines.push('mainVideo: ' + (main ? (main.getBoundingClientRect().width | 0) + 'x' +
            (main.getBoundingClientRect().height | 0) : 'none'));
        lines.push('chatPanelRect: ' + (chat ? [chat.left | 0, chat.top | 0,
            chat.width | 0, chat.height | 0].join(',') : 'null'));
        lines.push('current: ' + (camEl ? (camEl.outerHTML || '').slice(0, 200) : 'null'));
        lines.push('auto: ' + (function () {
            const el = camAutoEl();
            if (!el) return 'null';
            const r = el.getBoundingClientRect();
            return '<' + el.tagName.toLowerCase() + '> ' + String(el.className || '').slice(0, 60) +
                ' rect=' + [r.left | 0, r.top | 0, r.width | 0, r.height | 0].join(',');
        })());
        /* 浮窗为什么偏 / 为什么拖不动，多半是祖先链上的 position/transform/overflow，
           这里把自动识别命中的那个壳子的 6 层祖先一并打出来。 */
        const autoEl = camAutoEl();
        if (autoEl) {
            lines.push('auto offset(containing block): ' + JSON.stringify(camContainingOffset(autoEl)));
            lines.push('auto ancestors:');
            let p = autoEl, d = 0;
            while (p && p !== document.body && d++ < 6) {
                let st = null;
                try { st = getComputedStyle(p); } catch (e) {}
                const pr = p.getBoundingClientRect();
                lines.push('  ' + d + ' <' + p.tagName.toLowerCase() + '> ' +
                    String(p.className || '').slice(0, 48) +
                    ' pos=' + (st ? st.position : '?') +
                    ' z=' + (st ? st.zIndex : '?') +
                    ' tf=' + (st ? String(st.transform).slice(0, 24) : '?') +
                    ' ovf=' + (st ? st.overflow : '?') +
                    ' rect=' + [pr.left | 0, pr.top | 0, pr.width | 0, pr.height | 0].join(','));
                p = p.parentElement;
            }
            /* 壳子里面的结构：放大后画面挤在角落 / 露黑边，就是这一层写死了像素 */
            lines.push('auto inner:');
            let dd = 0;
            const walk = (node, depth) => {
                if (dd++ > 14 || depth > 3) return;
                let st = null;
                try { st = getComputedStyle(node); } catch (e) {}
                const nr = node.getBoundingClientRect();
                lines.push('  ' + '  '.repeat(depth) + '<' + node.tagName.toLowerCase() + '> ' +
                    String(node.className || '').slice(0, 40) +
                    (node.id ? '#' + node.id : '') +
                    ' rect=' + [nr.left | 0, nr.top | 0, nr.width | 0, nr.height | 0].join(',') +
                    ' css=' + (st ? st.width + '×' + st.height : '?') +
                    ' pos=' + (st ? st.position : '?') +
                    ' tf=' + (st ? String(st.transform).slice(0, 22) : '?') +
                    ' of=' + (st ? st.objectFit : '?') +
                    ' inline="' + String(node.getAttribute && node.getAttribute('style') ||
                        '').slice(0, 70) + '"');
                for (const ch of node.children) walk(ch, depth + 1);
            };
            walk(autoEl, 0);
        }
        lines.push('--- 所有 video 候选 ---');
        let n = 0;
        for (const v of document.querySelectorAll('video')) {
            if (++n > 20) break;
            const r = v.getBoundingClientRect();
            const box = camBoxOf(v);
            const br = box.getBoundingClientRect();
            lines.push(JSON.stringify({
                video: [r.left | 0, r.top | 0, r.width | 0, r.height | 0],
                box: [br.left | 0, br.top | 0, br.width | 0, br.height | 0],
                tag: box.tagName, id: box.id,
                cls: String(box.className || '').slice(0, 120),
                e2e: box.getAttribute('data-e2e'),
                html: (box.outerHTML || '').slice(0, 220)
            }));
        }
        const text = lines.join('\n');
        try { console.log('[抖音优化] 摄像头小窗候选\n' + text); } catch (e) {}
        copyText(text);
        showTip('已复制摄像头小窗候选，直接粘贴给我即可', 2600);
    }
    window.__DY_OPT_DUMP_CAM__ = dumpCamBoxes;

    /* ---- 7.13 倍速播放：一键在「原速」和「设定倍速」之间切 ----
     * Shift+1 = 1.0x（原速），Shift+2 = 面板里设定的倍速（默认 2.0x）。
     * 两个键都能在面板里改；档位对齐抖音自带的 0.75 ~ 3.0。
     * 抖音切视频时会把 playbackRate 重置回 1，所以记住目标值，
     * 每轮轮询补一次；直播流（duration = Infinity）不支持倍速，提示后不动。 */
    let speedWanted = 1;                 // 目标倍速，1 = 原速（不干预）
    function speedSupported(v) {
        if (!v) return false;
        const d = v.duration;
        return !(d === Infinity || d === -Infinity);   // 只排除直播流
    }
    function fmtSpeed(r) {
        const n = Number(r);
        return (Number.isInteger(n) ? n.toFixed(1) : String(n)) + 'x';
    }
    function speedHotkeyMatch(e) {
        return specMatches(e, config.speedNormalHotkey) ||
               specMatches(e, config.speedAltHotkey);
    }
    function applySpeed(rate, fromKey) {
        const v = findActiveVideo();
        if (!v) {
            if (fromKey) showTip('没找到正在播放的视频', 1400);
            return false;
        }
        if (!speedSupported(v)) {
            if (fromKey) showTip('直播流不支持改倍速', 1600);
            return false;
        }
        speedWanted = rate;
        try { v.playbackRate = rate; } catch (e) {}
        /* v9.36：开了「写进抖音倍速栏」就顺手驱动抖音自己的倍速，让它记住 */
        if (config.speedSync) safeRun(() => syncSpeedToDouyin(rate));
        if (fromKey) showTip(rate === 1 ? '原速 1.0x' : '倍速 ' + fmtSpeed(rate), 1100);
        return true;
    }
    /* v9.41：倍速加 / 减一档。以「当前实际速率」为基准找最近的一档再跳，
       这样不管当前是脚本设的还是抖音自己的倍速栏设的，加减都接得上。 */
    function stepSpeed(dir) {
        const v = findActiveVideo();
        if (!v) { showTip('没找到正在播放的视频', 1400); return; }
        if (!speedSupported(v)) { showTip('直播流不支持改倍速', 1600); return; }
        const cur = Number(v.playbackRate) || 1;
        let idx = 0, best = Infinity;
        for (let i = 0; i < SPEED_STEPS.length; i++) {
            const d = Math.abs(SPEED_STEPS[i] - cur);
            if (d < best) { best = d; idx = i; }
        }
        let next = idx + (dir > 0 ? 1 : -1);
        if (next < 0) next = 0;
        if (next > SPEED_STEPS.length - 1) next = SPEED_STEPS.length - 1;
        if (next === idx) {
            showTip(dir > 0
                ? '已经是最快 ' + fmtSpeed(SPEED_STEPS[idx])
                : '已经是最慢 ' + fmtSpeed(SPEED_STEPS[idx]), 1200);
            return;
        }
        applySpeed(SPEED_STEPS[next], true);
    }
    /* 抖音换集 / 换视频会把速率重置，这里每轮补一次（只在偏差时才写，免得打架） */
    function keepPlaybackRate() {
        if (speedWanted === 1) return;
        const v = findActiveVideo();
        if (!v || !speedSupported(v)) return;
        if (Math.abs((v.playbackRate || 1) - speedWanted) < 0.01) return;
        try { v.playbackRate = speedWanted; } catch (e) {}
    }

    /* ---- 7.14 把倍速写进「抖音自己的倍速栏」（可选，设置里可关） ----
     * 只改 video.playbackRate 只影响当前这条：抖音按自己的设置记住倍速，
     * 换下一条又回到它记忆里的值（也是「用快捷键还原了原速，下一条还是 2x」的原因）。
     * 打开这个开关后，切倍速时同时驱动抖音自己的通道，让它把它记下来：
     *   ① xgplayer 实例（playbackRate / setPlaybackRate）
     *   ② React fiber 上带倍速能力的对象
     *   ③ 最后的兜底：点开抖音自己的倍速菜单，点中对应档位
     * ①② 拿不到才走 ③，且带冷却，避免菜单一直开合。 */
    function speedLabelSet(rate) {
        const n = Number(rate);
        const out = [fmtSpeed(n).toLowerCase(), n + 'x', n + '倍'];
        if (n === 1) out.push('原速', '1.0x', '正常');
        return out;
    }
    /* ---- 页面上的播放器实例：window.player ----
       控制台探查结果：window.player 就是当前在播那条的播放器（它自己的 video 属性 === 当前 video），
       有可读写的 playbackRate、plugins[36]（倍速插件叫 testspeed，不是 playbackRate），
       但没有 setPlaybackRate。另有 window.nextPlayer 对应预加载的下一条。
       本脚本是 @grant none，直接跑在页面环境，所以 window.player 能直接拿到。
       用途：设它自己的 playbackRate，速度和倍速栏会一起更新，不用点菜单。 */
    function pagePlayer(activeVideo) {
        const av = activeVideo || (function () { try { return findActiveVideo(); } catch (e) { return null; } })();
        const names = ['player', 'nextPlayer'];
        for (const n of names) {
            let p = null;
            try { p = window[n]; } catch (e) { continue; }
            if (!p || typeof p !== 'object') continue;
            if (typeof p.playbackRate !== 'number') continue;
            let pv = null;
            try { pv = p.video; } catch (e) {}
            /* 必须确认它管的就是当前这条视频，否则会改到预加载的那条上 */
            if (pv && pv.nodeType === 1 && av && pv === av) return p;
        }
        return null;
    }
    function xgPlayerOf(video) {
        const seen = new Set();
        const pick = (o) => {
            if (!o || typeof o !== 'object' || seen.has(o)) return null;
            seen.add(o);
            if (typeof o.setPlaybackRate === 'function') return o;
            if (typeof o.playbackRate === 'number' && o.video) return o;
            if (typeof o.playbackRate === 'number' && typeof o.play === 'function') return o;
            return null;
        };
        let el = video, d = 0;
        while (el && d++ < 8) {
            for (const key of ['xgplayer', 'player', 'playerInstance', '__xgplayer']) {
                let o = null;
                try { o = el[key]; } catch (e) {}
                const hit = pick(o);
                if (hit) return hit;
            }
            el = el.parentElement;
        }
        return null;
    }
    function deepFindObj(root, test, maxDepth) {
        if (!root || typeof root !== 'object') return null;
        const seen = new WeakSet();
        const lim = maxDepth || 4;
        let budget = 240;
        const stack = [{ o: root, d: 0 }];
        while (stack.length && budget > 0) {
            const it = stack.pop(), o = it.o;
            if (!o || typeof o !== 'object' || it.d > lim) continue;
            if (o.nodeType || seen.has(o)) continue;
            seen.add(o);
            budget--;
            try { if (test(o)) return o; } catch (e) {}
            let keys;
            try { keys = Object.keys(o); } catch (e) { continue; }
            for (const k of keys) {
                let v;
                try { v = o[k]; } catch (e) { continue; }
                if (!v || typeof v !== 'object' || v.nodeType) continue;
                if (it.d < lim) stack.push({ o: v, d: it.d + 1 });
            }
        }
        return null;
    }
    /* 找「播放器本体」而不是 video 元素：video 也符合 playbackRate+play，
       但改它不会更新 xgplayer 的倍速栏；真正要的是带 plugins / video 的那个对象 */
    const SPEED_API_TEST = (o) =>
        typeof o.setPlaybackRate === 'function' ||
        (o.plugins && typeof o.plugins === 'object' &&
            (o.plugins.playbackRate || o.plugins.playBackRate)) ||
        (o.video && o.video.nodeName === 'VIDEO' && typeof o.playbackRate === 'number');
    /* 走播放器接口改倍速（能拿到 plugins.playbackRate 时，它自己会刷新倍速栏） */
    function applyRateViaPlayer(p, rate) {
        if (!p || typeof p !== 'object') return '';
        try {
            const plugins = p.plugins;
            const plug = plugins && (plugins.playbackRate || plugins.playBackRate);
            if (plug) {
                if (typeof plug.setRate === 'function') { plug.setRate(rate); return 'plugin.setRate'; }
                if (typeof plug.changeRate === 'function') { plug.changeRate(rate); return 'plugin.changeRate'; }
                if (typeof plug.setPlaybackRate === 'function') { plug.setPlaybackRate(rate); return 'plugin.setPlaybackRate'; }
            }
            if (typeof p.setPlaybackRate === 'function') { p.setPlaybackRate(rate); return 'setPlaybackRate'; }
            if (typeof p.playbackRate === 'number' && p.video) { p.playbackRate = rate; return 'player.playbackRate'; }
        } catch (e) {}
        return '';
    }
    function speedApiNear(el) {
        let cur = el, d = 0;
        while (cur && d++ < 8) {
            let f = dyReactFiber(cur), k = 0;
            while (f && k++ < 26) {
                const hit = deepFindObj(f.memoizedProps, SPEED_API_TEST) ||
                            deepFindObj(f.pendingProps, SPEED_API_TEST);
                if (hit) return hit;
                f = f.return;
            }
            cur = cur.parentElement;
        }
        return null;
    }
    const SPEED_SEL = '[data-e2e*="speed"], [data-e2e*="playback"], [aria-label*="倍速"], ' +
        '[title*="倍速"], [class*="speed"], [class*="Speed"], ' +
        '[class*="playback"], [class*="Playback"]';
    const PLAYER_SEL = '.douyin-player, .xgplayer, [data-e2e="feed-active-video"], ' +
        '[data-e2e="video-player"], #living_player_container';
    /* 倍速按钮的锚点。抖音 class 全是哈希，所以主要靠文案：
       「倍速」优先，其次是显示当前档位的「1.0x」这种小标签。 */
    function speedAnchorEls() {
        const out = [];
        const add = (el) => {
            if (!el || (el.closest && el.closest('#gm-settings-panel'))) return;
            if (out.indexOf(el) >= 0) return;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { return; }
            if (!r || r.width < 8 || r.height < 8) return;
            if (r.width > 320 || r.height > 140) return;
            out.push(el);
        };
        const rank = (el) => (/^倍速/.test((el.textContent || '').replace(/\s+/g, '')) ? 0 : 1);
        for (const el of document.querySelectorAll(SPEED_SEL)) {
            add(el);
            if (out.length >= 6) break;
        }
        if (!out.length) {
            let n = 0;
            for (const el of document.querySelectorAll('div, span, button, a')) {
                if (++n > 2500) break;
                if (el.children.length) continue;
                const t = (el.textContent || '').replace(/\s+/g, '');
                if (!t || t.length > 6) continue;
                if (!(t.indexOf('倍速') === 0 || parseSpeedText(t) != null)) continue;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (!r || r.width < 8 || r.height < 8) continue;
                const inPlayer = !!(el.closest && el.closest(PLAYER_SEL));
                const nearBottom = r.top > window.innerHeight * 0.55;
                if (!inPlayer && !nearBottom) continue;
                add(el);
                if (out.length >= 6) break;
            }
        }
        /* 「倍速」排在前面：点它才是开菜单，点当前档位标签有时只是关菜单 */
        out.sort((a, b) => rank(a) - rank(b));
        return out;
    }
    /* 把一段文字解析成倍速值：2.0x / 2x / 2倍 / 原速 → 数字 */
    function parseSpeedText(t) {
        const s = String(t == null ? '' : t).replace(/\s+/g, '').toLowerCase();
        if (!s || s.length > 6) return null;
        if (/^(原速|正常|标准)$/.test(s)) return 1;
        const m = /^(\d+(?:\.\d+)?)(?:x|倍)?$/.exec(s);
        if (!m) return null;
        const n = parseFloat(m[1]);
        if (!Number.isFinite(n) || n < 0.1 || n > 5) return null;
        return n;
    }
    /* 往上一层层找「浮层面板」：absolute / fixed 的那个祖先 */
    function floatingAncestor(el) {
        let cur = el.parentElement, d = 0;
        while (cur && cur !== document.body && d++ < 10) {
            let st;
            try { st = getComputedStyle(cur); } catch (e) { return null; }
            if (st && (st.position === 'absolute' || st.position === 'fixed')) return cur;
            cur = cur.parentElement;
        }
        return null;
    }
    function inFloatingPanel(el) {
        return !!floatingAncestor(el);
    }
    /* 找「正在开着的倍速菜单」。判定标准：同一个父节点下至少有 2 个不同档位 ——
       控制栏上那个「1.0x」标签只有一个值，不会被误认成菜单。 */
    function speedMenuScan() {
        const rows = [];
        let n = 0;
        for (const el of document.querySelectorAll('div, span, li, button, p')) {
            if (++n > 3000) break;
            if (el.children.length) continue;
            if (el.closest('#gm-settings-panel')) continue;
            const val = parseSpeedText(el.textContent);
            if (val == null) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (!r || r.width < 20 || r.height < 12) continue;
            if (!inFloatingPanel(el)) continue;
            rows.push({ el: el, value: val });
            if (rows.length >= 40) break;
        }
        /* 按「浮层面板」分组，而不是按父节点 —— 有的菜单每行外面还包一层 wrapper */
        const groups = new Map();
        for (const row of rows) {
            const panel = floatingAncestor(row.el);
            if (!panel) continue;
            if (!groups.has(panel)) groups.set(panel, []);
            groups.get(panel).push(row);
        }
        let best = null, bestN = 1;
        for (const list of groups.values()) {
            const vals = new Set(list.map(x => x.value));
            if (vals.size > bestN) { bestN = vals.size; best = list; }
        }
        return best;
    }
    function speedMenuRows(rate) {
        const best = speedMenuScan();
        if (!best) return [];
        return best.filter(x => Math.abs(x.value - rate) < 0.01);
    }
    let speedSyncCooldown = 0, speedSyncVia = 'idle';
    function clickSpeedRow(rate) {
        const rows = speedMenuRows(rate);
        if (!rows.length) return false;
        const el = rows[0].el;
        activateMenuRow(el, 'full');
        speedSyncVia = 'menu(点中档位)';
        /* 抖音的 onClick 有时挂在行容器上，点叶子没反应：菜单还在就再点一次父级 */
        setTimeout(() => {
            if (!speedMenuScan()) return;             // 菜单已经关了 = 点成功了
            const p = el.parentElement;
            if (p) { activateMenuRow(p, 'full'); speedSyncVia = 'menu(点中父级)'; }
        }, 260);
        return true;
    }
    /* 「可能开菜单」的点击候选：倍速标签本身，以及它往上的两层小容器。
       抖音真正的按钮常常是包着文字的 div（onClick 在容器上），文字层只是 a11y 标签。 */
    function speedClickPlan() {
        const plan = [];
        for (const a of speedAnchorEls().slice(0, 3)) {
            plan.push(a);
            let p = a.parentElement, d = 0;
            while (p && p !== document.body && d++ < 2) {
                let r;
                try { r = p.getBoundingClientRect(); } catch (e) { r = null; }
                if (r && r.width <= 340 && r.height <= 150) plan.push(p);
                p = p.parentElement;
            }
        }
        return plan;
    }
    let speedPlanCache = null, speedPlanAt = 0;
    function getSpeedPlan() {
        /* 空结果不缓存：第一轮控制栏可能还是隐藏的（按钮 0×0），缓存住就再也找不到 */
        if (speedPlanCache && speedPlanCache.length && Date.now() - speedPlanAt < 4000)
            return speedPlanCache;
        speedPlanCache = speedClickPlan();
        speedPlanAt = Date.now();
        return speedPlanCache;
    }
    /* ---- xgplayer 的倍速菜单（抖音这个播放器就是 xgplayer，class 没哈希） ----
       控制栏：<div class="xgplayer-setting-playbackRatio">1.0x</div>  ← 只显示当前档位
       外层：  <xg-icon class="xgplayer-playback-setting">           ← 里面装着真正的档位列表
       点列表项才等于「用户自己改倍速」，抖音的倍速栏高亮和「下一条沿用」都记在这。 */
    function xgRateRoots() {
        const out = [];
        for (const el of document.querySelectorAll('[class]')) {
            const cls = el.className;
            if (typeof cls !== 'string') continue;
            if (cls.indexOf('xgplayer-playback-setting') < 0) continue;
            if (el.closest && el.closest('#gm-settings-panel')) continue;
            if (out.indexOf(el) >= 0) continue;
            out.push(el);
            if (out.length >= 6) break;
        }
        /* 优先拿真正的按钮容器（xg-icon），面板/列表往后排；
           页面上可能同时存在两个播放器（抖音会预加载下一个），属于当前活跃视频的排最前，
           否则会把非活跃播放器的面板点开、画面速度却不变 */
        let activeBox = null;
        try {
            const av = (typeof findActiveVideo === 'function') ? findActiveVideo() : null;
            activeBox = av && av.closest ? (av.closest(PLAYER_SEL) || av) : null;
        } catch (e) {}
        const score = (el) => {
            const cls = String(el.className || '');
            let base = 1;
            if (el.tagName === 'XG-ICON') base = 0;
            else if (/panel|list/i.test(cls)) base = 2;
            if (activeBox && activeBox.contains(el)) base -= 10;
            return base;
        };
        out.sort((a, b) => score(a) - score(b));
        return out;
    }
    function xgRateLabel() {
        for (const el of document.querySelectorAll('[class]')) {
            const cls = el.className;
            if (typeof cls !== 'string') continue;
            if (cls.indexOf('xgplayer-setting-playbackRatio') < 0) continue;
            if (el.closest && el.closest('#gm-settings-panel')) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (r && r.width >= 6 && r.height >= 6) return el;
        }
        return null;
    }
    /* 面板里「真的显示出来」的档位项。隐藏时尺寸是 0 —— 正好当「菜单开没开」的判据 */
    function xgRateItems() {
        const out = [];
        for (const root of xgRateRoots()) {
            let n = 0;
            for (const el of root.querySelectorAll('*')) {
                if (++n > 500) break;
                if (el.children.length) continue;
                const cls = (typeof el.className === 'string') ? el.className : '';
                if (cls.indexOf('xgplayer-setting-playbackRatio') >= 0) continue;  // 控制栏那个标签不算
                const v = parseSpeedText(el.textContent);
                if (v == null) continue;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (!r || r.width < 8 || r.height < 8) continue;
                if (out.some(x => x.el === el)) continue;
                out.push({ el: el, value: v });
                if (out.length >= 40) break;
            }
            if (out.length >= 40) break;
        }
        return out;
    }
    /* 控制栏 / 设置面板里「可见」的小面板。新打开时点按钮出来的是「设置列表」
       （里面有「倍速」这一行），点那一行才展开档位；选过一次之后按钮直接开档位列表。 */
    const XG_PANEL_RE = /panel|setting|playback|list|menu/i;
    function xgSpeedPanels() {
        const out = [];
        let n = 0;
        for (const el of document.querySelectorAll('[class*="xgplayer"]')) {
            if (++n > 1600) break;
            const cls = (typeof el.className === 'string') ? el.className : '';
            if (!XG_PANEL_RE.test(cls)) continue;
            if (el.closest && el.closest('#gm-settings-panel')) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (!r || r.width < 40 || r.height < 18) continue;
            if (r.width > 620 || r.height > 620) continue;
            if (out.indexOf(el) >= 0) continue;
            out.push(el);
            if (out.length >= 12) break;
        }
        return out;
    }
    /* 严格解析：必须带 x / 倍，避免把评论、标题里的「2」当成档位 */
    function strictRate(t) {
        const s = String(t == null ? '' : t).replace(/\s+/g, '').toLowerCase();
        if (!s || s.length > 6) return null;
        const m = /^(\d+(?:\.\d+)?)(x|倍)$/.exec(s);
        if (!m) return null;
        const n = parseFloat(m[1]);
        if (!Number.isFinite(n) || n < 0.1 || n > 5) return null;
        return n;
    }
    /* 全页扫描：「至少有 2 个不同档位同时可见」才算倍速列表。
       这样不管它把面板渲染在播放器里、还是 portal 到 body，都能抓到。 */
    function speedListAnywhere() {
        const label = xgRateLabel();
        const rows = [];
        let n = 0;
        for (const el of document.querySelectorAll('div, span, li, p')) {
            if (++n > 4500) break;
            if (el.children.length) continue;
            if (el === label) continue;
            if (label && label.contains(el)) continue;
            if (el.closest && el.closest('#gm-settings-panel')) continue;
            const v = strictRate(el.textContent);
            if (v == null) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (!r || r.width < 8 || r.height < 8) continue;
            rows.push({ el: el, value: v });
            if (rows.length >= 40) break;
        }
        const distinct = new Set(rows.map(x => x.value));
        return distinct.size >= 2 ? rows : null;
    }
    /* 面板里所有「真的显示出来」的档位项（隐藏的尺寸是 0，正好当「面板开没开」的判据） */
    function xgSpeedRows() {
        const out = [];
        const label = xgRateLabel();
        const add = (el) => {
            if (!el || el === label) return;
            if (el.closest && el.closest('#gm-settings-panel')) return;
            if (el.children.length) return;
            const v = parseSpeedText(el.textContent);
            if (v == null) return;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { return; }
            if (!r || r.width < 8 || r.height < 8) return;
            if (out.some(x => x.el === el)) return;
            out.push({ el: el, value: v });
        };
        for (const root of xgRateRoots()) {
            let n = 0;
            for (const el of root.querySelectorAll('*')) {
                if (++n > 300) break;
                const cls = (typeof el.className === 'string') ? el.className : '';
                if (cls.indexOf('xgplayer-setting-playbackRatio') >= 0) continue;
                add(el);
            }
        }
        for (const panel of xgSpeedPanels()) {
            let n = 0;
            for (const el of panel.querySelectorAll('*')) {
                if (++n > 300) break;
                add(el);
            }
        }
        /* 前面按 class 找不到时（面板可能是 portal 到 body、class 也不含 xgplayer），
           改用全页扫描：至少 2 个不同档位同时可见才认 */
        if (out.length < 2) {
            const any = speedListAnywhere();
            if (any) {
                for (const it of any) {
                    if (!out.some(x => x.el === it.el)) out.push(it);
                }
            }
        }
        return out;
    }
    /* 设置列表里那一行「倍速」：点它才展开档位（新打开、还没选过档位时就是这个状态） */
    function xgRateEntryRow() {
        const label = xgRateLabel();
        for (const panel of xgSpeedPanels()) {
            let n = 0;
            for (const el of panel.querySelectorAll('*')) {
                if (++n > 300) break;
                if (el === label) continue;
                if (label && label.contains(el)) continue;      // 控制栏那个标签本身不算「行」
                const t = (el.textContent || '').replace(/\s+/g, '');
                if (t !== '倍速' && t !== '倍速播放') continue;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (!r || r.width < 8 || r.height < 8) continue;
                if (r.width > 200 || r.height > 80) continue;
                return el;
            }
        }
        return null;
    }
    /* 同一个元素 1.2 秒内不重复点：反复点等于反复开关面板 */
    const speedClickAt = new WeakMap();
    function clickRateOnce(el, mode, note) {
        if (!el) return false;
        const now = Date.now();
        if (now - (speedClickAt.get(el) || 0) < 1200) return false;
        speedClickAt.set(el, now);
        activateMenuRow(el, mode || 'full');
        speedSyncVia = note;
        return true;
    }
    let entryHover = 0;                 // 「倍速」行先悬停几次，再改成点
    /* 面板里能做的一步：点中目标档位 / 展开「倍速」子列表。
       返回 'done' = 已经点中目标档位；'more' = 点了「展开子列表」，还要再看一轮；
       false = 面板没开、也没找到入口，交给后面的点击步骤。 */
    /* ---- 面板被插件藏起来时的最后一招：自己把它显示出来 ----
       抖音这套播放器的档位面板是「hover/点按钮才展开」，我们用合成事件有时压根
       触发不到（或者被它自己的 document click 关掉）。既然档位就在 DOM 里，
       直接给它 display/visibility/opacity/尺寸都放开，让它「可见」再点，
       点完 0.9 秒还原，不留一个浮在画面上的空面板。 */
    /* ---- 面板变更日志（只记录，不参与任何决策） ----
       用途：搞清楚「设置面板/档位列表为什么自己关了」。
       做法：每 120ms 比一次 slider 的 display + style，变了就记一条，
       并附上「变化前 600ms 内我们自己做过什么」以及「有没有真实用户事件」。
       合成事件的 isTrusted 是 false，真人操作是 true —— 靠这个分得清。 */
    let gmActs = [];                 // {t, what} 我们自己的动作
    let gmLastTrusted = 0;           // 最近一次真实用户事件的时间
    let gmPanelSnaps = [];           // 上一次的快照
    let gmPanelChanges = [];         // 变化记录（最多 40 条）
    let gmPanelT0 = 0;
    let gmPanelTimer = 0, gmPanelUntil = 0;

    function gmNoteAct(what) {
        const now = Date.now();
        const last = gmActs[gmActs.length - 1];
        if (last && last.what === what && now - last.t < 120) return;   // 同类限流
        gmActs.push({ t: now, what: what });
        if (gmActs.length > 60) gmActs.shift();
    }
    (function gmTrustWatch() {
        const mark = (e) => { if (e && e.isTrusted) gmLastTrusted = Date.now(); };
        ['pointerdown', 'mousedown', 'click', 'keydown', 'wheel'].forEach(function (t) {
            try { document.addEventListener(t, mark, true); } catch (e) {}
        });
    })();
    function gmPanelLabel(el) {
        const root = (typeof xgRootOf === 'function') ? xgRootOf(el) : null;
        if (!root) return '?';
        let r = null;
        try { r = root.getBoundingClientRect(); } catch (e) {}
        if (!r || !r.width) return '?';
        return '@' + (r.left | 0) + ',' + (r.top | 0);
    }
    function gmPanelTick() {
        const now = Date.now();
        if (!gmPanelT0) gmPanelT0 = now;
        let roots = [];
        try { roots = xgRateRoots(); } catch (e) { return; }
        for (const root of roots) {
            let sl = null;
            try { sl = root.querySelector('[class*="xgplayer-slider"]'); } catch (e) {}
            if (!sl) continue;
            let disp = '?';
            try { disp = getComputedStyle(sl).display; } catch (e) {}
            const style = (sl.getAttribute('style') || '').replace(/\s+/g, ' ');
            const sig = disp + ' | ' + style;
            let rec = null;
            for (const it of gmPanelSnaps) if (it.el === sl) { rec = it; break; }
            if (!rec) {
                gmPanelSnaps.push({ el: sl, sig: sig, label: gmPanelLabel(sl) });
                continue;
            }
            if (rec.sig === sig) continue;
            /* 变了 —— 找是谁干的：先看我们自己最近做过什么，再看有没有真人操作 */
            let cause = '';
            for (let i = gmActs.length - 1; i >= 0; i--) {
                const a = gmActs[i];
                const dt = now - a.t;
                if (dt > 600) break;
                cause = a.what + '（' + dt + 'ms前）';
                break;
            }
            if (now - gmLastTrusted < 600) cause = (cause ? cause + ' + ' : '') + 'user(isTrusted)';
            if (!cause) cause = '无近期动作（它自己收的）';
            gmPanelChanges.push({
                t: now - gmPanelT0,
                label: rec.label,
                from: rec.sig, to: sig, cause: cause
            });
            if (gmPanelChanges.length > 40) gmPanelChanges.shift();
            rec.sig = sig;
        }
        /* 清掉已经不在 DOM 里的快照 */
        gmPanelSnaps = gmPanelSnaps.filter(it => it.el && it.el.isConnected);
    }
    /* 常驻监视：面板什么时候被关、谁关的，必须「事前」就在盯着才抓得到。
       300ms 一次、每次只看 2~3 个元素的 computed style，开销可以忽略。 */
    function gmPanelWatchStart() {
        gmPanelUntil = 0;                          // 0 = 不自动停
        try { gmPanelTick(); } catch (e) {}        // 先采一次当基线
        if (gmPanelTimer) return;
        const tick = () => {
            gmPanelTimer = 0;
            if (gmPanelUntil && Date.now() > gmPanelUntil) return;
            try { gmPanelTick(); } catch (e) {}
            gmPanelTimer = setTimeout(tick, 300);
        };
        gmPanelTimer = setTimeout(tick, 0);
    }
    /* 页面一稳定就开始盯，这样即使不按快捷键，手动开关面板的过程也会被记下来 */
    setTimeout(function () { try { gmPanelWatchStart(); } catch (e) {} }, 1500);
    let forcedRatePanels = [];
    function gmForceVisible(el) {
        if (!el || el.__gmForcedAt) return false;
        gmNoteAct('force');
        el.__gmForcedAt = Date.now();
        el.__gmForcedCss = el.getAttribute('style') || '';
        try {
            el.style.setProperty('display', 'block', 'important');
            el.style.setProperty('visibility', 'visible', 'important');
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('pointer-events', 'auto', 'important');
            el.style.setProperty('height', 'auto', 'important');
            el.style.setProperty('max-height', 'none', 'important');
            el.style.setProperty('overflow', 'visible', 'important');
            el.style.setProperty('transform', 'none', 'important');
            el.style.setProperty('clip', 'auto', 'important');
            el.style.setProperty('clip-path', 'none', 'important');
        } catch (e) {}
        forcedRatePanels.push(el);
        /* 改完立刻采一次：force 和 restore 通常只隔十几毫秒，120ms 轮询根本抓不到 */
        try { gmPanelTick(); } catch (e) {}
        return true;
    }
    /* 关键：从外往里放开。父级 display:none 时只放开子级毫无意义（上一版就错在这） */
    function gmUnhideChain(el, stopAt) {
        if (!el) return 0;
        const chain = [];
        let q = el;
        let guard = 0;
        while (q && q !== stopAt && q.nodeType === 1 && guard++ < 24) {
            chain.push(q);
            q = q.parentElement;
        }
        chain.reverse();
        let n = 0;
        for (const x of chain) if (gmForceVisible(x)) n++;
        return n;
    }
    function forceShowRatePanels() {
        const roots = xgRateRoots();
        if (!roots.length) return 0;
        let n = 0;
        const isHidden = (el) => {
            let r = null, st = null;
            try { r = el.getBoundingClientRect(); } catch (e) {}
            try { st = getComputedStyle(el); } catch (e) {}
            const zero = !r || r.width < 4 || r.height < 4;
            const none = st && (st.display === 'none' || st.visibility === 'hidden');
            return zero || none;
        };
        /* ① 只放「带倍速文字的层」「panel/list/popper 容器」以及它们的整条祖先链 */
        for (const root of roots) {
            let k = 0;
            for (const el of root.querySelectorAll('*')) {
                if (++k > 260) break;
                const cls = (typeof el.className === 'string') ? el.className : '';
                const t = el.textContent || '';
                const looksRate = /\d+(\.\d+)?\s*x/i.test(t) || strictRate(t) != null;
                const looksPanel = /panel|list|dropdown|menu|popper|selector/i.test(cls);
                if (!looksRate && !looksPanel) continue;
                if (!isHidden(el)) continue;
                n += gmUnhideChain(el, root);
            }
            /* root 自己也藏着（控制栏自动隐藏）时，把它往上的链也放开 */
            if (isHidden(root)) n += gmUnhideChain(root.parentElement, document.body);
        }
        /* ② 还不行就整棵子树都放开（粗暴但有效，400ms 后统一还原） */
        if (n === 0 || xgSpeedRows().length < 2) {
            for (const root of roots) {
                let k = 0;
                for (const el of root.querySelectorAll('*')) {
                    if (++k > 240) break;
                    if (el.__gmForcedAt) continue;
                    if (!isHidden(el)) continue;
                    n += gmUnhideChain(el, root);
                }
            }
        }
        if (n) setTimeout(restoreForcedRatePanels, 400);
        return n;
    }
    function restoreForcedRatePanels() {
        if (forcedRatePanels.length) gmNoteAct('restore');
        const list = forcedRatePanels;
        forcedRatePanels = [];
        for (const el of list) {
            if (!el || !el.isConnected) continue;
            try {
                if (el.__gmForcedCss) el.setAttribute('style', el.__gmForcedCss);
                else el.removeAttribute('style');
            } catch (e) {}
            delete el.__gmForcedAt;
            delete el.__gmForcedCss;
        }
        try { gmPanelTick(); } catch (e) {}
    }
    /* ---- 已知结构：直接点档位项，不问「面板开没开」 ----
       真实结构（9.36 第十一次日志的 rate tree）：
         <xg-icon class="xgplayer-playback-setting">
           <div class="xgplayer-setting-playbackRatio">倍速</div>      ← 只是标签
           <div class="xgplayer-slider xgplayer-box" style="display:none">  ← 只有这一层藏着
             <div class="xgplayer-setting-content">
               <div class="xgplayer-playratio-wrap">
                 <div class="xgplayer-playratio-item">0.75x</div>
                 <div class="select xgplayer-playratio-item">1.0x</div>   ← 当前选中
                 …
       关键：档位项自己 disp=block，点它能触发它自己的 handler，跟容器可见与否无关。
       所以这里直接按类名找项、直接点，不再依赖「先把面板打开」。 */
    function xgRootOf(el) {
        let q = el, d = 0;
        while (q && d++ < 14) {
            if (q.nodeType === 1 && typeof q.className === 'string' &&
                q.className.indexOf('xgplayer-playback-setting') >= 0) return q;
            q = q.parentElement;
        }
        return null;
    }
    function xgPlayratioItems() {
        const out = [];
        const seen = [];
        const SEL = '[class*="playratio-item"]';
        const add = (el) => {
            if (!el || seen.indexOf(el) >= 0) return;
            if (el.closest && el.closest('#gm-settings-panel')) return;
            const v = parseSpeedText((el.textContent || '').replace(/\s+/g, ''));
            if (v == null) return;
            seen.push(el);
            out.push({
                el: el, value: v,
                selected: /(^|\s)select(\s|$)/.test(String(el.className || ''))
            });
        };
        for (const root of xgRateRoots()) {
            let list = [];
            try { list = root.querySelectorAll(SEL); } catch (e) {}
            for (const el of list) add(el);
        }
        /* 万一它把列表 portal 出去：全页按同一个类名再找一遍 */
        if (out.length < 2) {
            let n = 0;
            for (const el of document.querySelectorAll(SEL)) {
                if (++n > 80) break;
                add(el);
            }
        }
        return out;
    }
    /* 页面可能同时挂着 3 个播放器实例（抖音的滑窗会预加载上下条），
       每个实例都有一份 7 档位列表 → 21 项。点错实例画面速度不会变，
       所以按「档位按钮离当前视频有多近」排序：控制栏就贴在活跃视频的底边附近。 */
    function xgRateItemDist(el) {
        const root = xgRootOf(el);
        if (!root) return 9e8;
        let r = null;
        try { r = root.getBoundingClientRect(); } catch (e) { return 9e8; }
        if (!r || r.width < 4 || r.height < 4) return 5e8;           // 自己都看不见：排后面
        const cy = r.top + r.height / 2;
        let av = null;
        try { av = findActiveVideo(); } catch (e) {}
        if (!av) return Math.abs(cy - (window.innerHeight || 800) * 0.8);
        let ar = null;
        try { ar = av.getBoundingClientRect(); } catch (e) { ar = null; }
        if (!ar || ar.height < 40) return Math.abs(cy - (window.innerHeight || 800) * 0.8);
        const inside = cy >= ar.top - 80 && cy <= ar.bottom + 80;     // 和活跃视频同一条
        return (inside ? 0 : 3e6) + Math.abs(cy - ar.bottom);
    }
    /* 抖音在「正在播放」的那个实例上会忽略直接点档位（它要求面板真的开着），
       所以档位状态常常落到预加载的下一条上：切过去才显示，当前这条菜单不变。
       速度我们已经用 playbackRate 设对了，这里把当前实例的 UI 手动对齐，
       免得「明明 2 倍速，菜单还写倍速」。 */
    function syncActiveRateLabel(rate) {
        const roots = xgRateRoots();
        if (!roots.length) return false;
        let av = null;
        try { av = findActiveVideo(); } catch (e) {}
        /* 只改「离当前视频最近」的那个实例，别动预加载的那条 */
        let target = null, best = 1e9;
        for (const root of roots) {
            let r = null;
            try { r = root.getBoundingClientRect(); } catch (e) { continue; }
            if (!r || r.width < 4) continue;
            const cy = r.top + r.height / 2;
            let d = 1e9;
            if (av) {
                try { d = Math.abs(cy - av.getBoundingClientRect().bottom); } catch (e) {}
            }
            if (d < best) { best = d; target = root; }
        }
        if (!target) return false;
        const txt = fmtSpeed(rate);
        let changed = false;
        /* 1) 选中项：把 select 挪到目标档位 */
        let list = [];
        try { list = target.querySelectorAll('[class*="playratio-item"]'); } catch (e) {}
        for (const el of list) {
            const v = parseSpeedText((el.textContent || '').replace(/\s+/g, ''));
            if (v == null) continue;
            const isHit = Math.abs(v - rate) < 0.01;
            const cls = String(el.className || '');
            const has = /(^|\s)select(\s|$)/.test(cls);
            if (isHit && !has) {
                try { el.className = (cls + ' select').trim(); changed = true; } catch (e) {}
            } else if (!isHit && has) {
                try { el.className = cls.replace(/(^|\s)select(\s|$)/g, ' ').trim(); changed = true; } catch (e) {}
            }
        }
        /* 2) 控制栏那个标签（叶子节点才改，避免破坏它的结构） */
        let lb = null;
        try { lb = target.querySelector('[class*="setting-playbackRatio"]'); } catch (e) {}
        if (lb && !lb.children.length) {
            const cur = (lb.textContent || '').trim();
            if (cur !== txt) {
                try { lb.textContent = txt; changed = true; } catch (e) {}
            }
        }
        if (changed && speedSyncVia.indexOf('补标签') < 0) speedSyncVia += '（补标签）';
        return changed;
    }
    function xgClickByClass(rate) {
        const all = xgPlayratioItems();
        if (all.length < 2) return false;                  // 这个页面不是这套结构
        const hits = all.filter(x => Math.abs(x.value - rate) < 0.01);
        if (!hits.length) {
            speedSyncVia = 'xgplayer(档位里没有 ' + fmtSpeed(rate) + ')';
            return true;
        }
        hits.sort((a, b) => xgRateItemDist(a.el) - xgRateItemDist(b.el));
        /* 每个实例各点一次（1~3 个）：都是「把倍速设成 rate」，重复点无副作用，
           但总有一个属于当前正在播的那个视频 */
        const pick = hits.slice(0, 3);
        const fire = (it) => {
            const root = xgRootOf(it.el);
            let w = 0;
            try { w = it.el.getBoundingClientRect().width; } catch (e) {}
            const forced = (root && w < 4) ? gmUnhideChain(it.el, root) : 0;
            gmNoteAct('click档位');
            try { it.el.click(); } catch (e) {}              // 原生 click：不挑可见性
            try { gmPanelTick(); } catch (e) {}
            /* 点完立刻收回：拖动/常驻的档位列表会浮在画面上，看着像坏了 */
            if (forced) {
                if (typeof requestAnimationFrame === 'function')
                    requestAnimationFrame(() => restoreForcedRatePanels());
                else setTimeout(restoreForcedRatePanels, 0);
            }
        };
        fire(pick[0]);
        for (let i = 1; i < pick.length; i++) {
            setTimeout(() => { try { fire(pick[i]); } catch (e) {} }, 90 * i);
        }
        setTimeout(restoreForcedRatePanels, 200);
        speedSyncVia = 'xgplayer(直接点档位 ' + fmtSpeed(rate) + ' ×' + pick.length + ')';
        /* 标签还没变：先补一次完整指针序列（有的版本只认 mousedown/pointerdown），
           再不行就把当前实例的 UI 手动对齐（速度已经对了，只是它懒得更新文字） */
        setTimeout(() => {
            const lb = xgRateLabel();
            const txt = lb ? (lb.textContent || '').trim() : '';
            const cur = strictRate(txt);
            if (cur != null && Math.abs(cur - rate) < 0.01) return;
            for (const it of pick.slice(0, 2)) {
                try { if (document.contains(it.el)) activateMenuRow(it.el, 'full'); } catch (e) {}
            }
        }, 240);
        setTimeout(() => {
            const lb = xgRateLabel();
            const txt = lb ? (lb.textContent || '').trim() : '';
            const cur = strictRate(txt);
            if (cur != null && Math.abs(cur - rate) < 0.01) return;
            try { syncActiveRateLabel(rate); } catch (e) {}
        }, 620);
        /* 抖音有时过一会儿又把它自己的标签刷回去，再确认一次就收手（不无限拉锯） */
        setTimeout(() => {
            const lb = xgRateLabel();
            const txt = lb ? (lb.textContent || '').trim() : '';
            const cur = strictRate(txt);
            if (cur != null && Math.abs(cur - rate) < 0.01) return;
            try { syncActiveRateLabel(rate); } catch (e) {}
        }, 1350);
        return true;
    }
    function xgPanelAction(rate) {
        /* ⓪ 已知结构：直接点档位项（不依赖面板打开）——命中最准的一条 */
        if (xgClickByClass(rate)) return 'done';
        /* 两个播放器并存时只认活跃那个的档位，避免点了没反应 */
        let activeBox = null;
        try {
            const av = findActiveVideo();
            activeBox = av && av.closest ? (av.closest(PLAYER_SEL) || av) : null;
        } catch (e) {}
        const prefer = (list) => {
            if (!activeBox || !list.length) return list;
            const sub = list.filter(x => activeBox.contains(x.el));
            return sub.length ? sub : list;
        };
        let rows = prefer(xgSpeedRows());
        if (rows.length < 2 && xgRateRoots().length) {
            if (forceShowRatePanels()) {
                rows = prefer(xgSpeedRows());
                if (rows.length >= 2) speedSyncVia = 'xgplayer(自己展开了面板)';
            }
        }
        const hit = rows.filter(x => Math.abs(x.value - rate) < 0.01)[0];
        if (hit) {
            if (clickRateOnce(hit.el, 'full', 'xgplayer(点中 ' + fmtSpeed(rate) + ')')) {
                /* 强制展开过的面板尽快收回去，别留在画面上 */
                setTimeout(restoreForcedRatePanels, 300);
                /* 点完档位还在 = onClick 挂在行容器上，补一次父级 */
                setTimeout(() => {
                    const still = xgSpeedRows().filter(x => Math.abs(x.value - rate) < 0.01)[0];
                    if (still && still.el.parentElement)
                        activateMenuRow(still.el.parentElement, 'full');
                }, 300);
                /* 再确认一次：抖音那个倍速栏有没有跟着变。没变就把原因记进诊断，
                   下次一眼能看出是「点了没反应」还是「根本没点进去」 */
                setTimeout(() => {
                    const lb = xgRateLabel();
                    const txt = lb ? (lb.textContent || '').trim() : '';
                    if (txt && strictRate(txt) == null)
                        speedSyncVia = 'xgplayer(点了 ' + fmtSpeed(rate) + '，标签还是「' + txt + '」)';
                }, 700);
            }
            return 'done';
        }
        if (rows.length >= 2) {
            restoreForcedRatePanels();
            speedSyncVia = 'xgplayer(面板已开但没有 ' + fmtSpeed(rate) + ')';
            return 'done';                            // 面板开着但没这个档位，别乱点
        }
        const entry = xgRateEntryRow();
        if (entry) {
            /* 先只悬停：xgplayer 的设置列表是 hover 出子菜单的，点一下反而可能把面板关掉 */
            if (entryHover < 2) {
                entryHover++;
                hoverOver(entry);
                speedSyncVia = 'xgplayer(悬停「倍速」行)';
            } else {
                clickRateOnce(entry, 'full', 'xgplayer(点「倍速」行)');
            }
            return 'more';                            // 展开后还要再找一轮档位
        }
        return false;
    }
    function xgClickRate(rate) {
        return xgPanelAction(rate) === 'done';
    }
    function syncSpeedViaMenu(rate, step) {
        const n = step || 0;
        if (n === 0) entryHover = 0;
        if (n > 18) { speedSyncVia = 'menu: 放弃（试了 ' + n + ' 次）'; return false; }
        const act = xgPanelAction(rate);
        if (act === 'done') return true;                // 已经点中目标档位
        if (act === 'more') {                           // 刚展开子列表：下一轮再找档位
            setTimeout(() => syncSpeedViaMenu(rate, n + 1), 160);
            return true;
        }
        if (clickSpeedRow(rate)) return true;           // 其它结构：菜单已开 → 点中
        const xgRoot = xgRateRoots()[0] || null;
        const label = xgRateLabel();
        const plan = getSpeedPlan();
        /* 依次尝试：悬停 → xgplayer 按钮 → 档位标签 → 通用候选。
           点开面板后下一轮会在函数开头被 xgPanelAction 抓住，这里只管「怎么开」。 */
        /* 同一个元素要试几种点法（xpglayer 有的版本认完整指针序列，有的只认 click），
           所以这里按「动作」去重，而不是按元素去重 */
        const steps = [];
        const keys = [];
        const push = (key, fn) => {
            if (keys.indexOf(key) >= 0) return;
            keys.push(key);
            steps.push(fn);
        };
        if (xgRoot) {
            push('hover:xg', () => { hoverOver(xgRoot); speedSyncVia = 'xgplayer(悬停)'; });
            push('full:xg', () => { activateMenuRow(xgRoot, 'full'); speedSyncVia = 'xgplayer(点按钮)'; });
            push('click:xg', () => { synthClick(xgRoot); speedSyncVia = 'xgplayer(只点一下)'; });
        } else if (plan[0]) {
            push('hover:plan0', () => { hoverOver(plan[0]); speedSyncVia = 'menu(悬停)'; });
        }
        if (label) {
            push('full:label', () => { activateMenuRow(label, 'full'); speedSyncVia = 'xgplayer(点档位标签)'; });
            push('click:label', () => { synthClick(label); speedSyncVia = 'xgplayer(只点标签)'; });
        }
        plan.forEach((el, i) => {
            push('hit:' + i, () => { activateMenuRow(el, 'hit'); speedSyncVia = 'menu(点候选 ' + (i + 1) + ')'; });
        });
        if (!steps.length) { speedSyncVia = 'menu: 没找到倍速按钮'; return false; }
        if (n >= steps.length + 5) { speedSyncVia = 'menu: 菜单没出来'; return false; }
        if (n < steps.length) steps[n]();
        setTimeout(() => syncSpeedViaMenu(rate, n + 1), 160);
        return true;
    }
    /* 抖音可能把倍速记在 localStorage 里 —— 能直接写的话比驱动 UI 稳得多 */
    function speedStorageLines() {
        const out = [];
        try {
            for (let i = 0; i < localStorage.length && out.length < 12; i++) {
                const k = localStorage.key(i);
                if (!k || !/speed|rate|倍速|playback/i.test(k)) continue;
                out.push('  ' + k + ' = ' + (localStorage.getItem(k) || '').slice(0, 60));
            }
        } catch (e) {}
        return out;
    }
    /* 排障：把「倍速菜单」里可能的东西全部列出来（点开菜单后抓文本），
       菜单结构变了或者档位文案不是 2x 这种写法时用它定位。 */
    function dumpSpeedMenu() {
        const v0 = findActiveVideo();
        if (v0) hoverOver(v0.closest(PLAYER_SEL) || v0);
        const anchor = speedAnchorEls()[0];
        if (anchor) { try { activateMenuRow(anchor, 'hit'); } catch (e) {} }
        setTimeout(() => {
            const lines = [];
            lines.push('anchor: ' + (anchor
                ? '<' + anchor.tagName.toLowerCase() + '> "' +
                  (anchor.textContent || '').trim().slice(0, 16) + '" cls=' +
                  String(anchor.className || '').slice(0, 40)
                : 'null'));
            const v = findActiveVideo();
            const near = [];
            if (v) {
                let r;
                try { r = v.getBoundingClientRect(); } catch (e) { r = null; }
                let n = 0;
                for (const el of document.querySelectorAll('div, span, li, button, p')) {
                    if (++n > 4000) break;
                    if (el.children.length) continue;
                    const t = (el.textContent || '').trim();
                    if (!t || t.length > 12) continue;
                    let rr;
                    try { rr = el.getBoundingClientRect(); } catch (e) { continue; }
                    if (!rr || rr.width < 8 || rr.height < 8) continue;
                    if (r) {
                        if (rr.right < r.left - 60 || rr.left > r.right + 60) continue;
                        if (rr.bottom < r.top || rr.top > r.bottom + 60) continue;
                    }
                    const panel = floatingAncestor(el);
                    if (!panel && rr.top < window.innerHeight * 0.5) continue;
                    near.push('  <' + el.tagName.toLowerCase() + '> "' + t.slice(0, 12) + '" ' +
                        (rr.width | 0) + 'x' + (rr.height | 0) +
                        (panel ? ' [浮层]' : '') +
                        ' cls=' + String(el.className || '').slice(0, 24));
                    if (near.length >= 40) break;
                }
            }
            const plan = speedClickPlan();
            lines.push('click plan (' + plan.length + '):');
            plan.slice(0, 6).forEach((el, i) => {
                let r = null;
                try { r = el.getBoundingClientRect(); } catch (e) {}
                lines.push('  ' + (i + 1) + '. <' + el.tagName.toLowerCase() + '> "' +
                    (el.textContent || '').trim().slice(0, 10) + '" cls=' +
                    String(el.className || '').slice(0, 28) +
                    (r ? ' ' + (r.width | 0) + 'x' + (r.height | 0) : ''));
            });
            const icons = [];
            let m2 = 0;
            for (const el of document.querySelectorAll('div, button')) {
                if (++m2 > 3000) break;
                if (!el.querySelector || !el.querySelector(':scope > svg')) continue;
                let rr = null;
                try { rr = el.getBoundingClientRect(); } catch (e) {}
                if (!rr || rr.width < 10 || rr.width > 130 || rr.height < 10 || rr.height > 130) continue;
                if (v && rr.top < v.getBoundingClientRect().top) continue;
                icons.push('  <' + el.tagName.toLowerCase() + '> ' + (rr.width | 0) + 'x' + (rr.height | 0) +
                    ' @' + (rr.left | 0) + ',' + (rr.top | 0) +
                    ' cls=' + String(el.className || '').slice(0, 28));
                if (icons.length >= 12) break;
            }
            lines.push('icon buttons (' + icons.length + '):');
            lines.push.apply(lines, icons);
            /* 倍速相关节点的真实状态：class / 尺寸 / 计算后的 display —— 
               面板到底是「不存在」「被隐藏」还是「就在那儿但点不到」，看这段 */
            const nodes = [];
            let m3 = 0;
            for (const el of document.querySelectorAll('[class]')) {
                if (++m3 > 3500) break;
                const cls = el.className;
                if (typeof cls !== 'string') continue;
                if (!/playback|playbackRatio|speed/i.test(cls)) continue;
                let rr = null;
                try { rr = el.getBoundingClientRect(); } catch (e) {}
                let st = null;
                try { st = getComputedStyle(el); } catch (e) {}
                nodes.push('  <' + el.tagName.toLowerCase() + '> cls=' + cls.slice(0, 34) +
                    ' ' + (rr ? (rr.width | 0) + 'x' + (rr.height | 0) : '?') +
                    (rr && rr.width ? ' @' + (rr.left | 0) + ',' + (rr.top | 0) : '') +
                    (st ? ' disp=' + st.display + ' vis=' + st.visibility : '') +
                    ' text="' + (el.textContent || '').replace(/\s+/g, '').slice(0, 18) + '"');
                if (nodes.length >= 18) break;
            }
            lines.push('playback nodes (' + nodes.length + '):');
            lines.push.apply(lines, nodes);
            /* 倍速按钮的整棵子树（含 class / 尺寸 / display / 文案）：
               下次不用再猜档位项叫什么、被哪一层藏起来 */
            const tree = [];
            const r0 = xgRateRoots()[0];
            if (r0) {
                const depthOf = (el) => {
                    let d = 0, q = el;
                    while (q && q !== r0 && d < 6) { q = q.parentElement; d++; }
                    return d;
                };
                let q2 = 0;
                for (const el of r0.querySelectorAll('*')) {
                    if (++q2 > 36) break;
                    let tr = null, ts = null;
                    try { tr = el.getBoundingClientRect(); } catch (e) {}
                    try { ts = getComputedStyle(el); } catch (e) {}
                    const t = (el.textContent || '').replace(/\s+/g, '');
                    tree.push('  ' + '  '.repeat(depthOf(el)) + '<' + el.tagName.toLowerCase() + '> ' +
                        (tr ? (tr.width | 0) + 'x' + (tr.height | 0) : '?') +
                        ' disp=' + (ts ? ts.display : '?') +
                        ' cls=' + String(el.className || '').slice(0, 28) +
                        ' text="' + t.slice(0, 14) + '"');
                }
            } else {
                tree.push('  (没找到 xgplayer-playback-setting)');
            }
            lines.push('rate tree (' + tree.length + '):');
            lines.push.apply(lines, tree);
            const prItems = xgPlayratioItems();
            lines.push('playratio 档位: ' + prItems.length + ' 项' +
                (prItems.length ? ' → ' + prItems.map(x => fmtSpeed(x.value) + (x.selected ? '*' : '')).join(',') : '') +
                ' | 直接点这条路' + (prItems.length >= 2 ? '可用' : '不可用'));
            /* 上一次按键到底走了哪条路、活跃视频现在的速率是多少 —— 
               这两项合起来能判断「没点到」还是「点了没生效」 */
            let avRate = '?', avDesc = '';
            try {
                const av = findActiveVideo();
                if (av) {
                    avRate = av.playbackRate;
                    const ar = av.getBoundingClientRect();
                    avDesc = ' @' + (ar.left | 0) + ',' + (ar.top | 0) +
                        ' ' + (ar.width | 0) + 'x' + (ar.height | 0);
                } else avRate = 'null(没找到活跃视频)';
            } catch (e) {}
            lines.push('上次同步: last sync via=' + speedSyncVia +
                ' | 目标=' + fmtSpeed(speedWanted) +
                ' | 活跃 video.rate=' + avRate + avDesc);
            /* 播放器实例能不能直接调接口 —— 这条路不用点 DOM，也不会闪面板 */
            let plDesc = '无（只能靠点档位）';
            try {
                const av2 = findActiveVideo();
                const pp2 = pagePlayer(av2);
                if (pp2) {
                    let pn = [];
                    try {
                        pn = pp2.plugins && typeof pp2.plugins === 'object'
                            ? Object.keys(pp2.plugins).filter(k => /rate|speed/i.test(k)) : [];
                    } catch (e) {}
                    plDesc = 'window.player（video=★本条, rate=' + pp2.playbackRate +
                        ', 倍速插件=' + (pn.length ? pn.join('/') : '无') + '）';
                } else {
                    const pl = av2 ? xgPlayerOf(av2) : null;
                    if (pl) {
                        const plugNames = pl.plugins && typeof pl.plugins === 'object'
                            ? Object.keys(pl.plugins).filter(k => /rate|speed/i.test(k)) : [];
                        plDesc = '有(setPlaybackRate=' + (typeof pl.setPlaybackRate === 'function') +
                            ', rate=' + pl.playbackRate +
                            ', 倍速插件=' + (plugNames.length ? plugNames.join('/') : '无') + ')';
                    }
                }
            } catch (e) {}
            lines.push('播放器实例: ' + plDesc +
                ' | 守速: ' + (rateGuardUntil > Date.now()
                    ? fmtSpeed(rateGuardRate) + '（还剩 ' + Math.round((rateGuardUntil - Date.now()) / 1000) + 's）'
                    : '未守'));
            /* 面板被谁关的：看这段。cause=force/restore/hover/click档位 是我们干的，
               user(isTrusted) 是真人操作，无近期动作 = 它自己收的 */
            if (gmPanelChanges.length) {
                lines.push('面板变更 (' + gmPanelChanges.length + '):');
                for (const c of gmPanelChanges) {
                    lines.push('  +' + (c.t / 1000).toFixed(2) + 's ' + c.label +
                        '  ' + String(c.from).slice(0, 30) + '  →  ' + String(c.to).slice(0, 30) +
                        '   cause=' + c.cause);
                }
            } else {
                lines.push('面板变更: 无记录（监视器一直在跑，期间 slider 的 display/style 没变过）');
            }
            const storage = speedStorageLines();
            lines.push('storage (' + storage.length + '):');
            lines.push.apply(lines, storage);
            lines.push('near texts (' + near.length + '):');
            lines.push.apply(lines, near);
            const text = lines.join('\n');
            try { console.log('[抖音优化] 倍速菜单候选\n' + text); } catch (e) {}
            copyText(text);
            showTip('倍速菜单候选已复制', 2200);
        }, 520);
    }
    window.__DY_OPT_DUMP_SPEED_MENU__ = dumpSpeedMenu;
    /* 改完速率守 3 秒：抖音/播放器会在 ratechange、切集、恢复播放时把速率改回原速，
       被改回来就再设一次。这样即使菜单那条路完全点不动，倍速本身也是生效的。 */
    /* 改完速率要「守」住：抖音在开始播放、切集、缓冲结束时都会把 playbackRate 重置回 1，
       只设一次的话画面马上又变回原速。所以既监听 ratechange 立刻纠正，也留一个轮询兜底。 */
    let rateGuardUntil = 0, rateGuardRate = 0, rateGuardTimer = 0;
    let rateGuardV = null, rateGuardHandler = null, rateGuardBusy = false;
    function guardPlaybackRate(v, rate) {
        if (!v) return;
        if (rateGuardV && rateGuardHandler) {
            try { rateGuardV.removeEventListener('ratechange', rateGuardHandler); } catch (e) {}
        }
        rateGuardV = v;
        rateGuardRate = rate;
        rateGuardUntil = Date.now() + 12000;          // 守 12 秒，够覆盖起播/缓冲
        rateGuardHandler = () => {
            if (rateGuardBusy) return;
            if (Date.now() > rateGuardUntil) return;
            let cur = 1;
            try { cur = v.playbackRate; } catch (e) { return; }
            if (Math.abs(cur - rateGuardRate) < 0.01) return;
            rateGuardBusy = true;
            try { v.playbackRate = rateGuardRate; } catch (e) {}
            if (speedSyncVia.indexOf('守回') < 0) speedSyncVia += '（守回速率）';
            setTimeout(() => { rateGuardBusy = false; }, 80);
        };
        try { v.addEventListener('ratechange', rateGuardHandler); } catch (e) {}
        try { v.playbackRate = rate; } catch (e) {}
        if (rateGuardTimer) { clearTimeout(rateGuardTimer); rateGuardTimer = 0; }
        const tick = () => {
            rateGuardTimer = 0;
            if (!rateGuardV || !rateGuardV.isConnected) return;
            if (Date.now() > rateGuardUntil) return;
            try { rateGuardHandler(); } catch (e) {}
            rateGuardTimer = setTimeout(tick, 500);
        };
        tick();
    }
    let speedSyncBusyUntil = 0, speedSyncBusyRate = 0;
    function syncSpeedToDouyin(rate) {
        const v = findActiveVideo();
        if (!v) return false;
        gmNoteAct('key');
        gmPanelWatchStart();

        /* ①-a 最优：抖音自己的播放器实例 window.player。
             它的 playbackRate 是内部状态，改完视频速度和倍速栏一起更新，
             既不用点菜单，也不会出现「当前条不动、下一条才生效」。 */
        const pp = pagePlayer(v);
        if (pp) {
            let via = '';
            try { via = applyRateViaPlayer(pp, rate); } catch (e) {}
            if (!via) {
                try { pp.playbackRate = rate; via = 'playbackRate'; } catch (e) {}
            }
            let cur = 0;
            try { cur = v.playbackRate; } catch (e) {}
            if (via && Math.abs(cur - rate) < 0.01) {
                speedSyncVia = 'pagePlayer(' + via + ')';
                speedSyncBusyUntil = Date.now() + 2000;
                speedSyncBusyRate = rate;
                guardPlaybackRate(v, rate);            // 兜底：万一它后面又重置
                /* 它自己会刷新倍速栏；给一拍时间，没跟上就补标签（不点菜单，避免动到面板） */
                setTimeout(() => {
                    const lb = xgRateLabel();
                    const t = lb ? (lb.textContent || '').trim() : '';
                    const c = strictRate(t);
                    if (c != null && Math.abs(c - rate) < 0.01) return;
                    try { syncActiveRateLabel(rate); } catch (e) {}
                }, 380);
                return true;
            }
            speedSyncVia = 'pagePlayer 没生效（video.rate=' + cur + '）';
        }

        /* ①-b 播放器本身先改（立即生效，也保证画面速度是对的） */
        let apiOk = false;
        const p = xgPlayerOf(v);
        if (p) {
            try {
                if (typeof p.setPlaybackRate === 'function') { p.setPlaybackRate(rate); speedSyncVia = 'xgplayer'; apiOk = true; }
                else { p.playbackRate = rate; speedSyncVia = 'xgplayer'; apiOk = true; }
            } catch (e) {}
        }
        if (!apiOk) {
            const api = speedApiNear(v);
            if (api) {
                const via = applyRateViaPlayer(api, rate);
                if (via) { speedSyncVia = 'fiber(' + via + ')'; apiOk = true; }
            }
        }
        /* ①-b 兜底：菜单那条路可能完全点不动，这里至少保证「画面速度」真的变
              （3 秒内被它改回去就再设一次） */
        guardPlaybackRate(v, rate);
        apiOk = true;
        /* ② 关键：再点一次抖音自己的倍速档位 —— 它的「倍速栏」高亮和
              「下次沿用」都记在它自己的状态里，只改播放器同步不过去。 */
        /* 同一次按键可能被两个入口各触发一次（快捷键 + 周期任务），
           叠在一起会把菜单点成 开-关-开。这里做 2.5 秒去重。 */
        const nowSync = Date.now();
        if (nowSync < speedSyncBusyUntil && Math.abs(speedSyncBusyRate - rate) < 0.01)
            return apiOk;
        speedSyncBusyUntil = nowSync + 2500;
        speedSyncBusyRate = rate;
        /* 控制栏常常是自动隐藏的：先把鼠标"移"到画面上让它浮出来，再找倍速按钮 */
        hoverOver(v.closest(PLAYER_SEL) || v);
        gmNoteAct('hover');
        if (!syncSpeedViaMenu(rate, 0)) {
            /* 按钮还没渲染出来（控制栏刚浮出）：0.5 秒后再试一次，只试一次，
               开两条并行的链会把菜单点成 开-关-开 */
            setTimeout(() => syncSpeedViaMenu(rate, 0), 500);
        }
        return apiOk;
    }
    function dumpSpeedSync() {
        const v = findActiveVideo();
        /* 控制栏是自动隐藏的：先"移"一下鼠标，让它浮出来再量锚点 */
        if (v) hoverOver(v.closest(PLAYER_SEL) || v);
        const lines = [];
        lines.push('URL: ' + location.href);
        lines.push('activeVideo: ' + (v ? [Math.round(v.getBoundingClientRect().width) + 'x' +
            Math.round(v.getBoundingClientRect().height), 'rate=' + v.playbackRate,
            'muted=' + v.muted] .join(' ') : 'null'));
        lines.push('speedWanted=' + speedWanted + ' speedAlt=' + config.speedAlt +
                   ' speedSync=' + config.speedSync);
        const p = v ? xgPlayerOf(v) : null;
        lines.push('xgplayer: ' + (p ? ('FOUND (' + (typeof p.setPlaybackRate === 'function'
            ? 'setPlaybackRate' : 'playbackRate') + ')') : 'not found'));
        const api = v ? speedApiNear(v) : null;
        lines.push('fiber api: ' + (api ? 'FOUND' : 'not found'));
        const xgRoot = xgRateRoots()[0] || null;
        const xgLabel = xgRateLabel();
        const xgItems = xgRateItems();
        lines.push('xgplayer 倍速: root=' + (xgRoot ? '<' + xgRoot.tagName.toLowerCase() + '> ' +
            String(xgRoot.className || '').slice(0, 40) : 'null') +
            ' | label="' + (xgLabel ? (xgLabel.textContent || '').trim().slice(0, 8) : '') + '"' +
            ' | 档位项=' + xgItems.length +
            (xgItems.length ? ' → ' + xgItems.map(x => x.value).join(',') : '') +
            ' | 「倍速」行=' + (xgRateEntryRow() ? '有' : '无') +
            ' | 小面板=' + xgSpeedPanels().length);
        const anywhere = speedListAnywhere();
        lines.push('全页扫描到的档位列表: ' + (anywhere
            ? anywhere.length + ' 项 → ' + Array.from(new Set(anywhere.map(x => x.value))).join(',')
            : '无（面板没打开）'));
        const scan = speedMenuScan();
        lines.push('speed menu: ' + (scan
            ? scan.length + ' 档 → ' + scan.map(x => x.value).join(',')
            : '未打开'));
        const anchors = speedAnchorEls();
        lines.push('speed anchors: ' + anchors.length + ' | texts: ' +
            (anchors.slice(0, 5).map(el => (el.textContent || '').replace(/\s+/g, '').slice(0, 8))
                .join(' / ') || '(无，把鼠标移到画面上再点一次诊断)'));
        lines.push('last sync via: ' + speedSyncVia);
        const st = speedStorageLines();
        lines.push('storage (' + st.length + '): ' + (st.join(' | ').trim() || '(无)').slice(0, 200));
        const text = lines.join('\n');
        try { console.log('[抖音优化] 倍速诊断\n' + text); } catch (e) {}
        copyText(text);
        return text;
    }
    window.__DY_OPT_DUMP_SPEED__ = dumpSpeedSync;

    /* =====================================================================
     * 8. 播放器识别 + 滚轮 / 双击 / 空格
     * ===================================================================== */
    function findActiveVideo() {
        let best = null, max = -1;
        for (const v of document.querySelectorAll('video')) {
            const r = v.getBoundingClientRect();
            if (r.width < 100 || r.height < 80) continue;
            const area = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0)) *
                         Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
            /* 面积之外还要看「是不是在播」：抖音滑窗里预加载的那条可能一样大，
               光比面积容易选中它——那就会出现「改了下一个、当前这条不动」 */
            if (area <= 0) continue;                  // 完全在视口外的一律不算
            let score = area;
            try { if (!v.paused) score += 3e6; } catch (e) {}
            try { if (v.readyState >= 2) score += 1e5; } catch (e) {}
            if (score > max) { max = score; best = v; }
        }
        return best;
    }

    function getPlayerContext(target) {
        if (target instanceof Element) {
            const box = target.closest('[id^="living_player_container"], .douyin-player, .xgplayer, ' +
                                       '[data-e2e="feed-active-video"], [data-e2e="video-player"], ' +
                                       '.douyin-player-controls, .xgplayer-controls');
            if (box && box.querySelector('video')) return playerInfo(box.querySelector('video'));
        }
        const v = findActiveVideo();
        return v ? playerInfo(v) : null;
    }

    function playerInfo(video) {
        const shell = video.closest('[id^="living_player_container"], .douyin-player, .xgplayer, ' +
                                    '[data-e2e="feed-active-video"], [data-e2e="video-player"], #sliderVideo') || video;
        return { video: video, shell: shell, rect: shell.getBoundingClientRect() };
    }

    function pointInRect(x, y, r, pad) {
        const p = pad == null ? 8 : pad;
        return x >= r.left - p && x <= r.right + p && y >= r.top - p && y <= r.bottom + p;
    }

    /* 只在需要排除的控件上放行。v9.2 去掉了 [class*="chatroom"] /
       [class*="danmaku"] 这类过宽匹配（会把整个视频容器一起排除掉，
       正是双击全屏失效的原因之一）。 */
    const controlSelector = '.douyin-player-controls, .xgplayer-controls, #ShortTouchLayout, ' +
        '#chatroom, [data-e2e="chatroom"], #gm-settings-panel, input, textarea, select, ' +
        '[contenteditable="true"], [role="slider"], [class*="comment"], [class*="Comment"], ' +
        '.xydy-cam-detached';

    /* ---- 音量命中判定 ----
     * 抖音的 hover 音量控件可能：藏在控制栏里、class 是哈希、滑块浮层
     * portal 到 body、或图标只有一个 SVG。只靠 [class*="volume"] 会漏。
     *
     * v9.20.4：旧版每次 wheel 都做 elementFromPoint + 全文档
     * querySelectorAll（6 个属性子串选择器）。抖音页面上万元素时单次十几毫秒，
     * 每滚一格都付一遍，手感就是「卡卡的」。现在分三级：
     *   ① 祖先链（几乎零成本，控制栏里的音量按钮基本都能命中）
     *   ② 浮层扫描结果按「鼠标位置 + 时间」缓存 —— 滚动时鼠标几乎不动，
     *      连续滚动只需要扫第一次
     *   ③ 扫描本身只查最可能命中的几个选择器，且限制 40 个候选
     * elementFromPoint 去掉了：wheel 的 target 本身就是命中最深的元素，
     * 再取一次除了强制布局没有别的收益。
     */
    const VOLUME_WORD = /volume|音量/i;
    function volumeSignature(el) {
        return [
            el.tagName, el.id, (typeof el.className === 'string' ? el.className : ''),
            el.getAttribute('data-e2e') || '',
            el.getAttribute('aria-label') || '',
            el.getAttribute('title') || ''
        ].join(' ');
    }
    let volScanAt = -1e9, volScanHit = false, volScanX = 0, volScanY = 0;
    function scanVolumeFloaters(x, y) {
        const list = document.querySelectorAll(
            '[class*="volume"], [class*="Volume"], [aria-label*="音量"], [data-e2e*="volume"]');
        for (let i = 0; i < list.length && i < 40; i++) {
            const r = list[i].getBoundingClientRect();
            if (r.width > 4 && r.height > 4 && r.width < 340 && r.height < 340 &&
                pointInRect(x, y, r, 24)) return true;
        }
        return false;
    }
    function isVolumeHoverTarget(target, e) {
        let cur = target instanceof Element ? target : null, d = 0;
        while (cur && d++ < 8) {
            if (VOLUME_WORD.test(volumeSignature(cur))) return true;
            cur = cur.parentElement;
        }
        const now = performance.now();
        if (now - volScanAt < 600 &&
            Math.abs(e.clientX - volScanX) < 24 && Math.abs(e.clientY - volScanY) < 24)
            return volScanHit;
        volScanAt = now; volScanX = e.clientX; volScanY = e.clientY;
        volScanHit = scanVolumeFloaters(e.clientX, e.clientY);
        return volScanHit;
    }

    /* ---- 滚轮音量：两条彼此独立的通路 ----
     * A 接管抖音原生「hover 音量图标」滚轮：全站生效，固定步进，
     *   不再随系统「每次滚动 N 行」改变幅度；
     * B 画面内任意位置滚轮调音量：仍只在直播间生效，普通视频页完全放行。
     *
     * v9.20.4 手感修复：
     *   1) 去重从 80ms 改成「同一帧」（10ms）。旧窗口把快速连续滚动整批吞掉，
     *      表现就是滚好几格音量不跟着动。
     *   2) deltaY 改像素累加：一格（100px）算一步。触控板的碎增量会累积后
     *      再走步进，不会一次抖出好几档，也不会小到没反应。
     *   3) 不再每次改写事件对象的 deltaY（无效且白付开销）。
     *   4) 「重申目标音量」从 3 个定时器合并成 1 个，「改文字提示」并到一帧，
     *      连续滚动时不再每步都触发布局。 */
    const VOLUME_WHEEL_UNIT = 100;   // Chrome 鼠标滚轮一格的 deltaY
    let volumeGuard = null, volRepaintTimer = 0, volTipRaf = 0;
    function applyVolumeStep(video, dir) {
        const step = Number(config.volumeStep) || 0.05;
        if (video.muted) video.muted = false;
        const target = Math.max(0, Math.min(1,
            Math.round(((Number(video.volume) || 0) + dir * step) * 1000) / 1000));
        // 已经到顶/到底：不再重复写，避免滚动时白白触发 volumechange
        if (Math.abs(target - video.volume) < 0.0005) return;
        /* v9.42：滚轮也是「用户自己在调音量」。先刷新 lastUserInputAt，
           下面派发的 volumechange 才会被判定成手动静音并让防静音守护收手；
           旧版这里不刷新，滚到 0 立刻被守护顶回 50%。 */
        lastUserInputAt = Date.now();
        volumeGuard = { video: video, value: target, until: Date.now() + 200 };
        video.volume = target;
        try { video.dispatchEvent(new Event('volumechange', { bubbles: true })); } catch (e) {}
        // 页面若把内部音量状态回写，短窗口内重申一次目标值
        clearTimeout(volRepaintTimer);
        volRepaintTimer = setTimeout(() => {
            const g = volumeGuard;
            if (!g || g.video !== video || Date.now() > g.until) return;
            if (Math.abs(video.volume - g.value) > 0.0005) video.volume = g.value;
        }, 60);
        // 提示合并到一帧：连续滚动只显示最终值，不打断过渡
        if (!volTipRaf) {
            volTipRaf = requestAnimationFrame(() => {
                volTipRaf = 0;
                const v = (volumeGuard && volumeGuard.video) || video;
                showTip('音量: ' + Math.round((Number(v.volume) || 0) * 100) + '%', 900);
            });
        }
    }

    function wheelDelta(e) {
        if (typeof e.deltaY === 'number' && e.deltaY !== 0) return e.deltaY;
        const w = (typeof e.wheelDeltaY === 'number' && e.wheelDeltaY !== 0)
            ? e.wheelDeltaY : e.wheelDelta;
        return (typeof w === 'number' && w !== 0) ? -w : 0;
    }

    let lastWheelTs = -1e9, wheelAcc = 0, wheelAccAt = 0;
    function onVolumeWheel(e) {
        if (e.ctrlKey || e.metaKey || document.hidden) return;
        if (e.target instanceof Element && e.target.closest(panelIgnore)) return;
        const dy = wheelDelta(e);
        if (!dy || Math.abs(dy) < Math.abs(e.deltaX || 0)) return;
        const t = e.target;
        const inVolume = isVolumeHoverTarget(t, e);
        let ctx = null;
        if (inVolume) {
            if (!config.hoverVolumeWheel) return;      // 关掉接管则完全放行原生行为
        } else {
            if (!config.wheelVolume || !isLivePage()) return;
            if (t instanceof Element && t.closest(controlSelector)) return;
            ctx = getPlayerContext(t);
            if (!ctx || !pointInRect(e.clientX, e.clientY, ctx.rect)) return;
        }
        if (!ctx) ctx = getPlayerContext(t);
        const video = (ctx && ctx.video) || findActiveVideo();
        if (!video) return;

        /* 同一次物理滚动会同时派发 wheel 与 mousewheel，两者时间戳完全相同。
           只合并「同一时刻」的两个事件；窗口放宽到 10ms 会误伤高刷触控板
           （8ms 一帧的连续滚动会被当成重复吞掉，那才是真正的卡）。 */
        const ts = e.timeStamp || performance.now();
        e.preventDefault();
        e.stopImmediatePropagation();
        if (Math.abs(ts - lastWheelTs) < 3) return;
        lastWheelTs = ts;

        // deltaMode 非 0（按行/按页）时，事件粒度本身就是一档，直接用
        if (e.deltaMode) {
            wheelAcc = 0;
            applyVolumeStep(video, dy < 0 ? 1 : -1);
            return;
        }
        const now = performance.now();
        if (now - wheelAccAt > 400) wheelAcc = 0;   // 停顿后重新起算
        wheelAccAt = now;
        wheelAcc += dy;
        let steps = 0;
        while (Math.abs(wheelAcc) >= VOLUME_WHEEL_UNIT && steps < 6) {
            const up = wheelAcc < 0;
            wheelAcc += up ? VOLUME_WHEEL_UNIT : -VOLUME_WHEEL_UNIT;
            applyVolumeStep(video, up ? 1 : -1);
            steps++;
        }
        if (Math.abs(wheelAcc) > VOLUME_WHEEL_UNIT * 4) wheelAcc = 0;  // 防溢出
    }
    window.addEventListener('wheel', onVolumeWheel, { capture: true, passive: false });
    window.addEventListener('mousewheel', onVolumeWheel, { capture: true, passive: false });

    /* ---- 双击画面网页全屏（取代双击点赞） ----
     * 只派发抖音官方快捷键 Y（网页全屏，再按退出）；不扫描/点击任何全屏按钮。
     * click(detail>=2) 的点赞拦截仍在上面，因此双击依旧取代点赞。
     * 注意：抖音没有「双击暂停」，双击序列是 click(1) + click(2)：
     * 第一击被当成单击画面 → 播放/暂停切换，第二击的 click 又被我们的点赞
     * 拦截吃掉，于是全屏后停在暂停。这里按「第一击前的播放状态」还原：
     * 原来在播就继续播，原来暂停就保持暂停。 */
    let firstDownPlaying = false, firstDownVideo = null, firstDownAt = 0, dblUserDownAt = 0;
    /* 记录「双击序列第一击」时主视频是否在播。原生单击可能在第二击前
       就把视频切走，所以不能等 dblclick 时才取状态。 */
    document.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.detail >= 2) return;
        const v = findActiveVideo();
        if (!v) return;
        firstDownPlaying = !v.paused;
        firstDownVideo = v;
        firstDownAt = Date.now();
    }, true);
    document.addEventListener('pointerdown', () => { dblUserDownAt = Date.now(); }, true);
    function restoreDblPlayState(video) {
        if (!video || isLivePage()) return;
        /* 以「第一击前的状态」为准：当前 paused 可能已经被第一击改成暂停了，
           直接读 !video.paused 会把「原本就暂停」误判成「原本在播」。 */
        const fromFirst = (video === firstDownVideo && Date.now() - firstDownAt < 600);
        const wasPlaying = fromFirst ? firstDownPlaying : !video.paused;
        const startedAt = Date.now();
        const apply = () => {
            // 守护只持续 220ms；用户在这之后自己点暂停/播放不再干预
            if (dblUserDownAt > startedAt) return;
            let v = video;
            if (!v.isConnected) v = findActiveVideo();
            if (!v) return;
            try {
                if (wasPlaying) { if (v.paused && !v.ended) v.play().catch(() => {}); }
                else if (!v.paused) v.pause();
            } catch (e) {}
        };
        apply();
        setTimeout(apply, 80);
        setTimeout(apply, 200);
    }
    /* v9.21：双击的「点赞特效」不走 click / dblclick —— 抖音在第二击按下的
       那一刻就开始播放心形动画了，等 dblclick 再拦已经晚了一帧。
       所以在第二击的 pointerdown / mousedown 上直接吞掉。
       v9.22：又补了三处（视频流才有点赞，直播间的双击是全屏，不涉及）：
         ① 播放器内部的装饰层不再算浮层，否则 isOverlayClick 会把第二击放行；
         ② 双击窗口 350ms → 600ms，系统双击阈值默认 500ms，原来手慢一点就漏；
         ③ 补 pointerup / mouseup：抖音也可能在「抬起」时起动画。
       第一击始终放行（否则没有 detail=2，也拿不到「第一击前是否在播」），
       pointerdown 与随之而来的 mousedown 是同一次物理按下，用 pairAt 去重。 */
    let pressAt = 0, pressX = 0, pressY = 0, pressSeen = false, pairAt = 0, blockedAt = 0;
    let blockX = 0, blockY = 0, genuinePair = false;
    function blockSecondPress(e) {
        if (!config.doubleFullScreen || hotkeyCapturing) return;
        if (e.button !== 0) return;
        if (e.target instanceof Element && e.target.closest(panelIgnore)) return;
        /* v9.24：弹层里的控件（主页 X 返回、图片查看器缩放、详情页按钮）
           不参与双击全屏，也绝不能被当成「第二击」吞掉。这条必须放在
           所有放行/拦截判定之前 —— 之前晚了一步，弹层按钮的 pointerdown
           会先被吞，click 自然也就没了。 */
        if (isLayeredUi(e.target)) return;
        if (!(e.target instanceof Element) || e.target.closest(controlSelector)) return;
        /* v9.30：控件上的按下/抬起不参与双击全屏判定，更不该被当「第二击」吞掉 */
        if (isInteractiveTarget(e.target)) return;
        /* 播放器内部的装饰层不算浮层（点赞动画容器本身就在里面），
           否则第二击会被当成「点在浮层上」直接放行。 */
        if (isOverlayClick(e.target) && !insidePlayerBox(e.target)) return;
        const ctx = getPlayerContext(e.target);
        if (!ctx || !pointInRect(e.clientX, e.clientY, ctx.rect, 24)) return;
        const now = Date.now();
        /* 抬起通道：万一抖音是在第二击「抬起」时起点赞动画，这里一并吞掉 */
        if (e.type === 'pointerup' || e.type === 'mouseup') {
            if (blockedAt && now - blockedAt < 700 &&
                Math.abs(e.clientX - blockX) < 14 && Math.abs(e.clientY - blockY) < 14) {
                e.preventDefault(); e.stopImmediatePropagation();
            }
            return;
        }
        if (e.type === 'mousedown' && now - pairAt < 40) {
            // 同一次按下：pointerdown 已判定过，只在它判为第二击时跟着吞掉
            if (blockedAt && now - blockedAt < 40) {
                e.preventDefault(); e.stopImmediatePropagation();
            }
            return;
        }
        /* 600ms：Windows 双击阈值默认 500ms，原来 350ms 把「手慢一点」的双击
           全漏掉了，而 detail 在部分环境并不递增，于是特效照出。 */
        const quick = pressSeen && now - pressAt < 600 &&
            Math.abs(e.clientX - pressX) < 14 && Math.abs(e.clientY - pressY) < 14;
        if (e.detail >= 2 || quick) {
            e.preventDefault(); e.stopImmediatePropagation();
            /* v9.39：区分「脚本亲眼看到的两击」和「浏览器单方面报的 detail>=2」。
               只有 quick（本脚本两次 pointerdown 命中同一落点）才算真双击序列，
               供 dblclick 校验；单纯 detail>=2 可能是触控板/单击误报。 */
            genuinePair = !!quick;
            blockedAt = now; blockX = e.clientX; blockY = e.clientY;
            pairAt = now; pressSeen = false;
            likeShieldUntil = now + 400;
            gmGuardUntil = now + 600;
            return;
        }
        pressAt = now; pressX = e.clientX; pressY = e.clientY;
        pressSeen = true; pairAt = now; blockedAt = 0; genuinePair = false;
    }
    /* v9.23：四个通道全部提到 window capture —— 必须比抖音自己的监听更早，
       否则 stopImmediatePropagation 只能拦住同一节点上后注册的监听。 */
    window.addEventListener('pointerdown', blockSecondPress, true);
    window.addEventListener('mousedown', blockSecondPress, true);
    window.addEventListener('pointerup', blockSecondPress, true);
    window.addEventListener('mouseup', blockSecondPress, true);

    window.addEventListener('dblclick', (e) => {
        if (!config.doubleFullScreen || hotkeyCapturing) return;
        if (!(e.target instanceof Element) || e.target.closest(controlSelector)) return;
        if (isLayeredUi(e.target)) return;
        if (isInteractiveTarget(e.target)) return;
        const ctx = getPlayerContext(e.target);
        if (!ctx || !pointInRect(e.clientX, e.clientY, ctx.rect, 24)) return;
        /* v9.39：视频流「只单点一下却全屏」——触控板/某些鼠标会把一次物理点击
           误报成 dblclick，之前这里零校验直接派发 Y。现在必须有本脚本亲眼看到的
           两击序列（blockSecondPress 里命中 quick、且落点/时间与这一击吻合）
           才认作真双击；误报的 dblclick 直接放行，交给抖音当普通单击。 */
        const now = Date.now();
        const realDouble = genuinePair && blockedAt && now - blockedAt <= 120 &&
            Math.abs(e.clientX - blockX) <= 14 && Math.abs(e.clientY - blockY) <= 14;
        genuinePair = false;   // 一次性消费，防止一次两击被后续误报复用
        if (!realDouble) return;
        e.preventDefault(); e.stopImmediatePropagation();
        likeShieldUntil = now + 400;
        gmGuardUntil = now + 600;
        cancelPendingSingle();          // 双击：取消第一击延迟的那次单击
        restoreDblPlayState(ctx.video);
        tapKey('y', 'KeyY');
    }, true);

    /* v9.24 排障：如果双击仍然会点赞，在控制台执行
       __DY_OPT_DBL_DEBUG__() 后双击视频，会打印这 10 秒内播放器上收到的
       全部指针 / 点击事件（谁被拦、谁被放行），据此定位是哪条通道漏的。 */
    window.__DY_OPT_DBL_DEBUG__ = function () {
        const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick'];
        const logs = [];
        const on = (e) => {
            if (!(e.target instanceof Element)) return;
            if (!insideShell(e.target)) return;
            logs.push([
                new Date().toTimeString().slice(0, 12),
                e.type,
                'detail=' + (e.detail == null ? '-' : e.detail),
                'blocked=' + (e.defaultPrevented ? 'yes' : 'no'),
                'target=<' + e.target.tagName.toLowerCase() + '> ' +
                    String(e.target.className || '').slice(0, 40),
                '(' + (e.clientX | 0) + ',' + (e.clientY | 0) + ')'
            ].join(' '));
        };
        types.forEach(t => window.addEventListener(t, on, true));
        showTip('双击排障已开启，10 秒内双击视频后会打印到控制台', 2600);
        setTimeout(() => {
            types.forEach(t => window.removeEventListener(t, on, true));
            console.log('[抖音优化] 双击排障\n' + logs.join('\n'));
            copyText(logs.join('\n'));
        }, 10000);
    };

    let restoreTimer = null;
    function mainLiveVideo() {
        let best = null, area = 0;
        for (const v of document.querySelectorAll('video')) {
            const r = v.getBoundingClientRect();
            const a = r.width * r.height;
            if (a > area) { area = a; best = v; }
        }
        return best;
    }
    /* v9.42：只在「真的被静音了」（muted=true）时才解除并补音量，而且补的是
       用户最后用过的音量，不再写死 0.5。
       旧版是 `if (!v.volume) v.volume = 0.5` —— 用户把滚轮滚到 0% 时，
       volumechange 会触发守护，200ms 后这里就把 0 顶成 50%，
       表现就是「调到 0% 立刻变 50%，点一下画面又正常」（点击让
       lastUserInputAt 刷新，守护才肯停手）。 */
    let lastGoodVolume = 0.5;
    function unmuteLiveVideo() {
        const v = mainLiveVideo();
        if (!v) return false;
        try {
            if (v.volume > 0.01) lastGoodVolume = v.volume;
            if (v.muted) {
                v.muted = false;
                if (!v.volume) v.volume = lastGoodVolume;
            }
            return !v.muted;
        } catch (e) { return false; }
    }
    function startResumeGuard() {
        if (userMutedManually) return;      // v9.35：本房间已经手动静音过，别再解
        resumeGuardUntil = Date.now() + 8000;
        if (restoreTimer) { clearInterval(restoreTimer); restoreTimer = null; }
        let count = 0;
        restoreTimer = setInterval(() => {
            /* 守护跑着的时候用户自己静音了：立刻收手，不许把人家的静音再打开 */
            if (userMutedManually) {
                clearInterval(restoreTimer); restoreTimer = null;
                return;
            }
            const ok = unmuteLiveVideo();
            if (++count > 45 || (Date.now() > resumeGuardUntil && ok)) {
                clearInterval(restoreTimer); restoreTimer = null;
            }
        }, 200);
    }
    /* 只在「明确的播放恢复信号」下武装 8 秒守护。用户在本房间动过音量
       控件后永久不再自动解除——手动长时间静音不会被定时器解掉。 */
    function armResumeGuard() {
        if (!config.resumeAudio || !isLivePage()) return;
        if (userMutedManually) return;
        startResumeGuard();
    }
    function isResumeClick(e) {
        const path = (e.composedPath && e.composedPath()) || [];
        let node = e.target;
        for (let i = 0; i < 6; i++) {
            const el = path[i] || node;
            if (el && el.textContent) {
                const t = (el.textContent || '').trim();
                if (/继续看播|继续播放|点击继续|继续观看|恢复播放|继续/.test(t) &&
                    t.length < 40) return true;
            }
            node = node && node.parentElement;
            if (!node && !path[i + 1]) break;
        }
        return false;
    }
    const onResumeClick = (e) => {
        if (!config.resumeAudio || !isLivePage()) return;
        if (!isResumeClick(e)) return;
        armResumeGuard();
    };
    document.addEventListener('pointerdown', onResumeClick, true);
    document.addEventListener('click', onResumeClick, true);

    function guardResumeAudio() {
        if (!config.resumeAudio || !isLivePage()) return;
        // 切直播间重新判断（新房间的用户可能希望脚本帮忙解除）
        // 首次运行只记录当前房间，别把刚标记的手动静音误当成切房间重置
        if (!resumeLastUrl) resumeLastUrl = location.href;
        else if (location.href !== resumeLastUrl) {
            resumeLastUrl = location.href;
            userMutedManually = false;
        }
        if (userMutedManually) return;
        if (Date.now() > resumeGuardUntil) return;   // 只在明确信号后的窗口内
        const v = mainLiveVideo();
        if (!v || v.paused) return;
        if (v.muted || !v.volume) unmuteLiveVideo();
    }
    /* 用户碰过音量 / 静音控件 → 本房间永久视为手动静音。
       不需要「30 秒后过期」那种定时放行，长时间静音也不会被解掉。 */
    document.addEventListener('pointerdown', (e) => {
        if (!config.resumeAudio || !isLivePage()) return;
        const t = e.target;
        try {
            if (t && t.closest && t.closest(
                '[data-e2e*="volume"], [class*="volume"], [class*="Volume"], ' +
                '.xgplayer-volume, [data-e2e*="mute"], [class*="muted"], ' +
                '[data-e2e*="audio"], [class*="audio-icon"]'))
                userMutedManually = true;
        } catch (e2) {}
    }, true);
    // 信号一：播放恢复
    document.addEventListener('play', (e) => {
        if (!config.resumeAudio || !isLivePage()) return;
        if (e.target && e.target.tagName === 'VIDEO') armResumeGuard();
    }, true);
    /* 信号二：主视频被静音。
       旧版这里无条件 armResumeGuard()，结果「手动静音 → 8 秒守护把你解掉」，
       表现就是刚点静音又被自动打开。现在分两种：
         · 静音发生在刚有鼠标 / 键盘操作之后 → 就是用户自己静音的，
           记成手动静音（本房间不再自动解除），并把正在跑的守护停掉；
         · 没人操作却静音 → 抖音自己的行为（继续看播那种），才交给守护。 */
    document.addEventListener('volumechange', (e) => {
        if (!config.resumeAudio || !isLivePage()) return;
        const v = e.target;
        if (!v || v.tagName !== 'VIDEO' || v.paused) return;
        if (!v.muted && v.volume) return;        // 没静音、音量也不是 0：不管
        if (Date.now() - lastUserInputAt < 1500) {
            userMutedManually = true;
            if (restoreTimer) { clearInterval(restoreTimer); restoreTimer = null; }
            return;
        }
        if (userMutedManually) return;
        armResumeGuard();
    }, true);

    window.addEventListener('keydown', (e) => {
        if (!config.spacePause || hotkeyCapturing) return;
        if (e.code !== 'Space' && e.key !== ' ') return;
        const ae = document.activeElement;
        const tag = (ae && ae.tagName && ae.tagName.toUpperCase()) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
            tag === 'BUTTON' || tag === 'A' || (ae && ae.isContentEditable) ||
            (ae && ae.getAttribute && ae.getAttribute('role') === 'button')) return;
        let targetVideo = null, maxArea = 0;
        document.querySelectorAll('video').forEach(v => {
            const r = v.getBoundingClientRect();
            const area = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0)) *
                         Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
            if (area > maxArea && r.width > 100) { maxArea = area; targetVideo = v; }
        });
        if (!targetVideo) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (targetVideo.paused) targetVideo.play().catch(() => {});
        else targetVideo.pause();
    }, true);

    /* =====================================================================
     * 9. 统一定时器
     * ===================================================================== */
    const closePausePopupTask = () => closePausePopup(null);
    const hideLivePopupsTask = () => hideLivePopupsIn([document.body], 3000);

    /* v9.19：按页面类型分组。旧版 20 个任务每轮全跑，live 页也要进一遍
       www 专属任务的函数体再早退；分组后两边只跑自己的。 */
    /* =====================================================================
     * v9.41 界面清理：去掉某些按钮 / 入口
     * =====================================================================
     * 两类规则，原因不同：
     *   css  —— 有稳定标识（独立 class / data-e2e / href 片段），直接注入样式；
     *   text —— 只能靠文案定位。抖音顶栏那几个按钮共用哈希 class，还都套着
     *           data-e2e="something-button"（命中 5 个），光看选择器会误伤一片，
     *           所以按「文案 + 区域（顶栏 / 右侧栏）」找元素，再往上找到只含
     *           这段文字、尺寸像按钮的那一层隐藏。
     * 文案规则用一次遍历同时处理所有规则，最多扫 6000 个节点，2.5 秒一轮。 */
    const CLEAN_CSS_RULES = [
        ['cleanAiDouyin', '[class*="ai-douyin-entry"], .ai-douyin-entry'],
        ['cleanTopClient', 'a[href*="/download/pc"], a[href*="/downloadpage/pc"]'],
        ['cleanWallpaper', 'div.ZLiWmE4n'],
        /* 听抖音：它在右侧竖排工具栏里，和点赞/评论/收藏/分享同一列。
           刻意只用 class 定位、不用文案 —— 聊天室里单独一条「听抖音」的弹幕
           也会被文案规则误伤，而右侧那一列和聊天区在 x 轴上是重叠的。 */
        ['cleanListenDouyin', '.X8FkYUpY.dR9rKVUF'],
        /* 收藏弹窗：探查报告里它的容器是 div.semi-always-dark._KRDPUZX
           （_KRDPUZX 是收藏那一份的专属哈希），CSS 直接压掉不会闪。 */
        ['cleanCollectPopup', 'div.semi-always-dark._KRDPUZX'],
        /* 分享弹窗：容器带 `recommend-login-panel`（实测 315x492，另有一串随机哈希）。
           这里也必须走 CSS —— 只靠 JS 判定的话，弹窗先被画出来才轮到我们处理，
           于是「闪一下」。CSS 是元素一插入就生效，跟收藏弹窗一个待遇。
           JS 那条（文案认人）保留着，万一哪天这个 class 换了名字还能兜住。 */
        ['cleanSharePopup', '[class*="recommend-login-panel"]']
    ];
    /* 文案规则只用于「顶栏」（y < 80px）—— 聊天室、评论都在下面，不会误伤 */
    const CLEAN_TEXT_RULES = [
        ['cleanDiamond', '充钻石', 'top'],
        ['cleanWallpaper', '壁纸', 'top'],
        ['cleanTopClient', '客户端', 'top']
    ];
    let cleanTextAt = 0;

    function applyCleanStyle() {
        let css = '';
        for (const [key, sel] of CLEAN_CSS_RULES) {
            if (config[key]) css += sel + ' { display: none !important; }\n';
        }
        let st = document.getElementById('gm-clean-style');
        if (!st) {
            st = document.createElement('style');
            st.id = 'gm-clean-style';
            (document.head || document.documentElement).appendChild(st);
        }
        if (st.textContent !== css) st.textContent = css;
    }

    function applyCleanText() {
        if (Date.now() - cleanTextAt < 2500) return;
        const rules = CLEAN_TEXT_RULES.filter(r => config[r[0]]);
        if (!rules.length) return;
        cleanTextAt = Date.now();
        const want = new Map();
        for (const [key, text, area] of rules) want.set(text, { key: key, area: area });
        const vw = window.innerWidth;
        let guard = 0;
        for (const el of document.querySelectorAll('p, span, div, a')) {
            if (++guard > 6000) break;
            if (el.children.length > 2) continue;
            if (el.closest && el.closest('#gm-settings-panel')) continue;
            const t = (el.textContent || '').trim();
            const hit = want.get(t);
            if (!hit) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (!r || r.width < 8 || r.height < 8) continue;
            /* 区域过滤：顶栏 = 贴着窗口顶；右侧工具栏 = 靠右竖排 */
            if (hit.area === 'top' && r.top > 80) continue;
            if (hit.area === 'right' && r.left < vw * 0.65) continue;
            /* 往上找到「只包含这段文字、尺寸像按钮」的最高那层再隐藏 */
            let best = el, cur = el.parentElement, d = 0;
            while (cur && cur !== document.body && d++ < 4) {
                if ((cur.textContent || '').trim() !== t) break;
                let cr;
                try { cr = cur.getBoundingClientRect(); } catch (e) { break; }
                if (!cr || cr.height > 78 || cr.width > 220) break;
                best = cur; cur = cur.parentElement;
            }
            if (best.getAttribute('data-gm-clean') === hit.key) continue;
            best.setAttribute('data-gm-clean', hit.key);
            best.style.setProperty('display', 'none', 'important');
        }
    }

    /* v9.41：播放器右侧的收藏 / 分享浮层。
       两份弹窗都套在 semi 设计系统的 `semi-always-dark` 里（哈希不同），
       所以容器按 class 前缀找，再用弹窗自己的文案区分是谁：
         含「收藏夹」            → 收藏弹窗
         含「分享给朋友 / 复制链接」→ 分享弹窗
       只隐藏浮层本身，右侧工具栏上的收藏 / 分享按钮原样保留。
       通过 MutationObserver 触发（弹窗是点出来才插入的），节流 150ms。 */
    /* v9.41：收藏弹窗在 semi 那套里（`.semi-always-dark._KRDPUZX`），
       分享弹窗不在 —— 它的容器 class 带 `recommend-login-panel`
       （实测 315x492：顶部「分享给朋友」+ 会话列表 + 底部按钮行）。
       两族都收；命中后再往上扩到「装得下整个弹窗」的那层，
       否则只藏到列表那一截，底部按钮行还留着。 */
    const POPUP_BOX_SEL = '.semi-always-dark, [class*="semi-always-dark"], ' +
        '[class*="recommend-login-panel"], [class*="share-panel"], [class*="SharePanel"]';
    let cleanPopupAt = 0, cleanPopupObserver = null;

    /* v9.41：弹窗「闪一下」的解法。
       弹窗是点出来才插入 DOM 的，等下一轮定时任务（1.5 秒）再处理必然看得见。
       现在 MutationObserver 一认出候选节点就**先把它设成 visibility:hidden**
       （这一拍量不到尺寸也没关系，反正已经画不出来了），
       紧接着同步做一次精确判定：确实是收藏 / 分享弹窗就 display:none，
       不是的话 700ms 后把 visibility 还回去。 */
    function pendingHidePopup(roots) {
        for (const root of roots) {
            if (!root || root.nodeType !== 1) continue;
            let list = [];
            try {
                if (root.matches && root.matches(POPUP_BOX_SEL)) list.push(root);
                if (root.querySelectorAll) {
                    root.querySelectorAll(POPUP_BOX_SEL).forEach(x => list.push(x));
                }
            } catch (e) { continue; }
            for (const el of list) {
                if (el.closest && el.closest('#gm-settings-panel')) continue;
                if (el.hasAttribute('data-gm-popup-pending')) continue;
                el.setAttribute('data-gm-popup-pending', String(Date.now()));
                el.style.setProperty('visibility', 'hidden', 'important');
            }
        }
    }
    function settlePendingPopup() {
        const pend = document.querySelectorAll('[data-gm-popup-pending]');
        const now = Date.now();
        for (const el of pend) {
            const at = Number(el.getAttribute('data-gm-popup-pending')) || 0;
            if (now - at < 700) continue;
            el.removeAttribute('data-gm-popup-pending');
            /* display:none 的不用管；判定失败的把 visibility 还回去 */
            if (el.style.visibility === 'hidden' && el.style.display !== 'none') {
                el.style.removeProperty('visibility');
            }
        }
    }

    function expandPopupBox(el) {
        let box = el;
        for (let i = 0; i < 4; i++) {
            const p = box.parentElement;
            if (!p || p === document.body) break;
            let pr;
            try { pr = p.getBoundingClientRect(); } catch (e) { break; }
            if (pr.width < 200 || pr.width > 720) break;
            if (pr.height < 100 || pr.height > 820) break;
            if (pr.left < window.innerWidth * 0.4) break;
            /* 父层文本量暴涨 = 已经扩到整页容器了，停手 */
            const a = (box.textContent || '').length;
            const b = (p.textContent || '').length;
            if (b > a * 1.5 + 60) break;
            box = p;
        }
        return box;
    }
    function applyCleanPopup() {
        /* 先结算 pending：两个开关都关掉时这个函数会提前 return，
           放在末尾就永远清不到，被 pending 按住（visibility:hidden）的元素会一直隐形。 */
        settlePendingPopup();
        const needC = !!config.cleanCollectPopup;
        const needS = !!config.cleanSharePopup;
        /* 开关关掉后要把之前隐藏的恢复回去 */
        const marked = document.querySelectorAll('[data-gm-cleanpopup]');
        for (const el of marked) {
            const k = el.getAttribute('data-gm-cleanpopup');
            if ((k === 'collect' && !needC) || (k === 'share' && !needS)) {
                el.removeAttribute('data-gm-cleanpopup');
                el.removeAttribute('data-gm-popup-pending');
                el.style.removeProperty('display');
                el.style.removeProperty('visibility');
            }
        }
        if (!needC && !needS) return;
        const vw = window.innerWidth;
        const boxes = document.querySelectorAll(POPUP_BOX_SEL);
        for (const el0 of boxes) {
            if (el0.closest && el0.closest('#gm-settings-panel')) continue;
            let r0;
            try { r0 = el0.getBoundingClientRect(); } catch (e) { continue; }
            /* 太小的先放过（按钮、tooltip 之类），弹窗本体 300x250 起 */
            if (r0.width < 200 || r0.height < 100) continue;
            if (r0.left < vw * 0.4) continue;
            const el = expandPopupBox(el0);
            if (el.closest && el.closest('#gm-settings-panel')) continue;
            let r;
            try { r = el.getBoundingClientRect(); } catch (e) { continue; }
            if (r.width < 200 || r.width > 700 || r.height < 100 || r.height > 800) continue;
            if (r.left < vw * 0.4) continue;         // 播放器右侧那一列
            const t = (el.textContent || '').slice(0, 600);
            let kind = '';
            /* 先认分享（特征更具体），再认收藏 */
            if (/分享给朋友|复制链接|分享到|生成图片/.test(t)) kind = 'share';
            else if (/选择收藏夹|暂无收藏夹|新建收藏夹|收藏夹/.test(t)) kind = 'collect';
            if (!kind) continue;
            if (kind === 'collect' && !needC) continue;
            if (kind === 'share' && !needS) continue;
            if (el.getAttribute('data-gm-cleanpopup') === kind) continue;
            el.setAttribute('data-gm-cleanpopup', kind);
            el.style.setProperty('display', 'none', 'important');
            el.removeAttribute('data-gm-popup-pending');
        }
    }
    function ensureCleanPopupObserver() {
        if (cleanPopupObserver || !document.body) return;
        if (!config.cleanCollectPopup && !config.cleanSharePopup) return;
        cleanPopupObserver = new MutationObserver((records) => {
            /* 只认「新增节点里出现弹窗候选」这一种变化：抖音每帧都在改 DOM，
               无条件全量查一遍太浪费。不节流 —— 回调跑在微任务里、下一帧渲染之前，
               所以能赶在弹窗画出来之前把它按住。 */
            const hit = [];
            for (const rec of records) {
                const nodes = rec.addedNodes;
                for (let i = 0; i < nodes.length; i++) {
                    const n = nodes[i];
                    if (!n || n.nodeType !== 1) continue;
                    let ok = false;
                    try {
                        ok = (n.matches && n.matches(POPUP_BOX_SEL)) ||
                             (n.children && n.children.length && n.querySelector &&
                              !!n.querySelector(POPUP_BOX_SEL));
                    } catch (e) { ok = false; }
                    if (ok) hit.push(n);
                }
                if (hit.length > 3) break;
            }
            if (!hit.length) return;
            try { pendingHidePopup(hit); } catch (e) {}
            cleanPopupAt = Date.now();
            try { applyCleanPopup(); } catch (e) {}
            /* 有些弹窗这一拍还量不到尺寸（入场动画 / 布局未完成），
               120ms 后补一次，那时还没判定成功也不会再闪（一直是 hidden）。 */
            setTimeout(() => { try { applyCleanPopup(); } catch (e) {} }, 120);
        });
        try {
            cleanPopupObserver.observe(document.body, { childList: true, subtree: true });
        } catch (e) { cleanPopupObserver = null; }
    }

    /* v9.47：底部那道「透明方块」——
       直播页底部的 OperatingBarPluginContainer 是个**占高度的普通块**（不是浮层），
       里面装的是礼物栏 / 礼物托盘 / 评论输入。我们把礼物那几块 display:none 之后，
       它自己那 88px 照样留着：变成一块看不见但占位的透明方块，
       把播放器整个往上顶（诊断里 video 只有 622 高、窗口 710，差的 88 就是它）。
       只在「里面确实一个可见子元素都没有」时收成 0 高；一旦有内容重新出现
       （比如评论输入框弹出来）立刻还原，不会误伤。 */
    function collapseEmptyOpBar() {
        let bars;
        try { bars = document.querySelectorAll('div[class*="OperatingBarPluginContainer"]'); } catch (e) { return; }
        if (!bars.length) return;
        /* 只用「高度归零」这一套，不设 overflow:hidden，也不动 flex：
           · 不设 overflow —— 万一以后评论输入框在里面显示，不会被裁掉；
           · 不动 flex —— 父容器是 row 还是 column 不确定，flex-basis 归零
             在 row 下会把宽度也压掉；height 归零两种方向都只是「不占高度」。 */
        const PROPS = [['height', '0'], ['min-height', '0'], ['max-height', '0'],
            ['padding', '0'], ['margin', '0']];
        /* 「里面有没有画出东西」用 rect 判断：display:none 的子树 rect 全是 0，
           隐藏得再深也测得到 0 —— 比逐层读 computedStyle 便宜，也不会误判
           那些「本身不隐藏、只是里面空了」的包装层。 */
        const paintsSomething = (bar) => {
            let kids;
            try { kids = bar.querySelectorAll('*'); } catch (e) { return true; }
            const n = Math.min(kids.length, 400);
            for (let i = 0; i < n; i++) {
                let r;
                try { r = kids[i].getBoundingClientRect(); } catch (e) { continue; }
                if (r.width >= 4 && r.height >= 4) return true;
            }
            return false;
        };
        for (const bar of bars) {
            const hidden = !paintsSomething(bar);
            const collapsed = bar.getAttribute('data-gm-opcollapsed') === '1';
            if (hidden && !collapsed) {
                /* 记下它原本占多少高度：抖音会把「底部操作栏高度」缓存进控制条的
                   偏移里（710-88=622 就是那个 88），后面要用这个数去比对。 */
                let before = 0;
                try { before = Math.round(bar.getBoundingClientRect().height); } catch (e) {}
                if (before > 4) bar.setAttribute('data-gm-oph', String(before));
                bar.setAttribute('data-gm-opcollapsed', '1');
                for (const [k, v] of PROPS) { try { bar.style.setProperty(k, v, 'important'); } catch (e) {} }
                /* 播放器按容器尺寸算画面，容器一变高就催一次 resize 让它重算 */
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
                /* 折叠会把控制条顶到窗口外，立刻贴回底部；再补一拍兜住重渲染 */
                try { restoreControlBar(); } catch (e) {}
            } else if (!hidden && collapsed) {
                bar.removeAttribute('data-gm-opcollapsed');
                for (const [k] of PROPS) { try { bar.style.removeProperty(k); } catch (e) {} }
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            }
        }
    }

    /* v9.47：这里原本有一段「闭环校准」，想修控制条不贴窗口底的问题。
       实测证明它反而把 Edge 弄坏了 —— 诊断记下的接管是 `gap=-713`，
       说明接管发生在控制条还没渲染完的过渡态；接管后 left/right 归零让它
       变成整窗口宽，右侧就伸到聊天室底下被压住，而且 fixed 之后不再随
       播放器尺寸变化。Chrome 那个偏移是它自己的布局问题（关掉脚本也一样错），
       先等它自己修，不值得为它把正常的浏览器改坏。
       所以这段现在只做一件事：把以前被接管过的元素还原回抖音原生排版。 */
    let ctrlCalibNote = 'disabled';
    function restoreControlBar() {
        let list;
        try { list = document.querySelectorAll('[data-gm-barcalib]'); } catch (e) { return; }
        if (!list.length) return;
        for (const c of list) {
            c.removeAttribute('data-gm-barcalib');
            for (const k of ['position', 'left', 'right', 'top', 'bottom', 'z-index', 'width']) {
                try { c.style.removeProperty(k); } catch (e) {}
            }
        }
        ctrlCalibNote = 'restored ' + list.length;
    }

    const COMMON_TASKS = [
        ensureObserver,
        refreshSidebarRoot,
        clearSidebarStretch,
        fitSidebarHeight,
        restoreNativeSidebarWhenOff,
        syncSidebarHostState,
        syncNavBg,                 // v9.45：侧栏底板跟着抖音容器底色走
        checkUrlChange,
        liftSidebarOverlays,
        closePausePopupTask,
        applyCleanText,
        applyCleanPopup
    ];
    const WWW_TASKS = [
        applyVideoMaxQuality,
        keepPlaybackRate,
        highlightSearchWords,
        checkVideoFilter,
        checkFeedSkip
    ];
    const LIVE_TASKS = [
        applySearchCenter,
        applyDanmakuSettings,
        applyMaxQuality,
        applyCamDetach,
        keepPlaybackRate,          // 直播流自己会跳过（duration=Infinity）
        guardResumeAudio,
        hideLivePopupsTask,
        collapseEmptyOpBar,        // v9.47：礼物栏藏掉后，底部别留一块透明占位
        restoreControlBar,         // v9.47：把以前误接管的控制条还原回抖音原生排版
        /* v9.43：updateViewerCount / pollViewerCount 从这里挪走了 ——
           它们改由下面的专属定时器驱动（350ms / 1s），不再被 1.5s 主循环拖慢。 */
        muteGiftAudios
    ];

    /* v9.19：顺手记录每个任务的平均耗时（0.8 衰减），面板可一键复制，
       优化前后有数据可比，不用靠感觉。 */
    const taskCost = new Map();
    function timedTask(fn) {
        const name = fn.name || 'anon';
        const t0 = performance.now();
        safeRun(fn);
        const dt = performance.now() - t0;
        const prev = taskCost.get(name);
        taskCost.set(name, prev == null ? dt : prev * 0.8 + dt * 0.2);
    }
    function perfReport() {
        const rows = Array.from(taskCost.entries()).sort((a, b) => b[1] - a[1]);
        const sum = rows.reduce((s, r) => s + r[1], 0);
        const lines = ['# 抖音优化 · 任务耗时（人数任务 350ms/1s 一拍，其余 1.5s 一轮，衰减平均）',
            'url: ' + location.href,
            'live: ' + (isLiveHost || isLivePage()) + ' hidden: ' + document.hidden,
            'totalMs: ' + sum.toFixed(2)];
        for (const [name, ms] of rows) lines.push('  ' + ms.toFixed(2) + ' ms  ' + name);
        return lines.join('\n');
    }
    function dumpPerf() {
        copyText(perfReport());
        showTip('性能诊断已复制', 1600);
    }

    /* v9.47：布局诊断 —— 针对「底部多一条空白带 / 控制条不在最底部」这类纯几何问题。
       核心手段是 elementFromPoint：直接问浏览器「这个坐标上是谁在画」，
       再配一份顶层容器清单（谁多高、谁从多少像素开始），就能一眼看出
       那几十像素是谁占的 —— 比逐个猜选择器快得多。
       抖音里开控制台会断网，所以照旧走「复制到剪贴板」。 */
    function descEl(el) {
        if (!el) return 'null';
        if (el === document.documentElement) return '<html>';
        if (el === document.body) return '<body>';
        let s = '';
        try { s = el.tagName.toLowerCase(); } catch (e) { return '?'; }
        try { if (el.id) s += '#' + el.id; } catch (e) {}
        try {
            const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
            if (cls.length) s += '.' + cls.slice(0, 2).join('.');
        } catch (e) {}
        try {
            const e2e = el.getAttribute('data-e2e');
            if (e2e) s += '[e2e=' + e2e + ']';
        } catch (e) {}
        return s;
    }
    function rectOf(el) {
        try {
            const r = el.getBoundingClientRect();
            return [r.left, r.top, r.width, r.height].map(n => Math.round(n)).join(',');
        } catch (e) { return 'err'; }
    }
    function boxOf(el) {
        let bg = '?', disp = '?', pos = '?';
        try {
            const cs = window.getComputedStyle(el);
            bg = cs.backgroundColor;
            disp = cs.display;
            pos = cs.position;
        } catch (e) {}
        return 'rect=' + rectOf(el) + ' disp=' + disp + ' pos=' + pos + ' bg=' + bg;
    }
    function dumpLayout() {
        const L = [];
        const p = (s) => L.push(s);
        const vw = window.innerWidth, vh = window.innerHeight;
        p('# 抖音布局诊断（底部空白带 / 高度异常）');
        p('url: ' + location.href);
        p('host: ' + location.hostname + ' | live=' + (isLiveHost || isLivePage()));
        p('viewport: ' + vw + 'x' + vh + ' | dpr=' + (window.devicePixelRatio || 1) +
          ' | screen: ' + screen.width + 'x' + screen.height);
        try {
            p('html.class: ' + (document.documentElement.getAttribute('class') || '-'));
            const nb = window.getComputedStyle(document.documentElement)
                .getPropertyValue('--gm-nav-bg').trim();
            p('--gm-nav-bg: ' + (nb || '(未设置)'));
        } catch (e) {}
        p('fullscreenEl: ' + (document.fullscreenElement ? descEl(document.fullscreenElement) : 'null') +
          ' | webkit: ' + (document.webkitFullscreenElement ? descEl(document.webkitFullscreenElement) : 'null'));
        /* 100vh 实测值：和 innerHeight 不一致说明抖音/浏览器用的是旧的视口高度 */
        let vhPx = null;
        try {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:100vh;';
            (document.body || document.documentElement).appendChild(probe);
            vhPx = Math.round(probe.getBoundingClientRect().height);
            probe.remove();
        } catch (e) {}
        const de = document.documentElement, bd = document.body;
        p('docEl: ' + boxOf(de) + ' client=' + de.clientWidth + 'x' + de.clientHeight +
          ' scroll=' + de.scrollWidth + 'x' + de.scrollHeight);
        if (bd) p('body: ' + boxOf(bd) + ' scroll=' + bd.scrollWidth + 'x' + bd.scrollHeight);
        p('100vh: ' + (vhPx == null ? '(测不到)' : vhPx + 'px') +
          ' | innerHeight: ' + vh + 'px | 差: ' + (vhPx == null ? '?' : (vh - vhPx) + 'px'));

        p('');
        p('## 关键容器');
        const sels = [
            '#root', '#dark', '#douyin-header', '#douyin-right-container', '#douyin-navigation',
            '[data-e2e="living-container"]', '.living_player_container',
            '[data-e2e="living_player_container"]', '[class*="living_player"]',
            '[class*="player-container"]', '.xgplayer', '.xgplayer-container', '.douyin-player-controls',
            '#BottomLayout', '#GiftTrayLayout', '[data-e2e="gifts-container"]',
            'div[class*="OperatingBarPluginContainer"]',
            '[data-e2e="live-room-audience"]', 'video'
        ];
        for (const s of sels) {
            let el = null;
            try { el = document.querySelector(s); } catch (e) {}
            p('  ' + s + ': ' + (el ? boxOf(el) : '(无)'));
        }

        /* 顶层兄弟清单：底部那条带子最可能是某个「从 X 像素开始、高 Y」的兄弟撑出来的 */
        const roots = [];
        try { if (de.firstElementChild) roots.push(de.firstElementChild); } catch (e) {}
        const walkTop = (root, tag) => {
            if (!root) return;
            let kids = [];
            try { kids = Array.from(root.children).slice(0, 12); } catch (e) {}
            if (!kids.length) return;
            p('');
            p('## ' + tag + ' 的直接子元素（' + kids.length + ' 个，最多列 12）');
            for (const k of kids) p('  ' + k.tagName.toLowerCase() + ' ' + descEl(k) + ' ' + boxOf(k));
        };
        const rootEl = document.querySelector('#root') || document.querySelector('#dark');
        walkTop(rootEl, descEl(rootEl) || '#root');
        /* 底部操作栏：那 88px 平时是礼物栏 / 评论输入的位置，空着就是一块透明占位 */
        try {
            const opBar = document.querySelector('div[class*="OperatingBarPluginContainer"]');
            if (opBar) {
                p('');
                p('## 底部操作栏 ' + descEl(opBar) + ' ' + boxOf(opBar) +
                  ' | 子元素 ' + opBar.children.length + ' 个 | gm折叠=' +
                  (opBar.getAttribute('data-gm-opcollapsed') || 'no'));
                for (const kid of Array.from(opBar.children).slice(0, 10)) {
                    p('  ' + descEl(kid) + ' ' + boxOf(kid));
                }
            }
        } catch (e) {}
        try {
            const player = document.querySelector('[data-e2e="living-container"]') ||
                document.querySelector('[class*="living_player"]') ||
                document.querySelector('.xgplayer');
            if (player && player.parentElement) walkTop(player.parentElement, descEl(player.parentElement));
        } catch (e) {}

        p('');
        p('## 底部取样点（elementsFromPoint，整叠从上层到下层）');
        /* 用复数版：单数版只给最上层，而播放器上盖着点赞特效层，
           永远只会返回它，看不到下面真正排布的控件。 */
        const pts = [
            ['底边中点', vw / 2, vh - 3],
            ['底边偏左', 24, vh - 3],
            ['底边偏右', vw - 24, vh - 3],
            ['底上 45', vw / 2, vh - 45],
            ['底上 90', vw / 2, vh - 90],
            ['底上 130', vw / 2, vh - 130]
        ];
        for (const [name, x, y] of pts) {
            let stack = [];
            try { stack = document.elementsFromPoint(x, y) || []; } catch (e) {}
            p('  [' + name + ' ' + Math.round(x) + ',' + Math.round(y) + '] ' + stack.length + ' 层');
            for (const el of stack.slice(0, 8)) {
                p('    - ' + descEl(el) + ' ' + boxOf(el));
            }
            if (!stack.length) p('    (null)');
        }

        /* 底部那一排控件：按几何找出来，再挖它们用的偏移量。
           现在的情况是「操作栏已经收成 0 高，但控制条还停在离底 88px 的地方」——
           710 - 88 = 622，正好是原来操作栏的高度，说明抖音把这个高度缓存进了
           某个 bottom / CSS 变量里。下面三段就是去找那个 88 藏在哪。 */
        p('');
        p('## 底部控件（按几何定位：底上 30~150px 内的宽元素）');
        try {
            const cands = [];
            const all = document.querySelectorAll('div');
            const cap = Math.min(all.length, 9000);
            for (let i = 0; i < cap; i++) {
                const el = all[i];
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (r.width < 200 || r.height < 8 || r.height > 70) continue;
                const gap = vh - r.bottom;
                if (gap < 30 || gap > 150) continue;
                cands.push([gap, el, r]);
            }
            cands.sort((a, b) => a[0] - b[0]);
            if (!cands.length) p('  (没有符合条件的元素)');
            for (const [gap, el, r] of cands.slice(0, 8)) {
                let cs = null;
                try { cs = window.getComputedStyle(el); } catch (e) {}
                p('  距底 ' + Math.round(gap) + 'px  ' + descEl(el) + ' rect=' + rectOf(el) +
                  (cs ? ' | pos=' + cs.position + ' bottom=' + cs.bottom + ' top=' + cs.top +
                        ' bottomPx=' + cs.getPropertyValue('bottom') : ''));
                try {
                    const inline = (el.getAttribute('style') || '').slice(0, 140);
                    if (inline) p('      inline: ' + inline);
                } catch (e) {}
                let up = el.parentElement, d = 0;
                while (up && d++ < 3) {
                    let cs2 = null;
                    try { cs2 = window.getComputedStyle(up); } catch (e) {}
                    p('      ^ ' + descEl(up) + ' rect=' + rectOf(up) +
                        (cs2 ? ' pos=' + cs2.position + ' bottom=' + cs2.bottom : ''));
                    up = up.parentElement;
                }
            }
        } catch (e) {}

        /* CSS 变量里最可能藏那个 88：抖音常把「底部操作栏高度」挂在
           播放器容器上（如 --operating-bar-h: 88px），控制条用它做 bottom。 */
        p('');
        p('## 播放器祖先上的 CSS 变量（含数字的才列）');
        try {
            const seeds = [
                document.querySelector('.douyin-player-controls'),
                document.querySelector('#PlayerLayout'),
                document.querySelector('[class*="__livingPlayer__"]'),
                document.querySelector('[data-e2e="living-container"]'),
                document.querySelector('[data-e2e="LikeLayout"], #LikeLayout'),
                document.querySelector('div[class*="OperatingBarPluginContainer"]')
            ].filter(Boolean);
            const seen = new Set();
            for (const seed of seeds) {
                let el = seed, d = 0;
                while (el && d++ < 5 && !seen.has(el)) {
                    seen.add(el);
                    let cs = null;
                    try { cs = window.getComputedStyle(el); } catch (e) { break; }
                    const vars = [];
                    for (let i = 0; i < cs.length; i++) {
                        const name = cs[i];
                        if (name.slice(0, 2) !== '--') continue;
                        const v = (cs.getPropertyValue(name) || '').trim();
                        if (!/\d/.test(v) || /var\(/.test(v)) continue;
                        vars.push(name + ': ' + v);
                    }
                    if (vars.length) {
                        p('  ' + descEl(el) + ' (' + vars.length + ' 个)');
                        for (const v of vars.slice(0, 12)) p('    ' + v);
                    }
                    el = el.parentElement;
                }
            }
        } catch (e) {}

        /* 直接找「底部留了一大截偏移」的绝对定位元素：那个 88px 就在这类元素身上 */
        p('');
        p('## 用 bottom>30px 绝对定位的元素（播放器子树内）');
        try {
            const scope = document.querySelector('#PlayerLayout') ||
                document.querySelector('[class*="__livingPlayer__"]') ||
                document.querySelector('[data-e2e="living-container"]') || document.body;
            const all = scope.querySelectorAll('*');
            const cap = Math.min(all.length, 3000);
            let shown = 0;
            for (let i = 0; i < cap && shown < 12; i++) {
                const el = all[i];
                let cs = null;
                try { cs = window.getComputedStyle(el); } catch (e) { continue; }
                if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
                const b = parseFloat(cs.bottom);
                if (!(b > 30)) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 60) continue;
                shown++;
                p('  ' + descEl(el) + ' bottom=' + cs.bottom + ' rect=' + rectOf(el) +
                  ' | 距底 ' + Math.round(vh - r.bottom) + 'px | inline=' +
                  ((el.getAttribute('style') || '').slice(0, 90) || '-'));
            }
            if (!shown) p('  (没有：说明那个 88 不在 bottom 上)');
        } catch (e) {}

        /* 直接把控制条容器里的每一个后代摊开：谁离底多远、用什么定位 */
        p('');
        p('## .douyin-player-controls 实例');
        try {
            const ctls = document.querySelectorAll('.douyin-player-controls');
            p('  共有 ' + ctls.length + ' 个');
            let idx = 0;
            for (const ctl of ctls) {
                idx++;
                if (idx > 4) break;
                const kids = ctl.querySelectorAll('*');
                let sized = 0;
                for (const el of kids) {
                    let r; try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                    if (r.width >= 4 && r.height >= 4) sized++;
                    if (sized > 99) break;
                }
                p('  #' + idx + ' rect=' + rectOf(ctl) + ' 后代 ' + kids.length + ' 个，其中有尺寸 ' + sized +
                  ' 个 | shadowRoot=' + (ctl.shadowRoot ? '有' : '无') +
                  ' | 接管=' + (ctl.getAttribute('data-gm-barcalib') === '1' ? 'yes' : 'no') +
                  ' | inline bottom=' + (ctl.style.getPropertyValue('bottom') || '-') +
                  ' | 距窗口底=' + Math.round(vh - ctl.getBoundingClientRect().bottom));
                p('      校准状态: ' + (ctrlCalibNote || '-'));
                if (!sized) { p('      (整个子树没一个元素有尺寸 → 控制条没被真正渲染)'); continue; }
                for (const el of Array.from(kids)) {
                    const r = el.getBoundingClientRect();
                    if (r.width < 4 || r.height < 4) continue;
                    let cs = null;
                    try { cs = window.getComputedStyle(el); } catch (e) {}
                    p('    ' + descEl(el) + ' rect=' + [r.left, r.top, r.width, r.height].map(n => Math.round(n)).join(',') +
                      ' 距底 ' + Math.round(vh - r.bottom) +
                      (cs ? ' pos=' + cs.position + ' bottom=' + cs.bottom : ''));
                }
            }
        } catch (e) {}

        /* 影子 DOM：玩家 UI 有可能是塞在 shadow root 里的，普通查询看不到，
           但元素上的 shadowRoot 属性可以查到 */
        p('');
        p('## 播放器子树里的 shadowRoot');
        try {
            const scope2 = document.querySelector('#PlayerLayout') ||
                document.querySelector('[class*="__livingPlayer__"]') || document.body;
            const all2 = scope2.querySelectorAll('*');
            const cap2 = Math.min(all2.length, 4000);
            let n = 0;
            for (let i = 0; i < cap2 && n < 8; i++) {
                if (all2[i].shadowRoot) {
                    n++;
                    p('  ' + descEl(all2[i]) + ' rect=' + rectOf(all2[i]));
                }
            }
            if (!n) p('  (没有)');
        } catch (e) {}

        /* 老办法：按文案找（有的版本按钮上是文字，能直接看到它自己离底多远） */
        p('');
        p('## 底部控件（按文案定位）');
        try {
            const want = /^(原画|蓝光|超清|高清|标清|流畅|弹幕|清屏|连播|倍速|发送|说点什么|礼物)$/;
            const hits = [];
            const all = document.querySelectorAll('*');
            const cap = Math.min(all.length, 12000);
            for (let i = 0; i < cap && hits.length < 10; i++) {
                const el = all[i];
                if (el.childElementCount > 0) continue;
                const t = (el.textContent || '').replace(/\s+/g, '');
                if (!want.test(t)) continue;
                const r = el.getBoundingClientRect();
                if (!r.width && !r.height) continue;
                hits.push([t, el, r]);
            }
            if (!hits.length) p('  (没找到，可能文案不同)');
            for (const [t, el, r] of hits) {
                p('  "' + t + '" rect=' + [r.left, r.top, r.width, r.height].map(n => Math.round(n)).join(',') +
                  ' | 距底 ' + Math.round(vh - r.bottom) + 'px');
                let up = el.parentElement, d = 0;
                while (up && d++ < 5) {
                    let cs = null;
                    try { cs = window.getComputedStyle(up); } catch (e) {}
                    p('      ^ ' + descEl(up) + ' rect=' + rectOf(up) +
                        (cs ? ' pos=' + cs.position + ' bottom=' + cs.bottom + ' h=' + cs.height : ''));
                    up = up.parentElement;
                }
            }
        } catch (e) {}

        p('');
        p('## 悬停快照（控制条出现时的底部叠层）');
        try {
            if (!bottomSnap) p('  (还没抓到：先把鼠标在播放器底部晃两下，再点诊断)');
            else {
                p('  抓取时间: ' + bottomSnap.at + '，命中控件的采样 ' + bottomSnap.rows.length + ' 档（★ = 尺寸像真控件的）');
                let shown = 0;
                for (const row of bottomSnap.rows) {
                    if (shown >= 10) break;
                    shown++;
                    p('  [底上 ' + row.dy + 'px, x=' + Math.round((row.nx || 0.75) * 100) + '%]');
                    for (const it of row.list) p('    ' + (it.small ? '★ ' : '  ') + it.d + ' rect=' + it.r);
                }
                if (bottomSnap.texts && bottomSnap.texts.length) {
                    p('  —— 按文案定位到的控制条按钮 ——');
                    for (const it of bottomSnap.texts) {
                        p('  "' + it.t + '" rect=' + it.r);
                        for (const c of it.chain) p('      ^ ' + c);
                    }
                } else {
                    p('  (文案没扫到：鼠标要停在画面底部让控制条出现)');
                }
            }
        } catch (e) {}

        /* 兜底：整篇文档扫一遍「底部区域里的宽元素」。控制条万一挂在我们没猜到的
           容器里（或者根本不在播放器子树内），这一步也能把它捞出来。 */
        p('');
        p('## 全文档：底上 0~300px 内的宽元素（宽≥160、高 8~80）');
        try {
            const all = document.querySelectorAll('*');
            const cap = Math.min(all.length, 20000);
            const cands = [];
            for (let i = 0; i < cap; i++) {
                const el = all[i];
                if (el === document.documentElement || el === document.body) continue;
                let r;
                try { r = el.getBoundingClientRect(); } catch (e) { continue; }
                if (r.width < 160 || r.height < 8 || r.height > 80) continue;
                const gap = vh - r.bottom;
                if (gap < -40 || gap > 300) continue;
                cands.push([gap, el, r]);
            }
            cands.sort((a, b) => a[0] - b[0]);
            if (!cands.length) p('  (没有)');
            for (const [gap, el, r] of cands.slice(0, 14)) {
                let cs = null;
                try { cs = window.getComputedStyle(el); } catch (e) {}
                p('  距底 ' + Math.round(gap) + '  ' + descEl(el) + ' rect=' + rectOf(el) +
                  (cs ? ' pos=' + cs.position + ' z=' + cs.zIndex + ' vis=' + cs.visibility + ' op=' + cs.opacity : ''));
            }
        } catch (e) {}

        p('');
        p('## 全文档 shadowRoot 宿主（控制条可能渲染在影子树里）');
        try {
            const all3 = document.querySelectorAll('*');
            const cap3 = Math.min(all3.length, 20000);
            let n3 = 0;
            for (let i = 0; i < cap3 && n3 < 10; i++) {
                if (all3[i].shadowRoot) {
                    n3++;
                    p('  ' + descEl(all3[i]) + ' rect=' + rectOf(all3[i]));
                }
            }
            if (!n3) p('  (没有)');
        } catch (e) {}

        p('');
        p('## 我们自己的痕迹');
        try {
            p('  data-gm-real-count 节点: ' + document.querySelectorAll('[data-gm-real-count]').length);
            p('  gm 面板/提示: ' +
              (document.querySelector('#gm-settings-panel') ? 'panel 存在' : 'panel 无') + ' / ' +
              (document.querySelector('#gm-tip') ? 'tip 存在' : 'tip 无'));
            const stash = document.querySelectorAll('[data-gm-stash], [class*="gm-"]');
            p('  *gm-* 元素数: ' + stash.length);
        } catch (e) {}
        return L.join('\n');
    }
    function dumpLayoutToClip() {
        copyText(dumpLayout());
        showTip('布局诊断已复制', 1600);
    }

    /* v9.47：底部那排控件只在鼠标停在播放器上时才渲染 —— 一打开设置面板，
       鼠标就离开播放器，它们随即消失，任何「点按钮现量」的诊断都量不到。
       这里在鼠标移动时抓一份「底部叠层快照」，面板里的诊断直接打印这份快照。
       v9.47b：采样范围从「离底 24~96px」扩大到「16~256px，每 16px 一档」——
       之前只采到 96px，而实测图标行在离底 100~120px 那一带，正好漏掉了，
       所以总是抓不到真正在显示的那个元素。
       只在「这一拍确实命中播放器以外的东西」时才覆盖快照，避免记录一份
       “鼠标已经离开、控制条已隐藏”的空数据把好数据冲掉。 */
    const PLAYER_WRAPPER_RE = /LikeLayout|PPcGIai7|like-layer|LikeEffect|LivingPlayer|pip-anchor|gZxYAuQb|livingPlayer|PlayerLayout|BackgroundLayout|living-container|scroll_container/i;
    let bottomSnapAt = 0, bottomSnap = null;
    /* v9.47c：按 class 找控制条一直找错（抖音有两条实例、还有一条是 hidden），
       改成**按文案**定位：「原画 / 标清 / 弹幕 / 清屏」这些字只可能出现在控制条上。
       用 TreeWalker 走文本节点，比 elementFromPoint 可靠 —— 不依赖命中坐标。
       只在鼠标靠近画面底部时才扫，避免常态开销。 */
    const CTL_LABEL_RE = /^(原画|蓝光|超清|高清|标清|流畅|弹幕|清屏|连播|倍速|画质|字幕|静音)$/;
    function probeControlByText() {
        const out = [];
        try {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let node, guard = 0;
            while ((node = walker.nextNode()) && guard++ < 12000) {
                const t = (node.nodeValue || '').trim();
                if (!t || t.length > 6 || !CTL_LABEL_RE.test(t)) continue;
                const el = node.parentElement;
                if (!el) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) continue;
                const chain = [];
                let up = el, d = 0;
                while (up && d++ < 6) {
                    let cs = null;
                    try { cs = window.getComputedStyle(up); } catch (e) {}
                    chain.push(descEl(up) + ' rect=' + rectOf(up) +
                        (cs ? ' pos=' + cs.position + ' vis=' + cs.visibility + ' z=' + cs.zIndex : ''));
                    up = up.parentElement;
                }
                out.push({ t: t, r: rectOf(el), chain: chain });
                if (out.length >= 3) break;
            }
        } catch (e) {}
        return out;
    }
    document.addEventListener('mousemove', (e) => {
        if (!(isLiveHost || isLivePage())) return;
        const now = Date.now();
        if (now - bottomSnapAt < 800) return;
        bottomSnapAt = now;
        try {
            const vw = window.innerWidth, vh = window.innerHeight;
            const rows = [];
            let real = false;
            for (const nx of [0.1, 0.75]) {
                for (let dy = 16; dy <= 320; dy += 16) {
                    const stack = document.elementsFromPoint(Math.round(vw * nx), vh - dy) || [];
                    const list = [];
                    let rowReal = false;
                    /* v9.47d：之前只留 3 层，而最上层是铺满全屏的覆盖层（div.YsD6aIyy
                       这类），3 层被它和播放器外框占满，真正那排图标排在下面 —— 于是
                       永远看不到它。现在留 8 层，且用「尺寸明显小于视口」作为
                       『这是个真控件』的判据，而不是靠 class 名单去猜。 */
                    for (const el of stack) {
                        if (!el || el === document.documentElement || el === document.body) continue;
                        const tag = (el.id || '') + ' ' + (el.getAttribute ? (el.getAttribute('class') || '') : '');
                        if (/LikeLayout|PPcGIai7|like-layer|LikeEffect/i.test(tag)) continue;
                        let r; try { r = el.getBoundingClientRect(); } catch (err) { continue; }
                        const small = r.height > 4 && r.width > 4 &&
                            r.width < vw - 40 && r.height < vh - 40;
                        if (small) rowReal = true;
                        list.push({ d: descEl(el), r: rectOf(el), small: small });
                        if (list.length >= 8) break;
                    }
                    if (rowReal) { real = true; rows.push({ dy: dy, nx: nx, list: list }); }
                }
            }
            /* 鼠标在画面下半部分才会让控制条出现，这时顺手做一次文案扫描 */
            let texts = [];
            if (e.clientY > vh - 260) texts = probeControlByText();
            if (!real && !texts.length) return;    // 没有有效信息 → 保留上一份
            bottomSnap = { at: new Date().toLocaleTimeString(), rows: real ? rows : (bottomSnap ? bottomSnap.rows : []),
                texts: texts.length ? texts : (bottomSnap ? bottomSnap.texts : []) };
        } catch (err) {}
    }, { passive: true });

    setInterval(() => {
        if (document.hidden || !document.body) return;
        for (const fn of COMMON_TASKS) timedTask(fn);
        /* live 首页没有 living_player_container，光看 isLivePage() 会误判成
           www，把搜索框居中、弹幕设置这些 live 任务全跳过。 */
        for (const fn of ((isLiveHost || isLivePage()) ? LIVE_TASKS : WWW_TASKS)) timedTask(fn);
    }, 1500);

    /* v9.43：人数用自己的一套定时器。
       快通道 350ms：非直播页几乎零成本（两次 isLivePage 查询就返回）；
       逻辑本身还带 300ms 节流 + fiber 降频，读不到 room_store 时不会空转。 */
    setInterval(() => {
        if (document.hidden || !isLivePage()) return;
        timedTask(updateViewerCount);
    }, 350);
    /* 轮询 1s 一拍，真正的间隔由「设置里的秒数」决定（默认 2s）。 */
    setInterval(() => {
        if (document.hidden || !isLivePage()) return;
        timedTask(pollViewerCount);
    }, 1000);

    /* =====================================================================
     * 10. 设置面板：可自定义快捷键 / Esc 关闭 / 菜单命令桥接
     * ===================================================================== */
    window.addEventListener('keydown', (e) => {
        if (hotkeyCapturing) return;         // 让位给组合键捕获
        if (hotkeyMatches(e)) {
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
            e.preventDefault(); e.stopImmediatePropagation();
            togglePanel();
            return;
        }
        if (e.key === 'Escape' && settingsPanel && settingsPanel.classList.contains('show')) {
            e.preventDefault(); e.stopImmediatePropagation();
            closePanel();
            return;
        }
        /* 倍速快捷键（默认 Shift+1 / Shift+2，可在面板里改） */
        if (speedHotkeyMatch(e)) {
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
            const normal = specMatches(e, config.speedNormalHotkey);
            e.preventDefault(); e.stopImmediatePropagation();
            safeRun(() => applySpeed(normal ? 1 : config.speedAlt, true));
            return;
        }
        /* v9.41：倍速加 / 减一档（默认 Shift + = / Shift + -） */
        if (specMatches(e, config.speedUpHotkey) || specMatches(e, config.speedDownHotkey)) {
            const ae = document.activeElement;
            if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
            const up = specMatches(e, config.speedUpHotkey);
            e.preventDefault(); e.stopImmediatePropagation();
            safeRun(() => stepSpeed(up ? 1 : -1));
        }
    }, true);

    window.addEventListener('message', (e) => {
        if (e.source !== window) return;
        if (e.data && e.data.__dyOptAction === 'toggle-settings') togglePanel();
    });
    document.addEventListener('__dyOptToggleSettings', () => togglePanel());

    /* =====================================================================
     * 11. 设置面板（屏幕正中，无悬浮按钮）
     * ===================================================================== */
    const ROWS = [
        ['enableSidebar',     '侧边栏自动隐藏'],
        ['liveSidebar',       '直播间显示悬浮侧边栏'],
        ['liveCenterSearch',  'live 域名搜索框居中补偿'],
        ['videoMaxQuality',   '视频流默认最高画质'],
        ['liveMaxQuality',    '直播间默认最高画质'],
        ['detachCam',         '摄像头小窗独立浮出 (可拖动)'],
        ['pollViewerCount',   '主动轮询刷新在线人数'],
        ['enableGestures',    '鼠标手势 (长按/中键)'],
        ['hideEffects',       '屏蔽礼物特效与底部礼物栏'],
        ['skipAds',           '自动跳过广告视频'],
        ['skipLiveFeed',      '自动跳过推荐直播'],
        ['hideSwitchBtn',     '屏蔽切换播放↑↓按钮'],
        ['hideDownloadApp',   '屏蔽下载抖音精选'],
        ['hideLivePopups',    '屏蔽悬浮弹窗(展馆/送礼)'],
        ['danmakuSwitchOff',  '关掉福袋口令与送礼信息弹幕'],
        ['cleanAiDouyin',     '去掉「AI抖音」入口'],
        ['cleanListenDouyin', '去掉「听抖音」'],
        ['cleanTopClient',    '去掉顶部「客户端」'],
        ['cleanDiamond',      '去掉顶部「充钻石」'],
        ['cleanWallpaper',    '去掉顶部「壁纸」'],
        ['cleanCollectPopup', '去掉收藏弹窗'],
        ['cleanSharePopup',   '去掉分享弹窗'],
        ['hideGiftAudio',     '静默拦截礼物声音'],
        ['showViewerCount',   '显示真实在线人数'],
        ['highlightSearch',   '评论区可搜索词高亮'],
        ['autoClosePausePopup', '关闭无操作暂停提示'],
        ['wheelVolume',       '画面内滚轮调音量 (仅直播间)'],
        ['hoverVolumeWheel',  '接管原生音量滚轮 (全站固定步进)'],
        ['doubleFullScreen',  '双击画面 → Y 键网页全屏 (取代点赞)'],
        ['clickPause',        '单击画面 → 播放/暂停（视频流）'],
        ['clickPauseLive',    '单击画面 → 播放/暂停（直播间）'],
        ['speedSync',         '倍速写进抖音自己的倍速栏'],
        ['spacePause',        '空格键播放/暂停'],
        ['resumeAudio',       '防静音续播'],
        ['crossDomainSync',   '跨域名同步配置 (cookie)'],
        ['liquidGlass',       '液态玻璃面板']
    ];

    let settingsPanel = null;

    /* v9.38：液态玻璃 —— 只切一个 class，样式全在 CSS 里。
       指针在面板上移动时把坐标写进 --gm-gx / --gm-gy，做出会跟着手走的镜面反光。
       反光是 panel 自己的 background 层（不是绝对定位的覆盖层），
       滚动容器里的 background 钉在边框盒上、不随内容滚，所以坐标直接用
       相对面板的客户端坐标即可，不用加 scrollTop/scrollLeft —— 加了反而会偏。
       真透镜折射（liquidLens）：把 SDF 位移滤镜写进 --gm-lens-f 变量，
       backdrop-filter 从磨砂档整体切到滤镜档（D 样板同款，feColorMatrix
       抽单通道时必须保留 alpha 行，否则整帧透明＝看起来完全没效果）。 */
    let glassRaf = 0, glassX = 0, glassY = 0;

    function gmLensSupported() {
        const el = document.createElement('div');
        el.style.backdropFilter = 'url("#gm-probe")';
        return !!(el.style.backdropFilter && el.style.backdropFilter !== 'none');
    }

    /* ---- SDF 位移图：圆角矩形符号距离场，只有边缘一圈有梯度（D 样板 makeMap） ---- */
    function gmMakeLensMap(w, h, radius) {
        const SCALE = 52, EDGE = 0.30, K = 118;
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(w, h);
        const d = img.data;
        const bx = w / 2, by = h / 2;
        const r = Math.min(radius, bx, by);
        const thick = Math.max(8, Math.min(w, h) * EDGE);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const px = x - bx, py = y - by;
                const qx = Math.abs(px) - bx + r, qy = Math.abs(py) - by + r;
                const sd = Math.min(Math.max(qx, qy), 0) +
                    Math.sqrt(Math.max(qx, 0) * Math.max(qx, 0) + Math.max(qy, 0) * Math.max(qy, 0)) - r;
                let t = 1 - (-sd) / thick;
                t = Math.max(0, Math.min(1, t));
                t = t * t * (3 - 2 * t);
                t *= Math.max(0, Math.min(1, (-sd) / 2));
                const fx = bx > 0 ? px / bx : 0;
                const fy = by > 0 ? py / by : 0;
                const R = Math.round(128 - fx * t * K);
                const G = Math.round(128 - fy * t * K);
                const i = (y * w + x) * 4;
                d[i] = R < 0 ? 0 : R > 255 ? 255 : R;
                d[i + 1] = G < 0 ? 0 : G > 255 ? 255 : G;
                d[i + 2] = 0; d[i + 3] = 255;
            }
        }
        ctx.putImageData(img, 0, 0);
        return c.toDataURL();
    }

    /* ---- 透镜滤镜：中心轻模糊 → 三通道位移（色散）→ screen 叠回（D 样板 buildLens） ----
       性能要点（开面板慢半拍的根因）：
       1) 位移图（77KB data URL）按尺寸缓存，不再每次开面板重算/重编码；
       2) 滤镜 DOM 常驻，只在面板尺寸变化时才换 feImage 的 href/size，
          不再每次删节点重建（重建会让浏览器重新解码图 + 编译滤镜链）；
       3) 透镜档关掉入场缩放动画（CSS .gm-lens-on），避免整块面板每帧重跑滤镜。 */
    let gmLensKey = '';
    function gmBuildLensFilter(target) {
        const w = Math.max(4, Math.round(target.offsetWidth));
        const h = Math.max(4, Math.round(target.offsetHeight));
        if (w <= 4 || h <= 4) return false;
        const radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 30;
        const key = w + 'x' + h + '@' + radius;
        const id = 'gm-lens-filter';
        let filter = document.getElementById(id);

        if (filter && gmLensKey === key) {
            /* 命中缓存：只挂上变量，不碰 DOM、不解码图 */
            target.style.setProperty('--gm-lens-f', 'url(#' + id + ')');
            return true;
        }

        const SCALE = 52, CHROMA = 0.05, CENTER_BLUR = 3;
        const sR = SCALE * (1 + CHROMA), sG = SCALE, sB = SCALE * (1 - CHROMA);
        /* alpha 行必须是 0 0 0 1 0 —— 抽掉 alpha 整帧透明，滤镜就「没效果」了 */
        const keep = {
            R: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0',
            G: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0',
            B: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'
        };
        const NS = 'http://www.w3.org/2000/svg';
        const node = (name, attrs) => {
            const n = document.createElementNS(NS, name);
            for (const k in attrs) n.setAttribute(k, attrs[k]);
            return n;
        };
        if (filter) {
            /* 尺寸变了：原地更新 feImage，其余滤镜原语全部复用 */
            const mapImg = filter.querySelector('feImage');
            if (mapImg) {
                mapImg.setAttribute('width', String(w));
                mapImg.setAttribute('height', String(h));
                mapImg.setAttribute('href', gmMakeLensMap(w, h, radius));
            }
        } else {
            const disp = (scale, res) => node('feDisplacementMap', {
                in: 'blurred', in2: 'map', scale: String(scale),
                xChannelSelector: 'R', yChannelSelector: 'G', result: res
            });
            filter = node('filter', {
                /* 作用区必须收在元素框内：开 -25%/150% 时滤镜结果（尤其中心模糊
                   向外渗的几像素）会洇到边框外，透镜档沿边框外圈一圈模糊边。
                   位移采样全部向内取，缩小作用区不损失任何折射效果。 */
                id: id, x: '0%', y: '0%', width: '100%', height: '100%',
                'color-interpolation-filters': 'sRGB'
            });
            const mapImg = node('feImage', {
                x: '0', y: '0', width: String(w), height: String(h),
                preserveAspectRatio: 'none', result: 'map'
            });
            mapImg.setAttribute('href', gmMakeLensMap(w, h, radius));
            filter.appendChild(mapImg);
            filter.appendChild(node('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: String(CENTER_BLUR), result: 'blurred' }));
            filter.appendChild(disp(sR, 'dR')); filter.appendChild(disp(sG, 'dG')); filter.appendChild(disp(sB, 'dB'));
            filter.appendChild(node('feColorMatrix', { in: 'dR', type: 'matrix', values: keep.R, result: 'rOnly' }));
            filter.appendChild(node('feColorMatrix', { in: 'dG', type: 'matrix', values: keep.G, result: 'gOnly' }));
            filter.appendChild(node('feColorMatrix', { in: 'dB', type: 'matrix', values: keep.B, result: 'bOnly' }));
            filter.appendChild(node('feBlend', { in: 'rOnly', in2: 'gOnly', mode: 'screen', result: 'rg' }));
            filter.appendChild(node('feBlend', { in: 'rg', in2: 'bOnly', mode: 'screen' }));
            const svg = node('svg', { width: '0', height: '0', style: 'position:absolute' });
            svg.appendChild(filter);
            document.body.appendChild(svg);
        }
        gmLensKey = key;
        target.style.setProperty('--gm-lens-f', 'url(#' + id + ')');
        return true;
    }

    function applyPanelLens() {
        if (!settingsPanel) return;
        const on = !!(config.liquidGlass && config.liquidLens && gmLensSupported());
        settingsPanel.classList.toggle('gm-lens-on', on);
        if (!on) {
            settingsPanel.style.removeProperty('--gm-lens-f');
            return;
        }
        /* 面板 display:none 时量不到尺寸，等可见后再建 */
        if (!settingsPanel.offsetWidth) {
            requestAnimationFrame(applyPanelLens);
            return;
        }
        try { gmBuildLensFilter(settingsPanel); } catch (e) {
            settingsPanel.style.removeProperty('--gm-lens-f');
        }
    }

    function applyPanelGlass() {
        if (!settingsPanel) return;
        const on = !!config.liquidGlass;
        settingsPanel.classList.toggle('gm-glass', on);
        if (!on) {
            settingsPanel.classList.remove('gm-pressed', 'gm-lens-on');
            try {
                settingsPanel.style.removeProperty('--gm-lens-f');
                settingsPanel.style.removeProperty('--gm-gx');
                settingsPanel.style.removeProperty('--gm-gy');
            } catch (e) {}
            return;
        }
        applyPanelLens();
        if (settingsPanel.__gmGlassBound) return;
        settingsPanel.__gmGlassBound = true;
        settingsPanel.addEventListener('pointermove', (e) => {
            if (!config.liquidGlass) return;
            const r = settingsPanel.getBoundingClientRect();
            if (!r.width || !r.height) return;
            glassX = Math.round(e.clientX - r.left);
            glassY = Math.round(e.clientY - r.top);
            if (glassRaf) return;
            glassRaf = requestAnimationFrame(() => {
                glassRaf = 0;
                if (!settingsPanel) return;
                settingsPanel.style.setProperty('--gm-gx', glassX + 'px');
                settingsPanel.style.setProperty('--gm-gy', glassY + 'px');
            });
        }, { passive: true });
        settingsPanel.addEventListener('pointerleave', () => {
            try {
                settingsPanel.style.removeProperty('--gm-gx');
                settingsPanel.style.removeProperty('--gm-gy');
            } catch (e) {}
        });
        /* C 样板按压反馈：按住整块「鼓一下」，松手果冻回弹；glassPress 可独立关 */
        settingsPanel.addEventListener('pointerdown', () => {
            if (config.liquidGlass && config.glassPress) settingsPanel.classList.add('gm-pressed');
        });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => {
            settingsPanel.addEventListener(t, () => settingsPanel.classList.remove('gm-pressed'));
        });
    }

    function openPanel() {
        if (!settingsPanel) return;
        const sc = settingsPanel.querySelector('.gm-panel-scroll');
        if (sc) sc.scrollTop = 0;
        settingsPanel.classList.add('show');
        /* 先可见再挂玻璃：真透镜要量面板实际尺寸生成位移图 */
        applyPanelGlass();
        syncUI();
    }
    function closePanel() {
        if (hotkeyCapturing) {
            hotkeyCapturing = false;
            if (hotkeyInput) hotkeyInput.classList.remove('capturing');
        }
        if (settingsPanel) settingsPanel.classList.remove('show');
        syncUI();
    }
    function togglePanel() {
        if (!settingsPanel) return;
        if (settingsPanel.classList.contains('show')) closePanel();
        else openPanel();
    }

    function syncUI() {
        if (!settingsPanel) return;
        settingsPanel.querySelectorAll('[id^="cfg-"]').forEach(input => {
            const key = input.id.slice(4);
            if (input.tagName === 'SELECT') { input.value = config[key] || ''; return; }
            if (typeof config[key] === 'boolean') input.checked = config[key];
            else if (key === 'volumeStep') input.value = Math.round(config[key] * 100);
            else if (key === 'countPollSec') input.value = config[key];
        });
        const ta = settingsPanel.querySelector('#cfg-filterKeywords');
        if (ta && document.activeElement !== ta) ta.value = (config.filterKeywords || []).join('\n');
        const sel = settingsPanel.querySelector('#cfg-chatroomToggleSelector');
        if (sel && document.activeElement !== sel) sel.value = config.chatroomToggleSelector || '';
        const camSel = settingsPanel.querySelector('#cfg-camSelector');
        if (camSel && document.activeElement !== camSel) camSel.value = config.camSelector || '';
        if (hotkeyInput && !hotkeyCapturing) {
            hotkeyInput.value = hotkeyLabel(config.settingsHotkey);
            hotkeyInput.classList.remove('capturing');
        }
        for (const [sel, key] of [['#gm-hk-speed-normal', 'speedNormalHotkey'],
                                  ['#gm-hk-speed-alt', 'speedAltHotkey'],
                                  ['#gm-hk-speed-up', 'speedUpHotkey'],
                                  ['#gm-hk-speed-down', 'speedDownHotkey']]) {
            const el = settingsPanel.querySelector(sel);
            if (!el) continue;
            if (hotkeyCapturing && hotkeyInput === el) continue;
            el.value = hotkeyLabel(config[key]);
            el.classList.remove('capturing');
        }
        const hint = settingsPanel.querySelector('#gm-hint');
        if (hint) hint.textContent = hotkeyLabel(config.settingsHotkey) +
            ' 打开/关闭 · ' + hotkeyLabel(config.speedNormalHotkey) + ' 原速 · ' +
            hotkeyLabel(config.speedAltHotkey) + ' ' + fmtSpeed(config.speedAlt) +
            ' · ' + hotkeyLabel(config.speedUpHotkey) + '/' +
            hotkeyLabel(config.speedDownHotkey) + ' 加减速 · Esc 或点击面板外关闭';
    }

    function createSettingsUI() {
        const panel = document.createElement('div');
        panel.id = 'gm-settings-panel';

        const labelOf = (k) => {
            const hit = ROWS.find(r => r[0] === k);
            return hit ? hit[1] : k;
        };
        const rowOf = (key, extra) => `
            <div class="gm-setting-row">
                <span>${labelOf(key)}</span>
                <label class="gm-switch"><input type="checkbox" id="cfg-${key}" ${config[key] ? 'checked' : ''}><span class="gm-slider"></span></label>
            </div>${extra || ''}`;

        const sec = (title) => `<div class="gm-section">${title}</div>`;

        const sub = (label, inner) => `
            <div class="gm-sub-row"><span>${label}</span>${inner}</div>`;

        const actionSelect = (key) => `
            <select id="cfg-${key}" class="gm-select">
                <option value="next"${config[key] === 'next' ? ' selected' : ''}>只划走（能划回来看）</option>
                <option value="block"${config[key] === 'block' ? ' selected' : ''}>点「不感兴趣」（不再推荐）</option>
            </select>`;

        /* 视频流目标画质：就是抖音清晰度菜单里那几档。
           选 4K = 所有视频尽量 4K；选 1080P = 所有视频最高 1080P（网差时省点带宽），
           目标视频没有该档位时由抖音自己逐级下降。 */
        const qualityTargetSelect = () => `
            <select id="cfg-videoQualityTarget" class="gm-select">
                ${QUALITY_TARGETS.map(t =>
                    `<option value="${t[0]}"${config.videoQualityTarget === t[0] ? ' selected' : ''}>${t[1]}</option>`
                ).join('')}
            </select>`;

        /* v9.40：直播目标画质 —— 直播清晰度菜单里那五档，网差时可以压到高清/标清省带宽。
           选原画 = 老行为（能到原画就到原画）；选标清 = 所有直播间最高只到标清。
           房间没有这一档时，取它列表里不高于目标的最高档。 */
        const liveQualitySelect = () => `
            <select id="cfg-liveQualityTarget" class="gm-select">
                ${LIVE_QUALITY_TARGETS.map(t =>
                    `<option value="${t[0]}"${config.liveQualityTarget === t[0] ? ' selected' : ''}>${t[1]}</option>`
                ).join('')}
            </select>`;

        panel.innerHTML = `
            <h3><span>抖音网页版个人优化 <small>v9.47</small></span><span id="gm-panel-close" title="关闭">×</span></h3>
            <div class="gm-tabs" id="gm-tabs">
                <button type="button" class="gm-tab active" data-tab="main">常用</button>
                <button type="button" class="gm-tab" data-tab="clean">清理</button>
                <button type="button" class="gm-tab" data-tab="keys">快捷键</button>
                <button type="button" class="gm-tab" data-tab="adv">高级</button>
                <button type="button" class="gm-tab" data-tab="diag">诊断</button>
            </div>
            <div class="gm-panel-scroll">
                <div class="gm-hint" id="gm-hint"></div>

                <div class="gm-view" id="gm-view-main">
                    ${sec('画质')}
                    ${rowOf('videoMaxQuality', sub('目标画质上限', qualityTargetSelect()))}
                    ${rowOf('liveMaxQuality', sub('目标画质上限', liveQualitySelect()))}

                    ${sec('播放')}
                    ${sub('设定倍速', `<select id="cfg-speedAlt" class="gm-select">${
                        SPEED_STEPS.map(x => `<option value="${x}"${config.speedAlt === x ? ' selected' : ''}>${fmtSpeed(x)}</option>`).join('')
                    }</select>`)}
                    ${rowOf('speedSync')}
                    ${rowOf('clickPause')}
                    ${rowOf('doubleFullScreen')}

                    ${sec('跳过与过滤')}
                    ${rowOf('skipAds', sub('跳过方式', actionSelect('adSkipAction')))}
                    ${rowOf('skipLiveFeed', sub('跳过方式', actionSelect('liveSkipAction')))}
                    <div class="gm-setting-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                        <span>自定义黑名单（一行一个关键词，匹配标题或作者自动跳过）</span>
                        <textarea id="cfg-filterKeywords" class="gm-textarea" placeholder="一行一个关键词，例如：&#10;带货&#10;拼多多&#10;@王者荣耀"></textarea>
                        <div class="gm-sub-row" style="margin-left:0;">
                            <span>屏蔽方式</span>${actionSelect('filterSkipAction')}
                        </div>
                    </div>

                    ${sec('界面')}
                    ${rowOf('liquidGlass',
                        sub('真透镜折射',
                            `<label class="gm-switch"><input type="checkbox" id="cfg-liquidLens" ${config.liquidLens ? 'checked' : ''}><span class="gm-slider"></span></label>`) +
                        sub('按压反馈',
                            `<label class="gm-switch"><input type="checkbox" id="cfg-glassPress" ${config.glassPress ? 'checked' : ''}><span class="gm-slider"></span></label>`))}
                    ${rowOf('enableSidebar')}
                    ${rowOf('liveSidebar')}

                    ${sec('直播间')}
                    ${rowOf('showViewerCount')}
                    ${rowOf('detachCam')}
                </div>

                <div class="gm-view" id="gm-view-clean" style="display:none">
                    <div class="gm-hint">所有「去掉界面上某个东西」的开关都在这里。</div>

                    ${sec('按钮与入口')}
                    ${rowOf('cleanAiDouyin')}
                    ${rowOf('cleanListenDouyin')}
                    ${rowOf('cleanTopClient')}
                    ${rowOf('cleanDiamond')}
                    ${rowOf('cleanWallpaper')}
                    ${rowOf('hideSwitchBtn')}
                    ${rowOf('hideDownloadApp')}

                    ${sec('弹窗')}
                    ${rowOf('cleanCollectPopup')}
                    ${rowOf('cleanSharePopup')}
                    ${rowOf('hideLivePopups')}
                    <div class="gm-hint" style="margin-top:-2px;">收藏 / 分享只收掉点出来的面板，右侧工具栏的按钮本身保留。</div>

                    ${sec('特效与弹幕')}
                    ${rowOf('hideEffects')}
                    <div class="gm-hint" style="margin-top:-2px;">
                        第一项同时管「礼物 / 点赞特效」和「直播间底部那条礼物栏」——它们本来就是一套，
                        关掉它特效和礼物栏会一起回来。
                    </div>
                    ${rowOf('hideGiftAudio')}
                    ${rowOf('danmakuSwitchOff')}
                    <div class="gm-hint" style="margin-top:-2px;">
                        最后一项是直接去关抖音弹幕设置里的「送礼信息」和「福袋口令」两个开关，
                        直播间里刷屏的送礼 / 福袋口令就是这么没的；如果发现抢福袋入口也不见了，把它关掉即可。
                    </div>
                </div>

                <div class="gm-view" id="gm-view-keys" style="display:none">
                    <div class="gm-hint">点一下输入框，然后按下你想要的组合键即可改绑。</div>
                    <div class="gm-setting-row">
                        <span>设置面板</span>
                        <input type="text" id="gm-hotkey-input" class="gm-hk-input" readonly title="点击后按下你想要的组合键">
                    </div>
                    <div class="gm-setting-row">
                        <span>原速 (1.0x)</span>
                        <input type="text" id="gm-hk-speed-normal" class="gm-hk-input" readonly title="点击后按下你想要的组合键">
                    </div>
                    <div class="gm-setting-row">
                        <span>设定倍速</span>
                        <input type="text" id="gm-hk-speed-alt" class="gm-hk-input" readonly title="点击后按下你想要的组合键">
                    </div>
                    <div class="gm-setting-row">
                        <span>加速一档</span>
                        <input type="text" id="gm-hk-speed-up" class="gm-hk-input" readonly title="点击后按下你想要的组合键">
                    </div>
                    <div class="gm-setting-row">
                        <span>减速一档</span>
                        <input type="text" id="gm-hk-speed-down" class="gm-hk-input" readonly title="点击后按下你想要的组合键">
                    </div>
                    <div class="gm-hint" style="margin-top:8px;">
                        抖音自带 Z/C/G/F/X/V/P/R/N/B/J/K/Y/H/L/U、空格、↑↓、←→、Shift+= 音量，绑键时避开；选到它占用的组合会提示。
                    </div>
                </div>

                <div class="gm-view" id="gm-view-adv" style="display:none">
                    ${sec('播放与音量')}
                    ${rowOf('wheelVolume', sub('步进大小 (%)',
                        `<input type="number" id="cfg-volumeStep" class="gm-input" value="${Math.round(config.volumeStep * 100)}" min="1" max="20">`))}
                    ${rowOf('hoverVolumeWheel')}
                    ${rowOf('spacePause')}
                    ${rowOf('resumeAudio')}
                    ${rowOf('clickPauseLive')}

                    ${sec('直播间')}
                    ${rowOf('pollViewerCount', sub('轮询间隔 (秒)',
                        `<input type="number" id="cfg-countPollSec" class="gm-input" value="${config.countPollSec}" min="1" max="30">`))}
                    ${rowOf('liveCenterSearch')}
                    ${rowOf('autoClosePausePopup')}
                    <div class="gm-setting-row" style="flex-direction:column;align-items:stretch;gap:6px;margin-top:-6px;">
                        <span style="font-size:12px;color:#aaa;">摄像头小窗选择器（留空自动识别聊天室上方那块）</span>
                        <input type="text" id="cfg-camSelector" class="gm-sel-input" placeholder="留空 = 自动找聊天室上沿的摄像头画面">
                        <div style="display:flex;gap:8px;justify-content:flex-end;">
                            <button type="button" id="gm-cam-reset" class="gm-btn">位置复位</button>
                            <button type="button" id="gm-cam-dump" class="gm-btn">复制候选</button>
                        </div>
                    </div>

                    ${sec('其它')}
                    ${rowOf('enableGestures')}
                    ${rowOf('highlightSearch')}
                    ${rowOf('crossDomainSync')}
                </div>

                <div class="gm-view" id="gm-view-diag" style="display:none">
                    <div class="gm-setting-row" style="flex-direction:column;align-items:stretch;gap:6px;">
                        <span>聊天室收起/展开按钮选择器 (可留空)</span>
                        <input type="text" id="cfg-chatroomToggleSelector" class="gm-sel-input" placeholder="留空 = 自动命中顶栏 ≡→ 按钮">
                    </div>
                    <div class="gm-setting-row">
                        <span>复制聊天室顶栏 DOM</span>
                        <button type="button" id="gm-dump-dom" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制人数诊断</span>
                        <button type="button" id="gm-dump-count" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制消息过滤诊断 (含福袋图标排查)</span>
                        <button type="button" id="gm-dump-filter" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制弹幕开关诊断 (自动弹面板)</span>
                        <button type="button" id="gm-dump-danmaku" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制直播跳过诊断</span>
                        <button type="button" id="gm-dump-liveskip" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制画质诊断</span>
                        <button type="button" id="gm-dump-quality" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制倍速诊断</span>
                        <button type="button" id="gm-dump-speed" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制倍速菜单候选</span>
                        <button type="button" id="gm-dump-speedmenu" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制直播画质诊断</span>
                        <button type="button" id="gm-dump-livequality" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制性能诊断</span>
                        <button type="button" id="gm-dump-perf" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-setting-row">
                        <span>复制布局诊断 (底部空白/高度异常)</span>
                        <button type="button" id="gm-dump-layout" class="gm-btn">复制</button>
                    </div>
                    <div class="gm-hint" style="margin-top:10px;">
                        这些都是把结构化信息复制到剪贴板，贴给作者即可定位问题，不会改动任何设置。
                    </div>
                </div>
            </div>`;

        const scrollBox = panel.querySelector('.gm-panel-scroll');
        /* v9.42：设置面板改成「页签 + 分页」。
           五个页面（常用 / 清理 / 快捷键 / 高级 / 诊断）全部常驻 DOM，只切 display ——
           面板里那套 cfg-* 的 change 监听可以一次绑完，切页不重建、不丢焦点。 */
        const viewEls = {};
        panel.querySelectorAll('.gm-view').forEach(v => {
            viewEls[v.id.replace('gm-view-', '')] = v;
        });
        const showTab = (name) => {
            for (const k of Object.keys(viewEls))
                viewEls[k].style.display = (k === name) ? '' : 'none';
            panel.querySelectorAll('.gm-tab').forEach(b =>
                b.classList.toggle('active', b.dataset.tab === name));
            try { scrollBox.scrollTop = 0; } catch (e) {}
        };
        panel.querySelectorAll('.gm-tab').forEach(b => {
            b.addEventListener('click', () => showTab(b.dataset.tab));
        });
        showTab('main');

        const textarea = panel.querySelector('#cfg-filterKeywords');
        textarea.value = (config.filterKeywords || []).join('\n');
        textarea.placeholder = '一行一个关键词，例如：\n带货\n拼多多\n@王者荣耀';

        document.body.appendChild(panel);
        settingsPanel = panel;
        hotkeyInput = panel.querySelector('#gm-hotkey-input');
        applyPanelGlass();

        const VALID_KEYS = Object.keys(defaultConfig);
        panel.querySelectorAll('[id^="cfg-"]').forEach(input => {
            input.addEventListener('change', (e) => {
                const key = e.target.id.slice(4);
                if (VALID_KEYS.indexOf(key) < 0) return;
                if (e.target.tagName === 'SELECT') {
                    config[key] = e.target.value;
                    if (key === 'speedAlt') config[key] = Number(e.target.value);
                    /* 改了设定倍速：如果当前正处在「倍速」状态，立刻跟着变 */
                    if (key === 'speedAlt' && speedWanted !== 1) safeRun(() => applySpeed(config.speedAlt, false));
                } else if (e.target.type === 'checkbox') {
                    config[key] = e.target.checked;
                } else if (e.target.type === 'number') {
                    let val = parseFloat(e.target.value);
                    if (!Number.isFinite(val)) return;
                    if (key === 'countPollSec') {
                        val = Math.max(1, Math.min(30, Math.round(val)));
                        config[key] = val;
                    } else {
                        val = Math.max(1, Math.min(20, val));
                        config[key] = val / 100;
                    }
                    e.target.value = val;
                } else if (e.target.type === 'text') {
                    config[key] = e.target.value.trim().slice(0, 300);
                }
                saveConfig();
                if (key === 'liquidGlass' || key === 'liquidLens' || key === 'glassPress') {
                    applyPanelGlass();
                }
                /* v9.41：界面清理的开关变了，立刻重算样式与文案规则 */
                if (key.indexOf('clean') === 0) {
                    applyCleanStyle();
                    safeRun(applyCleanText);
                    safeRun(ensureCleanPopupObserver);
                    safeRun(applyCleanPopup);
                }
                if (key === 'enableSidebar' || key === 'liveSidebar' ||
                    key === 'liveCenterSearch' || key === 'liveMaxQuality') {
                    updateStyles();
                    syncSidebarHostState(true);
                }
                /* 换了目标画质 / 重开画质开关：把一溜状态全部复位，立刻按新目标再来一遍
                   （否则旧的 override / writes 计数会把新一轮挡住） */
                if (key === 'videoQualityTarget' || key === 'videoMaxQuality') {
                    vqApplied = false; vqUserOverridden = false; vqWrites = 0;
                    vqXgTries = 0; vqXgCooldown = 0; vqXgDone = false;
                    vqTplTryAt = 0; xgHoverAt = 0;
                    if (config.videoMaxQuality) safeRun(applyVideoMaxQuality);
                }
                /* v9.40：直播目标画质同理 —— qualityDone 不复位的话换了目标永远不会生效 */
                if (key === 'liveQualityTarget' || key === 'liveMaxQuality') {
                    qualityLastUrl = ''; qualityDone = false;
                    qualityDomTries = 0; qualityDomCooldown = 0;
                    qualityBurstUntil = 0; xgClarityStep = 0; xgHoverAt = 0;
                    if (config.liveMaxQuality && (isLiveHost || isLivePage())) {
                        safeRun(() => kickQualityBurst(6000));
                        safeRun(applyMaxQuality);
                    }
                }
            });
        });

        const dumpBtn = panel.querySelector('#gm-dump-dom');
        if (dumpBtn) dumpBtn.addEventListener('click', () => safeRun(dumpChatroomDOM));

        const countBtn = panel.querySelector('#gm-dump-count');
        if (countBtn) countBtn.addEventListener('click', () => safeRun(dumpViewerCount));

        const filterBtn = panel.querySelector('#gm-dump-filter');
        if (filterBtn) filterBtn.addEventListener('click', () => safeRun(dumpLiveFilter));
        const danmakuBtn = panel.querySelector('#gm-dump-danmaku');
        if (danmakuBtn) danmakuBtn.addEventListener('click', () => safeRun(dumpDanmakuSwitch));
        const liveSkipBtn = panel.querySelector('#gm-dump-liveskip');
        if (liveSkipBtn) liveSkipBtn.addEventListener('click', () => safeRun(() => {
            copyText(dumpLiveSkip());
            showTip('直播跳过诊断已复制', 1600);
        }));

        const qualityBtn = panel.querySelector('#gm-dump-quality');
        if (qualityBtn) qualityBtn.addEventListener('click', () => safeRun(dumpVideoQuality));

        const speedMenuBtn = panel.querySelector('#gm-dump-speedmenu');
        if (speedMenuBtn) speedMenuBtn.addEventListener('click', () => safeRun(dumpSpeedMenu));

        const speedBtn = panel.querySelector('#gm-dump-speed');
        if (speedBtn) speedBtn.addEventListener('click', () => {
            safeRun(dumpSpeedSync);
            showTip('倍速诊断已复制', 1600);
        });

        const liveQualityBtn = panel.querySelector('#gm-dump-livequality');
        if (liveQualityBtn) liveQualityBtn.addEventListener('click', () => safeRun(dumpLiveQuality));

        const perfBtn = panel.querySelector('#gm-dump-perf');
        if (perfBtn) perfBtn.addEventListener('click', () => safeRun(dumpPerf));

        const layoutBtn = panel.querySelector('#gm-dump-layout');
        if (layoutBtn) layoutBtn.addEventListener('click', () => safeRun(dumpLayoutToClip));

        const camResetBtn = panel.querySelector('#gm-cam-reset');
        if (camResetBtn) camResetBtn.addEventListener('click', () => safeRun(camResetPos));
        const camDumpBtn = panel.querySelector('#gm-cam-dump');
        if (camDumpBtn) camDumpBtn.addEventListener('click', () => safeRun(dumpCamBoxes));

        /* 快捷键捕获：点输入框 → 直接按组合键保存，Esc 取消。
           面板快捷键 / 原速 / 倍速共用一套捕获逻辑，靠 hotkeyTargetKey 区分。 */
        const HOTKEY_NAME = {
            settingsHotkey: '设置面板',
            speedNormalHotkey: '原速',
            speedAltHotkey: '倍速',
            speedUpHotkey: '加速一档',
            speedDownHotkey: '减速一档'
        };
        const bindHotkeyInput = (input, key) => {
            if (!input) return;
            input.addEventListener('click', () => {
                hotkeyCapturing = true;
                hotkeyInput = input;
                hotkeyTargetKey = key;
                input.classList.add('capturing');
                input.value = '按下组合键…';
            });
        };
        hotkeyInput = panel.querySelector('#gm-hotkey-input');
        bindHotkeyInput(hotkeyInput, 'settingsHotkey');
        bindHotkeyInput(panel.querySelector('#gm-hk-speed-normal'), 'speedNormalHotkey');
        bindHotkeyInput(panel.querySelector('#gm-hk-speed-alt'), 'speedAltHotkey');
        bindHotkeyInput(panel.querySelector('#gm-hk-speed-up'), 'speedUpHotkey');
        bindHotkeyInput(panel.querySelector('#gm-hk-speed-down'), 'speedDownHotkey');

        window.addEventListener('keydown', (e) => {
            if (!hotkeyCapturing) return;
            e.preventDefault(); e.stopImmediatePropagation();
            if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                hotkeyCapturing = false;
                if (hotkeyInput) hotkeyInput.classList.remove('capturing');
                syncUI();
                return;
            }
            const spec = specFromEvent(e);
            if (!spec) return;           // 只按了修饰键或不支持的键，继续等待
            /* 同一个组合键别同时绑两件事：撞了就提示，还留在捕获状态等下一个 */
            for (const k of Object.keys(HOTKEY_NAME)) {
                if (k === hotkeyTargetKey) continue;
                if (config[k] === spec) {
                    showTip('这个组合键已经是「' + HOTKEY_NAME[k] + '」了，换一个', 2000);
                    return;
                }
            }
            /* v9.41：撞上抖音自己的键位就提醒一句（仍然保存，用户自己决定） */
            const clash = douyinConflict(spec);
            config[hotkeyTargetKey] = spec;
            hotkeyCapturing = false;
            if (hotkeyInput) hotkeyInput.classList.remove('capturing');
            saveConfig();
            syncUI();
            if (clash) {
                showTip('已保存，但抖音自己也用 ' + hotkeyLabel(spec) + '（' + clash +
                    '），可能会同时触发，建议换一个', 3000);
            } else {
                showTip(HOTKEY_NAME[hotkeyTargetKey] + '快捷键已设为 ' + hotkeyLabel(spec), 1800);
            }
        }, true);

        let kwTimer = null;
        textarea.addEventListener('input', (e) => {
            config.filterKeywords = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
            clearTimeout(kwTimer);
            kwTimer = setTimeout(persistConfig, 300);
        });

        panel.querySelector('#gm-panel-close').addEventListener('click', closePanel);


        document.addEventListener('pointerdown', (e) => {
            if (!settingsPanel || !settingsPanel.classList.contains('show')) return;
            /* v9.37.3：只认真人点击。脚本自己派发的合成事件（倍速点档位、
               画质点菜单、面板开合、悬浮提权…）isTrusted 一律是 false，
               以前会被当成「点了面板外面」而把设置面板关掉 ——
               这就是「设置菜单自己关闭」的来源。 */
            if (e.isTrusted === false) return;
            if (e.target && typeof e.target.closest === 'function' &&
                e.target.closest('#gm-settings-panel')) return;
            if (!settingsPanel.contains(e.target)) closePanel();
        }, true);

        window.addEventListener('storage', (e) => {
            if (e.key !== CONFIG_KEY || !e.newValue) return;
            try {
                config = normalize(JSON.parse(e.newValue));
                updateStyles();
                updateSidebarFlag();
                syncSidebarHostState(true);
                syncUI();
            } catch (err) {}
        });

        syncUI();
    }

    if (document.body) createSettingsUI();
    else document.addEventListener('DOMContentLoaded', createSettingsUI, { once: true });

    /* =====================================================================
     * 12. 早期引导 + 菜单命令（若运行环境提供 GM_registerMenuCommand）
     * ===================================================================== */
    let bootstrapTimer = setInterval(() => {
        safeRun(() => {
            if (document.body) { ensureObserver(); refreshSidebarRoot(); clearSidebarStretch(); }
            if (sidebarRoot && observer) { clearInterval(bootstrapTimer); bootstrapTimer = null; }
        });
    }, 120);
    setTimeout(() => {
        if (bootstrapTimer) { clearInterval(bootstrapTimer); bootstrapTimer = null; }
    }, 10000);

    /* 首视频起播前就写入画质记忆（等 TASKS 首次执行已经晚于播放器读取） */
    safeRun(applyCleanStyle);
    safeRun(applyCleanText);
    safeRun(ensureCleanPopupObserver);
    safeRun(applyCleanPopup);
    safeRun(applyVideoMaxQuality);
    /* 直播画质：进房间立刻开一段爆发期，别等 1.5s 周期 */
    safeRun(() => { if (config.liveMaxQuality && (isLiveHost || isLivePage())) kickQualityBurst(8000); });
    /* 摄像头小窗：进房间就浮出来，不用等第一个 1.5s 周期 */
    safeRun(applyCamDetach);

    /* =====================================================================
     * 13. 给页面监听器加一道闸：「这一击已经被我们吃掉了」
     * =====================================================================
     * 双击全屏取代双击点赞这件事，光靠 stopImmediatePropagation 不一定压得住：
     * 抖音的点赞监听可能挂在别的节点上（portal 出去的点赞动画层、xgplayer 内部），
     * 也可能在同一个节点上注册得比我们更早。这里换方向 —— 不抢事件，而是在
     * 本脚本末尾把 EventTarget.addEventListener 包一层：页面注册的指针 / 点击
     * 回调进入时先问一句「这次事件是不是我们正在吃掉的那一击」，是就直接返回。
     *
     * 只包 6 种事件，且只在「双击被拦下」之后 600ms 内、且事件落在播放器上
     * 才拦；其它任何情况原样放行，等于零影响。
     * 必须放在本脚本所有自己的监听注册之后，否则会把自己也包进去。 */
    function gmGuardAllows(e) {
        if (!gmGuardUntil || Date.now() > gmGuardUntil) return true;
        const t = e && e.target;
        if (!(t instanceof Element)) return true;
        try {
            if (t.closest('#gm-settings-panel')) return true;
            if (isLayeredUi(t)) return true;
            if (insideShell(t)) return false;
            const v = findActiveVideo();
            if (v && pointInRect(e.clientX || 0, e.clientY || 0,
                                 v.getBoundingClientRect(), 24)) return false;
        } catch (err) { return true; }
        return true;
    }

    function installListenerGuard() {
        const proto = window.EventTarget && window.EventTarget.prototype;
        if (!proto || proto.__gmGuardInstalled) return;
        const nativeAdd = proto.addEventListener;
        const nativeRemove = proto.removeEventListener;
        if (typeof nativeAdd !== 'function' || typeof nativeRemove !== 'function') return;
        const TYPES = {
            pointerdown: 1, mousedown: 1, pointerup: 1, mouseup: 1, click: 1, dblclick: 1
        };
        const wrapperOf = new WeakMap();
        proto.addEventListener = function (type, handler, opts) {
            try {
                if (handler && typeof handler === 'function' && TYPES[type]) {
                    const cap = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
                    const key = type + '|' + (cap ? 1 : 0);
                    let m = wrapperOf.get(handler);
                    if (!m) { m = new Map(); wrapperOf.set(handler, m); }
                    let w = m.get(key);
                    if (!w) {
                        w = function (ev) {
                            try { if (!gmGuardAllows(ev)) return; } catch (err) {}
                            return handler.apply(this, arguments);
                        };
                        m.set(key, w);
                    }
                    return nativeAdd.call(this, type, w, opts);
                }
            } catch (err) {}
            return nativeAdd.call(this, type, handler, opts);
        };
        proto.removeEventListener = function (type, handler, opts) {
            try {
                if (handler && typeof handler === 'function' && TYPES[type]) {
                    const cap = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
                    const m = wrapperOf.get(handler);
                    const w = m && m.get(type + '|' + (cap ? 1 : 0));
                    if (w) return nativeRemove.call(this, type, w, opts);
                }
            } catch (err) {}
            return nativeRemove.call(this, type, handler, opts);
        };
        proto.__gmGuardInstalled = true;
    }
    safeRun(installListenerGuard);

    try {
        if (typeof GM_registerMenuCommand === 'function') {
            GM_registerMenuCommand('⚙️ 抖音优化 · 打开设置面板', () => togglePanel());
        }
    } catch (e) {}

})();
