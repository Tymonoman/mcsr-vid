import { Config } from "@remotion/cli/config";

// public/ at the repo root is the dashboard's, not Remotion's. Point staticFile() at
// remotion/assets/ so the vendored achievement badges resolve and the dashboard files never end
// up in a bundle (src/remotionBundle.ts sets the same dir for programmatic renders).
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
