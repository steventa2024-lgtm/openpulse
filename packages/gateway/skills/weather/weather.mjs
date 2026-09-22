// Usage: node weather.mjs "<place>" [--imperial]
const args = process.argv.slice(2);
const imperial = args.includes('--imperial');
const location = args
  .filter((a) => !a.startsWith('--'))
  .join(' ')
  .trim();
if (!location) {
  console.error('Usage: node weather.mjs "<place>" [--imperial]');
  process.exit(2);
}

const CODES = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'rime fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'heavy freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'light showers',
  81: 'showers',
  82: 'violent showers',
  85: 'snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with hail',
  99: 'severe thunderstorm with hail',
};

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const geo = await getJson(
  `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=${encodeURIComponent(location)}`,
);
const place = geo.results?.[0];
if (!place) {
  console.error(`No place found matching "${location}".`);
  process.exit(1);
}

const params = new URLSearchParams({
  latitude: String(place.latitude),
  longitude: String(place.longitude),
  current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
  daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  timezone: 'auto',
  forecast_days: '3',
  ...(imperial && { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph' }),
});
const wx = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);

const t = imperial ? '°F' : '°C';
const w = imperial ? 'mph' : 'km/h';
const c = wx.current;
const name = [place.name, place.admin1, place.country].filter(Boolean).join(', ');
console.log(
  [
    `${name} (local time ${c.time.replace('T', ' ')})`,
    `Now: ${CODES[c.weather_code] ?? 'unknown'}, ${c.temperature_2m}${t} (feels ${c.apparent_temperature}${t}), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} ${w}`,
    'Forecast:',
    ...wx.daily.time.map(
      (day, i) =>
        `- ${day}: ${CODES[wx.daily.weather_code[i]] ?? 'unknown'}, ${wx.daily.temperature_2m_min[i]}–${wx.daily.temperature_2m_max[i]}${t}, rain chance ${wx.daily.precipitation_probability_max[i] ?? '?'}%`,
    ),
  ].join('\n'),
);
