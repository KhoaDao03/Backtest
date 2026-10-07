/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // Members do not need a local ESLint install for `npm run build` to succeed.
    ignoreDuringBuilds: true,
  },
  compress: false,
  // ws is Node-only; keep it out of the browser bundle
  serverExternalPackages: ["ws"],
  // next dev's client-fallback graph traces instrumentation → engine → fs.
  // Without this, the home `npm run dev` path 500s with "Can't resolve 'fs'".
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        net: false,
        tls: false,
        child_process: false,
      };
    }
    return config;
  },
};

module.exports = nextConfig;
