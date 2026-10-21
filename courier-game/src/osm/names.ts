// Russian street-name abbreviations for compact labels: «улица Мосина» → «ул. Мосина».

const ABBREVIATIONS: [RegExp, string][] = [
  [/(^|\s)улица(\s|$)/i, '$1ул.$2'],
  [/(^|\s)проспект(\s|$)/i, '$1пр.$2'],
  [/(^|\s)переулок(\s|$)/i, '$1пер.$2'],
  [/(^|\s)шоссе(\s|$)/i, '$1ш.$2'],
  [/(^|\s)набережная(\s|$)/i, '$1наб.$2'],
  [/(^|\s)площадь(\s|$)/i, '$1пл.$2'],
  [/(^|\s)бульвар(\s|$)/i, '$1б-р$2'],
  [/(^|\s)проезд(\s|$)/i, '$1пр-д$2'],
  [/(^|\s)дорога(\s|$)/i, '$1дор.$2'],
  [/(^|\s)аллея(\s|$)/i, '$1ал.$2'],
  [/(^|\s)тупик(\s|$)/i, '$1туп.$2'],
];

export function shortStreetName(name: string): string {
  let s = name.trim().replace(/\s+/g, ' ');
  for (const [re, rep] of ABBREVIATIONS) s = s.replace(re, rep);
  // Put the street type first, as people say it: «Мосина ул.» → «ул. Мосина».
  const m = s.match(/^(.*\S)\s+(ул\.|пр\.|пер\.|ш\.|наб\.|пл\.|б-р|пр-д|дор\.|ал\.|туп\.)$/);
  if (m) s = `${m[2]} ${m[1]}`;
  return s;
}

export function formatAddress(street: string, house: string): string {
  return `${shortStreetName(street)}, ${house}`;
}
