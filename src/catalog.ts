/**
 * Apple software-update catalog → Command Line Tools releases → SDK packages.
 *
 * The catalog is a public XML plist listing every product Apple's Software
 * Update currently serves. Command Line Tools products are split into
 * sub-packages; the macOS SDK lives in its own ~55 MiB package, so we never
 * have to touch the ~600 MiB of compiler executables.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { asBuffer, compareVersions, log, mapLimit, XmacError, type GlobalOpts } from "./util";
import { httpGetBytes } from "./net";
import { parsePlist, type PlistValue } from "./xml";
import { parseXarHeader, parseXarToc } from "./xar";
import { decompressWith } from "./exec";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CatalogPackage {
  url: string;
  size: number;
  digest?: string;
  metadataUrl?: string;
}

export interface SdkPackage {
  /** e.g. "CLTools_macOSNMOS_SDK.pkg" */
  fileName: string;
  url: string;
  size: number;
  digest?: string;
  /** Resolved name of the SDK inside, e.g. "MacOSX15.2.sdk". */
  sdkName?: string;
  /** e.g. "15.2" */
  sdkVersion?: string;
}

export interface CltRelease {
  productId: string;
  postDate: string;
  /** Marketing version of the Command Line Tools, e.g. "16.2". */
  version: string;
  title: string;
  distributionUrl?: string;
  /** The SDK payload packages within the product. */
  sdkPackages: SdkPackage[];
}

export interface Manifest {
  catalogUrl: string;
  fetchedAt: string;
  releases: CltRelease[];
}

export interface Selection {
  release: CltRelease;
  packages: SdkPackage[];
}

/** "Command Line Tools for Xcode 26.5" + "26.5" → no doubled version. */
export function displayName(r: { title: string; version: string }): string {
  return r.title.endsWith(r.version) ? r.title : `${r.title} ${r.version}`;
}

// ---------------------------------------------------------------------------
// Catalog parsing
// ---------------------------------------------------------------------------

function isSdkPackage(url: string): boolean {
  const f = url.split("/").pop() ?? "";
  // CLTools_macOS_SDK.pkg in modern products is a tiny stub; the real SDKs
  // are the (N|L)MOS variants. In older products CLTools_macOS_SDK.pkg *is*
  // the SDK. Keep anything that is plausibly an SDK payload and let size +
  // payload inspection sort it out.
  return /^CLTools_.*SDK.*\.pkg$/i.test(f) && !/DevSDK_Remove/i.test(f);
}

async function fetchCatalog(catalogUrl: string): Promise<PlistValue> {
  let data = await httpGetBytes(catalogUrl);
  if (data[0] === 0x1f && data[1] === 0x8b) data = zlib.gunzipSync(data);
  return parsePlist(new TextDecoder().decode(data));
}

/** Extract the Command Line Tools products from a parsed sucatalog. */
function extractCltProducts(catalog: PlistValue): {
  productId: string;
  postDate: string;
  distributionUrl?: string;
  packages: CatalogPackage[];
}[] {
  const products = (catalog as Record<string, PlistValue>)["Products"] as
    | Record<string, PlistValue>
    | undefined;
  if (!products) throw new XmacError("catalog: missing Products dict");
  const out: ReturnType<typeof extractCltProducts> = [];
  for (const [productId, p] of Object.entries(products)) {
    const prod = p as Record<string, PlistValue>;
    const pkgs = (prod["Packages"] as PlistValue[] | undefined) ?? [];
    const packages: CatalogPackage[] = pkgs.map((x) => {
      const d = x as Record<string, PlistValue>;
      return {
        url: String(d["URL"] ?? ""),
        size: Number(d["Size"] ?? 0),
        digest: d["Digest"] ? String(d["Digest"]) : undefined,
        metadataUrl: d["MetadataURL"] ? String(d["MetadataURL"]) : undefined,
      };
    });
    if (!packages.some((x) => /\/CLTools_/.test(x.url))) continue;
    if (!packages.some((x) => isSdkPackage(x.url))) continue;
    const dists = prod["Distributions"] as Record<string, PlistValue> | undefined;
    const distributionUrl = dists
      ? String(dists["English"] ?? dists["en"] ?? Object.values(dists)[0] ?? "")
      : undefined;
    const postDate = prod["PostDate"];
    out.push({
      productId,
      postDate:
        postDate instanceof Date ? postDate.toISOString().slice(0, 10) : String(postDate ?? ""),
      distributionUrl: distributionUrl || undefined,
      packages,
    });
  }
  return out;
}

/** Pull the human title + version out of a .dist installer script. */
async function fetchDistInfo(url: string): Promise<{ title: string; version: string }> {
  const text = new TextDecoder().decode(await httpGetBytes(url));
  // The localization block contains: "SU_TITLE" = "Command Line Tools for Xcode";
  // and "SU_VERS" = "16.2". Fall back to <title> if not templated.
  const grab = (key: string) => {
    const m = new RegExp(`"${key}"\\s*=\\s*"([^"]*)"`).exec(text);
    return m ? m[1] : undefined;
  };
  let title = grab("SU_TITLE");
  let version = grab("SU_VERS");
  if (!title) {
    const m = /<title>([^<]*)<\/title>/.exec(text);
    if (m && m[1] !== "SU_TITLE") title = m[1];
  }
  if (!version) {
    // Fall back to the pkg-ref version attribute, e.g. "16.2.0.0.1.1733547573".
    const m = /<pkg-ref[^>]*\bversion="(\d+\.\d+)/.exec(text);
    if (m) version = m[1];
  }
  return { title: title ?? "Command Line Tools", version: version ?? "?" };
}

/** Fetch the raw English .dist (installer script + license) for a release. */
export async function fetchDistribution(release: CltRelease): Promise<string> {
  if (!release.distributionUrl)
    throw new XmacError("no distribution document is available for this release");
  return new TextDecoder().decode(await httpGetBytes(release.distributionUrl));
}

/**
 * Determine which `MacOSX*.sdk` lives inside an SDK package without
 * downloading it: range-request the xar header + TOC, locate the Payload,
 * range-request the start of its first XZ chunk, decompress the prefix and
 * scan the first cpio entries for `SDKs/<name>.sdk`.
 */
async function peekSdkName(pkg: SdkPackage): Promise<string | undefined> {
  try {
    // 1. xar header + TOC. 64 KiB covers every CLT SDK package observed;
    //    fall back to an exact second request if the TOC is larger.
    let head = await httpGetBytes(pkg.url, [0, 65535]);
    const hdr = parseXarHeader(head);
    if (head.length < hdr.headerSize + hdr.tocCompressedLength) {
      head = await httpGetBytes(pkg.url, [0, hdr.headerSize + hdr.tocCompressedLength - 1]);
    }
    const toc = zlib.inflateSync(
      head.subarray(hdr.headerSize, hdr.headerSize + hdr.tocCompressedLength),
    );
    const entries = parseXarToc(new TextDecoder().decode(toc));
    const payload = entries.find((e) => e.name === "Payload");
    if (!payload) return undefined;

    // 2. Start of the payload. 96 KiB of an XZ stream decompresses to far
    //    more than the few hundred bytes of cpio we need.
    const start = hdr.heapStart + payload.offset;
    const want = Math.min(payload.size, 96 * 1024);
    const data = await httpGetBytes(pkg.url, [start, start + want - 1]);
    let cpio: Uint8Array;
    if (new TextDecoder().decode(data.subarray(0, 4)) === "pbzx") {
      const b = asBuffer(data);
      const uncompressedSize = Number(b.readBigUInt64BE(12));
      const compressedSize = Number(b.readBigUInt64BE(20));
      const chunk = data.subarray(28, Math.min(28 + compressedSize, data.length));
      cpio =
        compressedSize === uncompressedSize
          ? chunk // stored raw
          : await decompressWith("xz", ["-dcq"], chunk, /*allowFailure*/ true);
    } else if (data[0] === 0x1f && data[1] === 0x8b) {
      cpio = await decompressWith("gzip", ["-dcq"], data, true);
    } else {
      return undefined;
    }
    const text = asBuffer(cpio.subarray(0, 65536)).toString("latin1");
    const m = /SDKs\/([A-Za-z0-9_.]+\.sdk)/.exec(text);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Manifest (cached, resolved view of the catalog)
// ---------------------------------------------------------------------------

export async function getManifest(opts: GlobalOpts, forceRefresh = false): Promise<Manifest> {
  const cachePath = path.join(opts.cacheDir, "manifest.json");
  if (!forceRefresh && fs.existsSync(cachePath)) {
    try {
      const m = JSON.parse(fs.readFileSync(cachePath, "utf8")) as Manifest;
      if (m.catalogUrl === opts.catalog && Array.isArray(m.releases)) {
        const age = Date.now() - new Date(m.fetchedAt).getTime();
        if (opts.offline || age < 24 * 3600 * 1000) return m;
      }
    } catch {
      /* fall through to refetch */
    }
  }
  if (opts.offline)
    throw new XmacError(
      `--offline was passed but no cached manifest exists at ${cachePath}. Run \`xmac list\` online once first.`,
    );

  log(`Fetching Apple software update catalog…`);
  const catalog = await fetchCatalog(opts.catalog);
  const products = extractCltProducts(catalog);
  log(`Resolving ${products.length} Command Line Tools releases…`);

  const releases = await mapLimit(products, 8, async (p) => {
    const sdkPkgs = p.packages
      .filter((x) => isSdkPackage(x.url))
      .map<SdkPackage>((x) => ({
        fileName: x.url.split("/").pop() ?? "pkg",
        url: x.url,
        size: x.size,
        digest: x.digest,
      }))
      // Tiny stub packages (a few KiB) are uninstall/cleanup helpers.
      .filter((x) => x.size > 1024 * 1024);
    const info = p.distributionUrl
      ? await fetchDistInfo(p.distributionUrl).catch(() => ({
          title: "Command Line Tools",
          version: "?",
        }))
      : { title: "Command Line Tools", version: "?" };
    await Promise.all(
      sdkPkgs.map(async (s) => {
        s.sdkName = await peekSdkName(s);
        if (s.sdkName) {
          const m = /^MacOSX(\d+(?:\.\d+)*)\.sdk$/i.exec(s.sdkName);
          if (m) s.sdkVersion = m[1];
        }
      }),
    );
    const rel: CltRelease = {
      productId: p.productId,
      postDate: p.postDate,
      version: info.version,
      title: info.title,
      distributionUrl: p.distributionUrl,
      sdkPackages: sdkPkgs,
    };
    return rel;
  });

  const filtered = releases.filter((r) => r.sdkPackages.length > 0);
  filtered.sort((a, b) => {
    const d = a.postDate.localeCompare(b.postDate);
    return d !== 0 ? d : compareVersions(a.version, b.version);
  });
  filtered.reverse();

  const manifest: Manifest = {
    catalogUrl: opts.catalog,
    fetchedAt: new Date().toISOString(),
    releases: filtered,
  };
  fs.mkdirSync(opts.cacheDir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(manifest, null, 2));
  return manifest;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function selectSdks(manifest: Manifest, sdkSpec: string, releaseSpec?: string): Selection {
  let releases = manifest.releases;
  if (releases.length === 0)
    throw new XmacError("no Command Line Tools releases found in the catalog");

  if (releaseSpec) {
    releases = releases.filter((r) => r.productId === releaseSpec || r.version === releaseSpec);
    if (releases.length === 0)
      throw new XmacError(
        `no Command Line Tools release matches '${releaseSpec}'. Run \`xmac list\` to see what is available.`,
      );
  }

  const spec = sdkSpec.trim();
  if (spec.toLowerCase() === "all") {
    const release = releases[0];
    return { release, packages: release.sdkPackages };
  }

  // Collect every (release, package) candidate, newest release first.
  const candidates: { release: CltRelease; pkg: SdkPackage }[] = [];
  for (const r of releases) for (const p of r.sdkPackages) candidates.push({ release: r, pkg: p });

  if (spec.toLowerCase() === "latest") {
    // Highest SDK version across all considered releases; prefer the newest
    // release if versions tie or are unknown.
    let best: { release: CltRelease; pkg: SdkPackage } | undefined;
    for (const cand of candidates) {
      if (!best) {
        best = cand;
        continue;
      }
      const a = cand.pkg.sdkVersion ?? "0";
      const b = best.pkg.sdkVersion ?? "0";
      if (compareVersions(a, b) > 0) best = cand;
    }
    if (!best) throw new XmacError("no SDK packages found");
    return { release: best.release, packages: [best.pkg] };
  }

  // Normalize "MacOSX14.5.sdk" / "macosx14.5" / "14.5" / "14" → version prefix.
  const vm = /^(?:macosx)?(\d+(?:\.\d+)*)(?:\.sdk)?$/i.exec(spec);
  if (!vm)
    throw new XmacError(
      `invalid --sdk '${spec}'. Use 'latest', 'all', a version like '14.5', or a name like 'MacOSX14.5.sdk'.`,
    );
  const wanted = vm[1];
  const exact = candidates.filter((cand) => cand.pkg.sdkVersion === wanted);
  const prefix = candidates.filter(
    (cand) =>
      cand.pkg.sdkVersion &&
      (cand.pkg.sdkVersion === wanted || cand.pkg.sdkVersion.startsWith(wanted + ".")),
  );
  let pool = exact.length > 0 ? exact : prefix;
  if (pool.length === 0) {
    const known = [
      ...new Set(candidates.map((cand) => cand.pkg.sdkVersion).filter(Boolean) as string[]),
    ].sort(compareVersions);
    throw new XmacError(
      `no macOS ${wanted} SDK found in the catalog.\nAvailable SDK versions: ${known.join(", ")}`,
    );
  }
  // Prefer the highest matching SDK version, then the newest release.
  pool = [...pool].sort((a, b) => {
    const d = compareVersions(b.pkg.sdkVersion ?? "0", a.pkg.sdkVersion ?? "0");
    return d !== 0 ? d : b.release.postDate.localeCompare(a.release.postDate);
  });
  return { release: pool[0].release, packages: [pool[0].pkg] };
}
