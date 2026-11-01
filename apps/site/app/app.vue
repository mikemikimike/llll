<script setup lang="ts">
import { normalizeRoutePath } from './utils/shell-route'

const route = useRoute()
const path = computed(() => normalizeRoutePath(route.path))
const shell = computed(() => ['/servers', '/create'].includes(path.value) || /^\/[a-f0-9]{8}-[a-f0-9-]{27}(?:\/|$)/i.test(path.value))
useHead({
  title: computed(() => path.value === '/servers' ? 'My Servers · L4' : path.value === '/create' ? (route.query.update || route.query.resume === 'update' ? 'Update a Server · L4' : 'Add a Server · L4') : shell.value ? 'L4' : undefined),
  htmlAttrs: { class: computed(() => shell.value ? 'l4-shell' : undefined) },
})
</script>
<template>
  <UApp>
    <ClientOnly>
      <Shell v-show="shell" />
      <!-- The Shell renders only in the browser; show the same mark as the Client's loading screen meanwhile. -->
      <template #fallback>
        <div v-if="shell" role="status" class="flex h-dvh items-center justify-center bg-black text-white">
          <BrandMark class="size-12 animate-pulse" /><span class="sr-only">Opening L4</span>
        </div>
      </template>
    </ClientOnly>
    <div v-show="!shell"><NuxtPage /></div>
  </UApp>
</template>
