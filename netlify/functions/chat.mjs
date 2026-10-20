/**
 * الخادم الخلفي للمساعد الذكي لجمعية مكنون.
 *
 * الاتصال بالذكاء الاصطناعي يمر عبر lib/ai.mjs على الخادم، لذلك المفتاح لا يصل إلى المتصفح أبدًا.
 * الإجابة تُبَثّ تدريجيًا (streaming) لتفادي مهلة Netlify ولتحسين التجربة.
 *
 * المسار: POST /api/chat
 */

import { FALLBACK_ANSWER } from './lib/prompt.mjs';
import { aiConfigured, streamCompletion, describeAIError } from './lib/ai.mjs';
import { knowledgeReady, buildMessages } from './lib/answer.mjs';
import { createRedactingStreamer } from './lib/redact.mjs';
import { getKnowledge } from './lib/knowledge-store.mjs';
import { checkRateLimit, visitorKey } from './lib/ratelimit.mjs';

export const config = { path: '/api/chat' };

/* ------------------------------------------------------------------ */
/* الإعدادات                                                           */
/* ------------------------------------------------------------------ */

const MAX_QUESTION_CHARS = Number(process.env.MAX_QUESTION_CHARS || 600);
const RATE_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 6);
const RATE_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY || 60);

const HISTORY_TURNS = 6; // عدد الرسائل السابقة التي تُمرَّر كسياق

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
  if (!aiConfigured()) {
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

  // 5) التأكد من وجود معرفة محمّلة (آخر تحديث من الدرايف)
  const knowledge = await getKnowledge();
  if (!knowledgeReady(knowledge)) {
    return errorResponse(503, 'مصادر المعرفة لم تُحمَّل بعد. يرجى التواصل مع الجمعية على الرقم الموحد 920011799.');
  }

  // 6) الاتصال بالذكاء الاصطناعي
  let stream;
  try {
    const messages = await buildMessages({ knowledge, history });
    stream = await streamCompletion(messages);
  } catch (e) {
    const { status, message } = describeAIError(e);
    return errorResponse(status, message);
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
          if (part.text) {
            produced += part.text.length;
            const safe = streamer.push(part.text);
            if (safe) send({ t: 'delta', v: safe });
          }
          if (part.truncated) {
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
        const { message } = describeAIError(e);
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
