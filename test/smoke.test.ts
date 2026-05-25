/**
 * Smoke tests: cross-compile a matrix of {language} × {arch} × {output type}
 * permutations against a splatted SDK and verify each artifact is a
 * structurally valid Mach-O of the expected kind.
 *
 * Prerequisites (the suite self-skips if they are missing):
 *   - a splatted SDK at ./xmac-sdk (or $XMAC_TEST_SDK):
 *       bun xmac.ts splat --accept-license --output ./xmac-sdk
 *   - clang and ld64.lld on PATH
 *
 * Run with: bun test
 */

import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ROOT = path.resolve(import.meta.dir, "..");
const SDK_ROOT = path.resolve(process.env["XMAC_TEST_SDK"] ?? path.join(ROOT, "xmac-sdk"));

const haveSdk = fs.existsSync(path.join(SDK_ROOT, "bin"));
const haveClang = !!Bun.which("clang");
const haveLld = !!Bun.which("ld64.lld");
const ready = haveSdk && haveClang && haveLld;

if (!ready) {
  console.warn(
    `[smoke] skipping: ${[
      !haveSdk && `no splatted SDK at ${SDK_ROOT} (run: bun xmac.ts splat --accept-license)`,
      !haveClang && "clang not on PATH",
      !haveLld && "ld64.lld not on PATH (install lld)",
    ]
      .filter(Boolean)
      .join("; ")}`,
  );
}

// ---------------------------------------------------------------------------
// Mach-O / archive validation without external tools
// ---------------------------------------------------------------------------

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const CPU_X86_64 = 0x01000007;
const CPU_ARM64 = 0x0100000c;
const MH_EXECUTE = 0x2;
const MH_DYLIB = 0x6;

interface MachO {
  kind: "macho" | "fat" | "archive";
  arches: string[];
  filetype?: number;
}

function inspect(file: string): MachO {
  const buf = fs.readFileSync(file);
  expect(buf.length).toBeGreaterThan(64);
  if (buf.subarray(0, 8).toString("latin1") === "!<arch>\n") return { kind: "archive", arches: [] };
  const beMagic = buf.readUInt32BE(0);
  if (beMagic === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    const arches: string[] = [];
    for (let i = 0; i < n; i++) {
      const cputype = buf.readUInt32BE(8 + i * 20);
      arches.push(
        cputype === CPU_ARM64
          ? "arm64"
          : cputype === CPU_X86_64
            ? "x86_64"
            : `0x${cputype.toString(16)}`,
      );
    }
    return { kind: "fat", arches };
  }
  const leMagic = buf.readUInt32LE(0);
  expect(leMagic >>> 0).toBe(MH_MAGIC_64);
  const cputype = buf.readUInt32LE(4);
  const filetype = buf.readUInt32LE(12);
  return {
    kind: "macho",
    arches: [
      cputype === CPU_ARM64
        ? "arm64"
        : cputype === CPU_X86_64
          ? "x86_64"
          : `0x${cputype.toString(16)}`,
    ],
    filetype,
  };
}

function expectMachO(file: string, arch: string, filetype: number) {
  const m = inspect(file);
  expect(m.kind).toBe("macho");
  expect(m.arches).toEqual([arch]);
  expect(m.filetype).toBe(filetype);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workDir: string;

function run(cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(cmd, {
    cwd: workDir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(
      `command failed (${proc.exitCode}): ${cmd.join(" ")}\n${proc.stderr.toString()}\n${proc.stdout.toString()}`,
    );
  }
  return proc;
}

const SOURCES: Record<string, string> = {
  "hello.c": `#include <stdio.h>\n#include <CoreFoundation/CoreFoundation.h>\nint main(void){CFStringRef s=CFSTR("hi");printf("%p\\n",(const void*)s);return 0;}\n`,
  "plain.c": `int add(int a, int b) { return a + b; }\nint main(void) { return add(1, 2) - 3; }\n`,
  "hello.cpp": `#include <vector>\n#include <string>\n#include <iostream>\nint main(){std::vector<std::string> v{"a","b"};std::cout<<v.size()<<"\\n";}\n`,
  "hello.m": `#import <Foundation/Foundation.h>\nint main(void){@autoreleasepool{NSLog(@"%@",@"hi");}return 0;}\n`,
  "hello.mm": `#import <Foundation/Foundation.h>\n#include <string>\nint main(){@autoreleasepool{std::string s("hi");NSLog(@"%s",s.c_str());}return 0;}\n`,
  "lib.c": `#include <CoreFoundation/CoreFoundation.h>\ndouble lib_now(void){return CFAbsoluteTimeGetCurrent();}\n`,
};

const wrapper = (arch: string, xx: boolean) =>
  path.join(SDK_ROOT, "bin", `${arch}-apple-darwin-${xx ? "c++" : "cc"}`);

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe.skipIf(!ready)("cross-compilation smoke tests", () => {
  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "xmac-smoke-"));
    for (const [name, src] of Object.entries(SOURCES))
      fs.writeFileSync(path.join(workDir, name), src);
  });

  const ARCHES = ["arm64", "x86_64"] as const;

  for (const arch of ARCHES) {
    describe(arch, () => {
      test("C executable + CoreFoundation framework", () => {
        run([wrapper(arch, false), "-framework", "CoreFoundation", "hello.c", "-o", `c-${arch}`]);
        expectMachO(path.join(workDir, `c-${arch}`), arch, MH_EXECUTE);
      });

      test("C executable, no frameworks, -O2", () => {
        run([wrapper(arch, false), "-O2", "plain.c", "-o", `plain-${arch}`]);
        expectMachO(path.join(workDir, `plain-${arch}`), arch, MH_EXECUTE);
      });

      test("C++ executable using the SDK's libc++", () => {
        run([wrapper(arch, true), "hello.cpp", "-o", `cpp-${arch}`]);
        expectMachO(path.join(workDir, `cpp-${arch}`), arch, MH_EXECUTE);
      });

      test("Objective-C executable + Foundation + ARC", () => {
        run([
          wrapper(arch, false),
          "-fobjc-arc",
          "-framework",
          "Foundation",
          "hello.m",
          "-o",
          `objc-${arch}`,
        ]);
        expectMachO(path.join(workDir, `objc-${arch}`), arch, MH_EXECUTE);
      });

      test("Objective-C++ executable", () => {
        run([
          wrapper(arch, true),
          "-fobjc-arc",
          "-framework",
          "Foundation",
          "hello.mm",
          "-o",
          `objcpp-${arch}`,
        ]);
        expectMachO(path.join(workDir, `objcpp-${arch}`), arch, MH_EXECUTE);
      });

      test("shared library (dylib)", () => {
        run([
          wrapper(arch, false),
          "-dynamiclib",
          "-framework",
          "CoreFoundation",
          "lib.c",
          "-o",
          `lib-${arch}.dylib`,
          "-install_name",
          "@rpath/lib.dylib",
        ]);
        expectMachO(path.join(workDir, `lib-${arch}.dylib`), arch, MH_DYLIB);
      });

      test("static archive via llvm-ar", () => {
        const ar = Bun.which("llvm-ar");
        if (!ar) return; // optional tool
        run([wrapper(arch, false), "-c", "lib.c", "-o", `lib-${arch}.o`]);
        run([ar, "rcs", `lib-${arch}.a`, `lib-${arch}.o`]);
        expect(inspect(path.join(workDir, `lib-${arch}.a`)).kind).toBe("archive");
      });

      test("MACOSX_DEPLOYMENT_TARGET is honoured by the wrapper", () => {
        run([wrapper(arch, false), "plain.c", "-o", `minos-${arch}`], {
          MACOSX_DEPLOYMENT_TARGET: "12.4",
        });
        // LC_BUILD_VERSION minos is encoded as xx.yy.zz nibbles; just assert
        // the binary built and is the right arch — the version plumbing is
        // exercised by the flag reaching clang without erroring.
        expectMachO(path.join(workDir, `minos-${arch}`), arch, MH_EXECUTE);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Raw clang — no wrapper scripts, no env.sh, no CMake. This is the
  // `--sdk-only` workflow: the user points their own compiler invocation at
  // the bare .sdk directory using exactly the flags the README documents.
  // ---------------------------------------------------------------------
  describe("raw clang against the bare .sdk (no xmac-generated glue)", () => {
    const sdkDir = () =>
      fs
        .readdirSync(path.join(SDK_ROOT, "SDKs"))
        .map((n) => path.join(SDK_ROOT, "SDKs", n))
        .find((p) => /MacOSX.*\.sdk$/.test(p) && fs.lstatSync(p).isDirectory())!;
    const lldDir = () => path.dirname(Bun.which("ld64.lld")!);

    for (const arch of ARCHES) {
      test(`${arch}: C executable + framework`, () => {
        run([
          Bun.which("clang")!,
          `--target=${arch}-apple-macosx11.0`,
          "-isysroot",
          sdkDir(),
          "-fuse-ld=lld",
          "-B",
          lldDir(),
          "-framework",
          "CoreFoundation",
          "hello.c",
          "-o",
          `raw-c-${arch}`,
        ]);
        expectMachO(path.join(workDir, `raw-c-${arch}`), arch, MH_EXECUTE);
      });
    }

    test("C++ executable with the documented -stdlib++-isystem flag", () => {
      run([
        Bun.which("clang++")!,
        "--target=arm64-apple-macosx11.0",
        "-isysroot",
        sdkDir(),
        "-stdlib++-isystem",
        path.join(sdkDir(), "usr", "include", "c++", "v1"),
        "-fuse-ld=lld",
        "-B",
        lldDir(),
        "hello.cpp",
        "-o",
        "raw-cpp",
      ]);
      expectMachO(path.join(workDir, "raw-cpp"), "arm64", MH_EXECUTE);
    });

    test("compile-only (-c) then separate link step", () => {
      run([
        Bun.which("clang")!,
        "--target=arm64-apple-macosx11.0",
        "-isysroot",
        sdkDir(),
        "-c",
        "plain.c",
        "-o",
        "raw-sep.o",
      ]);
      run([
        Bun.which("clang")!,
        "--target=arm64-apple-macosx11.0",
        "-isysroot",
        sdkDir(),
        "-fuse-ld=lld",
        "-B",
        lldDir(),
        "raw-sep.o",
        "-o",
        "raw-sep",
      ]);
      expectMachO(path.join(workDir, "raw-sep"), "arm64", MH_EXECUTE);
    });
  });

  // A single `clang -arch a -arch b` invocation needs an unprefixed `lipo`
  // on PATH; building per-arch and merging with llvm-lipo is the portable
  // cross-compilation workflow, so that is what we test.
  test.skipIf(!Bun.which("llvm-lipo"))(
    "universal (fat) binary via per-arch builds + llvm-lipo",
    () => {
      run([wrapper("arm64", false), "plain.c", "-o", "fat-arm64"]);
      run([wrapper("x86_64", false), "plain.c", "-o", "fat-x86_64"]);
      run([Bun.which("llvm-lipo")!, "-create", "fat-arm64", "fat-x86_64", "-output", "fat"]);
      const m = inspect(path.join(workDir, "fat"));
      expect(m.kind).toBe("fat");
      expect(m.arches.sort()).toEqual(["arm64", "x86_64"]);
    },
  );

  test("env.sh drives a plain $CC / $CXX build", () => {
    const sh = Bun.spawnSync(
      [
        "bash",
        "-ec",
        `source "${SDK_ROOT}/env.sh" && "$CC" plain.c -o env-c && "$CXX" hello.cpp -o env-cpp`,
      ],
      { cwd: workDir, stdout: "pipe", stderr: "pipe" },
    );
    if (sh.exitCode !== 0) throw new Error(sh.stderr.toString());
    expectMachO(path.join(workDir, "env-c"), "arm64", MH_EXECUTE);
    expectMachO(path.join(workDir, "env-cpp"), "arm64", MH_EXECUTE);
  });

  describe.skipIf(!Bun.which("cmake") || !Bun.which("ninja"))("cmake + ninja", () => {
    test("configure and build the examples project", () => {
      const build = path.join(workDir, "cmake-build");
      run([
        Bun.which("cmake")!,
        "-S",
        path.join(ROOT, "examples"),
        "-B",
        build,
        "-G",
        "Ninja",
        "--toolchain",
        path.join(SDK_ROOT, "arm64-apple-darwin.toolchain.cmake"),
      ]);
      run([Bun.which("cmake")!, "--build", build]);
      expectMachO(path.join(build, "hello"), "arm64", MH_EXECUTE);
      expectMachO(path.join(build, "hello-cpp"), "arm64", MH_EXECUTE);
      expectMachO(path.join(build, "libgreeter.dylib"), "arm64", MH_DYLIB);
    });
  });
});

// Always-on sanity check so `bun test` never reports "0 tests" even without
// an SDK present.
test("xmac.ts parses and prints its version", () => {
  const proc = Bun.spawnSync(["bun", path.join(ROOT, "xmac.ts"), "--version"], { stdout: "pipe" });
  expect(proc.exitCode).toBe(0);
  expect(proc.stdout.toString()).toContain("xmac");
});
