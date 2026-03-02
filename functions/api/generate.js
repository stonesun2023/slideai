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
        { role: 'system', content: system },
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