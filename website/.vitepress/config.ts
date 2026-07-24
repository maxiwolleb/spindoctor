import { defineConfig } from "vitepress"

export default defineConfig({
  title: "spindoctor",
  description:
    "Qualify used and refurbished drives with a repeatable SMART / self-test / surface-scan regime and a strict PASS / WARN / FAIL verdict.",
  lang: "en-US",
  appearance: "dark",

  // Local dev/build serve from the root. The GitLab Pages deploy is a
  // project site (https://maxiwolleb.gitlab.io/spindoctor/), so CI sets
  // DOCS_BASE=/spindoctor/ for that build only.
  base: process.env.DOCS_BASE ?? "/",

  head: [["link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }]],

  themeConfig: {
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
