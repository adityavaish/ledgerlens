const path = require("path");
const fs = require("fs");
const os = require("os");
const HtmlWebpackPlugin = require("html-webpack-plugin");

const certDir = path.join(os.homedir(), ".office-addin-dev-certs");
const certPath = path.join(certDir, "localhost.crt");
const keyPath = path.join(certDir, "localhost.key");
const useTrustedCert = fs.existsSync(certPath) && fs.existsSync(keyPath);

module.exports = {
  entry: { taskpane: "./src/taskpane/index.tsx" },
  resolve: { extensions: [".ts", ".tsx", ".js"] },
  module: {
    rules: [
      { test: /\.tsx?$/, loader: "ts-loader", exclude: /node_modules/ },
      { test: /\.css$/, use: ["style-loader", "css-loader"] },
    ],
  },
  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "dist"),
    clean: true,
  },
  plugins: [
    new HtmlWebpackPlugin({
      filename: "taskpane.html",
      template: "./src/taskpane/index.html",
      chunks: ["taskpane"],
    }),
  ],
  devServer: {
    static: path.join(__dirname, "dist"),
    port: 3000,
    host: "localhost",
    server: useTrustedCert
      ? { type: "https", options: { cert: certPath, key: keyPath } }
      : "https",
    open: ["/taskpane.html"],
    headers: { "Access-Control-Allow-Origin": "*" },
    historyApiFallback: { index: "/taskpane.html" },
  },
};
