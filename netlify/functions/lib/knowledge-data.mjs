// ملف مُولَّد تلقائيًا بواسطة scripts/sync-drive.mjs — لا تُعدّله يدويًا.
//
// هذه نسخة مبدئية فارغة موجودة فقط حتى لا ينكسر المشروع قبل أول مزامنة.
// شغّل الأمر التالي لملئها من مجلد Google Drive:
//
//     npm run sync
//
// وعلى Netlify يحدث ذلك تلقائيًا في كل عملية بناء (Deploy).

export const knowledge = {
  mode: 'full',
  builtAt: null,
  stats: { files: 0, chars: 0, tokens: 0 },
  docs: [],
  chunks: [],
  vectors: [],
  embedModel: null,
};
