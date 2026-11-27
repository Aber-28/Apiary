# Machine usage in the top bar

The top bar shows small figures for the computer Apiary runs on: **CPU**, **RAM**, **Disk** and **network speed** (download ↓ and upload ↑), refreshed **every second**. Network speed adds up the real network cards; loopback, containers and virtual bridges are left out. They are read from Linux, the same source a task manager uses, so they add almost no load. A figure turns amber at 75% and red at 90%. Hover over one for details (cores and load, gigabytes used and free).

It shows only the local machine, not your other servers. It is hidden on narrow screens, and it pauses when the page is in the background.
