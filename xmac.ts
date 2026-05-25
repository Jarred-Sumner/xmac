#!/usr/bin/env bun
/**
 * xmac — download and extract macOS SDKs for cross-compilation, without
 * redistributing Apple's SDK.
 *
 * Like https://github.com/Jake-Shadle/xwin, but for macOS: Apple publicly
 * serves "Command Line Tools for Xcode" packages (which contain the macOS
 * SDK) from its software-update CDN with no authentication. xmac fetches the
 * catalog, downloads the SDK package(s) of your choosing directly from Apple,
 * and extracts just the `MacOSX*.sdk` directory plus toolchain glue for
 * clang/lld cross-compilation from Linux (CMake, Ninja, Make, Cargo, ...).
 *
 * Because every machine downloads from Apple itself, you never redistribute
 * the SDK. You must still accept Apple's license terms (--accept-license).
 *
 * Zero npm dependencies. External tools: `xz` and `bzip2`.
 * The implementation lives in ./src; this file is the CLI entry point so that
 * both `bun xmac.ts` and `bun build --compile ./xmac.ts` keep working.
 */

import { run } from "./src/main";

run();
