// hls.js ships no types for its light build (no subtitles, DRM or alternate audio); the API is the same.
declare module "hls.js/light" {
  export * from "hls.js";
  export { default } from "hls.js";
}
