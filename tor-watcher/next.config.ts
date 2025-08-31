import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "image.tmdb.org" },
       { protocol: 'https', hostname: 'cdn.myanimelist.net' },
      // optional but handy if you ever show YT/IMDb assets:
      { protocol: 'https', hostname: 'i.ytimg.com' },
      { protocol: 'https', hostname: 'img.youtube.com' },
      { protocol: 'https', hostname: 'm.media-amazon.com' },
    ],
  },
  output: "standalone",
};

export default nextConfig;
