import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // 実 DB テストは同じ DB を共有するので、ファイルを並列に流すと migrate() と行の掃除が衝突する
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
