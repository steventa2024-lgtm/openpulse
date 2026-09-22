---
name: system-info
description: Check this computer's health — OS, uptime, CPU, memory and free disk space.
metadata: { 'openpulse': { 'emoji': '🖥️' } }
---

# System info

For questions like "how is my computer doing", "how much disk space is left" or "what OS is
this", and for heartbeat checks that monitor the machine, run:

```bash
node {baseDir}/system-info.mjs
```

It's read-only and fast. Summarise the relevant line(s) rather than pasting everything.
Warn the user when any disk is below 10% free.
