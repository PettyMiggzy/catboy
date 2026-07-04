// pm2 process config. Start with:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "catboy-buybot",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      watch: false,
      env: { NODE_ENV: "production" },
    },
  ],
};
