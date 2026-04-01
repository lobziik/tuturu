/**
 * Mock chat messages for Session 4 UI development.
 * Deterministic data — no randomness — for reproducible testing.
 *
 * TODO(session-8): Remove this file when real chat integration is done.
 *
 * @module mock/mockMessages
 */

import type { ChatMessage } from '../../shared/schemas';

/** Device ID used for "self" messages in mock data */
export const MOCK_SELF_DEVICE_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
/** Display name for self in mock data */
export const MOCK_SELF_NICKNAME = 'Okarin';

const OTHER_DEVICE_ID = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const OTHER_NICKNAME = 'Mama';

/** Sequence counters per device for mock data */
let selfSeq = 0;
let otherSeq = 0;

function self(ts: number, text: string): ChatMessage {
  return {
    v: 1,
    deviceId: MOCK_SELF_DEVICE_ID,
    seq: ++selfSeq,
    uuid: `self-${String(selfSeq).padStart(4, '0')}`,
    sender: MOCK_SELF_NICKNAME,
    timestamp: ts,
    type: 'text',
    text,
  };
}

function other(ts: number, text: string): ChatMessage {
  return {
    v: 1,
    deviceId: OTHER_DEVICE_ID,
    seq: ++otherSeq,
    uuid: `other-${String(otherSeq).padStart(4, '0')}`,
    sender: OTHER_NICKNAME,
    timestamp: ts,
    type: 'text',
    text,
  };
}

function selfPhoto(ts: number, blobId: string, size: number): ChatMessage {
  return {
    v: 1,
    deviceId: MOCK_SELF_DEVICE_ID,
    seq: ++selfSeq,
    uuid: `self-${String(selfSeq).padStart(4, '0')}`,
    sender: MOCK_SELF_NICKNAME,
    timestamp: ts,
    type: 'photo',
    blobId,
    size,
  };
}

function otherPhoto(ts: number, blobId: string, size: number): ChatMessage {
  return {
    v: 1,
    deviceId: OTHER_DEVICE_ID,
    seq: ++otherSeq,
    uuid: `other-${String(otherSeq).padStart(4, '0')}`,
    sender: OTHER_NICKNAME,
    timestamp: ts,
    type: 'photo',
    blobId,
    size,
  };
}

/**
 * Generate 57 deterministic mock messages spanning 3 days.
 * Resets sequence counters on each call.
 */
export function generateMockMessages(): ChatMessage[] {
  selfSeq = 0;
  otherSeq = 0;

  // Base: 2 days ago at 10:00 AM local time
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 10, 0, 0).getTime();
  const day1 = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 30, 0).getTime();
  const day2 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0, 0).getTime();

  /** minutes → ms offset */
  const m = (min: number) => min * 60_000;

  return [
    // ===== Day 0 (2 days ago) — 15 messages =====
    other(day0, 'Привет! Как дела?'),
    self(day0 + m(2), 'Привет! Всё хорошо, работаю'),
    other(day0 + m(3), 'Что делаешь?'),
    self(day0 + m(5), 'Пишу код, как обычно 😄'),
    other(day0 + m(6), 'Опять допоздна сидишь?'),
    self(day0 + m(7), 'Нет нет, сегодня рано закончу'),
    other(day0 + m(8), 'Хорошо, не забывай про обед'),
    self(day0 + m(10), 'Уже поел! Спасибо что напомнила'),
    other(day0 + m(12), 'Молодец'),
    self(day0 + m(45), 'Кстати, завтра смогу позвонить вечером'),
    other(day0 + m(47), 'Отлично! Во сколько?'),
    self(day0 + m(48), 'Часов в 7 наверное'),
    other(day0 + m(49), 'Хорошо, буду ждать'),
    otherPhoto(day0 + m(120), 'blob-photo-001', 2_500_000),
    other(day0 + m(121), 'Посмотри какой закат сегодня!'),

    // ===== Day 1 (yesterday) — 22 messages =====
    other(day1, 'Доброе утро!'),
    self(day1 + m(15), 'Доброе! Как спалось?'),
    other(day1 + m(16), 'Хорошо, рано встала'),
    other(day1 + m(17), 'Сходила на рынок за овощами'),
    selfPhoto(day1 + m(20), 'blob-photo-002', 1_800_000),
    self(day1 + m(21), 'А я вот завтрак приготовил'),
    other(day1 + m(22), 'Выглядит вкусно!'),
    other(day1 + m(23), 'Ты научился готовить наконец-то 😊'),
    self(day1 + m(25), 'Стараюсь!'),
    self(day1 + m(180), 'Мам, а ты помнишь рецепт борща?'),
    other(day1 + m(185), 'Конечно помню'),
    other(day1 + m(186), 'Тебе нужны: свёкла, капуста, картошка, морковь, лук'),
    other(day1 + m(187), 'И обязательно томатная паста'),
    other(day1 + m(188), 'Могу потом подробно написать'),
    self(day1 + m(190), 'Да, напиши пожалуйста!'),
    other(
      day1 + m(240),
      'Вот подробный рецепт:\n1. Свёклу натереть на крупной тёрке\n2. Обжарить с томатной пастой\n3. Капусту нашинковать\n4. Картошку кубиками\n5. Варить всё вместе 40 минут',
    ),
    self(day1 + m(242), 'Спасибо огромное! Попробую в выходные'),
    other(day1 + m(243), 'Удачи! Если что — звони, подскажу'),
    self(day1 + m(360), 'Звоню через 10 минут, ок?'),
    other(day1 + m(361), 'Да, жду!'),
    self(day1 + m(400), 'Было здорово поговорить! Спасибо за рецепт'),
    other(day1 + m(401), 'Мне тоже! Звони почаще ❤️'),

    // ===== Day 2 (today) — 20 messages =====
    self(day2, 'Доброе утро! Уже на ногах?'),
    other(day2 + m(5), 'Да, давно встала'),
    other(day2 + m(6), 'Пью чай на балконе'),
    otherPhoto(day2 + m(7), 'blob-photo-003', 3_200_000),
    other(day2 + m(8), 'Вид с балкона утром'),
    self(day2 + m(10), 'Красота! У нас пасмурно'),
    other(day2 + m(12), 'Жаль, тут солнце'),
    self(day2 + m(60), 'Сделал борщ!'),
    selfPhoto(day2 + m(61), 'blob-photo-004', 2_100_000),
    other(day2 + m(63), 'О, молодец!!! Как на вкус?'),
    self(day2 + m(64), 'Вкусно, но не как у тебя конечно'),
    other(day2 + m(65), 'Это нормально, с первого раза идеально не бывает'),
    other(day2 + m(66), 'В следующий раз добавь чеснок в конце'),
    self(day2 + m(67), 'Записал, спасибо!'),
    self(day2 + m(120), 'Можем сегодня вечером созвониться?'),
    other(day2 + m(125), 'Давай! Часов в 8?'),
    self(day2 + m(126), 'Идеально'),
    other(day2 + m(127), 'Хочу показать что в саду выросло'),
    selfPhoto(day2 + m(180), 'blob-photo-005', 1_500_000),
    self(day2 + m(181), 'А пока посмотри на моего кота, спит опять'),
  ];
}
