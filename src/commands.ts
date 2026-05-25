/** The xmac subcommands. */

import * as fs from "node:fs";
import * as path from "node:path";
import { compareVersions, die, humanSize, thousands, XmacError, type GlobalOpts } from "./util";
import { c, interactive, ok, result, status, table } from "./ui";
import { decodeEntities } from "./xml";
import { downloadTo } from "./net";
import {
  displayName,
  fetchDistribution,
  getManifest,
  selectSdks,
  type CltRelease,
  type SdkPackage,
  type Selection,
} from "./catalog";
import { newStats, splatPackage } from "./extract";
import { emitToolchain } from "./toolchain";

export type { GlobalOpts };

// ---------------------------------------------------------------------------
// License
// ---------------------------------------------------------------------------

export const LICENSE_NOTICE = `The macOS SDK is licensed by Apple Inc. under the "macOS SDK and Xcode
Agreement" (and, for SDKs obtained through Xcode, the Xcode and Apple SDKs
Agreement). xmac downloads the SDK directly from Apple's servers to *this*
machine — it does not redistribute anything — but by extracting and using the
SDK you are agreeing to Apple's license terms, which notably restrict the SDK
to developing software for Apple platforms and prohibit redistributing the SDK
itself (e.g. do not commit the extracted SDK to a public repository or bake it
into a public container image).

View the full text with \`xmac license --release <ver>\` or at:
  https://www.apple.com/legal/sla/

Pass --accept-license to proceed.`;

export function checkLicense(accepted: boolean) {
  if (accepted) return;
  // Write directly: console.error would colorize the whole notice red on a
  // TTY, making an informational message look like an error.
  process.stderr.write(LICENSE_NOTICE + "\n");
  if (process.stdin.isTTY && process.stderr.isTTY) {
    const answer = prompt("\nDo you accept the license terms? [y/N]");
    if (answer && /^y(es)?$/i.test(answer.trim())) return;
    die("license not accepted");
  }
  die("pass --accept-license to accept Apple's license terms non-interactively");
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function cmdList(opts: GlobalOpts, refresh: boolean) {
  const manifest = await getManifest(opts, refresh);
  if (opts.json) {
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  console.log(c.bold(`Command Line Tools releases from Apple's software-update catalog`));
  console.log(c.dim(`catalog fetched ${manifest.fetchedAt}`));
  console.log("");
  const rows: string[][] = [["CLT", "RELEASED", "PRODUCT", "SDKS"]];
  for (const r of manifest.releases) {
    const sdks = r.sdkPackages
      .map(
        (s) =>
          `${interactive ? c.cyan(s.sdkName?.replace(/\.sdk$/, "") ?? s.fileName) : (s.sdkName?.replace(/\.sdk$/, "") ?? s.fileName)} ${c.dim(`(${humanSize(s.size)})`)}`,
      )
      .join(", ");
    rows.push([r.version, r.postDate, r.productId, sdks]);
  }
  table(rows);
  console.log("");
  console.log(c.dim(`Use \`xmac splat --accept-license --sdk <version>\` to fetch one.`));
}

// ---------------------------------------------------------------------------
// license
// ---------------------------------------------------------------------------

export async function cmdLicense(opts: GlobalOpts, releaseSpec?: string) {
  const manifest = await getManifest(opts);
  if (manifest.releases.length === 0) die("no Command Line Tools releases found in the catalog");
  const release = releaseSpec
    ? selectSdks(manifest, "all", releaseSpec).release
    : manifest.releases[0];
  const text = await fetchDistribution(release);
  const m = /<license[^>]*>([\s\S]*?)<\/license>/.exec(text);
  if (!m) die("could not locate the license text in the distribution file");
  // The license is RTF; strip control words for terminal display.
  const rtf = decodeEntities(m[1]);
  const plain = rtf
    .replace(/\{\\(?:fonttbl|colortbl|\*\\[a-z]+)[^{}]*\}/g, "")
    .replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\tab\b/g, "\t")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/^[\s;]+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  console.log(c.bold(`# License for ${displayName(release)}`));
  console.log("");
  console.log(plain);
}

// ---------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------

function pkgCachePath(opts: GlobalOpts, release: CltRelease, pkg: SdkPackage) {
  return path.join(opts.cacheDir, "dl", release.productId, pkg.fileName);
}

export async function cmdDownload(opts: GlobalOpts, sel: Selection): Promise<string[]> {
  const paths: string[] = [];
  status(`Downloading ${sel.packages.length} package(s) for ${displayName(sel.release)}`);
  for (const pkg of sel.packages) {
    const dest = pkgCachePath(opts, sel.release, pkg);
    if (opts.offline) {
      if (!fs.existsSync(dest)) throw new XmacError(`--offline: ${dest} is not in the cache`);
    } else {
      // Note: the catalog's `Digest` field is not a plain SHA-1 of the file,
      // so it cannot be used for verification. Integrity is checked against
      // the xar TOC's archived-checksum during extraction instead.
      await downloadTo(pkg.url, dest, pkg.size, undefined, `${pkg.sdkName ?? pkg.fileName}`);
    }
    paths.push(dest);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// unpack
// ---------------------------------------------------------------------------

export async function cmdUnpack(opts: GlobalOpts, sel: Selection): Promise<void> {
  const pkgPaths = await cmdDownload(opts, sel);
  const results: [string, string][] = [];
  for (const p of pkgPaths) {
    const dest = p.replace(/\.pkg$/i, "") + ".unpacked";
    fs.mkdirSync(dest, { recursive: true });
    const stats = newStats();
    status(`Unpacking ${path.basename(p)}`);
    await splatPackage(p, dest, false, stats);
    ok(
      `${path.basename(p)}: ${thousands(stats.files)} files, ${humanSize(stats.bytes)} (${stats.sdkNames.join(", ") || "no SDK found"})`,
    );
    for (const n of stats.sdkNames)
      results.push([n.replace(/\.sdk$/, ""), path.join(dest, "SDKs", n)]);
  }
  result(results.map(([k, v]) => [`sdk-path[${k}]`, v]));
}

// ---------------------------------------------------------------------------
// splat
// ---------------------------------------------------------------------------

export interface SplatOpts {
  output: string;
  archs: string[];
  minOs: string;
  sdkOnly: boolean;
  copySymlinks: boolean;
}

function readSdkSettings(outDir: string, sdkName: string): { display?: string; version?: string } {
  try {
    const s = JSON.parse(
      fs.readFileSync(path.join(outDir, "SDKs", sdkName, "SDKSettings.json"), "utf8"),
    );
    return { display: s.DisplayName, version: s.Version };
  } catch {
    return {};
  }
}

export async function cmdSplat(opts: GlobalOpts, sel: Selection, splat: SplatOpts): Promise<void> {
  const pkgPaths = await cmdDownload(opts, sel);
  const outDir = path.resolve(splat.output);
  fs.mkdirSync(outDir, { recursive: true });

  const stats = newStats();
  status(`Extracting into ${outDir}`);
  for (const p of pkgPaths) {
    await splatPackage(p, outDir, splat.copySymlinks, stats);
  }
  if (stats.sdkNames.length === 0)
    throw new XmacError("no MacOSX*.sdk directory was found in the package payload(s)");

  // Pick the "main" SDK for toolchain files: the highest versioned one.
  const named = stats.sdkNames
    .map((n) => ({ n, v: /MacOSX(\d+(?:\.\d+)*)\.sdk/i.exec(n)?.[1] }))
    .sort((a, b) => compareVersions(b.v ?? "0", a.v ?? "0"));
  const mainSdk = named[0].n;

  let emitted: { cmake: string; env: string; wrappers: string[] } | undefined;
  if (!splat.sdkOnly) {
    emitted = emitToolchain(outDir, mainSdk, splat.archs, splat.minOs);
  }

  // A few convenience symlinks Apple's own layout provides.
  for (const { n, v } of named) {
    if (!v) continue;
    const major = v.split(".")[0];
    for (const alias of [`MacOSX${major}.sdk`, "MacOSX.sdk"]) {
      const aliasPath = path.join(outDir, "SDKs", alias);
      if (!fs.existsSync(aliasPath) && !stats.sdkNames.includes(alias)) {
        try {
          fs.symlinkSync(n, aliasPath);
        } catch {}
      }
    }
  }

  // --- summary -------------------------------------------------------------
  const settings = readSdkSettings(outDir, mainSdk);
  ok(
    `${c.bold(mainSdk)}${settings.display ? ` ${c.dim(`(${settings.display})`)}` : ""} — ${thousands(stats.files)} files, ${thousands(stats.dirs)} directories, ${thousands(stats.symlinks)} symlinks, ${humanSize(stats.bytes)}`,
  );
  if (interactive) console.log("");

  const pairs: [string, string][] = [];
  for (const { n } of named) {
    const s = readSdkSettings(outDir, n);
    pairs.push([named.length > 1 ? `sdk[${n}]` : "sdk", n]);
    if (s.version) pairs.push([named.length > 1 ? `sdk-version[${n}]` : "sdk-version", s.version]);
  }
  pairs.push(["sdk-path", path.join(outDir, "SDKs", mainSdk)]);
  pairs.push(["sdk-root", path.join(outDir, "SDKs")]);
  if (emitted) {
    pairs.push(["toolchain-cmake", emitted.cmake]);
    pairs.push(["env-script", emitted.env]);
    pairs.push(["cc", path.join(outDir, "bin", `${splat.archs[0]}-apple-darwin-cc`)]);
    pairs.push(["cxx", path.join(outDir, "bin", `${splat.archs[0]}-apple-darwin-c++`)]);
  }
  pairs.push(["files", String(stats.files)]);
  pairs.push(["bytes", String(stats.bytes)]);
  result(pairs);

  if (interactive) {
    console.log("");
    console.log(c.bold("Cross-compile with CMake:"));
    console.log(
      c.dim(
        `  cmake -B build -G Ninja --toolchain ${emitted?.cmake ?? `<output>/${splat.archs[0]}-apple-darwin.toolchain.cmake`}`,
      ),
    );
    console.log(c.bold("Or anything else (make, ninja, cargo, ./configure):"));
    console.log(c.dim(`  source ${emitted?.env ?? "<output>/env.sh"} && $CC -o hello hello.c`));
    console.log(c.bold("Or directly:"));
    console.log(
      c.dim(
        `  clang --target=${splat.archs[0]}-apple-macosx${splat.minOs} -isysroot ${path.join(outDir, "SDKs", mainSdk)} -fuse-ld=lld ...`,
      ),
    );
  }
}
