import { Config } from "@remotion/cli/config";

Config.overrideWebpackConfig((currentConfig) => ({
  ...currentConfig,
  resolve: {
    ...currentConfig.resolve,
    extensionAlias: {
      ".js": [".js", ".ts", ".tsx"],
    },
  },
}));
