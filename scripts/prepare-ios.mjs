/**
 * Applies the FGame iOS overrides onto a Capacitor-generated iOS project,
 * and patches the Xcode project for the FGame bundle id + signing.
 *
 * Run AFTER `npx cap add ios` / `npx cap sync ios`:
 *     node scripts/prepare-ios.mjs
 *
 * All files that must differ from the stock Capacitor template live in
 * ios-overrides/. Keeping them here (instead of committing a generated
 * ios/ tree) means `cap add ios` can always regenerate a clean project.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const IOS = join(ROOT, "ios", "App");
const OVERRIDES = join(ROOT, "ios-overrides", "App");
const PBXPROJ = join(IOS, "App.xcodeproj", "project.pbxproj");

const BUNDLE_ID = process.env.FGAME_BUNDLE_ID || "com.fgame.daily";
const TEAM = process.env.DEVELOPMENT_TEAM || "";
const MARKETING = process.env.FGAME_VERSION || "1.0.0";
const BUILD = process.env.FGAME_BUILD || "1";

// Version metadata comes from the CI workflow (workflow_dispatch inputs).
// Bake it into Info.plist as literal strings so the version is always
// visible in sideloaders / iOS Settings even if Xcode build settings differ.
if (!/^\d+(\.\d+){0,2}$/.test(MARKETING)) {
  console.error(`✖ 非法版本号: ${MARKETING}（应形如 1.0.0）`);
  process.exit(1);
}
if (!/^\d+$/.test(BUILD)) {
  console.error(`✖ 非法构建号: ${BUILD}（应为整数）`);
  process.exit(1);
}

if (!existsSync(PBXPROJ)) {
  console.error("✖ ios/App/App.xcodeproj not found. Run `npx cap add ios` first.");
  process.exit(1);
}

// 1. Copy overrides (AppDelegate.swift, Info.plist, AppIcon, config).
cpSync(OVERRIDES, IOS, { recursive: true, force: true });
console.log("✓ copied ios-overrides/ -> ios/App/");

// 1b. Bake the version into Info.plist (CFBundleShortVersionString /
//     CFBundleVersion). The override file uses $(MARKETING_VERSION) and
//     $(CURRENT_PROJECT_VERSION) placeholders; replacing them here makes
//     the version independent of Xcode build settings.
const PLIST = join(IOS, "App", "Info.plist");
let plist = readFileSync(PLIST, "utf8");
plist = plist
  .replace(/\$\(MARKETING_VERSION\)/g, MARKETING)
  .replace(/\$\(CURRENT_PROJECT_VERSION\)/g, BUILD);
writeFileSync(PLIST, plist);
console.log(`✓ Info.plist version = ${MARKETING} (${BUILD})`);

// 2. Patch project.pbxproj: bundle id, version, signing style / team.
let pbx = readFileSync(PBXPROJ, "utf8");
pbx = pbx.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`);
pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${MARKETING};`);
pbx = pbx.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${BUILD};`);
if (TEAM) {
  pbx = pbx.replace(/CODE_SIGN_STYLE = [^;]+;/g, "CODE_SIGN_STYLE = Manual;");
  // Ensure DEVELOPMENT_TEAM exists on each build config that has a bundle id.
  pbx = pbx.replace(
    /(PRODUCT_BUNDLE_IDENTIFIER = [^;]+;)/g,
    `$1\n\t\t\t\tDEVELOPMENT_TEAM = ${TEAM};`,
  );
  // Avoid duplicate DEVELOPMENT_TEAM lines on repeated runs.
  pbx = pbx.replace(/(DEVELOPMENT_TEAM = [^;]+;\s*\n\s*)+DEVELOPMENT_TEAM = ([^;]+;)/g, "DEVELOPMENT_TEAM = $2");
} else {
  pbx = pbx.replace(/CODE_SIGN_STYLE = [^;]+;/g, "CODE_SIGN_STYLE = Automatic;");
}
writeFileSync(PBXPROJ, pbx);
console.log(`✓ patched project.pbxproj (bundle id ${BUNDLE_ID}${TEAM ? `, team ${TEAM}` : ", automatic signing"})`);

// 3. Emit an ExportOptions.plist for signed exports (used by CI).
const exportOptions = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>${process.env.EXPORT_METHOD || "development"}</string>
  <key>teamID</key><string>${TEAM}</string>
  <key>signingStyle</key><string>${TEAM ? "manual" : "automatic"}</string>
  ${TEAM && process.env.PROVISIONING_PROFILE_UUID
    ? `<key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${process.env.PROVISIONING_PROFILE_UUID}</string></dict>`
    : ""}
  <key>stripSwiftSymbols</key><true/>
  <key>compileBitcode</key><false/>
</dict>
</plist>
`;
mkdirSync(join(ROOT, "build"), { recursive: true });
writeFileSync(join(ROOT, "build", "ExportOptions.plist"), exportOptions);
console.log("✓ wrote build/ExportOptions.plist");

console.log(`\nFGame v${MARKETING} (build ${BUILD}) — iOS project ready: ios/App/App.xcworkspace`);
