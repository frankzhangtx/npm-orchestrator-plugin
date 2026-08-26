// Keep the package root plugin-only. OpenCode treats every root export as a
// plugin factory, so constants and lifecycle APIs must live under ./api.
export { default } from "./plugin/index.js";
