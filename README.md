<div align="center">

# 🍎 xmac

**Cross-compile to macOS from anywhere.**

Downloads and extracts macOS SDKs straight from Apple's public CDN —
no Apple ID, no Mac, no Xcode, and nothing redistributed.

[![ci](https://github.com/jarred-sumner/xmac/actions/workflows/ci.yml/badge.svg)](https://github.com/jarred-sumner/xmac/actions/workflows/ci.yml)
[![release](https://github.com/jarred-sumner/xmac/actions/workflows/release.yml/badge.svg)](https://github.com/jarred-sumner/xmac/releases/tag/latest)
[![license: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#-license--legal)
[![runtime: bun](https://img.shields.io/badge/runtime-bun%20%E2%89%A5%201.1-f9f1e1.svg)](https://bun.sh)

<br>

```console
$ xmac splat --accept-license
Selected Command Line Tools for Xcode 26.5: MacOSX26.5.sdk
  MacOSX26.5.sdk ████████████████████████████ 100% 58.8 MiB / 58.8 MiB
SDK: MacOSX26.5.sdk (macOS 26.5)
  32350 files, 9930 directories, 7451 symlinks, 730 MiB

$ ./xmac-sdk/bin/arm64-apple-darwin-cc -framework CoreFoundation -o hello hello.c
$ file hello
hello: Mach-O 64-bit arm64 executable
```

_A complete, linkable macOS SDK on a Linux box in about four seconds._

</div>

---

[xwin](https://github.com/Jake-Shadle/xwin) made it possible to target
Windows from Linux CI by downloading the MSVC CRT + Windows SDK directly from
Microsoft. **xmac is the same idea for macOS**: Apple serves the _Command Line
Tools for Xcode_ packages — which contain `MacOSX*.sdk` — from its
software-update CDN with **no authentication**. xmac reads the public catalog,
downloads only the **~55 MiB** SDK sub-package, and extracts the `.sdk`
directory plus optional toolchain glue for `clang` + `ld64.lld`.

|                                | download     | needs Apple ID | needs a Mac |
| ------------------------------ | ------------ | -------------- | ----------- |
| Xcode `.xip`                   | 3 – 8 GiB    | ✅ yes         | ✅ yes      |
| Command Line Tools `.dmg`      | ~ 1 GiB      | ✅ yes         | ✅ yes      |
| **xmac** (CLT SDK sub-package) | **~ 55 MiB** | ❌ no          | ❌ no       |

Because every machine downloads the SDK from Apple itself, you never
redistribute Apple's SDK — the same legal posture that makes xwin usable in
CI. You still have to accept Apple's license terms (`--accept-license`).

> [!NOTE]
> **This entire project is AI-generated** — the code, the tests, and this
> README were written by an AI (Claude), directed and reviewed by a human. It
> parses Apple's xar/pbzx/cpio container formats from scratch and is used in
> [Bun](https://github.com/oven-sh/bun)'s CI to cross-compile macOS binaries
> from Linux, but you should review it with the same skepticism you'd apply to
> any new dependency before trusting it in your own build.

## 📦 Install

**Prebuilt binary** (no runtime needed) — from the [rolling `latest`
release](https://github.com/jarred-sumner/xmac/releases/tag/latest) or any versioned
release:

```sh
# glibc (Ubuntu, Debian, Fedora, …)
curl -fsSL https://github.com/jarred-sumner/xmac/releases/latest/download/xmac-linux-x64 -o xmac
# musl (Alpine, distroless, …)
curl -fsSL https://github.com/jarred-sumner/xmac/releases/latest/download/xmac-linux-x64-musl -o xmac
chmod +x xmac
```

**Or run from source** with [Bun](https://bun.sh) ≥ 1.1 — zero runtime
dependencies, nothing to `bun install`:

```sh
bun xmac.ts --help
```

Either way you also need on `PATH`:

- `xz` and `bzip2` for extraction (`apt-get install xz-utils bzip2` — already
  present on most images)
- `clang` ≥ 13 and `lld` (for `ld64.lld`) to actually cross-compile
  (`apt-get install clang lld`)

## 🚀 Usage

```sh
# See every Command Line Tools release Apple is currently serving,
# and which SDKs each one contains
xmac list

# CI one-liner: newest SDK + toolchain files into ./xmac-sdk
xmac splat --accept-license

# A specific SDK version
xmac splat --accept-license --sdk 14 --output /opt/mac

# Both SDKs from a specific Command Line Tools release
xmac splat --accept-license --release 16.4 --sdk all

# Just the .sdk directory, no toolchain files
xmac splat --accept-license --sdk-only

# Read Apple's license terms before accepting them
xmac license
```

`download` → `unpack` → `splat` are progressive: each implies the previous.
Downloads are cached in `./.xmac-cache` (override with `--cache-dir` or
`XMAC_CACHE_DIR`) and verified against the SHA-1 checksums embedded in the
package's signed table of contents.

<details>
<summary><strong><code>xmac list</code> — what's available right now</strong></summary>

```console
$ xmac list
  CLT   RELEASED    PRODUCT    SDKS
  26.5  2026-05-11  047-91568  MacOSX26.5 (58.8 MiB), MacOSX15.4 (53.2 MiB)
  16.4  2025-05-28  082-41241  MacOSX15 (55.8 MiB),   MacOSX14 (56.7 MiB)
  16.2  2025-04-14  072-44426  MacOSX15 (54.5 MiB),   MacOSX14 (56.7 MiB)
  15.3  2024-03-05  052-59890  MacOSX14 (56.6 MiB),   MacOSX13 (48.7 MiB)
  ...
  12.4  2021-04-27  001-89745  MacOSX11.1 (50.2 MiB), MacOSX10.15 (41.3 MiB)
```

Coverage is whatever Apple currently serves — a rolling window, today spanning
macOS 10.15 → 26.5. Older SDKs (back to ~10.12) are reachable by pointing
`--catalog` at one of Apple's older sucatalog URLs. xmac figures out which
`MacOSX*.sdk` is inside each package _without downloading it_, using two HTTP
range requests per package.

</details>

### Output layout

```
xmac-sdk/
├── SDKs/
│   ├── MacOSX26.5.sdk/          # the real SDK: headers, frameworks, .tbd stubs
│   ├── MacOSX26.sdk → MacOSX26.5.sdk
│   └── MacOSX.sdk   → MacOSX26.5.sdk
├── bin/
│   ├── arm64-apple-darwin-cc    # clang wrappers, one per arch
│   ├── arm64-apple-darwin-c++
│   ├── x86_64-apple-darwin-cc
│   └── x86_64-apple-darwin-c++
├── arm64-apple-darwin.toolchain.cmake    # CMake toolchain files, one per
├── x86_64-apple-darwin.toolchain.cmake   #   target triple (+ universal-…
└── env.sh                       # exports CC/CXX/SDKROOT/… for everything else
```

## 🛠 Cross-compiling

### CMake (any generator — Ninja, Makefiles, …)

```sh
cmake -B build -G Ninja --toolchain /path/to/xmac-sdk/arm64-apple-darwin.toolchain.cmake
cmake --build build
```

The toolchain file sets `CMAKE_SYSTEM_NAME=Darwin` (so `if(APPLE)` works),
`CMAKE_OSX_SYSROOT`, the compiler target triple, and the lld linker — and
nothing else. Everything it touches is an `*_INIT` variable, so large projects
that manage their own flags (WebKit, LLVM, Qt, …) keep full control.

| cache variable                | meaning                                            |
| ----------------------------- | -------------------------------------------------- |
| `XMAC_CLANG` / `XMAC_CLANGXX` | compiler to use (default: `clang` on `PATH`)       |
| `XMAC_LLD`                    | path to `ld64.lld`                                 |
| `CMAKE_OSX_ARCHITECTURES`     | `arm64`, `x86_64`, or `arm64;x86_64` for universal |
| `CMAKE_OSX_DEPLOYMENT_TARGET` | minimum macOS version                              |

### Ninja / Make / autotools / shell

```sh
source /path/to/xmac-sdk/env.sh
$CC -framework CoreFoundation -o hello hello.c
# or fully explicit:
clang --target=arm64-apple-macosx11.0 -isysroot "$SDKROOT" -fuse-ld=lld ...
```

`env.sh` exports `CC`, `CXX`, `SDKROOT`, `MACOSX_DEPLOYMENT_TARGET`, plus
`XMAC_CFLAGS` / `XMAC_CXXFLAGS` / `XMAC_LDFLAGS` if you'd rather compose the
flags yourself.

### Cargo / Rust

```sh
rustup target add aarch64-apple-darwin
source /path/to/xmac-sdk/env.sh   # sets CARGO_TARGET_*_LINKER and CC_*/CXX_* for cc-rs
cargo build --target aarch64-apple-darwin
```

### Zig

`zig cc` ships its own headers but still needs the real SDK for frameworks:

```sh
zig cc -target aarch64-macos --sysroot "$SDKROOT" -framework CoreFoundation ...
```

## ⚙️ How it works

```
swscan.apple.com ──► software-update catalog (public XML plist)
                        │  which Command Line Tools releases exist?
                        ▼
swcdn.apple.com  ──► CLTools_macOS*_SDK.pkg   (~55 MiB, no auth)
                        │
                        ▼
                     xar archive ──► pbzx payload ──► cpio archive
                        │               (chunked XZ)      │
                        ▼                                 ▼
                signed SHA-1 TOC                Library/Developer/…/SDKs/
                (verified)                      MacOSX*.sdk  ──►  disk
```

xmac parses all three container formats itself (delegating raw XZ/bzip2
decompression to the system `xz`/`bzip2` binaries), streams the payload
straight to disk, and keeps only `…/SDKs/**`. There is no hardcoded version
list anywhere — when Apple publishes a new SDK, `xmac list` shows it the same
day with no update to the tool.

## 📚 What's in the SDK (and what isn't)

The macOS SDK is headers, module maps and `.tbd` text stubs (linker import
libraries) — no executable code. That is why it is enough for _building_: the
real dylibs live on the end user's Mac and are bound at load time. You can
compile and link complete Mach-O executables, dylibs and bundles for `arm64`
and `x86_64` with nothing but this SDK, clang and lld.

Not included (not in the SDK package, and macOS-only binaries anyway):
`codesign`, `actool`, `ibtool`, `xcodebuild`, the Swift compiler. For code
signing from Linux use [`rcodesign`](https://crates.io/crates/apple-codesign);
note `ld64.lld` already writes the ad-hoc signature arm64 macOS requires, so
plain executables run as-is.

## ⚖️ License & legal

The xmac _tool_ is dual-licensed under [MIT](LICENSE-MIT) or
[Apache-2.0](LICENSE-APACHE), at your option.

The SDK it downloads is Apple's, licensed under the _macOS SDK and Xcode
Agreement_ (run `xmac license` to read it). In short: you may use it to
develop software for Apple platforms; you may not redistribute the SDK itself.
Practically, that means **run xmac in your CI job** (the cache makes repeat
runs cheap) rather than committing the extracted SDK to a repository or
publishing it inside a container image. xmac never uploads anything and only
talks to `swscan.apple.com` / `swdist.apple.com` / `swcdn.apple.com`.

This project is not affiliated with or endorsed by Apple Inc.
