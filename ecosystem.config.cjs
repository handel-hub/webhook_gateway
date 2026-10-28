/**
 * PM2 Process Supervision Configuration for CWIDS Production Deployment.
 * Gateway runs in cluster mode (2 instances) behind reverse proxy (Caddy/Nginx).
 * Delivery Worker runs in fork mode (single instance to avoid unneeded scheduler overlap).
 */
module.exports = {
  apps: [
    {
      name: 'cwids-gateway',
      script: 'src/server.mjs',
      instances: 2,
      exec_mode: 'cluster',
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        METRICS_PORT: 9090,
      },
    },
    {
      name: 'cwids-worker',
      script: 'src/worker.mjs',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      kill_timeout: 35000, // Wait up to 35s for in-flight dispatches to drain cleanly
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
