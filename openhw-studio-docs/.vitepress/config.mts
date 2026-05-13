import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/docs/',
  title: "OpenHW Studio",
  description: "Advanced Arduino & Hardware Simulation Documentation",
  themeConfig: {
    logo: '/logo.png',
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Guide', link: '/guides/deployment' },
      { text: 'Architecture', link: '/architecture/overview' }
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Deployment Guide', link: '/guides/deployment' },
          { text: 'Implementation Guide v2.5', link: '/guides/implementation-v2-5' },
          { text: 'Quick Reference', link: '/guides/quick-reference' },
          { text: 'Keyboard Shortcuts', link: '/guides/shortcuts' },
        ]
      },
      {
        text: 'Architecture',
        items: [
          { text: 'System Overview', link: '/architecture/overview' },
          { text: 'Autofix Engine', link: '/architecture/autofix' },
          { text: 'Autowiring System', link: '/architecture/autowiring' },
          { text: 'Compiler Backend', link: '/architecture/compiler-backend' },
        ]
      },
      {
        text: 'Grading Engine',
        items: [
          { text: 'Grading Overview', link: '/grading/overview' },
          { text: 'Engine Status', link: '/grading/engine-status' },
          { text: 'Scoring Guide', link: '/grading/scoring-guide' },
          { text: 'Compatibility Audit', link: '/grading/audit' },
        ]
      },
      {
        text: 'Telemetry & Data',
        items: [
          { text: 'Telemetry Overview', link: '/telemetry/overview' },
          { text: 'API Reference', link: '/telemetry/api' },
          { text: 'Pin Telemetry', link: '/telemetry/pin-telemetry' },
        ]
      },
      {
        text: 'Components',
        items: [
          { text: 'Frontend', link: '/components/frontend' },
          { text: 'Backend', link: '/components/backend' },
          { text: 'Emulator', link: '/components/emulator' },
          { text: 'CLI', link: '/components/cli' },
        ]
      },
      {
        text: 'Releases',
        items: [
          { text: 'Changelog', link: '/releases/changelog' },
          { text: 'Latest Changes', link: '/releases/latest-changes' },
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/danish9661/Arduino-simulator' }
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Danish'
    },

    search: {
      provider: 'local'
    }
  }
})
