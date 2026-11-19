import { defineConfig } from "vitepress";

// PLAN.md is the internal implementation plan and is never published.
export default defineConfig({
  title: "PlatformCosmo",
  description:
    "Prompt to animated isometric architecture diagrams, as a Claude Code plugin and CLI.",
  srcExclude: ["PLAN.md", "**/PLAN.md"],
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
    socialLinks: [{ icon: "github", link: "https://github.com/mirastacklabs-ai/platformcosmo" }],
    // The footer (credit, license, trademark note) is theme/SiteFooter.vue so it shows on every page.
  },
});
