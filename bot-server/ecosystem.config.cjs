// pm2 config for the STAG bot. Runs from the repo root so assets/trivia resolves.
//   cd <repo root>  &&  pm2 start bot-server/ecosystem.config.cjs  &&  pm2 save
const path = require("path");
module.exports = {
  apps: [{
    name: "stag-bot",
    script: "bot-server/index.mjs",
    cwd: path.join(__dirname, ".."), // repo root — the handler reads assets/trivia via process.cwd()
    node_args: "--env-file=bot-server/.env", // Node 20+: load env from the .env file
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000,
    max_memory_restart: "500M",
    time: true, // timestamp log lines
  },{
    name: "stag-hunt-web",             // static host for the Hooded Hunt game
    script: "bot-server/serve.mjs",
    cwd: path.join(__dirname, ".."),   // repo root — serves ./games
    env: { PORT: process.env.HUNT_PORT || "8090" },
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000,
    time: true,
  }],
};
