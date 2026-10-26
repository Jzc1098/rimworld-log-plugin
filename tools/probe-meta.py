"""Print where each metadata stream actually starts, to debug heap-index decoding.

Kept separate from probe-method-il.py because four attempts to fix that decoder by reasoning alone
all failed: each time the symptom (a bad string index) was several steps away from the cause. This
prints the intermediate values so the wrong one is visible instead of inferred.

Usage:
  python probe-meta.py <file>
"""

import struct
import sys

d = open(sys.argv[1], "rb").read()


def u16(o):
    return struct.unpack_from("<H", d, o)[0]


def u32(o):
    return struct.unpack_from("<I", d, o)[0]


pe = u32(0x3C)
opt_size = u16(pe + 20)
magic = u16(pe + 24)
dir_start = pe + 24 + (112 if magic == 0x20B else 96)
cli_rva = u32(dir_start + 14 * 8)


def rva_to_offset(rva):
    sec = pe + 24 + opt_size
    for i in range(u16(pe + 6)):
        base = sec + i * 40
        vaddr = u32(base + 12)
        vsize = u32(base + 8)
        rawptr = u32(base + 20)
        rawsize = u32(base + 16)
        if vaddr <= rva < vaddr + max(vsize, rawsize):
            return rawptr + (rva - vaddr)
    raise ValueError("rva 0x" + format(rva, "x") + " not mapped")


cli_off = rva_to_offset(cli_rva)
meta_rva = u32(cli_off + 8)
meta_off = rva_to_offset(meta_rva)

print("metadata root file offset: 0x" + format(meta_off, "x"))
print("magic: 0x" + format(u32(meta_off), "x") + "  (want 0x424a5342)")
ver_len = u32(meta_off + 12)
print("version length: " + str(ver_len))
pos = meta_off + 16 + ver_len
print("after version string, at 0x" + format(pos, "x") + ": flags=0x" + format(u16(pos), "x"))
streams = u16(pos + 2)
print("stream count: " + str(streams))
print()

pos += 4
for i in range(streams):
    s_off = u32(pos)
    s_size = u32(pos + 4)
    name_start = pos + 8
    end = d.index(b"\0", name_start)
    name = d[name_start:end].decode("ascii", "replace")
    padded = (end + 1 + 3) & ~3
    print("stream " + str(i) + ": " + repr(name))
    print("    offset field = 0x" + format(s_off, "x") + "   size = " + str(s_size))
    print("    absolute     = 0x" + format(meta_off + s_off, "x"))
    print("    header bytes at absolute: " + d[meta_off + s_off:meta_off + s_off + 16].hex(" "))
    pos = padded
    print()

# Now find the #~ (or #-) table stream header and print its heap-size flags.
pos = meta_off + 16 + ver_len + 4
for i in range(streams):
    s_off = u32(pos)
    name_start = pos + 8
    end = d.index(b"\0", name_start)
    name = d[name_start:end].decode("ascii", "replace")
    pos = (end + 1 + 3) & ~3
    if name in ("#~", "#-"):
        t = meta_off + s_off
        print("table stream " + repr(name) + " at 0x" + format(t, "x"))
        print("  reserved   = 0x" + format(u32(t), "x"))
        print("  major/minor= " + str(d[t + 4]) + "." + str(d[t + 5]))
        print("  heapSizes  = 0x" + format(d[t + 6], "x"))
        print("     bit0 string heap uses 4-byte indices: " + str(bool(d[t + 6] & 1)))
        print("     bit1 guid   heap uses 4-byte indices: " + str(bool(d[t + 6] & 2)))
        print("     bit2 blob   heap uses 4-byte indices: " + str(bool(d[t + 6] & 4)))
        print("  reserved2  = 0x" + format(d[t + 7], "x"))
        valid = struct.unpack_from("<Q", d, t + 8)[0]
        print("  valid mask = 0x" + format(valid, "x"))
        print("     table 2 (TypeDef) present: " + str(bool(valid & (1 << 2))))
        print("     table 6 (MethodDef) present: " + str(bool(valid & (1 << 6))))
        n = bin(valid).count("1")
        print("  tables present: " + str(n))
        rows_at = t + 24
        print("  first few row counts:")
        idx = 0
        for bit in range(64):
            if valid & (1 << bit):
                print("     table " + str(bit).rjust(2) + " rows = " + str(u32(rows_at + idx * 4)))
                idx += 1
                if idx > 12:
                    break
        break
