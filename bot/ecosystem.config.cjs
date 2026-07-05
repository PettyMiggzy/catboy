// pm2 process config. Start with:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "catboy-buybot",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork", // MUST be fork — cluster mode breaks Telegram getUpdates (409 conflict → no commands)
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      watch: false,
      env: { NODE_ENV: "production" },
    },
  ],
};
