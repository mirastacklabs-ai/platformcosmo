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
          { text: "Icons", link: "/guide/icons" },
          { text: "Lesson templates", link: "/guide/lessons" },
        ],
      },
      { text: "Gallery", link: "/gallery" },
    ],
    socialLinks: [{ icon: "github", link: "https://github.com/mirastacklabs-ai/platformcosmo" }],
    footer: {
      message:
        "Apache-2.0. AWS, Azure, Google Cloud, Kubernetes and the brands in Simple Icons are trademarks of their owners; use does not imply endorsement.",
      copyright: "Copyright 2026 MiraStack Labs",
    },
  },
});
