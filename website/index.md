---
layout: home

hero:
  name: spindoctor
  tagline: Qualify used and refurbished drives — SMART, self-test, destructive surface scan, and a clear PASS / WARN / FAIL verdict, from a live web console.
  image:
    src: /logo-mark.svg
    alt: spindoctor
  actions:
    - theme: brand
      text: Get started
      link: /guide/
    - theme: alt
      text: GitHub
      link: https://github.com/maxiwolleb/spindoctor

features:
  - title: Live console
    details: A Vue 3 + Vuetify dashboard driven by a live event stream — SMART snapshots, self-test progress, and surface-scan status update in real time, per drive.
  - title: Strict verdicts
    details: Reallocated and pending sectors, SSD/NVMe wear, self-test and surface-scan results are evaluated against configurable thresholds into a structured PASS / WARN / FAIL with reasons.
  - title: Safety-first
    details: Mounted, system, and protected-list drives are never eligible for a destructive run. Starting one requires typing the drive's serial number, enforced in the UI and again by the API.
  - title: Self-hosted
    details: Ships as a single Debian-slim Docker image with SQLite storage. No account, no cloud dependency — runs on your own hardware.
---

<div style="max-width: 960px; margin: 3rem auto 0; padding: 0 24px;">

![spindoctor dashboard: drive inventory with health and verdict](/screenshots/dashboard.png)

</div>
