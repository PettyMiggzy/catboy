// pm2 config — starts the trigger bot and the auto-deploy watcher. `pm2 start autocopy/deploy/ecosystem.config.cjs`
module.exports = {
  apps: [
    { name: "autocopy", script: "autocopy/trigger.mjs", cwd: __dirname + "/../..", autorestart: true, max_restarts: 100, restart_delay: 4000 },
    { name: "buybot", script: "autocopy/buybot.mjs", cwd: __dirname + "/../..", autorestart: true, max_restarts: 200, restart_delay: 4000 },
    { name: "autocopy-deploy", script: "autocopy/deploy/update.sh", interpreter: "bash", cwd: __dirname + "/../..", autorestart: true },
  ],
};
