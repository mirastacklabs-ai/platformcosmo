<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import HeroDiagram from "./HeroDiagram.vue";
import MiraLogo from "./MiraLogo.vue";
import NavIcons from "./NavIcons.vue";
import SiteFooter from "./SiteFooter.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #nav-bar-title-before>
      <span class="pc-product">PLATFORMCOSMO</span>
      <span class="pc-by">by</span>
      <MiraLogo wordmark class="pc-title-lockup" />
    </template>
    <template #nav-bar-content-after><NavIcons /></template>
    <template #home-hero-after><HeroDiagram /></template>
    <template #layout-bottom><SiteFooter /></template>
  </Layout>
</template>
