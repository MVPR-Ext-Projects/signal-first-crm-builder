import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Allow pdf-parse to work in server actions/routes
  serverExternalPackages: ["pdf-parse"],
}

export default nextConfig
