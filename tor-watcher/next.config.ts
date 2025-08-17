import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org" },
    ],
  },
  output: "standalone",
   transpilePackages: ["webtorrent"],

  webpack: (config) => {
    // Alias out native deps that break on Windows/Node 22
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      "utp-native": false,
      "node-gyp-build": false,
    };
    return config;
  },
};

export default nextConfig;
