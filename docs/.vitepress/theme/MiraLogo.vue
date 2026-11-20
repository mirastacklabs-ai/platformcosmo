<script setup lang="ts">
// MiraStack Labs logo: the mark (three slanted bars) and, optionally, the wordmark, as on mirastacklabs.ai.
// Polygons are the official mark, unmodified. The teal bar follows --pc-logo-teal (light/dark), as on the site.
defineProps<{ wordmark?: boolean }>();
</script>

<template>
  <span class="pc-logo">
    <svg viewBox="0 0 32 26" aria-hidden="true" focusable="false">
      <polygon class="b1" points="0,26 7,0 12,0 5,26" />
      <polygon class="b2" points="9,26 16,0 21,0 14,26" />
      <polygon class="b3" points="18,26 25,0 30,0 23,26" />
    </svg>
    <span v-if="wordmark" class="pc-wordmark"><b>MIRASTACK</b><span>LABS</span></span>
  </span>
</template>
