import { defineConfig } from "vitepress"

export default defineConfig({
  title: "spindoctor",
  description:
    "Qualify used and refurbished drives with a repeatable SMART / self-test / surface-scan regime and a strict PASS / WARN / FAIL verdict.",
  lang: "en-US",
  appearance: "dark",

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
          items: [{ text: "What is spindoctor", link: "/guide/" }],
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
