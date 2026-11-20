<script setup lang="ts">
import { withBase } from "vitepress";
// Rendered at docs build by scripts/prepare.mjs from examples/gpu-inference-cluster.cosmo.json (light and dark themes).
// Both are in the page; CSS shows the one that matches the active appearance (follows the toggle, not only the OS).
</script>

<template>
  <figure class="pc-hero-diagram">
    <img
      class="pc-hero-light"
      :src="withBase('/hero/hero-light.svg')"
      alt="Animated isometric diagram: requests pass an API gateway and a router to a pool of GPU inference servers."
      width="1858"
      height="986"
    />
    <img
      class="pc-hero-dark"
      :src="withBase('/hero/hero-dark.svg')"
      alt=""
      aria-hidden="true"
      width="1858"
      height="986"
    />
  </figure>
</template>
