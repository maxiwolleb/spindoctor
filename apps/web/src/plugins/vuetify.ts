import "vuetify/styles"
import { createVuetify, type ThemeDefinition } from "vuetify"

/** The dark "instrument console" theme — exact tokens from Plan 5's Global
 * Constraints. Keep these values in sync with `styles/tokens.css`. */
const spindoctor: ThemeDefinition = {
  dark: true,
  colors: {
    background: "#0E1116",
    surface: "#171B22",
    "surface-bright": "#1F242D",
    primary: "#4EA1FF",
    secondary: "#8B95A5",
    success: "#3FB950",
    warning: "#D29922",
    error: "#F85149",
    info: "#4EA1FF",
    "on-background": "#E6EAF0",
    "on-surface": "#E6EAF0",
  },
}

export const vuetify = createVuetify({
  theme: {
    defaultTheme: "spindoctor",
    themes: { spindoctor },
  },
})
