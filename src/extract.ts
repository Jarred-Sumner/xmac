/**
 * Extract `Library/Developer/CommandLineTools/SDKs/<name>.sdk/**` from a
 * downloaded CLT SDK package straight onto disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { XmacError } from "./util";
import { Progress, warn, note } from "./ui";
import { XarFile } from "./xar";
import { decompressPayload } from "./pbzx";
import { cpioEntries, S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } from "./cpio";

export interface SplatStats {
  files: number;
  dirs: number;
  symlinks: number;
  bytes: number;
  sdkNames: string[];
}

export function newStats(): SplatStats {
  return { files: 0, dirs: 0, symlinks: 0, bytes: 0, sdkNames: [] };
}

export async function splatPackage(
  pkgPath: string,
  outDir: string,
  copySymlinks: boolean,
  stats: SplatStats,
): Promise<void> {
  const xar = XarFile.open(pkgPath);
  try {
    const payload = xar.find("Payload");
    if (!payload) {
      // Product archives nest component packages one level down.
      const nested = xar.entries.find((e) => e.name.endsWith("/Payload"));
      if (!nested) throw new XmacError(`${path.basename(pkgPath)}: no Payload entry found`);
      throw new XmacError(
        `${path.basename(pkgPath)}: nested product archives are not supported yet (found ${nested.name})`,
      );
    }
    const prog = new Progress(path.basename(pkgPath), payload.size);
    const sdkRoot = path.join(outDir, "SDKs");
    fs.mkdirSync(sdkRoot, { recursive: true });

    // The payload paths look like ./Library/Developer/CommandLineTools/SDKs/<x>
    const PREFIX = /^\.?\/?Library\/Developer\/CommandLineTools\/SDKs\//;
    // Some very old CLT packages install to /Applications/Xcode.app/.../SDKs.
    const ALT_PREFIX = /^\.?\/?.*?\/SDKs\/(?=[A-Za-z0-9_.]+\.sdk(\/|$))/;

    const deferredLinks: { at: string; target: string }[] = [];
    let symlinkFailures = 0;
    let rejected = 0;

    // Path-traversal guards. Two ways an archive entry could escape sdkRoot:
    //   1. an entry path containing `..` — caught by `inside` below;
    //   2. a symlink whose *target* resolves outside sdkRoot, which a later
    //      file entry then writes through (tar-slip) — caught by `safeLink`.
    // Rejecting escaping symlinks at creation time means no later write can
    // ever traverse one, so the file-write path needs no realpath checks.
    const inside = (p: string) => p === sdkRoot || p.startsWith(sdkRoot + path.sep);
    const safeLink = (at: string, target: string) =>
      target !== "" && !path.isAbsolute(target) && inside(path.resolve(path.dirname(at), target));

    for await (const entry of cpioEntries(
      decompressPayload(xar.streamRaw(payload), (n) => prog.update(n)),
    )) {
      let rel: string | undefined;
      if (PREFIX.test(entry.path)) rel = entry.path.replace(PREFIX, "");
      else if (ALT_PREFIX.test(entry.path)) rel = entry.path.replace(ALT_PREFIX, "");
      if (!rel || rel === "") {
        await entry.skip();
        continue;
      }
      const dest = path.join(sdkRoot, rel);
      if (!inside(dest)) {
        rejected++;
        await entry.skip();
        continue;
      }
      const type = entry.mode & S_IFMT;
      // Record real SDK directories (not the MacOSX<major>.sdk symlinks).
      const m = /^([A-Za-z0-9_.+-]+\.sdk)$/.exec(rel.replace(/\/$/, ""));
      if (m && type === S_IFDIR && !stats.sdkNames.includes(m[1])) stats.sdkNames.push(m[1]);
      if (type === S_IFDIR) {
        fs.mkdirSync(dest, { recursive: true });
        stats.dirs++;
      } else if (type === S_IFLNK) {
        const target = entry.linkTarget ?? "";
        if (!safeLink(dest, target)) {
          rejected++;
        } else if (copySymlinks) {
          deferredLinks.push({ at: dest, target });
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          try {
            fs.rmSync(dest, { force: true });
          } catch {}
          try {
            fs.symlinkSync(target, dest);
            stats.symlinks++;
          } catch {
            symlinkFailures++;
            deferredLinks.push({ at: dest, target });
          }
        }
      } else if (type === S_IFREG || type === 0) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const fd = fs.openSync(dest, "w", entry.mode & 0o777 || 0o644);
        try {
          for await (const piece of entry.body()) {
            let off = 0;
            while (off < piece.byteLength)
              off += fs.writeSync(fd, piece, off, piece.byteLength - off, -1);
          }
        } finally {
          fs.closeSync(fd);
        }
        stats.files++;
        stats.bytes += entry.size;
      } else {
        // fifo/device/socket — should not appear in an SDK.
        await entry.skip();
      }
    }

    // Materialize deferred symlinks as copies (used with --copy-symlinks or
    // when the filesystem rejects symlink creation). Multiple passes because
    // links can point at other links.
    if (deferredLinks.length > 0) {
      let remaining = deferredLinks;
      for (let pass = 0; pass < 40 && remaining.length > 0; pass++) {
        const next: typeof remaining = [];
        for (const l of remaining) {
          // deferredLinks are pre-validated by safeLink(), but re-check here
          // since this path dereferences and copies whatever the target is.
          const resolved = path.resolve(path.dirname(l.at), l.target);
          if (!inside(resolved)) continue;
          try {
            const st = fs.statSync(resolved);
            if (st.isDirectory()) {
              fs.cpSync(resolved, l.at, { recursive: true, dereference: true });
            } else {
              fs.mkdirSync(path.dirname(l.at), { recursive: true });
              fs.copyFileSync(resolved, l.at);
            }
            stats.files++;
          } catch {
            next.push(l);
          }
        }
        if (next.length === remaining.length) break; // no progress
        remaining = next;
      }
      if (remaining.length > 0)
        note(`${remaining.length} symlink(s) could not be materialized (dangling targets)`);
    }
    if (symlinkFailures > 0)
      note(
        `${symlinkFailures} symlink(s) were materialized as copies because the filesystem rejected symlink creation`,
      );
    if (rejected > 0)
      warn(
        `${rejected} entr${rejected === 1 ? "y" : "ies"} rejected for escaping the output directory (unexpected in a genuine Apple package)`,
      );
    prog.finish();
  } finally {
    xar.close();
  }
}
