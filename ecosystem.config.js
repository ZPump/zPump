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
        NEXT_PUBLIC_PROOF_RPC_URL: '/api/proof',
        PROOF_RPC_INTERNAL_URL: 'http://127.0.0.1:8788/prove',
        INDEXER_INTERNAL_URL: 'http://127.0.0.1:8787',
        NEXT_PUBLIC_INDEXER_URL: '/api/indexer',
        NEXT_PUBLIC_FAUCET_MODE: 'local',
        FAUCET_MODE: 'local',
        NEXT_PUBLIC_WALLET_ACTIVITY_MODE: 'private',
        WALLET_ACTIVITY_MODE: 'private'
      },
      env_local: {
        NEXT_PUBLIC_FAUCET_MODE: 'local',
        FAUCET_MODE: 'local',
        NEXT_PUBLIC_RPC_URL: 'http://127.0.0.1:8899',
        NEXT_PUBLIC_PROOF_RPC_URL: '/api/proof',
        PROOF_RPC_INTERNAL_URL: 'http://127.0.0.1:8788/prove',
        NEXT_PUBLIC_WALLET_ACTIVITY_MODE: 'private',
        WALLET_ACTIVITY_MODE: 'private'
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '512M'
    }
  ]
};
