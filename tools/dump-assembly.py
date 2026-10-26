"""Dump a .NET assembly's surface: types, their methods with signatures, and string literals.

Written because the game's assemblies cannot be reflected outside Unity (they reference engine types
that do not resolve), so the only reliable route is reading the ECMA-335 metadata directly.

Reuses the decoder from decode-sigs.py but extends it to walk every TypeDef and list its methods,
which is what makes "what does this mod actually do" answerable without a decompiler.

Usage: python dump-assembly.py <assembly.dll>
"""

import struct
import sys


def u16(b, o):
    return struct.unpack_from("<H", b, o)[0]


def u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def i32(b, o):
    return struct.unpack_from("<i", b, o)[0]


ELEM = {
    0x01: "void", 0x02: "bool", 0x03: "char", 0x04: "sbyte", 0x05: "byte", 0x06: "short",
    0x07: "ushort", 0x08: "int", 0x09: "uint", 0x0A: "long", 0x0B: "ulong", 0x0C: "float",
    0x0D: "double", 0x0E: "string", 0x0F: "ptr", 0x10: "byref", 0x11: "valuetype", 0x12: "class",
    0x13: "var", 0x14: "array", 0x15: "genericinst", 0x16: "typedbyref", 0x18: "intptr",
    0x19: "uintptr", 0x1B: "fnptr", 0x1C: "object", 0x1D: "szarray", 0x1E: "mvar",
}


class Meta:
    def __init__(self, path):
        self.d = d = open(path, "rb").read()
        pe = i32(d, 0x3C)
        assert d[pe : pe + 4] == b"PE\x00\x00", "not a PE file"
        coff = pe + 4
        nsec = u16(d, coff + 2)
        optsz = u16(d, coff + 16)
        opt = coff + 20
        dd = opt + (112 if u16(d, opt) == 0x20B else 96)
        cli_rva = u32(d, dd + 14 * 8)

        sects = []
        so = opt + optsz
        for i in range(nsec):
            s = so + i * 40
            sects.append((u32(d, s + 12), u32(d, s + 8), u32(d, s + 20)))
        self.sects = sects

        cli = self.r2o(cli_rva)
        md = self.r2o(u32(d, cli + 8))
        assert d[md : md + 4] == b"BSJB", "bad metadata signature"
        verlen = u32(d, md + 12)
        nstreams = u16(d, md + 16 + verlen + 2)
        p = md + 16 + verlen + 4
        self.h = {}
        for _ in range(nstreams):
            off, size = struct.unpack_from("<II", d, p)
            ns = p + 8
            ne = ns
            while d[ne]:
                ne += 1
            name = d[ns:ne].decode("latin1")
            self.h[name] = (md + off, size)
            p = ns + ((len(name) + 1 + 3) // 4) * 4

    def r2o(self, rva):
        for v, vs, raw in self.sects:
            if v <= rva < v + max(vs, 1):
                return raw + (rva - v)
        return -1

    def s(self, idx):
        if idx == 0:
            return ""
        base = self.h["#Strings"][0]
        o = base + idx
        e = o
        while self.d[e]:
            e += 1
        return self.d[o:e].decode("utf-8", "replace")

    def blob(self, idx):
        base = self.h["#Blob"][0]
        o = base + idx
        b0 = self.d[o]
        if b0 & 0x80 == 0:
            n = b0
            o += 1
        elif b0 & 0xC0 == 0x80:
            n = ((b0 & 0x3F) << 8) + self.d[o + 1]
            o += 2
        else:
            n = ((b0 & 0x1F) << 24) + (self.d[o + 1] << 16) + (self.d[o + 2] << 8) + self.d[o + 3]
            o += 4
        return self.d[o : o + n]

    def tables(self):
        d = self.d
        t = self.h["#~"][0]
        heap = d[t + 6]
        valid = struct.unpack_from("<Q", d, t + 8)[0]
        self.str_idx = 4 if heap & 1 else 2
        self.guid_idx = 4 if heap & 2 else 2
        self.blob_idx = 4 if heap & 4 else 2
        rows = {}
        q = t + 24
        for i in range(64):
            if (valid >> i) & 1:
                rows[i] = u32(d, q)
                q += 4
        return rows, q

    def strings(self):
        """Raw string literals from the #US heap, decoded from UTF-16LE."""
        base, size = self.h["#US"]
        out = []
        o = base + 1
        while o < base + size:
            b0 = self.d[o]
            if b0 & 0x80 == 0:
                n = b0
                o += 1
            elif b0 & 0xC0 == 0x80:
                n = ((b0 & 0x3F) << 8) + self.d[o + 1]
                o += 2
            else:
                n = ((b0 & 0x1F) << 24) + (self.d[o + 1] << 16) + (self.d[o + 2] << 8) + self.d[o + 3]
                o += 4
            if n <= 0:
                break
            raw = self.d[o : o + n]
            o += n
            # The last byte is a flag; drop it before decoding.
            try:
                text = raw[:-1].decode("utf-16-le", "replace")
            except Exception:
                continue
            if text.strip():
                out.append(text)
        return out


def main():
    path = sys.argv[1]
    m = Meta(path)
    rows, q = m.tables()

    tdr = 4 if (rows.get(2, 0) >= 1024 or rows.get(1, 0) >= 1024) else 2
    field_idx = 4 if rows.get(4, 0) >= 65536 else 2
    method_idx = 4 if rows.get(6, 0) >= 65536 else 2
    param_idx = 4 if rows.get(8, 0) >= 65536 else 2

    # Row sizes for every table that can appear before MethodDef.
    #
    # FieldPtr(3) and MethodPtr(5) are usually absent, but Field(4) is not - skipping table 4 shifts
    # the MethodDef start and every row read after it lands on garbage.
    simple = {
        0: m.str_idx + m.guid_idx * 3,
        1: m.str_idx * 2 + m.guid_idx,
        2: 4 + m.str_idx * 2 + tdr + field_idx + method_idx,
        3: field_idx,
        4: 2 + m.str_idx + m.blob_idx,
        5: method_idx,
    }

    off = q
    type_def_start = off
    method_start = off
    for i in range(7):
        if i == 6:
            method_start = off
            break
        if i in rows:
            off += rows[i] * simple[i]

    print(f"file: {path}")
    print(f"TypeDef rows: {rows.get(2)}   MethodDef rows: {rows.get(6)}   Field rows: {rows.get(4)}")
    print()

    # TypeDef rows carry a method range, so each type's methods are its own slice.
    #
    # TypeDef layout: Flags(4) Name(str) Namespace(str) Extends(TypeDefOrRef) FieldList(Field idx)
    # MethodList(MethodDef idx). Every column after Flags is str_idx/tdr/idx wide - an extra fixed 4
    # here reads past the table and produces garbage indices.
    tstride = simple[2]
    mstride = 8 + m.str_idx + m.blob_idx + param_idx
    method_col = 4 + m.str_idx * 2 + tdr + field_idx
    types = []
    for r in range(rows.get(2, 0)):
        row = type_def_start + r * tstride
        name = m.s(u32(m.d, row + 4))
        ns = m.s(u32(m.d, row + 4 + m.str_idx))
        if method_idx == 4:
            first_method = u32(m.d, row + method_col)
        else:
            first_method = u16(m.d, row + method_col)
        types.append((f"{ns}.{name}" if ns else name, first_method))

    print("=" * 90)
    print("TYPES AND METHODS")
    print("=" * 90)
    for i, (tname, first) in enumerate(types):
        nxt = types[i + 1][1] if i + 1 < len(types) else rows.get(6, 0)
        print(f"\n{tname}   ({nxt - first} methods)")
        for mi in range(first, min(nxt, rows.get(6, 0))):
            row = method_start + mi * mstride
            flags = u16(m.d, row + 6)
            mname = m.s(u32(m.d, row + 8))
            bidx = u32(m.d, row + 8 + m.str_idx) if m.blob_idx == 4 else u16(m.d, row + 8 + m.str_idx)
            bl = m.blob(bidx)
            if len(bl) < 3:
                continue
            head = bl[0]
            has_this = (head >> 5) & 1
            pcount = bl[1]
            ret = bl[2]
            static = "" if has_this else "static "
            print(f"    {static}{ELEM.get(ret, hex(ret))} {mname}({pcount} params)  flags=0x{flags:04X}")

    print()
    print("=" * 90)
    print("STRING LITERALS")
    print("=" * 90)
    for s in m.strings():
        print(f"    {s!r}")


main()
