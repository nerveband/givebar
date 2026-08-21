import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

describe("Client JavaScript Syntax Integrity", () => {
  const jsDir = join(process.cwd(), "client/js");
  const files = readdirSync(jsDir).filter(f => f.endsWith(".js"));

  test("discovers client JavaScript files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`parses ${file} without syntax errors`, () => {
      const fullPath = join(jsDir, file);
      const code = readFileSync(fullPath, "utf8");
      
      const transpiler = new Bun.Transpiler({ loader: "js" });
      expect(() => {
        transpiler.transformSync(code);
      }).not.toThrow();
    });
  }
});
