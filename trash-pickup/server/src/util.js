import { HttpError } from './http.js';

export const now = () => new Date().toISOString();

/** Локальная дата сервера в формате YYYY-MM-DD (часовой пояс задаётся через TZ). */
export const localDate = (d = new Date()) => d.toLocaleDateString('sv-SE');

export const addDays = (dateStr, days) => {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return localDate(d);
};

/** Временные окна выноса. */
export const SLOTS = ['08:00-10:00', '10:00-12:00', '12:00-14:00', '14:00-16:00', '16:00-18:00', '18:00-20:00', '20:00-22:00'];

/** На сколько дней вперёд можно заказать. */
export const BOOKING_DAYS = 7;

export function str(value, field, { required = true, max = 200 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw new HttpError(400, `Не заполнено поле «${field}»`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) throw new HttpError(400, `Поле «${field}» слишком длинное`);
  return s;
}

export function int(value, field, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new HttpError(400, `Не заполнено поле «${field}»`);
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Некорректное значение поля «${field}»`);
  return n;
}

export function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  const normalized = digits.length === 11 && digits.startsWith('8') ? '7' + digits.slice(1) : digits;
  if (normalized.length !== 11 || !normalized.startsWith('7')) throw new HttpError(400, 'Телефон должен быть в формате +7XXXXXXXXXX');
  return '+' + normalized;
}

/** Стоимость заказа и выплата курьеру по тарифу. */
export function calcPrice(tariff, bags) {
  const extra = Math.max(0, bags - tariff.included_bags);
  return {
    price: tariff.price + extra * tariff.extra_bag_price,
    courier_fee: tariff.courier_fee + extra * tariff.extra_bag_fee,
  };
}
