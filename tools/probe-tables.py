"""Cross-check the table-stream offset computation for the IL decoder.

Exists because probe-method-il.py kept reading garbage string indices. The suspicion is the start
offset of the row-count array or the size of an early table row, so this prints both the computed
offset of each table and, for the first row of TypeDef, each individual column value. A correct
decoder must produce a small, plausible Name index and a Name that looks like an identifier.

Usage:
  python probe-tables.py <file>
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
    raise ValueError("unmapped")


cli_off = rva_to_offset(cli_rva)
meta_off = rva_to_offset(u32(cli_off + 8))

ver_len = u32(meta_off + 12)
pos = meta_off + 16 + ver_len + 4
streams = u16(meta_off + 16 + ver_len + 2)

t = None
strings = None
blob = None
for _ in range(streams):
    s_off = u32(pos)
    name_start = pos + 8
    end = d.index(b"\0", name_start)
    name = d[name_start:end].decode("ascii", "replace")
    pos = (end + 1 + 3) & ~3
    if name == "#~":
        t = meta_off + s_off
    elif name == "#Strings":
        strings = meta_off + s_off
    elif name == "#Blob":
        blob = meta_off + s_off

print("#~      at 0x" + format(t, "x"))
print("#Strings at 0x" + format(strings, "x"))
print("#Blob    at 0x" + format(blob, "x"))
print()

heap_sizes = d[t + 6]
str_idx = 4 if (heap_sizes & 1) else 2
guid_idx = 4 if (heap_sizes & 2) else 4 if False else (4 if (heap_sizes & 2) else 2)
blob_idx = 4 if (heap_sizes & 4) else 2
print("heapSizes byte = 0x" + format(heap_sizes, "x"))
print("  string index size = " + str(str_idx))
print("  guid   index size = " + str(guid_idx))
print("  blob   index size = " + str(blob_idx))
print("  reserved2 byte    = 0x" + format(d[t + 7], "x"))
print()

valid = struct.unpack_from("<Q", d, t + 8)[0]
sorted_mask = struct.unpack_from("<Q", d, t + 16)[0]
print("valid  mask = 0x" + format(valid, "x"))
print("sorted mask = 0x" + format(sorted_mask, "x"))
print()

# The reserved2 byte is 0x01, which is not part of the row-count array. Confirm where the array is by
# reading the TypeDef row count at the candidate offsets and seeing which equals probe-meta's value.
for trial in (24, 25):
    n2 = u32(t + trial + 4)
    print("if row-count array starts at t+" + str(trial) + ": table row counts would be "
          + ", ".join(str(u32(t + trial + k * 4)) for k in range(6)))
print("known from probe-meta: table0=1 table1=562 table2=262 table4=462 table6=749")
print()

rowcount = {}
n = 0
pos2 = t + 24
for bit in range(64):
    if valid & (1 << bit):
        rowcount[bit] = u32(pos2)
        pos2 += 4
print("computed table offsets using t+24 as the array start:")
off = pos2
for bit in sorted(rowcount):
    print("  table " + str(bit).rjust(2) + " rows=" + str(rowcount[bit]).rjust(6)
          + "  offset=0x" + format(off, "x"))


def s(idx):
    start = strings + idx
    end = d.index(b"\0", start)
    return d[start:end].decode("utf8", "replace")


# TypeDef row: Flags(4) Name(str) Namespace(str) Extends(coded) FieldList(idx4) MethodList(idx4)
if 2 in rowcount and 4 in rowcount:
    field_idx = 4 if rowcount[4] >= 65536 else 2
    method_idx = 4 if rowcount[6] >= 65536 else 2
    # Extends: TypeDef/TypeRef/TypeSpec, 2 tag bits
    bits = max(rowcount.get(2, 0).bit_length(), rowcount.get(1, 0).bit_length(),
               rowcount.get(27, 0).bit_length())
    extends_idx = 4 if (bits + 2) > 16 else 2
    row_size = 4 + str_idx * 2 + extends_idx + field_idx + method_idx
    print()
    print("TypeDef row size = " + str(row_size) + " (str=" + str(str_idx) + " extends=" + str(extends_idx)
          + " field=" + str(field_idx) + " method=" + str(method_idx) + ")")
    base = off + 2 * row_size  # offset of TypeDef table = after table0(1 row) and table1(562 rows)
    # recompute properly
    o = pos2
    table_off = {}
    for bit in sorted(rowcount):
        table_off[bit] = o
    print("recomputed offsets start at 0x" + format(pos2, "x"))
    print()
    td = table_off[2]
    for rid in (1, 2, 3):
        b = td + (rid - 1) * row_size
        flags = u32(b)
        name_i = u16(b + 4) if str_idx == 2 else u32(b + 4)
        ns_i = u16(b + 4 + str_idx) if str_idx == 2 else u32(b + 4 + str_idx)
        print("TypeDef row " + str(rid) + ": flags=0x" + format(flags, "x")
              + " nameIdx=" + str(name_i) + " name=" + repr(s(name_i)[:40])
              + " nsIdx=" + str(ns_i) + " ns=" + repr(s(ns_i)[:40]))
