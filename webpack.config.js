const fs = require("fs");
const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

const devServerPort = 3002;

module.exports = (env, argv) => {
  const isDev = argv.mode === "development";
  return {
    entry: {
      taskpane: "./src/taskpane/taskpane.js",
      commands: "./src/commands/commands.js",
      "auth-redirect": "./src/taskpane/auth-redirect.js",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
    },
    devtool: isDev ? "source-map" : false,
    resolve: {
      extensions: [".js"],
    },
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: "babel-loader",
            options: {
              presets: ["@babel/preset-env"],
            },
          },
        },
        {
          test: /\.css$/,
          use: [isDev ? "style-loader" : MiniCssExtractPlugin.loader, "css-loader"],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: "./src/taskpane/taskpane.html",
        filename: "taskpane.html",
        chunks: ["taskpane"],
      }),
      new HtmlWebpackPlugin({
        template: "./src/commands/commands.html",
        filename: "commands.html",
        chunks: ["commands"],
      }),
      new HtmlWebpackPlugin({
        template: "./src/taskpane/auth-redirect.html",
        filename: "auth-redirect.html",
        chunks: ["auth-redirect"],
      }),
      new CopyWebpackPlugin({
        patterns: [{ from: "assets", to: "assets" }],
      }),
      ...(isDev ? [] : [new MiniCssExtractPlugin({ filename: "[name].css" })]),
      new webpack.EnvironmentPlugin({
        LEDGERLENS_CLIENT_ID: "",
        LEDGERLENS_TENANT_ID: "",
        LEDGERLENS_REDIRECT_URI: "",
      }),
    ],
    devServer: {
      setupMiddlewares: (middlewares) => {
        const { createOfficeSsoMiddleware } = require("./src/server/office-sso-middleware.js");
        const { createCopilotMiddleware } = require("./src/server/copilot-proxy.js");
        const { createStdioProxyMiddleware } = require("./src/server/mcp-stdio-proxy.js");
        const { createKustoLocalMiddleware } = require("./src/server/kusto-local-proxy.js");
        // Keep parity with the production server: MSAL.js popup auth needs
        // `same-origin-allow-popups` so it can poll the sign-in window.
        middlewares.unshift({
          name: "coop-allow-popups",
          middleware: (_req, res, next) => {
            res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
            next();
          },
        });
        middlewares.unshift({
          name: "office-sso-auth",
          middleware: createOfficeSsoMiddleware(),
        });
        middlewares.unshift({
          name: "copilot-proxy",
          middleware: createCopilotMiddleware(),
        });
        middlewares.unshift({
          name: "mcp-stdio-proxy",
          middleware: createStdioProxyMiddleware(),
        });
        middlewares.unshift({
          name: "kusto-local-proxy",
          middleware: createKustoLocalMiddleware(),
        });
        return middlewares;
      },
      port: devServerPort,
      ...(() => {
        const certDir = path.resolve(process.env.HOME || process.env.USERPROFILE || ".", ".office-addin-dev-certs");
        if (fs.existsSync(path.join(certDir, "localhost.key"))) {
          return {
            server: {
              type: "https",
              options: {
                key: fs.readFileSync(path.join(certDir, "localhost.key")),
                cert: fs.readFileSync(path.join(certDir, "localhost.crt")),
                ca: fs.readFileSync(path.join(certDir, "ca.crt")),
              },
            },
          };
        }
        return {};
      })(),
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      static: {
        directory: path.resolve(__dirname, "dist"),
      },
      hot: true,
      client: {
        overlay: false,
      },
    },
  };
};
