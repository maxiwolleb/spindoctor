import { createApp } from "vue"
import { createPinia } from "pinia"
import App from "./App.vue"
import { router } from "./router"
import { vuetify } from "./plugins/vuetify"

// Self-hosted fonts (no CDN) — only the weights the brand spec actually uses.
import "@fontsource/space-grotesk/600.css"
import "@fontsource/space-grotesk/700.css"
import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/jetbrains-mono/400.css"
import "@fontsource/jetbrains-mono/500.css"
import "@fontsource/jetbrains-mono/600.css"

import "./styles/tokens.css"

const app = createApp(App)

app.use(createPinia())
app.use(router)
app.use(vuetify)

app.mount("#app")
