import "vuetify/styles"
import { createVuetify, type ThemeDefinition } from "vuetify"
import { aliases, mdi } from "vuetify/iconsets/mdi-svg"

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
  // Vuetify's default `mdi` set expects the Material Design Icons *font* to be
  // loaded, which this app never shipped — so every checkbox and radio rendered
  // as a bare label with an empty gap where its control should be, including the
  // acknowledgment checkbox gating auto-mode's destructive wipe (issue #55).
  // The SVG set is used rather than the font: it draws from `@mdi/js`, so only
  // the ~30 icons Vuetify actually aliases get bundled instead of a ~1 MB
  // webfont, and it needs no external request — which the self-hosted-fonts rule
  // demands anyway.
  icons: {
    defaultSet: "mdi",
    aliases,
    sets: { mdi },
  },
  theme: {
    defaultTheme: "spindoctor",
    themes: { spindoctor },
  },
})
