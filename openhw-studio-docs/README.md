# OpenHW Studio Documentation Portal

This repository contains the professional documentation for OpenHW Studio, built using [VitePress](https://vitepress.dev/). It provides comprehensive guides on hardware simulation, autograding architecture, and system deployment.

## 🚀 Quick Start (Local Development)

To run the documentation server locally:

1.  Navigate to this directory.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Start the development server:
    ```bash
    npm run docs:dev
    ```
4.  Open your browser to [http://localhost:5174](http://localhost:5174).

## 🏗️ Build & Production

To generate the static site for production:
```bash
npm run docs:build
```
The optimized static assets will be located in the `.vitepress/dist` directory.

## 🚢 Deployment Architecture

This portal is configured for **unified deployment** with the [OpenHW Studio Frontend](https://github.com/OpenHW-Studio/OpenHW-studio-frontend).

- **CI/CD Integration**: The main frontend GitHub Action clones this repository during the build process.
- **Dockerized Hosting**: The portal is served via Nginx as a sub-path at `/docs/` within the frontend container.
- **Base Configuration**: The `base` path is set to `/docs/` in `.vitepress/config.mts` to ensure all assets resolve correctly in production.

## 📝 Writing Documentation

- **Structure**: Add or edit `.md` files in the respective category folders (`architecture`, `guides`, `grading`, `telemetry`, etc.).
- **Sidebar**: Update `.vitepress/config.mts` to reflect changes in the navigation menu or sidebar hierarchy.
- **Professionalism Policy**: Refrain from using graphical emojis. Use professional text-based identifiers (e.g., `[PASS]`, `[OK]`, `[WARN]`, `[FAIL]`) to maintain a consistent enterprise aesthetic.

---
© 2024-present OpenHW Studio Team

