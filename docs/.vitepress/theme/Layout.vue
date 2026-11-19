<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import BuiltBy from "./BuiltBy.vue";
import HeroDiagram from "./HeroDiagram.vue";
import NavBy from "./NavBy.vue";
import SiteFooter from "./SiteFooter.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <template #nav-bar-title-after><NavBy /></template>
    <template #home-hero-after><HeroDiagram /></template>
    <template #home-features-after><BuiltBy /></template>
    <template #layout-bottom><SiteFooter /></template>
  </Layout>
</template>
