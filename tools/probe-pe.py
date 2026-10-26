"""Print a PE file's section table and data directories, verified against the real bytes.

Written because two earlier attempts to locate the CLI header used a hard-coded offset into the
optional header and then failed with "rva not mapped". Printing the headers first shows which value
was wrong instead of guessing again.

Usage:
  python probe-pe.py <file>
"""

import struct
import sys

d = open(sys.argv[1], "rb").read()


def u16(o):
    return struct.unpack_from("<H", d, o)[0]


def u32(o):
    return struct.unpack_from("<I", d, o)[0]


pe = u32(0x3C)
magic = u16(pe + 24)
opt_size = u16(pe + 20)
dir_start = pe + 24 + (112 if magic == 0x20B else 96)

print("DOS header says PE at 0x" + format(pe, "x"))
print("signature           : " + d[pe:pe + 4].decode("ascii", "replace"))
print("optional magic      : 0x" + format(magic, "x") + (" (PE32+)" if magic == 0x20B else " (PE32)"))
print("optional header size: " + str(opt_size))
print("data directories at : 0x" + format(dir_start, "x"))
print()

names = [
    "Export", "Import", "Resource", "Exception", "Certificate", "BaseReloc", "Debug",
    "Architecture", "GlobalPtr", "TLS", "LoadConfig", "BoundImport", "IAT", "DelayImport",
    "CLI", "Reserved",
]
print("data directories:")
for i in range(16):
    rva = u32(dir_start + i * 8)
    size = u32(dir_start + i * 8 + 4)
    mark = "  <== CLI" if i == 14 else ""
    if rva or size:
        print("  [" + str(i).rjust(2) + "] " + names[i].ljust(14) + " rva=0x" + format(rva, "08x")
              + " size=" + str(size) + mark)
print()

sections = u16(pe + 6)
sec = pe + 24 + opt_size
print("sections: " + str(sections) + "   section table starts at 0x" + format(sec, "x"))
print("  " + "name".ljust(10) + "vaddr".ljust(12) + "vsize".ljust(12) + "rawptr".ljust(12) + "rawsize")
ranges = []
for i in range(sections):
    base = sec + i * 40
    name = d[base:base + 8].rstrip(b"\0").decode("ascii", "replace")
    vsize = u32(base + 8)
    vaddr = u32(base + 12)
    rawsize = u32(base + 16)
    rawptr = u32(base + 20)
    print("  " + name.ljust(10) + format(vaddr, "08x").ljust(12) + format(vsize, "08x").ljust(12)
          + format(rawptr, "08x").ljust(12) + format(rawsize, "08x"))
    ranges.append((vaddr, vsize, rawptr, rawsize))

print()
cli_rva = u32(dir_start + 14 * 8)
print("CLI header rva = 0x" + format(cli_rva, "x"))
hit = None
for vaddr, vsize, rawptr, rawsize in ranges:
    span = max(vsize, rawsize)
    if vaddr <= cli_rva < vaddr + span:
        hit = rawptr + (cli_rva - vaddr)
        print("  mapped by section at vaddr 0x" + format(vaddr, "x") + " -> file offset 0x" + format(hit, "x"))
        break
if hit is None:
    print("  NOT MAPPED by any section  <== this is what broke the earlier decoder")
else:
    print("  cb                                         = " + str(u32(hit)))
    print("  MajorRuntimeVersion / MinorRuntimeVersion  = " + str(u16(hit + 4)) + " / " + str(u16(hit + 6)))
    meta_rva = u32(hit + 8)
    meta_size = u32(hit + 12)
    print("  MetaData rva = 0x" + format(meta_rva, "x") + "  size = " + str(meta_size))
    for vaddr, vsize, rawptr, rawsize in ranges:
        span = max(vsize, rawsize)
        if vaddr <= meta_rva < vaddr + span:
            mo = rawptr + (meta_rva - vaddr)
            print("  MetaData file offset = 0x" + format(mo, "x"))
            print("  first 4 bytes there  = 0x" + format(u32(mo), "x")
                  + ("  (0x424A5342 = BSJB, correct)" if u32(mo) == 0x424A5342 else "  <== expected BSJB"))
            break
