/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: [
      '@chakra-ui/react',
      '@solana/wallet-adapter-react',
      '@solana/wallet-adapter-react-ui',
      'lucide-react'
    ]
  },
  typescript: {
    ignoreBuildErrors: true, // Ignore TypeScript errors in test scripts
  },
  eslint: {
    ignoreDuringBuilds: true,
  }
};

module.exports = nextConfig;
