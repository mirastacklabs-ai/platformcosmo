<script setup lang="ts">
import MiraLogo from "./MiraLogo.vue";
</script>

<template>
  <footer class="pc-footer">
    <div class="pc-footer-inner">
      <div class="pc-footer-brand">
        <a
          href="https://www.mirastacklabs.ai"
          target="_blank"
          rel="noopener"
          aria-label="MiraStack Labs"
        >
          <MiraLogo wordmark />
        </a>
        <p>
          PlatformCosmo is built by the engineering team at
          <a href="https://www.mirastacklabs.ai" target="_blank" rel="noopener">MiraStack Labs</a>.
        </p>
      </div>
      <div class="pc-footer-legal">
        <p>Apache-2.0. Copyright 2026 MiraStack Labs.</p>
        <p>
          AWS, Azure, Google Cloud, Kubernetes and the brands in Simple Icons are trademarks of
          their owners; use does not imply endorsement. The MiraStack Labs name and logo are
          trademarks of MiraStack Labs.
        </p>
      </div>
    </div>
  </footer>
</template>
