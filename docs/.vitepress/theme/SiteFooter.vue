<script setup lang="ts">
import MiraLogo from "./MiraLogo.vue";
</script>

<template>
  <footer class="pc-footer">
    <div class="pc-footer-inner">
      <a
        class="pc-footer-logo"
        href="/"
        aria-label="MIRASTACK LABS, home"
      >
        <MiraLogo wordmark />
      </a>
      <p class="pc-footer-tag">
        platformcosmo is open source under Apache-2.0, built by the engineering team at
        <a href="https://www.mirastacklabs.ai">MIRASTACK LABS</a>.
      </p>
      <div class="pc-footer-legal">
        <p>&copy; 2026 MIRASTACK LABS PRIVATE LIMITED &middot; Hyderabad, India</p>
        <p>This site records anonymous page views (no cookies, no IP addresses).</p>
        <p>
          AWS, Azure, Google Cloud, Kubernetes and the brands in Simple Icons are trademarks of
          their owners; use does not imply endorsement. The MIRASTACK LABS name and logo are
          trademarks of MIRASTACK LABS.
        </p>
      </div>
    </div>
  </footer>
</template>
