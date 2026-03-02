export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const body = await request.json();
    const { model, systemPrompt, userPrompt, userApiKey, style, lang } = body;
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    const monthKey = `quota:${clientIP}:${getMonthKey()}`;
    const usingUserKey = !!userApiKey;
    let apiKey = userApiKey;
    let quotaOk = true;

    if (!usingUserKey) {
      const freeTierModels = ['glm'];
      if (!freeTierModels.includes(model)) {
        return errorResponse('此模型需要您自己的 API Key', 403, corsHeaders);
      }
      const freeQuota = parseInt(env.FREE_QUOTA || '3');
      const used = parseInt(await env.QUOTA_KV?.get(monthKey) || '0');
      if (used >= freeQuota) {
        return errorResponse(
          `本月免费额度已用完（${freeQuota} 次），请填写您自己的 API Key 继续使用`,
          429, corsHeaders, { used, quota: freeQuota }
        );
      }
      quotaOk = true;
      if (model === 'glm') apiKey = env.GLM_KEY;
      if (!apiKey) {
        return errorResponse('平台 API Key 未配置，请联系管理员', 500, corsHeaders);
      }
    }

    let result;
    if (model === 'claude') {
      result = await callClaude(buildSystem(style, lang), userPrompt, apiKey);
    } else {
      result = await callOpenAICompat(getModelConfig(model), buildSystem(style, lang), userPrompt, apiKey);
    }

    if (!usingUserKey && quotaOk && env.QUOTA_KV) {
      const used = parseInt(await env.QUOTA_KV.get(monthKey) || '0');
      await env.QUOTA_KV.put(monthKey, String(used + 1), {
        expirationTtl: 60 * 60 * 24 * 35
      });
    }

    return new Response(JSON.stringify({ html: result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return errorResponse(err.message || '生成失败，请重试', 500, corsHeaders);
  }
}

async function callOpenAICompat(cfg, system, user, key) {
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8000,
      temperature: 0.7,
      messages: [
        { role: 'system', content: `你是专业网页演示文稿生成器。生成完整自包含的单个HTML文件，所有CSS和JS必须内联。

## 核心规则（不可违反）

1. 每张幻灯片高度精确为100vh/100dvh，禁止幻灯片内部任何滚动
2. 使用 scroll-snap-type: y mandatory 实现幻灯片切换
3. 支持键盘（↑↓/空格）、触摸滑动、鼠标滚轮导航
4. 所有字体大小必须使用 clamp() 响应式缩放
5. 右侧显示导航圆点，顶部显示进度条
6. 每张幻灯片内容进入时有动画（fade+slide up）

## 必须包含的基础CSS架构

\`\`\`css
html, body { height: 100%; overflow-x: hidden; }
html { scroll-snap-type: y mandatory; scroll-behavior: smooth; }

.slide {
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  scroll-snap-align: start;
  display: flex;
  flex-direction: column;
  position: relative;
}

.slide-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  max-height: 100%;
  overflow: hidden;
  padding: var(--slide-padding);
}

:root {
  --title-size: clamp(1.5rem, 5vw, 4rem);
  --h2-size: clamp(1.25rem, 3.5vw, 2.5rem);
  --h3-size: clamp(1rem, 2.5vw, 1.75rem);
  --body-size: clamp(0.75rem, 1.5vw, 1.125rem);
  --small-size: clamp(0.65rem, 1vw, 0.875rem);
  --slide-padding: clamp(1rem, 4vw, 4rem);
  --content-gap: clamp(0.5rem, 2vw, 2rem);
}

@media (max-height: 700px) {
  :root { --slide-padding: clamp(0.75rem, 3vw, 2rem); --title-size: clamp(1.25rem, 4.5vw, 2.5rem); }
}
@media (max-height: 600px) {
  :root { --slide-padding: clamp(0.5rem, 2.5vw, 1.5rem); --title-size: clamp(1.1rem, 4vw, 2rem); }
  .nav-dots, .keyboard-hint { display: none; }
}
\`\`\`

## 内容密度限制（必须遵守）

- 标题页：1个标题 + 1个副标题 + 可选tagline
- 内容页：1个标题 + 最多5个要点，每点1-2行
- 卡片网格：1个标题 + 最多6张卡片（2x3布局）
- 引言页：1句话引言 + 署名
- 超出限制必须拆分为多张幻灯片

## 入场动画（必须实现）

\`\`\`css
.reveal { opacity: 0; transform: translateY(30px); transition: opacity 0.6s ease, transform 0.6s ease; }
.visible .reveal { opacity: 1; transform: translateY(0); }
.reveal-delay-1 { transition-delay: 0.1s; }
.reveal-delay-2 { transition-delay: 0.2s; }
.reveal-delay-3 { transition-delay: 0.3s; }
\`\`\`

\`\`\`javascript
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => { if(e.isIntersecting) e.target.classList.add('visible'); });
}, { threshold: 0.3 });
document.querySelectorAll('.slide').forEach(s => observer.observe(s));
\`\`\`

## 导航系统（必须实现）

右侧固定圆点导航 + 顶部进度条 + 键盘/触摸支持：

\`\`\`javascript
// 键盘导航
document.addEventListener('keydown', e => {
  if(e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); navigateNext(); }
  if(e.key === 'ArrowUp') { e.preventDefault(); navigatePrev(); }
});
// 触摸滑动
let touchStart = 0;
document.addEventListener('touchstart', e => touchStart = e.touches[0].clientY);
document.addEventListener('touchend', e => {
  const diff = touchStart - e.changedTouches[0].clientY;
  if(Math.abs(diff) > 50) diff > 0 ? navigateNext() : navigatePrev();
});
\`\`\`

## 背景特效（根据风格选择一种）

Cinematic Dark（电影金调）:
- 背景 #0a0a0c，主题色 #c8a96e（金铜色）
- 字体：Cormorant Garamond（标题）+ DM Mono（正文）
- 背景加subtle grain texture + radial spotlight
- 慢速fade-in动画（1-1.5s）

Neon Cyber（霓虹赛博）:
- 背景纯黑，主题色 #00ffe0（青）+ #bf00ff（紫）
- 字体：Space Mono
- CSS grid背景线条 + neon glow box-shadow
- 文字scramble/glitch效果

Brutalist（大胆撞色）:
- 背景米白 #f0ebe1，撞色黑 + #ff2d00（红）
- 字体：Anton（超粗标题）+ 正文无衬线
- 粗边框 + 双栏不对称布局
- 快速、硬朗的transition

Swiss Modern（极简）:
- 背景纯白，黑色 + 极少红色点缀
- 字体：Helvetica/Arial + 严格网格
- 精准对齐，大量留白
- 极简subtle动画

Editorial（杂志）:
- 深灰背景，衬线大标题
- 强排版层次，黑白 + 单强调色
- Pull quotes，图文交错

Gradient Wave（渐变波浪）:
- 深蓝紫渐变背景
- 玻璃拟态卡片（backdrop-filter: blur）
- 圆角 + 柔和光晕
- 现代SaaS感

## 输出要求

- 直接输出完整HTML，不加任何解释文字
- 不使用markdown代码块包裹
- 代码要有注释，结构清晰
- 文件自包含，可直接在浏览器打开运行` },
        { role: 'user', content: user }
      ]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `AI API Error: ${res.status}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回了空响应');
  return content;
}

async function callClaude(system, user, key) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Claude API Error: ${res.status}`);
  }
  const data = await res.json();
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Claude 返回了空响应');
  return content;
}

function getModelConfig(model) {
  const configs = {
    glm:   { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    gpt4o: { baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
    grok:  { baseURL: 'https://api.x.ai/v1', model: 'grok-2-latest' },
  };
  const cfg = configs[model];
  if (!cfg) throw new Error(`不支持的模型: ${model}`);
  return cfg;
}

function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function errorResponse(message, status, corsHeaders, extra = {}) {
  return new Response(
    JSON.stringify({ error: message, ...extra }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

function buildSystem(style, lang) {
  const VIEWPORT_CSS = `
html, body { height: 100%; overflow-x: hidden; }
html { scroll-snap-type: y mandatory; scroll-behavior: smooth; }
.slide {
  width: 100vw; height: 100vh; height: 100dvh;
  overflow: hidden; scroll-snap-align: start;
  display: flex; flex-direction: column; position: relative;
}
.slide-content {
  flex: 1; display: flex; flex-direction: column;
  justify-content: center; max-height: 100%; overflow: hidden;
  padding: var(--slide-padding);
}
:root {
  --title-size: clamp(1.5rem, 5vw, 4rem);
  --h2-size: clamp(1.25rem, 3.5vw, 2.5rem);
  --h3-size: clamp(1rem, 2.5vw, 1.75rem);
  --body-size: clamp(0.75rem, 1.5vw, 1.125rem);
  --small-size: clamp(0.65rem, 1vw, 0.875rem);
  --slide-padding: clamp(1rem, 4vw, 4rem);
  --content-gap: clamp(0.5rem, 2vw, 2rem);
}
.card, .container { max-width: min(90vw, 1000px); max-height: min(80vh, 700px); }
img { max-width: 100%; max-height: min(50vh, 400px); object-fit: contain; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: clamp(0.5rem, 1.5vw, 1rem); }
@media (max-height: 700px) { :root { --slide-padding: clamp(0.75rem, 3vw, 2rem); --title-size: clamp(1.25rem, 4.5vw, 2.5rem); } }
@media (max-height: 600px) { :root { --slide-padding: clamp(0.5rem, 2.5vw, 1.5rem); --title-size: clamp(1.1rem, 4vw, 2rem); --body-size: clamp(0.7rem, 1.2vw, 0.95rem); } .nav-dots, .keyboard-hint, .decorative { display: none; } }
@media (max-height: 500px) { :root { --slide-padding: clamp(0.4rem, 2vw, 1rem); --title-size: clamp(1rem, 3.5vw, 1.5rem); } }
@media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.2s !important; } }
.reveal { opacity: 0; transform: translateY(28px); transition: opacity 0.8s cubic-bezier(0.16,1,0.3,1), transform 0.8s cubic-bezier(0.16,1,0.3,1); }
.reveal-left { opacity: 0; transform: translateX(-36px); transition: opacity 0.8s cubic-bezier(0.16,1,0.3,1), transform 0.8s cubic-bezier(0.16,1,0.3,1); }
.reveal-scale { opacity: 0; transform: scale(0.92); transition: opacity 0.8s cubic-bezier(0.16,1,0.3,1), transform 0.8s cubic-bezier(0.16,1,0.3,1); }
.slide.visible .reveal, .slide.visible .reveal-left, .slide.visible .reveal-scale { opacity: 1; transform: none; }
.delay-1 { transition-delay: 0.1s !important; } .delay-2 { transition-delay: 0.22s !important; } .delay-3 { transition-delay: 0.36s !important; } .delay-4 { transition-delay: 0.52s !important; } .delay-5 { transition-delay: 0.68s !important; }`;

  const NAV_JS = `
const slides = Array.from(document.querySelectorAll('.slide'));
const navRail = document.getElementById('navRail');
const progress = document.getElementById('progress');
const counter = document.getElementById('slideCounter');
const total = slides.length;
let current = 0;
slides.forEach((_, i) => {
  const dot = document.createElement('div');
  dot.className = 'nav-dot' + (i === 0 ? ' active' : '');
  dot.addEventListener('click', () => goTo(i));
  navRail.appendChild(dot);
});
function updateUI(idx) {
  current = idx;
  navRail.querySelectorAll('.nav-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
  if (progress) progress.style.width = (total > 1 ? (idx / (total - 1)) * 100 : 100) + '%';
  if (counter) counter.textContent = String(idx + 1).padStart(2,'0') + ' / ' + String(total).padStart(2,'0');
}
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => { if (entry.isIntersecting) { entry.target.classList.add('visible'); const idx = slides.indexOf(entry.target); if (idx !== -1) updateUI(idx); } });
}, { threshold: 0.5 });
slides.forEach(s => observer.observe(s));
function goTo(idx) { idx = Math.max(0, Math.min(total - 1, idx)); slides[idx].scrollIntoView({ behavior: 'smooth' }); }
document.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goTo(current + 1); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); goTo(current - 1); }
});
let touchY = 0;
document.addEventListener('touchstart', e => { touchY = e.touches[0].clientY; }, { passive: true });
document.addEventListener('touchend', e => { const dy = touchY - e.changedTouches[0].clientY; if (Math.abs(dy) > 40) goTo(current + (dy > 0 ? 1 : -1)); }, { passive: true });
updateUI(0); slides[0].classList.add('visible');`;

  const STYLES = {
    cinematic: {
      name: 'Cinematic Dark (电影金调)',
      fonts: `<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,600;1,300;1,600&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet">`,
      css: `:root { --bg: #0a0a0c; --gold: #c8a96e; --gold-dim: rgba(200,169,110,0.35); --gold-glow: rgba(200,169,110,0.12); --text: #f0ebe0; --muted: rgba(240,235,224,0.38); --border: rgba(240,235,224,0.07); --border-lg: rgba(240,235,224,0.12); }
body { background: var(--bg); color: var(--text); font-family: 'DM Mono', monospace; }
body::before { content: ''; position: fixed; inset: 0; opacity: 0.04; background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); pointer-events: none; z-index: 500; }
h1, h2, h3 { font-family: 'Cormorant Garamond', serif; font-weight: 300; letter-spacing: -1px; }
.accent { color: var(--gold); }
.eyebrow { font-size: var(--small-size); letter-spacing: 4px; text-transform: uppercase; color: var(--gold); }
.nav-rail { position: fixed; right: 28px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 10px; z-index: 1000; }
.nav-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--muted); cursor: pointer; transition: all 0.4s; }
.nav-dot.active { background: var(--gold); transform: scale(1.6); }
.progress-bar { position: fixed; top: 0; left: 0; height: 1px; background: linear-gradient(90deg, transparent, var(--gold), transparent); z-index: 1000; transition: width 0.4s ease; }
.slide-counter { position: fixed; bottom: 28px; right: 40px; font-size: 10px; letter-spacing: 3px; color: var(--muted); z-index: 1000; }`,
      layout: '三栏或双栏布局，竖排年份标注，大标题衬线字体，金色点缀，grain texture背景，每张幻灯片有独特的网格结构，避免千篇一律的居中布局'
    },
    neon: {
      name: 'Neon Cyber (霓虹赛博)',
      fonts: `<link href="https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">`,
      css: `:root { --bg: #0a0f1c; --cyan: #00ffcc; --magenta: #ff00aa; --text: #e0f0ff; --muted: rgba(224,240,255,0.4); --border: rgba(0,255,204,0.15); }
body { background: var(--bg); color: var(--text); font-family: 'Space Mono', monospace; }
body::before { content: ''; position: fixed; inset: 0; background-image: linear-gradient(rgba(0,255,204,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,255,204,0.03) 1px, transparent 1px); background-size: 50px 50px; pointer-events: none; z-index: 0; }
.glow { text-shadow: 0 0 20px var(--cyan), 0 0 40px var(--cyan); color: var(--cyan); }
.glow-box { box-shadow: 0 0 20px rgba(0,255,204,0.3), inset 0 0 20px rgba(0,255,204,0.05); border: 1px solid var(--cyan); }
.nav-rail { position: fixed; right: 28px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 10px; z-index: 1000; }
.nav-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--muted); cursor: pointer; transition: all 0.4s; }
.nav-dot.active { background: var(--cyan); box-shadow: 0 0 8px var(--cyan); transform: scale(1.6); }
.progress-bar { position: fixed; top: 0; left: 0; height: 1px; background: linear-gradient(90deg, var(--cyan), var(--magenta)); z-index: 1000; transition: width 0.4s; }
.slide-counter { position: fixed; bottom: 28px; right: 40px; font-size: 10px; letter-spacing: 3px; color: var(--muted); z-index: 1000; }`,
      layout: '全宽设计，网格线背景，霓虹发光文字和边框，大数字装饰，赛博朋克感，强对比'
    },
    brutalist: {
      name: 'Brutalist (大胆撞色)',
      fonts: `<link href="https://fonts.googleapis.com/css2?family=Anton&family=Space+Grotesk:wght@400;500;700&display=swap" rel="stylesheet">`,
      css: `:root { --bg: #f0ebe1; --black: #0a0a0a; --red: #ff2d00; --text: #0a0a0a; --muted: #666; }
body { background: var(--bg); color: var(--text); font-family: 'Space Grotesk', sans-serif; }
h1, h2, h3 { font-family: 'Anton', sans-serif; text-transform: uppercase; letter-spacing: -1px; }
.accent { color: var(--red); }
.border-box { border: 3px solid var(--black); }
.nav-rail { position: fixed; right: 0; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 0; z-index: 1000; }
.nav-dot { width: 8px; height: 32px; border-radius: 0; background: var(--muted); cursor: pointer; transition: all 0.2s; border-bottom: 1px solid var(--black); }
.nav-dot.active { background: var(--red); width: 12px; }
.progress-bar { position: fixed; top: 0; left: 0; height: 3px; background: var(--red); z-index: 1000; transition: width 0.3s; }
.slide-counter { position: fixed; bottom: 20px; left: 20px; font-family: 'Anton', sans-serif; font-size: 12px; letter-spacing: 3px; color: var(--muted); z-index: 1000; }`,
      layout: '不对称双栏，粗边框，超大字体，强烈撞色，原始感排版，数字装饰元素'
    },
    swiss: {
      name: 'Swiss Modern (极简现代)',
      fonts: `<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;700;800;900&family=Nunito:wght@300;400;600&display=swap" rel="stylesheet">`,
      css: `:root { --bg: #ffffff; --black: #0a0a0a; --red: #ff3300; --text: #0a0a0a; --muted: #888; --light: #f5f5f5; }
body { background: var(--bg); color: var(--text); font-family: 'Nunito', sans-serif; }
h1, h2, h3 { font-family: 'Archivo', sans-serif; font-weight: 900; }
.accent { color: var(--red); }
.grid-line { border-top: 1px solid rgba(0,0,0,0.1); }
.nav-rail { position: fixed; right: 28px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 10px; z-index: 1000; }
.nav-dot { width: 4px; height: 4px; border-radius: 0; background: var(--muted); cursor: pointer; transition: all 0.3s; }
.nav-dot.active { background: var(--red); transform: scale(2); }
.progress-bar { position: fixed; top: 0; left: 0; height: 2px; background: var(--black); z-index: 1000; transition: width 0.4s; }
.slide-counter { position: fixed; bottom: 28px; right: 40px; font-family: 'Archivo', sans-serif; font-size: 9px; letter-spacing: 4px; color: var(--muted); z-index: 1000; }`,
      layout: '严格网格对齐，大量留白，非对称布局，清晰层级，几何装饰元素，精准间距'
    },
    editorial: {
      name: 'Paper & Ink (杂志排版)',
      fonts: `<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,700;1,400;1,700&family=Source+Serif+4:ital,wght@0,300;0,400;1,300&display=swap" rel="stylesheet">`,
      css: `:root { --bg: #faf9f7; --black: #1a1a1a; --crimson: #c41e3a; --text: #1a1a1a; --muted: #666; --rule: rgba(26,26,26,0.15); }
body { background: var(--bg); color: var(--text); font-family: 'Source Serif 4', serif; }
h1, h2, h3 { font-family: 'Cormorant Garamond', serif; font-weight: 700; }
.accent { color: var(--crimson); font-style: italic; }
.rule { border-top: 1px solid var(--rule); }
.pull-quote { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: clamp(1.2rem, 3vw, 2rem); border-left: 3px solid var(--crimson); padding-left: 1.5rem; }
.nav-rail { position: fixed; right: 28px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 1000; }
.nav-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--muted); cursor: pointer; transition: all 0.3s; }
.nav-dot.active { background: var(--crimson); transform: scale(1.8); }
.progress-bar { position: fixed; top: 0; left: 0; height: 2px; background: var(--crimson); z-index: 1000; transition: width 0.4s; }
.slide-counter { position: fixed; bottom: 28px; right: 40px; font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 12px; color: var(--muted); z-index: 1000; }`,
      layout: '杂志排版，Drop cap首字母，pull quote引言，横线分割，图文交错，强烈排版层次'
    },
    gradient: {
      name: 'Gradient Wave (渐变波浪)',
      fonts: `<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;700;800&display=swap" rel="stylesheet">`,
      css: `:root { --bg: #0f0c29; --bg2: #302b63; --bg3: #24243e; --accent: #7c3aed; --blue: #3b82f6; --text: #f8fafc; --muted: rgba(248,250,252,0.5); --glass: rgba(255,255,255,0.05); --glass-border: rgba(255,255,255,0.1); }
body { background: linear-gradient(135deg, var(--bg) 0%, var(--bg2) 50%, var(--bg3) 100%); color: var(--text); font-family: 'Plus Jakarta Sans', sans-serif; }
.glass { background: var(--glass); backdrop-filter: blur(20px); border: 1px solid var(--glass-border); border-radius: 16px; }
.glow-accent { box-shadow: 0 0 40px rgba(124,58,237,0.3); }
.nav-rail { position: fixed; right: 28px; top: 50%; transform: translateY(-50%); display: flex; flex-direction: column; gap: 10px; z-index: 1000; }
.nav-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); cursor: pointer; transition: all 0.4s; }
.nav-dot.active { background: var(--accent); box-shadow: 0 0 10px var(--accent); transform: scale(1.5); }
.progress-bar { position: fixed; top: 0; left: 0; height:2px; background: linear-gradient(90deg, var(--accent), var(--blue)); z-index: 1000; transition: width 0.4s; }
.slide-counter { position: fixed; bottom: 28px; right: 40px; font-size: 10px; letter-spacing: 3px; color: var(--muted); z-index: 1000; }`,
      layout: '玻璃拟态卡片，渐变背景，圆角设计，柔和光晕，现代SaaS感，统计数字大字展示'
    }
  };

  const s = STYLES[style] || STYLES.cinematic;
  const langNote = lang === 'bilingual' ? '中英双语（中文为主，英文副标题/说明）' : lang === 'zh' ? '纯中文' : 'English only';

  return `你是顶级网页演示文稿生成器，专门创作令人惊叹的单文件HTML幻灯片。

## 当前风格：${s.name}

## 必须包含的字体
${s.fonts}

## 必须包含的风格CSS
${s.css}

## 必须包含的基础CSS架构（viewport约束，不可省略）
\`\`\`css
${VIEWPORT_CSS}
\`\`\`

## 布局原则：${s.layout}

## 必须包含的导航JS
在</body>前插入：
<div class="nav-rail" id="navRail"></div>
<div class="progress-bar" id="progress"></div>
<div class="slide-counter" id="slideCounter"></div>
<script>
(function() {
${NAV_JS}
})();
</script>

## 内容密度限制（不可违反）
- 标题页：1个标题 + 1个副标题 + 可选tagline，不超过3个元素
- 内容页：1个标题 + 最多5个要点，每点最多2行
- 卡片网格：1个标题 + 最多6张卡片（2x3或3x2布局）
- 引言页：1句引言（最多3行）+ 署名
- 超出限制必须拆分为多张幻灯片，绝不允许在幻灯片内滚动

## CSS关键规则
- 所有负值CSS函数必须用calc()：calc(-1 * clamp(...)) ✅，不能写 -clamp(...) ❌
- 所有字体大小必须用clamp()
- 所有间距尽量用clamp()或viewport单位

## 语言：${langNote}

## 输出要求
- 直接输出完整HTML文件，不加任何解释
- 不用markdown代码块包裹
- 代码有注释，结构清晰
- 文件自包含，可直接在浏览器运行
- 每张幻灯片的布局要有差异，避免重复感`;
}
