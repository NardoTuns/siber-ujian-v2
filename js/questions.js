/**
 * SIBER-UJIAN — questions.js
 * Pengacakan soal/pilihan (sekali saja saat ujian dimulai) dan
 * penyusunan soal sesuai urutan yang tersimpan di attempt.
 * Paket terkunci dibuka di memori memakai kunci yang tersimpan di attempt.
 */
const Questions = (function () {
  'use strict';

  const LETTERS = ['A', 'B', 'C', 'D'];

  function randomInt(max) {
    const arr = new Uint32Array(1);
    const limit = Math.floor(0x100000000 / max) * max;
    let x;
    do {
      crypto.getRandomValues(arr);
      x = arr[0];
    } while (x >= limit);
    return x % max;
  }

  function shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  async function loadExamQuestions(examId) {
    const qs = await DB.getAllByIndex('questions', 'exam_id', examId);
    return qs.sort(function (a, b) { return a.number - b.number; });
  }

  function buildOrder(questions, randomQuestion, randomOption) {
    const ids = questions.map(function (q) { return q.question_id; });
    const optionOrders = {};
    questions.forEach(function (q) {
      optionOrders[q.question_id] = randomOption ? shuffle(LETTERS) : LETTERS.slice();
    });
    return {
      question_order: randomQuestion ? shuffle(ids) : ids,
      option_orders: optionOrders
    };
  }

  /** Menyusun soal untuk ditampilkan, mengikuti urutan yang tersimpan di attempt. */
  async function buildForAttempt(attempt) {
    const list = await loadExamQuestions(attempt.exam_id);
    const map = {};
    list.forEach(function (q) { map[q.question_id] = q; });

    let content = null;
    if (list.some(function (q) { return q.encrypted; })) {
      if (!attempt.content_key) throw new Error('Kunci soal tidak ada di catatan ujian.');
      const exam = await DB.get('exams', attempt.exam_id);
      content = await Token.decryptQuestions(exam, Token.b64ToBytes(attempt.content_key));
    }

    return attempt.question_order.map(function (qid, i) {
      const q = map[qid];
      if (!q) throw new Error('Soal ' + qid + ' tidak ditemukan di perangkat. Data ujian rusak.');
      const text = content ? content[qid] : { question: q.question, options: q.options };
      if (!text || !text.options) throw new Error('Teks soal ' + qid + ' tidak dapat dibuka.');

      const order = attempt.option_orders[qid];
      if (!Array.isArray(order) || order.length !== 4 ||
          LETTERS.some(function (L) { return order.indexOf(L) === -1; })) {
        throw new Error('Urutan pilihan soal ' + qid + ' rusak.');
      }
      return {
        question_id: qid,
        original_number: q.number,
        display_number: i + 1,
        question: text.question,
        image: q.has_image ? q.image : null,
        options: order.map(function (orig, idx) {
          return { display: LETTERS[idx], original: orig, text: text.options[orig] };
        })
      };
    });
  }

  return { LETTERS: LETTERS, buildOrder: buildOrder, buildForAttempt: buildForAttempt, loadExamQuestions: loadExamQuestions };
})();
