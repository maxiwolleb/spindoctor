// `theme-without-fonts` skips VitePress's own bundled Inter so we don't ship
// two copies of it — we bring our own weights via `@fontsource` below.
import DefaultTheme from "vitepress/theme-without-fonts"

// Self-hosted fonts (no CDN) — only the weights the brand spec actually uses,
// matching apps/web/src/main.ts so the docs site and the app read as one product.
import "@fontsource/space-grotesk/600.css"
import "@fontsource/space-grotesk/700.css"
import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/jetbrains-mono/400.css"
import "@fontsource/jetbrains-mono/500.css"
import "@fontsource/jetbrains-mono/600.css"

import "./custom.css"

export default DefaultTheme
