import { Config } from "@remotion/cli/config";

// No project-root public/ dir exists (fonts are base64-inlined at build time instead) —
// point staticFile()'s resolution at remotion/assets/ so vendored images (e.g. achievement
// badges) can live next to the other vendored assets instead of a separate public/ tree.
Config.setPublicDir("remotion/assets");

Config.overrideWebpackConfig((currentConfig) => ({
  ...currentConfig,
  resolve: {
    ...currentConfig.resolve,
    extensionAlias: {
      ".js": [".js", ".ts", ".tsx"],
    },
  },
}));
