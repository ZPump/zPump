module.exports = {
  apps: [
    {
      name: 'ptf-web',
      cwd: './web/app',
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production',
        NEXT_PUBLIC_RPC_URL: 'http://127.0.0.1:8899',
        INDEXER_INTERNAL_URL: 'http://127.0.0.1:8787',
        NEXT_PUBLIC_INDEXER_URL: '/api/indexer'
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
