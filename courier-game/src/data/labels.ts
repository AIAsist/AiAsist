import type { PoiKind } from './mapFormat';

/** Default names for pickup points that have no `name` in OSM. */
export const POI_LABELS: Record<PoiKind, string> = {
  restaurant: 'Ресторан',
  cafe: 'Кафе',
  fast_food: 'Фастфуд',
  pizza: 'Пиццерия',
  supermarket: 'Супермаркет',
  grocery: 'Продукты',
  bakery: 'Пекарня',
  pharmacy: 'Аптека',
  flowers: 'Цветы',
  shop: 'Магазин',
};

export const POI_ICONS: Record<PoiKind, string> = {
  restaurant: '🍽️',
  cafe: '☕',
  fast_food: '🍔',
  pizza: '🍕',
  supermarket: '🛒',
  grocery: '🥖',
  bakery: '🥐',
  pharmacy: '💊',
  flowers: '💐',
  shop: '🛍️',
};

/** What the customer ordered, per pickup kind (purely flavour text). */
export const CARGO: Record<PoiKind, string[]> = {
  restaurant: ['бизнес-ланч', 'ужин на двоих', 'суп и салат', 'горячее'],
  cafe: ['кофе и круассан', 'капучино ×2', 'десерты', 'завтрак'],
  fast_food: ['шаурма', 'бургер-комбо', 'хот-доги', 'картошка фри'],
  pizza: ['пицца «Маргарита»', 'две пиццы', 'пицца и кола', 'кальцоне'],
  supermarket: ['пакет продуктов', 'вода 6 л', 'продукты на неделю', 'молоко и хлеб'],
  grocery: ['хлеб и молоко', 'овощи', 'фрукты', 'сыр и колбаса'],
  bakery: ['свежий хлеб', 'пирожки', 'торт', 'булочки'],
  pharmacy: ['лекарства', 'витамины', 'пластырь и бинт', 'сироп от кашля'],
  flowers: ['букет роз', 'тюльпаны', 'цветы в коробке', 'букет ромашек'],
  shop: ['посылка', 'коробка', 'подарок', 'пакет'],
};
