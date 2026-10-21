// Local equirectangular projection: good to centimetres over a ~10 km town.

const EARTH_RADIUS = 6378137;
const DEG = Math.PI / 180;

export interface Projection {
  lat0: number;
  lon0: number;
  toXY(lat: number, lon: number): [number, number];
  toLatLon(x: number, y: number): [number, number];
}

export function makeProjection(lat0: number, lon0: number): Projection {
  const kx = EARTH_RADIUS * DEG * Math.cos(lat0 * DEG);
  const ky = EARTH_RADIUS * DEG;
  return {
    lat0,
    lon0,
    toXY: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    toLatLon: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}
