<script setup lang="ts">
import MiraLogo from "./MiraLogo.vue";
</script>

<template>
  <section class="pc-built-by" aria-labelledby="pc-built-by-h">
    <div class="pc-built-by-inner">
      <p class="pc-eyebrow">Sponsor and maintainer</p>
      <h2 id="pc-built-by-h">Built by MiraStack Labs</h2>
      <a
        class="pc-built-by-logo"
        href="https://www.mirastacklabs.ai"
        target="_blank"
        rel="noopener"
        aria-label="MiraStack Labs"
      >
        <MiraLogo wordmark />
      </a>
      <p>
        PlatformCosmo is built by the engineering team at MiraStack Labs, which hosts and runs
        open-weight AI capacity and publishes the infrastructure it depends on as open source.
      </p>
      <a class="pc-btn" href="https://www.mirastacklabs.ai" target="_blank" rel="noopener"
        >Visit MiraStack Labs</a
      >
    </div>
  </section>
</template>
