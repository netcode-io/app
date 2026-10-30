import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

function executableRelativePath() {
  if (platform() === "darwin") return "Electron.app/Contents/MacOS/Electron";
  if (platform() === "win32") return "electron.exe";
  return "electron";
}

/**
 * Electron's postinstall uses extract-zip, which exits before the archive is
 * unpacked on current Node. Unpack with tar when the binary is missing.
 * @returns {Promise<string>} Absolute path to the Electron executable.
 */
export async function ensureElectron() {
  const pkgDir = dirname(require.resolve("electron/package.json"));
  const relativeExe = executableRelativePath();
  const exePath = join(pkgDir, "dist", relativeExe);
  const pathFile = join(pkgDir, "path.txt");
  if (existsSync(exePath) && existsSync(pathFile)) return exePath;

  const electronRequire = createRequire(join(pkgDir, "install.js"));
  const { downloadArtifact } = electronRequire("@electron/get");
  const { version } = electronRequire("./package.json");
  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: process.platform,
    arch: process.arch,
    checksums: electronRequire("./checksums.json"),
  });

  const distDir = join(pkgDir, "dist");
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  execFileSync("tar", ["-xf", zipPath, "-C", distDir], { stdio: "inherit" });
  if (!existsSync(exePath)) {
    throw new Error(`Electron archive did not contain ${relativeExe}`);
  }
  writeFileSync(pathFile, relativeExe);
  return exePath;
}
