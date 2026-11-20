import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import Layout from "./Layout.vue";
import "./fonts.css";
import "./brand.css";

// MiraStack Labs brand look (tokens from mirastacklabs.ai) on top of the default VitePress theme.
export default {
  extends: DefaultTheme,
  Layout,
} satisfies Theme;
