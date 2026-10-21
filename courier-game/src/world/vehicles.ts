// Courier transport: arcade speeds (m/s), prices and the order distances each one gets offered.

export type VehicleId = 'foot' | 'bike' | 'scooter' | 'moped';

export interface Vehicle {
  id: VehicleId;
  name: string;
  icon: string;
  description: string;
  price: number;
  /** Top speed on roads, m/s. */
  maxSpeed: number;
  /** Acceleration, m/s². */
  accel: number;
  /** Speed multiplier off the road (grass, yards, beach). */
  offroad: number;
  /** Route length range of offered orders, metres. */
  orderRange: [number, number];
  /** Body colour for the renderer. */
  color: number;
}

export const VEHICLES: Vehicle[] = [
  {
    id: 'foot',
    name: 'Пешком',
    icon: '🏃',
    description: 'Бесплатно и везде пролезешь. Короткие заказы.',
    price: 0,
    maxSpeed: 6.5,
    accel: 14,
    offroad: 0.85,
    orderRange: [250, 900],
    color: 0x3b82f6,
  },
  {
    id: 'bike',
    name: 'Велосипед',
    icon: '🚲',
    description: 'Быстрее пешего, заказы подальше. По траве едет хуже.',
    price: 1500,
    maxSpeed: 10.5,
    accel: 9,
    offroad: 0.55,
    orderRange: [400, 1600],
    color: 0x22c55e,
  },
  {
    id: 'scooter',
    name: 'Электросамокат',
    icon: '🛴',
    description: 'Шустрый городской вариант. На бездорожье почти встаёт.',
    price: 4000,
    maxSpeed: 13.5,
    accel: 12,
    offroad: 0.4,
    orderRange: [600, 2400],
    color: 0xa855f7,
  },
  {
    id: 'moped',
    name: 'Мопед',
    icon: '🛵',
    description: 'Самый быстрый. Дальние заказы через весь город — и деньги больше.',
    price: 9000,
    maxSpeed: 17,
    accel: 10,
    offroad: 0.45,
    orderRange: [800, 3200],
    color: 0xef4444,
  },
];

export function vehicleById(id: string): Vehicle {
  return VEHICLES.find((v) => v.id === id) ?? VEHICLES[0];
}
