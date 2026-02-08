module.exports = {
  apps : [{
    name: "GGBot",
    script: "./server.js",
    env: { NODE_ENV: "development" }, // Default
    env_production: { NODE_ENV: "production" },
    env_testing: { NODE_ENV: "testing" }
  }]
}
