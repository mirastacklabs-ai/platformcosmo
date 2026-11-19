import { defineConfig } from "vitepress";

// PLAN.md (implementation plan) and design/ (internal design specs) are never published.
export default defineConfig({
  title: "platformcosmo",
  // Same pattern as the sibling MIRASTACK LABS sites: "<product>: <page> | MIRASTACK LABS".
  titleTemplate: "platformcosmo: :title | MIRASTACK LABS",
  description:
    "platformcosmo turns a prompt into animated isometric architecture diagrams, as an open-source Claude Code plugin and CLI from MIRASTACK LABS.",
  transformHead({ pageData, description }) {
    const pageTitle = pageData.frontmatter.title ?? pageData.title;
    const full = `platformcosmo: ${pageTitle} | MIRASTACK LABS`;
    const desc = pageData.description || description;
    return [
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:site_name", content: "MIRASTACK LABS" }],
      ["meta", { property: "og:title", content: full }],
      ["meta", { property: "og:description", content: desc }],
      ["meta", { name: "twitter:card", content: "summary" }],
      ["meta", { name: "twitter:title", content: full }],
      ["meta", { name: "twitter:description", content: desc }],
    ];
  },
  srcExclude: ["PLAN.md", "**/PLAN.md", "design/**"],
  cleanUrls: true,
  cacheDir: "node_modules/.vitepress/cache",
  lastUpdated: false,
  appearance: true, // follows the system until the visitor uses the toggle
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: "/brand/mirastack-labs-mark.svg" }],
    [
      "link",
      {
        rel: "preload",
        href: "/fonts/oswald-400.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "",
      },
    ],
    [
      "link",
      {
        rel: "preload",
        href: "/fonts/oswald-600.woff2",
        as: "font",
        type: "font/woff2",
        crossorigin: "",
      },
    ],
  ],
  themeConfig: {
    // The nav logo is the MIRASTACK LABS lockup (theme/Layout.vue) linking to this site's home, as on
    // the MIRASTACK LABS product sites; no title text. The company site is credited in the footer.
    siteTitle: false,
    logoLink: "/",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Gallery", link: "/gallery" },
      { text: "Spec", link: "/guide/spec" },
      { text: "CLI", link: "/guide/cli" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting started", link: "/guide/getting-started" },
          { text: "Claude Code plugin", link: "/guide/plugin" },
          { text: "Spec format", link: "/guide/spec" },
          { text: "CLI reference", link: "/guide/cli" },
          { text: "Themes and fonts", link: "/guide/themes" },
          { text: "Icons", link: "/guide/icons" },
          { text: "Lesson templates", link: "/guide/lessons" },
        ],
      },
      { text: "Gallery", link: "/gallery" },
    ],
    // The footer (credit, license, trademark note) is theme/SiteFooter.vue so it shows on every page.
  },
});
