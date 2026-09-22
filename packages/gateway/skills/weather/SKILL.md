---
name: weather
description: Get current weather and forecasts for any place (no API key needed).
homepage: https://open-meteo.com
metadata: { 'openpulse': { 'emoji': '🌤️' } }
---

# Weather

Use this when the user asks about weather, temperature, rain, wind or what to wear.

Run the bundled script with `exec` (it uses the free Open-Meteo API):

```bash
node {baseDir}/weather.mjs "London"
node {baseDir}/weather.mjs "Austin, Texas" --imperial
```

It prints the location, current conditions and a 3-day forecast.

Tips:

- If `USER.md` or `MEMORY.md` has the user's home city and they don't name a place, use it.
- Match the user's units when known; default to metric.
- Answer in one or two sentences unless they ask for the full forecast.
- Quick alternative without the script: `web_fetch` `https://wttr.in/<city>?format=3`.
