const path = require("path");

module.exports = {
  apps: [{
    name: "server",
    cwd: path.join(__dirname, "src"),
    script: "server.js",
    env: { NODE_ENV: "development" }, // Default
    env_production: { NODE_ENV: "production" },
    env_testing: { NODE_ENV: "testing" }
  }]
}
