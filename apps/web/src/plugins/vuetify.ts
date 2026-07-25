import "vuetify/styles"
import { createVuetify, type ThemeDefinition } from "vuetify"

/** The "Phosphor Scope" theme — the exact brand tokens. Keep these values in
 * sync with `styles/tokens.css`. */
const spindoctor: ThemeDefinition = {
  dark: true,
  colors: {
    background: "#0A0F0D",
    surface: "#0F1613",
    "surface-bright": "#14201A",
    primary: "#38F5A2",
    secondary: "#5FA8FF",
    success: "#38F5A2",
    warning: "#E3B341",
    error: "#FF5C57",
    info: "#5FA8FF",
    "on-background": "#DDE9E1",
    "on-surface": "#DDE9E1",
  },
}

export const vuetify = createVuetify({
  theme: {
    defaultTheme: "spindoctor",
    themes: { spindoctor },
  },
})
