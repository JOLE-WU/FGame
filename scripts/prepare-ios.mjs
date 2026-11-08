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

if (!existsSync(PBXPROJ)) {
  console.error("✖ ios/App/App.xcodeproj not found. Run `npx cap add ios` first.");
  process.exit(1);
}

// 1. Copy overrides (AppDelegate.swift, Info.plist, AppIcon, config).
cpSync(OVERRIDES, IOS, { recursive: true, force: true });
console.log("✓ copied ios-overrides/ -> ios/App/");

// 2. Patch project.pbxproj: bundle id, version, signing style / team.
let pbx = readFileSync(PBXPROJ, "utf8");
pbx = pbx.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${BUNDLE_ID};`);
pbx = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${MARKETING};`);
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

console.log("\nFGame iOS project ready: ios/App/App.xcworkspace");
