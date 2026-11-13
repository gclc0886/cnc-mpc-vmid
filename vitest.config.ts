import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts so tests don't load the React/Tailwind plugins.
// Default environment is node; DOM-dependent tests (VMID parsing uses DOMParser)
// opt in with a `// @vitest-environment jsdom` header.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
})
