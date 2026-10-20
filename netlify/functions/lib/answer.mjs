// تجهيز رسائل النموذج لسؤال واحد — مشترك بين الموقع والواتساب.
//
// يجمع: تعليمات النظام الثابتة + المقاطع ذات الصلة (في وضع embeddings)
// + تعليمات القناة (إن وُجدت) + سجل المحادثة.

import { buildStaticSystemPrompt, buildContextMessage } from './prompt.mjs';
import { embed } from './ai.mjs';

const TOP_K = 6; // عدد المقاطع المستخرجة في وضع embeddings

/** هل المعرفة محمّلة وفيها محتوى؟ */
export function knowledgeReady(knowledge) {
  if (!knowledge?.builtAt) return false;
  return knowledge.mode === 'full' ? knowledge.docs.length > 0 : knowledge.chunks.length > 0;
}

/** بحث بالمتجهات داخل ملف المعرفة (بدون قاعدة بيانات خارجية) */
async function retrievePassages(knowledge, question) {
  if (knowledge.mode !== 'embed' || !knowledge.vectors.length) return [];

  const [q] = await embed([question], { model: knowledge.embedModel || undefined });
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

/**
 * يبني قائمة الرسائل المرسلة للنموذج.
 * history: رسائل { role: 'user' | 'assistant', content } آخرها سؤال المستخدم.
 * channelNote: تعليمات خاصة بالقناة (مثل تنسيق الواتساب)، تأتي بعد الجزء الثابت
 * حتى لا تُفسد التخزين المؤقت للمدخلات.
 * قد يرمي خطأ من المزوّد أثناء البحث بالمتجهات.
 */
export async function buildMessages({ knowledge, history, channelNote }) {
  const messages = [{ role: 'system', content: buildStaticSystemPrompt(knowledge) }];

  if (knowledge.mode === 'embed') {
    const question = history[history.length - 1].content;
    const passages = await retrievePassages(knowledge, question);
    messages.push({ role: 'system', content: buildContextMessage(passages) });
  }

  if (channelNote) messages.push({ role: 'system', content: channelNote });

  messages.push(...history);
  return messages;
}
