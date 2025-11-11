module.exports = {
  apps: [
    {
      name: 'ptf-web',
      cwd: './web/app',
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production'
      },
      env_local: {
        NEXT_PUBLIC_FAUCET_MODE: 'local'
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '512M'
    }
  ]
};
