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
    const { model, systemPrompt, userPrompt, userApiKey } = body;
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
      result = await callClaude(systemPrompt, userPrompt, apiKey);
    } else {
      result = await callOpenAICompat(getModelConfig(model), systemPrompt, userPrompt, apiKey);
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