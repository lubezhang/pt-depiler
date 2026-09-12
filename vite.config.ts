import fs from "node:fs";
import path from "node:path";

import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";

// @ts-ignore
import { vitePluginGenerateWebextLocales } from "./vite/plugin/generateWebextLocales.ts";

import git from "git-rev-sync";
import pkg from "./package.json";

function base_path(_path = "") {
  return path.resolve(__dirname, _path);
}

const git_count = git.count("HEAD");
const base_version = `${pkg.version}.${git_count}`;
const commit_version = `${base_version}+${git.short(__dirname)}`;

// https://vitejs.dev/config/
export default defineConfig({
  // 以 options 页为 SPA 入口；publicDir 仍指向项目根 public（index.html 用 /lib/mdi/* 绝对路径引用）
  root: base_path("./src/entries/options"),
  publicDir: base_path("./public"),
  build: {
    target: "es2023",
    outDir: base_path("./dist"),
    emptyOutDir: true,
  },
  plugins: [
    vitePluginGenerateWebextLocales(),
    nodePolyfills({
      include: ["buffer", "path"],
      globals: {
        Buffer: true,
      },
    }),
    vue(),
    vuetify(),
  ],
  resolve: {
    alias: {
      "~": base_path("./src"),
      "@": base_path("./src/entries"),
      "@ptd": base_path("./src/packages"),
    },
  },
  define: {
    __BROWSER__: JSON.stringify("tauri"),
    __EXT_VERSION__: JSON.stringify(`v${commit_version}`),
    __GIT_VERSION__: {
      short: git.short(__dirname),
      long: git.long(__dirname),
      date: +git.date(),
      count: git_count,
      branch: git.branch(__dirname),
    },
    __BUILD_TIME__: +Date.now(),
    __RESOURCE_SITE_ICONS__: fs.readdirSync(base_path("./public/icons/site")),
  },
});
