import { defineConfig } from "vitepress"

// The Pages deploy is a project site, so every absolute asset path has to carry
// the base. VitePress rewrites the ones it owns (themeConfig.logo, markdown
// links), but `head` entries are emitted verbatim — so `/favicon.svg` resolved to
// maxiwolleb.github.io/favicon.svg and 404'd, leaving the docs with no icon.
const base = process.env.DOCS_BASE ?? "/"
const asset = (path: string): string => `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`

export default defineConfig({
  title: "spindoctor",
  description:
    "Qualify used and refurbished drives with a repeatable SMART / self-test / surface-scan regime and a strict PASS / WARN / FAIL verdict.",
  lang: "en-US",
  // Dark-only identity — no light theme, no toggle.
  appearance: "force-dark",

  // Local dev/build serve from the root. The GitHub Pages deploy is a
  // project site (https://maxiwolleb.github.io/spindoctor/), so the Docs
  // workflow sets DOCS_BASE=/spindoctor/ for that build only.
  base,

  head: [
    ["link", { rel: "icon", href: asset("favicon.svg"), type: "image/svg+xml" }],
    ["link", { rel: "icon", type: "image/png", href: asset("favicon-512.png") }],
    ["link", { rel: "apple-touch-icon", href: asset("apple-touch-icon.png") }],
    ["link", { rel: "icon", href: asset("favicon.ico"), sizes: "any" }],
  ],

  themeConfig: {
    logo: "/logo-mark.svg",

    nav: [
      { text: "Guide", link: "/guide/" },
      { text: "GitHub", link: "https://github.com/maxiwolleb/spindoctor" },
    ],

    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            { text: "What is spindoctor", link: "/guide/" },
            { text: "Install & run", link: "/guide/install" },
            { text: "How it works", link: "/guide/how-it-works" },
            { text: "Safety", link: "/guide/safety" },
            { text: "Configuration", link: "/guide/configuration" },
            { text: "Architecture", link: "/guide/architecture" },
          ],
        },
      ],
    },

    socialLinks: [{ icon: "github", link: "https://github.com/maxiwolleb/spindoctor" }],

    footer: {
      message: "Released under the MIT License.",
      copyright: "spindoctor",
    },

    search: {
      provider: "local",
    },
  },
})
