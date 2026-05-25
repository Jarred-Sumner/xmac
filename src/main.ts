/** CLI entry point: argument parsing and command dispatch. */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_SUCATALOG, die, log, setQuiet, VERSION, XmacError } from "./util";
import {
  checkLicense,
  cmdDownload,
  cmdList,
  cmdLicense,
  cmdSplat,
  cmdUnpack,
  type GlobalOpts,
} from "./commands";
import { displayName, getManifest, selectSdks } from "./catalog";
import { normalizeArch } from "./toolchain";
import { status } from "./ui";

const HELP = `xmac ${VERSION}
Download and extract macOS SDKs from Apple's public CDN for cross-compilation.

USAGE:
  xmac [GLOBAL OPTIONS] <COMMAND> [OPTIONS]

COMMANDS:
  list      List Command Line Tools releases and the SDKs they contain
  download  Download SDK package(s) into the cache
  unpack    Download + extract package payloads into the cache
  splat     Download + unpack + emit an SDK and cross-compilation toolchain
  license   Print Apple's license terms for a release
  clean     Remove the cache directory

GLOBAL OPTIONS:
  --cache-dir <DIR>     Cache directory [default: ./.xmac-cache]
  --catalog <URL>       Apple software-update catalog URL to use
  --offline             Never hit the network; fail if the cache is missing
  --json                Machine-readable output (list)
  -q, --quiet           Suppress progress output
  -h, --help            Show this help
  -V, --version         Show version

SELECTION OPTIONS (download / unpack / splat):
  --sdk <SPEC>          Which SDK to fetch. One of:
                          latest          newest SDK available (default)
                          <major[.minor]> e.g. "15", "15.2", "MacOSX14.5"
                          all             every SDK in the chosen release
  --release <VER|ID>    Pin a Command Line Tools release (e.g. "16.2" or a
                        product id like "072-44426") instead of searching all
  --accept-license      Accept Apple's license terms non-interactively.
                        Required in CI. See \`xmac license\`.

SPLAT OPTIONS:
  --output <DIR>        Output directory [default: ./xmac-sdk]
  --arch <LIST>         Default target arch for the toolchain files: arm64,
                        x86_64, or arm64,x86_64 for universal binaries
                        [default: arm64]. Wrapper scripts for every arch are
                        always emitted; this only sets the default.
  --min-os <VER>        Deployment target baked into toolchain files
                        [default: 11.0]
  --sdk-only            Only emit the .sdk directory, no toolchain files
  --copy-symlinks       Materialize symlinks as file copies (for filesystems
                        or tools that cannot handle symlinks)

OUTPUT:
  Progress and status go to stderr. Final results go to stdout as stable
  \`key: value\` lines when stdout is not a terminal, e.g.:
      SDKROOT=$(xmac splat --accept-license -q | awk '/^sdk-path:/{print $2}')

EXAMPLES:
  # See what Apple is currently serving
  xmac list

  # CI one-liner: newest SDK + toolchain into ./xmac-sdk
  xmac splat --accept-license

  # A specific SDK, universal toolchain
  xmac splat --accept-license --sdk 14 --arch arm64,x86_64 --output /opt/mac

  # Then cross-compile:
  cmake -B build -G Ninja --toolchain /opt/mac/arm64-apple-darwin.toolchain.cmake
  # ...or without CMake:
  source /opt/mac/env.sh && $CC hello.c -o hello
`;

interface ParsedArgs {
  command?: string;
  flags: Map<string, string | boolean>;
  positional: string[];
}

const FLAGS_WITH_VALUES = new Set([
  "--cache-dir",
  "--catalog",
  "--sdk",
  "--release",
  "--output",
  "--arch",
  "--min-os",
]);

const KNOWN_BOOL_FLAGS = new Set([
  "--offline",
  "--json",
  "--quiet",
  "-q",
  "--help",
  "-h",
  "--version",
  "-V",
  "--accept-license",
  "--sdk-only",
  "--copy-symlinks",
  "--preserve-symlinks",
  "--refresh",
]);

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { flags: new Map(), positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const key = a.slice(0, eq);
        if (!FLAGS_WITH_VALUES.has(key)) die(`unknown option '${key}'. Run \`xmac --help\`.`);
        out.flags.set(key, a.slice(eq + 1));
        continue;
      }
      if (FLAGS_WITH_VALUES.has(a)) {
        const v = argv[++i];
        if (v === undefined) die(`${a} requires a value`);
        out.flags.set(a, v);
      } else if (KNOWN_BOOL_FLAGS.has(a)) {
        out.flags.set(a, true);
      } else {
        die(`unknown option '${a}'. Run \`xmac --help\`.`);
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      if (!KNOWN_BOOL_FLAGS.has(a)) die(`unknown option '${a}'. Run \`xmac --help\`.`);
      out.flags.set(a, true);
      continue;
    }
    if (!out.command) out.command = a;
    else out.positional.push(a);
  }
  return out;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("-V") || args.flags.has("--version")) {
    console.log(`xmac ${VERSION}`);
    return;
  }
  if (args.flags.has("-h") || args.flags.has("--help") || !args.command) {
    console.log(HELP);
    return;
  }
  setQuiet(Boolean(args.flags.get("-q") || args.flags.get("--quiet")));

  const opts: GlobalOpts = {
    cacheDir: path.resolve(
      String(args.flags.get("--cache-dir") ?? process.env["XMAC_CACHE_DIR"] ?? "./.xmac-cache"),
    ),
    catalog: String(
      args.flags.get("--catalog") ?? process.env["XMAC_CATALOG"] ?? DEFAULT_SUCATALOG,
    ),
    offline: Boolean(args.flags.get("--offline")),
    json: Boolean(args.flags.get("--json")),
  };

  const knownCommands = ["list", "download", "unpack", "splat", "clean", "license"];
  if (!knownCommands.includes(args.command))
    die(`unknown command '${args.command}'. Run \`xmac --help\`.`);

  if (args.command === "clean") {
    fs.rmSync(opts.cacheDir, { recursive: true, force: true });
    log(`removed ${opts.cacheDir}`);
    return;
  }
  if (args.command === "list") {
    await cmdList(opts, Boolean(args.flags.get("--refresh")));
    return;
  }
  if (args.command === "license") {
    await cmdLicense(
      opts,
      (args.flags.get("--release") as string | undefined) ?? args.positional[0],
    );
    return;
  }

  // download / unpack / splat all need a selection + license acceptance.
  checkLicense(Boolean(args.flags.get("--accept-license")));
  const manifest = await getManifest(opts);
  const sel = selectSdks(
    manifest,
    String(args.flags.get("--sdk") ?? "latest"),
    args.flags.get("--release") as string | undefined,
  );
  status(
    `Selected ${displayName(sel.release)} (${sel.release.productId}, ${sel.release.postDate}): ${sel.packages
      .map((p) => p.sdkName ?? p.fileName)
      .join(", ")}`,
  );

  if (args.command === "download") {
    await cmdDownload(opts, sel);
    return;
  }
  if (args.command === "unpack") {
    await cmdUnpack(opts, sel);
    return;
  }
  if (args.command === "splat") {
    const archs = String(args.flags.get("--arch") ?? "arm64")
      .split(",")
      .filter((a) => a.trim() !== "")
      .map(normalizeArch);
    if (archs.length === 0) die("--arch requires at least one architecture");
    await cmdSplat(opts, sel, {
      output: String(args.flags.get("--output") ?? "./xmac-sdk"),
      archs: [...new Set(archs)],
      minOs: String(args.flags.get("--min-os") ?? "11.0"),
      sdkOnly: Boolean(args.flags.get("--sdk-only")),
      copySymlinks: Boolean(args.flags.get("--copy-symlinks")),
    });
    return;
  }
}

export function run() {
  main().catch((e) => {
    if (e instanceof XmacError) die(e.message);
    console.error(e);
    process.exit(1);
  });
}
