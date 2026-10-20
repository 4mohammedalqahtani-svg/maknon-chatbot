/**
 * توليد الرد على رسالة واتساب وإرساله — وظيفة خلفية.
 *
 * تطلقها whatsapp.mjs لكل رسالة واردة، برمز سري داخلي، ولا تُستدعى من الإنترنت.
 * تستخدم نفس المعرفة والتعليمات والضوابط التي يستخدمها الموقع.
 * السجل: Netlify ← Logs ← Functions ← whatsapp-reply
 */

import { FALLBACK_ANSWER } from './lib/prompt.mjs';
import { getKnowledge } from './lib/knowledge-store.mjs';
import { checkRateLimit } from './lib/ratelimit.mjs';
import { internalToken, sameToken } from './lib/refresh-auth.mjs';
import { aiConfigured, complete, describeAIError } from './lib/ai.mjs';
import { knowledgeReady, buildMessages } from './lib/answer.mjs';
import { redact } from './lib/redact.mjs';
import { sendText, toWhatsAppText } from './lib/whatsapp-api.mjs';
import { userKey, loadRecord, saveRecord } from './lib/whatsapp-history.mjs';

export const config = { path: '/api/whatsapp-reply', background: true };

const MAX_QUESTION_CHARS = Number(process.env.MAX_QUESTION_CHARS || 600);
const RATE_PER_MINUTE = Number(process.env.RATE_LIMIT_PER_MINUTE || 6);
const RATE_PER_DAY = Number(process.env.RATE_LIMIT_PER_DAY || 60);

// تعليمات خاصة بالواتساب، تُضاف بعد الجزء الثابت من التعليمات
const WHATSAPP_NOTE = `هذه المحادثة عبر الواتساب:
- اجعل الإجابة مختصرة قدر الإمكان مع بقائها كاملة، فالقراءة على شاشة الجوال.
- لا تستخدم الجداول ولا العناوين؛ استخدم أسطرًا قصيرة ونقاطًا وترقيمًا فقط.
- اكتب الروابط كاملة كما وردت.`;

const CONTACT_LINE = 'يمكنك التواصل مع الجمعية على الرقم الموحد 920011799.';

export default async function handler(req) {
  const expected = await internalToken('maknon-whatsapp-reply');
  if (!expected || !sameToken(req.headers.get('x-internal-token'), expected)) {
    console.log('[مرفوض] طلب بدون رمز داخلي صحيح.');
    return;
  }

  let msg;
  try {
    msg = await req.json();
  } catch {
    return;
  }
  if (!msg?.id || !msg?.from) return;

  const key = await userKey(msg.from);
  const record = await loadRecord(key);

  // ميتا قد تعيد إرسال نفس الرسالة — نعالجها مرة واحدة فقط
  if (record.seen.includes(msg.id)) return;
  record.seen.push(msg.id);
  await saveRecord(key, record);

  const reply = async (text) => {
    try {
      await sendText(msg.from, text);
    } catch (e) {
      console.error(`[خطأ] ${e.message}`);
    }
  };

  if (msg.type !== 'text' || !msg.text.trim()) {
    await reply(`أستقبل حاليًا الرسائل النصية فقط، فضلًا اكتب سؤالك نصًا. ${CONTACT_LINE}`);
    return;
  }

  const question = msg.text.trim();
  if (question.length > MAX_QUESTION_CHARS) {
    await reply(`سؤالك طويل جدًا. الحد الأقصى ${MAX_QUESTION_CHARS} حرفًا، ويمكنك تقسيمه إلى عدة أسئلة.`);
    return;
  }

  try {
    const rl = await checkRateLimit(`wa-${key}`, { perMinute: RATE_PER_MINUTE, perDay: RATE_PER_DAY });
    if (!rl.allowed) {
      await reply(
        rl.reason === 'minute'
          ? 'أرسلت عددًا كبيرًا من الرسائل بسرعة. يرجى الانتظار قليلًا ثم المحاولة مجددًا.'
          : `بلغت الحد اليومي المسموح من الأسئلة. يمكنك المتابعة غدًا، أو ${CONTACT_LINE}`
      );
      return;
    }
  } catch {
    /* لا نمنع الخدمة إذا تعطّل العدّاد */
  }

  if (!aiConfigured()) {
    await reply(`الخدمة غير مهيأة بعد. ${CONTACT_LINE}`);
    return;
  }

  const knowledge = await getKnowledge();
  if (!knowledgeReady(knowledge)) {
    await reply(`مصادر المعرفة لم تُحمَّل بعد. ${CONTACT_LINE}`);
    return;
  }

  const history = [...record.messages, { role: 'user', content: question }];

  let answer;
  try {
    const messages = await buildMessages({ knowledge, history, channelNote: WHATSAPP_NOTE });
    const result = await complete(messages);
    answer = redact(result.text.trim()) || FALLBACK_ANSWER;
    if (result.truncated) answer += '\n\n_(اختُصرت الإجابة لتجاوزها الحد المسموح.)_';
  } catch (e) {
    console.error('[خطأ] من مزوّد الذكاء الاصطناعي:', e?.message || e);
    await reply(describeAIError(e).message);
    return;
  }

  await reply(toWhatsAppText(answer));

  record.messages = [...history, { role: 'assistant', content: answer }];
  await saveRecord(key, record);
}
