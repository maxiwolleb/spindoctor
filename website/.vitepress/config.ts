import { defineConfig } from "vitepress"

// The Pages deploy is a project site, so every absolute asset path has to carry
// the base. VitePress rewrites the ones it owns (themeConfig.logo, markdown
// links), but `head` entries are emitted verbatim — so `/favicon.svg` resolved to
// maxiwolleb.github.io/favicon.svg and 404'd, leaving the docs with no icon.
const base = process.env.DOCS_BASE ?? "/"
const asset = (path: string): string => `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`

/**
 * Where the built site actually lives, base included. Search engines and social
 * unfurlers need absolute URLs — a canonical or an `og:image` pointing at a path
 * is worthless to them — and this is the only place that knows the deployed
 * origin, since `base` alone can't produce one.
 */
const siteUrl = (process.env.DOCS_SITE_URL ?? "https://maxiwolleb.github.io/spindoctor/").replace(
  /\/?$/,
  "/",
)
const absolute = (path: string): string => `${siteUrl}${path.replace(/^\//, "")}`

const DESCRIPTION =
  "Qualify used and refurbished drives with a repeatable SMART / self-test / surface-scan regime and a strict PASS / WARN / FAIL verdict."

/**
 * The URL VitePress will actually serve a page at: `guide/index.md` → `guide/`,
 * `guide/install.md` → `guide/install.html`. Used for the canonical link and
 * `og:url`.
 *
 * The `.html` is not cosmetic — `cleanUrls` is off, so that is both the file on
 * disk and what the generated sitemap lists. A canonical pointing at an
 * extensionless URL would disagree with the sitemap, and two conflicting claims
 * about a page's real address are worse than making neither.
 */
function pageUrl(relativePath: string): string {
  const path = relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, ".html")
  return absolute(path)
}

export default defineConfig({
  title: "spindoctor",
  description: DESCRIPTION,
  lang: "en-US",

  // Emits sitemap.xml at the site root for search engines to crawl from;
  // `robots.txt` (in public/) points at it. The hostname carries the base
  // because this is a project site — without it every entry would claim to live
  // at the user-site root and none of them would resolve.
  sitemap: { hostname: siteUrl },
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

    // Social unfurls. Absolute URLs on purpose: Slack, Discord, Mastodon and the
    // rest fetch these without a page context, so a relative image never loads.
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "spindoctor" }],
    ["meta", { property: "og:image", content: absolute("og-image.png") }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    [
      "meta",
      { property: "og:image:alt", content: "spindoctor — PASS / WARN / FAIL drive testing" },
    ],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: absolute("og-image.png") }],
    ["meta", { name: "theme-color", content: "#0A0F0D" }],

    // What the tool is, in the vocabulary somebody would actually search with —
    // "test used hard drives", "badblocks web UI", "SMART self-test tool".
    [
      "script",
      { type: "application/ld+json" },
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "spindoctor",
        description: DESCRIPTION,
        url: siteUrl,
        applicationCategory: "UtilitiesApplication",
        operatingSystem: "Linux (Docker)",
        license: "https://opensource.org/licenses/MIT",
        codeRepository: "https://github.com/maxiwolleb/spindoctor",
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        keywords:
          "hard drive testing, SMART, smartmontools, badblocks, surface scan, refurbished drives, used drives, disk health, self-hosted, homelab, HDD, SSD, NVMe, SAS",
      }),
    ],
  ],

  /**
   * Per-page canonical, title and description. Without this every page inherits
   * the site description verbatim, which is what makes a docs site look like one
   * page repeated six times to a crawler — and duplicate descriptions are the
   * most common reason deep pages never rank for the thing they actually cover.
   */
  transformPageData(pageData) {
    const url = pageUrl(pageData.relativePath)
    const description = (pageData.frontmatter.description as string | undefined) ?? DESCRIPTION
    const title = pageData.frontmatter.title ?? pageData.title
    pageData.frontmatter.head ??= []
    pageData.frontmatter.head.push(
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { property: "og:title", content: title ? `${title} · spindoctor` : "spindoctor" }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { name: "twitter:description", content: description }],
    )
  },

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
