/**
 * الخادم الخلفي للمساعد الذكي لجمعية مكنون.
 *
 * كل الاتصال بـ OpenAI يحدث هنا، لذلك مفتاح API لا يصل إلى المتصفح أبدًا.
 * الإجابة تُبَثّ تدريجيًا (streaming) لتفادي مهلة Netlify ولتحسين التجربة.
 *
 * المسار: POST /api/chat
 */

import OpenAI from 'openai';
import { knowledge, buildStaticSystemPrompt, buildContextMessage, FALLBACK_ANSWER } from './lib/prompt.mjs';
import { checkRateLimit, visitorKey } from './lib/ratelimit.mjs';

export const config = { path: '/api/chat' };

/* ------------------------------------------------------------------ */
/* الإعدادات                                                           */
/* ------------------------------------------------------------------ */

const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
const EMBED_MODEL = knowledge.embedModel || 'text-embedding-3-small';
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';

const MAX_QUESTION_CHARS = Number(process.env.MAX_QUESTION_CHARS || 600);
const MAX_ANSWER_TOKENS = Number(process.env.MAX_ANSWER_TOKENS || 700);
const RATE_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 6);
const RATE_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY || 60);

const HISTORY_TURNS = 6; // عدد الرسائل السابقة التي تُمرَّر كسياق
const TOP_K = 6; // عدد المقاطع المستخرجة في وضع embeddings

/* ------------------------------------------------------------------ */
/* أدوات                                                               */
/* ------------------------------------------------------------------ */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function errorResponse(status, message, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), { status, headers: JSON_HEADERS });
}

/** هل الطلب قادم من نطاق موقعنا؟ */
function isAllowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return false;

  let originHost;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  // نفس نطاق الموقع الذي وصل إليه الطلب
  const requestHost = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '').toLowerCase();
  if (requestHost && originHost === requestHost) return true;

  // نطاقات Netlify الخاصة بالموقع
  for (const envUrl of [process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL]) {
    if (!envUrl) continue;
    try {
      if (new URL(envUrl).host.toLowerCase() === originHost) return true;
    } catch { /* تجاهل */ }
  }

  // نطاقات إضافية يحددها المسؤول
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  for (const e of extra) {
    try {
      if (new URL(e.includes('://') ? e : `https://${e}`).host.toLowerCase() === originHost) return true;
    } catch { /* تجاهل */ }
  }

  // التطوير المحلي
  const bare = originHost.split(':')[0];
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '[::1]') return true;

  return false;
}

/** ترجمة أخطاء OpenAI إلى رسائل عربية مفهومة */
function describeOpenAIError(err) {
  const status = err?.status || err?.response?.status;
  const code = err?.code || err?.error?.code || '';
  const raw = String(err?.message || '');

  if (code === 'insufficient_quota' || /quota|billing/i.test(raw)) {
    return { status: 503, message: 'نعتذر، الخدمة متوقفة مؤقتًا لأسباب فنية. يرجى التواصل مع الجمعية على الرقم الموحد 920011799.' };
  }
  if (status === 401 || status === 403) {
    return { status: 503, message: 'حدث خلل في إعدادات الخدمة. يرجى إبلاغ الجمعية أو المحاولة لاحقًا.' };
  }
  if (status === 429) {
    return { status: 429, message: 'الخدمة مزدحمة حاليًا. يرجى المحاولة بعد قليل.' };
  }
  if (status === 400 && /model/i.test(raw)) {
    return { status: 503, message: 'اسم النموذج المستخدم غير صحيح. يرجى مراجعة إعدادات الموقع.' };
  }
  if (status >= 500) {
    return { status: 502, message: 'تعذّر الوصول إلى خدمة الذكاء الاصطناعي حاليًا. يرجى المحاولة بعد قليل.' };
  }
  return { status: 500, message: 'حدث خطأ غير متوقع. يرجى المحاولة مرة أخرى.' };
}

/* ------------------------------------------------------------------ */
/* تنقية البيانات الشخصية من الإجابة (خط الدفاع الأخير)                */
/* ------------------------------------------------------------------ */

// الرقم الموحد للجمعية رقم معلَن ولا يُحجب
const PUBLIC_NUMBERS = /^9200\d{5}$/;

const REDACTIONS = [
  // بريد إلكتروني
  { re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g, mask: '[بريد محجوب]' },
  // آيبان سعودي
  { re: /\bSA\d{22}\b/gi, mask: '[رقم حساب محجوب]' },
  // جوال سعودي بصيغه المختلفة
  { re: /(?:\+?966|00966)5\d{8}|(?<!\d)05\d{8}(?!\d)/g, mask: '[رقم محجوب]' },
  // هوية أو سجل مدني (10 أرقام تبدأ بـ 1 أو 2)
  { re: /(?<!\d)[12]\d{9}(?!\d)/g, mask: '[رقم محجوب]' },
];

/** يحجب أنماط البيانات الشخصية من نص */
function redact(text) {
  let out = text;
  for (const { re, mask } of REDACTIONS) {
    out = out.replace(re, (m) => (PUBLIC_NUMBERS.test(m) ? m : mask));
  }
  return out;
}

/**
 * منقّي يعمل مع البثّ التدريجي.
 * يحتفظ بآخر جزء من النص حتى تكتمل الأنماط التي قد تنقسم بين دفعتين،
 * ولا يُخرج إلا حتى آخر مسافة بيضاء آمنة.
 */
function createRedactingStreamer() {
  const HOLD = 64; // عدد الأحرف المحجوزة احتياطًا
  let buffer = '';

  return {
    push(delta) {
      buffer += delta;
      if (buffer.length <= HOLD) return '';
      // نبحث عن آخر مسافة بيضاء قبل المنطقة المحجوزة حتى لا نقطع نمطًا
      const limit = buffer.length - HOLD;
      const match = /\s(?=\S*$)/.exec(buffer.slice(0, limit));
      const cut = match ? match.index + 1 : buffer.slice(0, limit).lastIndexOf(' ') + 1;
      if (cut <= 0) return '';
      const ready = buffer.slice(0, cut);
      buffer = buffer.slice(cut);
      return redact(ready);
    },
    flush() {
      const rest = buffer;
      buffer = '';
      return redact(rest);
    },
  };
}

/** بعض النماذج الحديثة لا تقبل temperature وتستخدم max_completion_tokens */
function isNewGenerationModel(model) {
  return /^(gpt-5|o[1-9])/i.test(model);
}

function buildModelParams(messages) {
  const base = { model: MODEL, messages, stream: true };
  if (isNewGenerationModel(MODEL)) {
    base.max_completion_tokens = MAX_ANSWER_TOKENS;
    if (REASONING_EFFORT) base.reasoning_effort = REASONING_EFFORT;
  } else {
    base.max_tokens = MAX_ANSWER_TOKENS;
    base.temperature = 0.2;
  }
  return base;
}

/** بحث بالمتجهات داخل ملف المعرفة (بدون قاعدة بيانات خارجية) */
async function retrievePassages(client, question) {
  if (knowledge.mode !== 'embed' || !knowledge.vectors.length) return [];

  const res = await client.embeddings.create({ model: EMBED_MODEL, input: question });
  const q = res.data[0].embedding;
  let norm = 0;
  for (const x of q) norm += x * x;
  norm = Math.sqrt(norm) || 1;

  const scored = knowledge.vectors.map((v, i) => {
    let dot = 0;
    for (let j = 0; j < v.length; j++) dot += v[j] * q[j];
    return { i, score: dot / norm };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .slice(0, TOP_K)
    .filter((s) => s.score > 0.15)
    .map((s) => knowledge.chunks[s.i]);
}

/* ------------------------------------------------------------------ */
/* المعالج الرئيسي                                                     */
/* ------------------------------------------------------------------ */

export default async function handler(req, context) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') {
    return errorResponse(405, 'طريقة الطلب غير مدعومة.');
  }

  // 1) رفض الطلبات القادمة من خارج نطاق الموقع
  if (!isAllowedOrigin(req)) {
    return errorResponse(403, 'هذه الخدمة متاحة من موقع جمعية مكنون فقط.');
  }

  // 2) التأكد من وجود المفتاح
  if (!process.env.OPENAI_API_KEY) {
    return errorResponse(503, 'الخدمة غير مهيأة بعد. يرجى التواصل مع الجمعية على الرقم الموحد 920011799.');
  }

  // 3) قراءة الطلب والتحقق منه
  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'صيغة الطلب غير صحيحة.');
  }

  const incoming = Array.isArray(body?.messages) ? body.messages : [];
  const history = incoming
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION_CHARS * 4) }));

  const last = history[history.length - 1];
  if (!last || last.role !== 'user') {
    return errorResponse(400, 'لم يصل أي سؤال. يرجى كتابة سؤالك.');
  }

  const question = last.content.trim();
  if (!question) {
    return errorResponse(400, 'يرجى كتابة سؤالك أولًا.');
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return errorResponse(400, `سؤالك طويل جدًا. الحد الأقصى ${MAX_QUESTION_CHARS} حرفًا، ويمكنك تقسيمه إلى عدة أسئلة.`);
  }

  // 4) تحديد معدّل الاستخدام
  const ip =
    context?.ip ||
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';

  try {
    const key = await visitorKey(ip, req.headers.get('user-agent') || '');
    const rl = await checkRateLimit(key, { perMinute: RATE_PER_MINUTE, perDay: RATE_PER_DAY });
    if (!rl.allowed) {
      const message =
        rl.reason === 'minute'
          ? `أرسلت عددًا كبيرًا من الرسائل بسرعة. يرجى الانتظار ${rl.retryAfterSeconds} ثانية ثم المحاولة مجددًا.`
          : 'بلغت الحد اليومي المسموح من الأسئلة. يمكنك المتابعة غدًا، أو التواصل مع الجمعية على الرقم الموحد 920011799.';
      return new Response(JSON.stringify({ error: message }), {
        status: 429,
        headers: { ...JSON_HEADERS, 'Retry-After': String(rl.retryAfterSeconds) },
      });
    }
  } catch {
    /* لا نمنع الخدمة إذا تعطّل العدّاد */
  }

  // 5) التأكد من وجود معرفة محمّلة
  if (!knowledge.builtAt || (knowledge.mode === 'full' ? !knowledge.docs.length : !knowledge.chunks.length)) {
    return errorResponse(503, 'مصادر المعرفة لم تُحمَّل بعد. يرجى التواصل مع الجمعية على الرقم الموحد 920011799.');
  }

  // 6) الاتصال بـ OpenAI
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1, timeout: 20000 });

  const messages = [{ role: 'system', content: buildStaticSystemPrompt() }];

  try {
    if (knowledge.mode === 'embed') {
      const passages = await retrievePassages(client, question);
      messages.push({ role: 'system', content: buildContextMessage(passages) });
    }
  } catch (e) {
    const { status, message } = describeOpenAIError(e);
    return errorResponse(status, message);
  }

  messages.push(...history);

  let stream;
  try {
    stream = await client.chat.completions.create(buildModelParams(messages));
  } catch (e) {
    // بعض النماذج لا تدعم reasoning_effort — نعيد المحاولة بدونه
    const raw = String(e?.message || '');
    if (e?.status === 400 && /reasoning_effort|max_completion_tokens|temperature/i.test(raw)) {
      try {
        const params = buildModelParams(messages);
        delete params.reasoning_effort;
        delete params.temperature;
        if (params.max_tokens == null && params.max_completion_tokens == null) {
          params.max_completion_tokens = MAX_ANSWER_TOKENS;
        }
        stream = await client.chat.completions.create(params);
      } catch (e2) {
        const { status, message } = describeOpenAIError(e2);
        return errorResponse(status, message);
      }
    } else {
      const { status, message } = describeOpenAIError(e);
      return errorResponse(status, message);
    }
  }

  // 7) بثّ الإجابة سطرًا سطرًا بصيغة NDJSON
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
      const streamer = createRedactingStreamer();
      let produced = 0;

      try {
        for await (const part of stream) {
          const delta = part?.choices?.[0]?.delta?.content;
          if (delta) {
            produced += delta.length;
            const safe = streamer.push(delta);
            if (safe) send({ t: 'delta', v: safe });
          }
          const reason = part?.choices?.[0]?.finish_reason;
          if (reason === 'length') {
            const tail = streamer.flush();
            if (tail) send({ t: 'delta', v: tail });
            send({ t: 'delta', v: '\n\n_(اختُصرت الإجابة لتجاوزها الحد المسموح.)_' });
          }
        }
        const tail = streamer.flush();
        if (tail) send({ t: 'delta', v: tail });
        if (!produced) send({ t: 'delta', v: FALLBACK_ANSWER });
        send({ t: 'done' });
      } catch (e) {
        const { message } = describeOpenAIError(e);
        send({ t: 'error', v: message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
