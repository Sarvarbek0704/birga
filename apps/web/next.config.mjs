/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace libraries ship ESM; let Next transpile them into the bundle.
  transpilePackages: ["@birga/client", "@birga/crdt", "@birga/protocol"],
};

export default nextConfig;
