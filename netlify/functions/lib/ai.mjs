// كل الاتصال بمزوّد الذكاء الاصطناعي يمر من هذا الملف فقط.
//
// الموقع (chat.mjs) والواتساب (whatsapp-reply.mjs) ومزامنة الدرايف (drive-sync.mjs)
// كلها تستدعي الدوال هنا، ولا يعرف أي منها اسم المزوّد.
//
// لتغيير النموذج داخل OpenAI: غيّر المتغير OPENAI_MODEL في إعدادات Netlify فقط.
// للانتقال إلى مزوّد آخر مستقبلًا (مثل Claude): أضف فرعًا جديدًا في هذا الملف
// يطبّق نفس الدوال الأربع (streamCompletion, complete, embed, describeAIError)
// واختره بالمتغير AI_PROVIDER. لا يلزم تعديل أي ملف آخر.
//
// تنبيه: نموذج الـ embeddings يجب أن يكون نفسه وقت بناء المعرفة ووقت السؤال.
// إن غيّرته فشغّل تحديث المعرفة (refresh-schedule ← Run now) ليُعاد حساب المتجهات.

import OpenAI from 'openai';

const PROVIDER = (process.env.AI_PROVIDER || 'openai').toLowerCase();

export const CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';
export const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || 'low';
const MAX_ANSWER_TOKENS = Number(process.env.MAX_ANSWER_TOKENS || 3000);

if (PROVIDER !== 'openai') {
  console.error(`[خطأ] المزوّد "${PROVIDER}" غير مدعوم بعد في lib/ai.mjs — سيُستخدم OpenAI.`);
}

/** هل مفتاح المزوّد موجود؟ */
export function aiConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

let client = null;
function getClient({ timeout = 20000 } = {}) {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 1, timeout });
  return client;
}

/* ------------------------------------------------------------------ */
/* المحادثة                                                            */
/* ------------------------------------------------------------------ */

/** بعض النماذج الحديثة لا تقبل temperature وتستخدم max_completion_tokens */
function isNewGenerationModel(model) {
  return /^(gpt-5|o[1-9])/i.test(model);
}

function buildModelParams(messages, stream) {
  const base = { model: CHAT_MODEL, messages, stream };
  if (isNewGenerationModel(CHAT_MODEL)) {
    base.max_completion_tokens = MAX_ANSWER_TOKENS;
    if (REASONING_EFFORT) base.reasoning_effort = REASONING_EFFORT;
  } else {
    base.max_tokens = MAX_ANSWER_TOKENS;
    base.temperature = 0.2;
  }
  return base;
}

async function createCompletion(messages, stream) {
  try {
    return await getClient().chat.completions.create(buildModelParams(messages, stream));
  } catch (e) {
    // بعض النماذج لا تدعم reasoning_effort — نعيد المحاولة بدونه
    const raw = String(e?.message || '');
    if (e?.status !== 400 || !/reasoning_effort|max_completion_tokens|temperature/i.test(raw)) throw e;
    const params = buildModelParams(messages, stream);
    delete params.reasoning_effort;
    delete params.temperature;
    if (params.max_tokens == null && params.max_completion_tokens == null) {
      params.max_completion_tokens = MAX_ANSWER_TOKENS;
    }
    return getClient().chat.completions.create(params);
  }
}

/**
 * يبدأ إجابة مبثوثة تدريجيًا.
 * أخطاء الاتصال الأولى تُرمى هنا (قبل بدء البث) ليُرد عليها برمز الحالة المناسب.
 * يعيد مولّدًا يُخرج { text } لكل دفعة، و{ truncated: true } إن قُطعت الإجابة لطولها.
 */
export async function streamCompletion(messages) {
  const stream = await createCompletion(messages, true);
  return (async function* () {
    for await (const part of stream) {
      const choice = part?.choices?.[0];
      if (choice?.delta?.content) yield { text: choice.delta.content };
      if (choice?.finish_reason === 'length') yield { truncated: true };
    }
  })();
}

/** إجابة كاملة دفعة واحدة (للواتساب). يعيد { text, truncated } */
export async function complete(messages) {
  const res = await createCompletion(messages, false);
  const choice = res?.choices?.[0];
  return { text: choice?.message?.content || '', truncated: choice?.finish_reason === 'length' };
}

/* ------------------------------------------------------------------ */
/* المتجهات (embeddings)                                               */
/* ------------------------------------------------------------------ */

/** يعيد متجهًا لكل نص في inputs (غير مُطبَّع) */
export async function embed(inputs, { model = EMBED_MODEL, apiKey } = {}) {
  const c = apiKey ? new OpenAI({ apiKey }) : getClient();
  const res = await c.embeddings.create({ model, input: inputs });
  return res.data.map((d) => d.embedding);
}

/* ------------------------------------------------------------------ */
/* الأخطاء                                                             */
/* ------------------------------------------------------------------ */

/** ترجمة أخطاء المزوّد إلى رسائل عربية مفهومة */
export function describeAIError(err) {
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
