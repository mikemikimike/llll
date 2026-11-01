import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

describe('page overscroll', () => {
  it('stops iOS dragging the Client page', () => {
    expect(read('app/assets/css/main.css')).toMatch(/html, body \{\s*overscroll-behavior: none;/)
  })

  it('stops iOS dragging the Shell page, which an embedded Client cannot prevent', () => {
    expect(read('apps/site/app/assets/css/main.css')).toContain('html.l4-shell, html.l4-shell body { overscroll-behavior: none; }')
    expect(read('apps/site/app/app.vue')).toContain(`htmlAttrs: { class: computed(() => shell.value ? 'l4-shell' : undefined) }`)
  })
})
