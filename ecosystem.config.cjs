module.exports = {
  apps: [{
    name: 'claude-weixin-bridge',
    script: 'src/standalone/run.ts',
    interpreter: '/home/booy1x/project/prj1/claude-weixin-bridge/node_modules/.bin/tsx',
    args: 'run',
    cwd: '/home/booy1x/project/prj1/claude-weixin-bridge',
    env: {
      NODE_ENV: 'production',
      CLAUDE_CMD: 'claude',
      CLAUDE_TIMEOUT_MS: '120000',
      CLAUDE_MAX_OUTPUT_CHARS: '4000',
      OPENCLAW_LOG_LEVEL: 'INFO'
    },
    error_file: '/home/booy1x/.pm2/logs/claude-weixin-bridge-error.log',
    out_file: '/home/booy1x/.pm2/logs/claude-weixin-bridge-out.log',
    log_file: '/home/booy1x/.pm2/logs/claude-weixin-bridge-combined.log',
    time: true,
    max_restarts: 10,
    restart_delay: 5000,
    exp_backoff_restart_delay: 100,
    autorestart: true,
    min_uptime: '60s',
    max_memory_restart: '1G'
  }]
};