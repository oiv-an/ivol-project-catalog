import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  throw new Error(
    "Пакет с помощником macOS нужно собирать на macOS (Apple Command Line Tools). Проверка JavaScript доступна на любой ОС.",
  );
}
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const output = "native/macos/bin/IVOLCatalogMenu.app/Contents";
const temporary = "artifacts/macos";
mkdirSync(`${output}/MacOS`, { recursive: true });
mkdirSync(temporary, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} завершился с кодом ${result.status}`);
}
for (const arch of ["arm64", "x86_64"]) {
  run("xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-O",
    "-framework",
    "AppKit",
    "-target",
    `${arch}-apple-macosx14.0`,
    "native/macos/MenuBar.swift",
    "-o",
    `${temporary}/IVOLCatalogMenu-${arch}`,
  ]);
}
run("xcrun", [
  "lipo",
  "-create",
  `${temporary}/IVOLCatalogMenu-arm64`,
  `${temporary}/IVOLCatalogMenu-x86_64`,
  "-output",
  `${output}/MacOS/IVOLCatalogMenu`,
]);
writeFileSync(
  `${output}/Info.plist`,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ivol.catalog.menubar</string>
<key>CFBundleName</key><string>IVOL Cataloger</string>
<key>CFBundleExecutable</key><string>IVOLCatalogMenu</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
);
run("/usr/bin/codesign", [
  "--force",
  "--sign",
  "-",
  "--timestamp=none",
  "native/macos/bin/IVOLCatalogMenu.app",
]);
console.log("Помощник macOS собран: Apple Silicon + Intel, macOS 14+.");
