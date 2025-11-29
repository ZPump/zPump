module.exports = {
  apps: [
    {
      name: 'ptf-indexer',
      cwd: './indexer/photon',
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production',
        PORT: 8787,
        RPC_URL: 'http://127.0.0.1:8899',
        ENABLE_BALANCE_API: 'true',
        LOG_LEVEL: 'info'
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      error_file: './.pm2-ptf-indexer-error.log',
      out_file: './.pm2-ptf-indexer-out.log',
      merge_logs: true,
      time: true
    },
    {
      name: 'ptf-proof',
      cwd: './services/proof-rpc',
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production',
        PORT: 8788,
        RPC_URL: 'http://127.0.0.1:8899',
        GROTH16_DIR: '../../circuits/keys',
        LOG_LEVEL: 'info'
      },
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      error_file: './.pm2-ptf-proof-error.log',
      out_file: './.pm2-ptf-proof-out.log',
      merge_logs: true,
      time: true
    },
    {
      name: 'ptf-web',
      cwd: './web/app',
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
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
      max_memory_restart: '512M',
      error_file: './.pm2-ptf-web-error.log',
      out_file: './.pm2-ptf-web-out.log',
      merge_logs: true,
      time: true
    }
  ]
};
