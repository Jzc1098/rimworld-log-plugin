"""Decode one method's IL body from a .NET assembly, with resolved member references.

Written for a live debugging question: a mod's Harmony postfix throws NullReferenceException and the
source is not public, so the only way to see what it dereferences is to read its IL. The existing
dump-assembly.py walks whole metadata tables and crashes on some assemblies (IndexError while reading
the string heap), so this walks only what is needed: TypeDef -> MethodDef -> the method's RVA ->
the IL stream, resolving every token it meets.

Usage:
  python probe-method-il.py <assembly.dll> <name-substring>
"""

import struct
import sys

data = b""
pe = 0
cli = 0


def u16(off):
    return struct.unpack_from("<H", data, off)[0]


def u32(off):
    return struct.unpack_from("<I", data, off)[0]


def u64(off):
    return struct.unpack_from("<Q", data, off)[0]


class Tables:
    """Minimal ECMA-335 metadata reader: only the tables needed to reach a method body."""

    def __init__(self, root):
        self.root = root
        self.sizes = {0: 2, 1: 4, 2: 4}
        self.rowcount = {}
        self.strings = 0
        self.blob = 0
        self.tables = 0

    def setup(self):
        # Metadata root.
        assert u32(self.root) == 0x424A5342, "not a metadata root"
        ver_len = u32(self.root + 12)
        off = self.root + 16 + ver_len
        off += 2  # flags
        streams = u16(off)
        off += 2
        for _ in range(streams):
            s_off = u32(off)
            s_size = u32(off + 4)
            name_start = off + 8
            end = data.index(b"\0", name_start)
            name = data[name_start:end].decode("ascii")
            here = self.root + s_off
            if name == "#Strings":
                self.strings = here
            elif name == "#Blob":
                self.blob = here
            elif name == "#~":
                self.tables = here
            # Advance past the null terminator, then align to 4. This must be computed from the
            # stream's own header position, not from an already-absolute offset: doing the latter
            # made every stream after the first be parsed at a nonsense address.
            off = (end + 1 + 3) & ~3

        heap = self.tables
        self.string_index_size = 4 if (u32(heap + 6) & 1) else 2
        valid = u64(heap + 8)
        pos = heap + 24
        for i in range(64):
            if valid & (1 << i):
                self.rowcount[i] = u32(pos)
                pos += 4
        self.offsets = {}
        for i in range(64):
            if valid & (1 << i):
                self.offsets[i] = pos
                pos += self.rowcount[i] * self.row_size(i)

    def row_size(self, table):
        # Column layouts follow ECMA-335 II.22. The TypeDef row is the one that bit me: it is
        # Flags(4) Name(string) Namespace(string) Extends(coded) FieldList(index) MethodList(index)
        # - omitting Extends shifted every later column and made the string heap index read garbage.
        if table == 0:  # Module
            return 2 + self.string_index_size + self.index(0) * 3
        if table == 1:  # TypeRef
            return self.coded(2, (2, 1, 26)) + self.string_index_size * 2
        if table == 2:  # TypeDef
            return 4 + self.string_index_size * 2 + self.coded(2, (2, 1, 26)) + self.index(4) * 2
        if table == 3:  # FieldPtr
            return self.index(4)
        if table == 4:  # Field
            return 2 + self.string_index_size + self.blob_index_size()
        if table == 5:  # MethodPtr
            return self.index(6)
        if table == 6:  # MethodDef
            return 4 + 2 + 2 + self.string_index_size + self.blob_index_size() + self.index(8)
        if table == 7:  # ParamPtr
            return self.index(8)
        if table == 8:  # Param
            return 2 + 2 + self.string_index_size
        if table == 9:  # InterfaceImpl
            return self.index(2) + self.coded(2, (2, 1, 27))
        if table == 10:  # MemberRef
            return self.coded(2, (2, 1, 26, 6, 27)) + self.string_index_size + self.blob_index_size()
        if table == 11:  # Constant
            return 2 + self.coded(2, (4, 8, 23)) + self.blob_index_size()
        if table == 12:  # CustomAttribute
            return self.coded(2, (6, 10, 0)) + self.coded(2, (2, 1, 27)) + self.blob_index_size()
        if table == 13:  # FieldMarshal
            return self.coded(2, (4, 8)) + self.blob_index_size()
        if table == 14:  # DeclSecurity
            return 2 + self.coded(2, (2, 6, 32)) + self.blob_index_size()
        if table == 15:  # ClassLayout
            return 2 + 4 + self.index(2)
        if table == 16:  # FieldLayout
            return 4 + self.index(4)
        if table == 17:  # StandAloneSig
            return self.blob_index_size()
        if table == 18:  # EventMap
            return self.index(2) + self.index(20)
        if table == 19:  # EventPtr
            return self.index(20)
        if table == 20:  # Event
            return 2 + self.string_index_size + self.coded(2, (2, 1, 26))
        if table == 21:  # PropertyMap
            return self.index(2) + self.index(23)
        if table == 22:  # PropertyPtr
            return self.index(23)
        if table == 23:  # Property
            return 2 + self.string_index_size + self.blob_index_size()
        if table == 24:  # MethodSemantics
            return 2 + self.index(6) + self.coded(2, (20, 23))
        if table == 25:  # MethodImpl
            return self.index(2) + self.coded(2, (6, 10)) * 2
        if table == 26:  # ModuleRef
            return self.string_index_size
        if table == 27:  # TypeSpec
            return self.blob_index_size()
        if table == 28:  # ImplMap
            return 2 + self.coded(2, (6, 10)) + self.string_index_size + self.index(26)
        if table == 29:  # FieldRVA
            return 4 + self.index(4)
        if table == 32:  # Assembly
            return 4 + 2 + 2 + 2 + 2 + 4 + self.blob_index_size() * 2 + self.string_index_size * 2
        if table == 35:  # AssemblyRef
            return 2 + 2 + 2 + 2 + 4 + self.blob_index_size() * 2 + self.string_index_size * 2
        if table == 38:  # NestedClass
            return self.index(2) * 2
        if table == 39:  # GenericParam
            return 2 + 2 + self.coded(2, (2, 1, 27)) + self.string_index_size
        if table == 40:  # MethodSpec
            return self.coded(2, (6, 10)) + self.blob_index_size()
        if table == 41:  # GenericParamConstraint
            return self.index(39) + self.coded(2, (2, 1, 27))
        if table == 42:  # Document (portable PDB, present in some builds)
            return self.blob_index_size() + self.blob_index_size() + self.blob_index_size() * 2
        if table == 43:  # MethodDebugInformation
            return self.index(42) + self.blob_index_size()
        if table == 44:  # LocalScope
            return self.index(43) + self.index(42) * 2 + 4 + 4
        if table == 45:  # LocalVariable
            return 2 + 2 + self.string_index_size
        if table == 46:  # LocalConstant
            return self.string_index_size + self.blob_index_size()
        if table == 48:  # ImportScope
            return self.index(48) + self.blob_index_size()
        if table == 55:  # StateMachineMethod
            return self.index(6) * 2
        # Fallback: assume every column is a 4-byte index. Only reached for tables this probe never
        # walks into; reported so a wrong size cannot silently corrupt later offsets.
        print("  [warn] table " + str(table) + " has no known row size", file=sys.stderr)
        return 4 * 4

    def index(self, table):
        return 4 if self.rowcount.get(table, 0) >= 65536 else 2

    def blob_index_size(self):
        return 4 if self.string_index_size == 4 else 2

    def coded(self, tagbits, tables):
        bits = 0
        for t in tables:
            bits = max(bits, self.rowcount.get(t, 0).bit_length())
        return 4 if (bits + tagbits) > 16 else 2

    def s(self, idx):
        start = self.strings + idx
        end = data.index(b"\0", start)
        return data[start:end].decode("utf8", "replace")

    def row(self, table, rid):
        base = self.offsets[table] + (rid - 1) * self.row_size(table)
        return base

    def type_name(self, rid):
        base = self.row(2, rid)
        return self.s(u32(base + 4))

    def type_methods(self, rid):
        base = self.row(2, rid)
        start = u32(base + 4 + self.string_index_size * 2 + self.coded(2, (2, 1, 26)))
        if rid + 1 <= self.rowcount.get(2, 0):
            nxt = self.row(2, rid + 1)
            end = u32(nxt + 4 + self.string_index_size * 2 + self.coded(2, (2, 1, 26)))
        else:
            end = self.rowcount.get(6, 0) + 1
        return range(start, end)

    def method_name(self, rid):
        base = self.row(6, rid)
        return self.s(u32(base + 8))

    def method_rva(self, rid):
        return u32(self.row(6, rid))

    def member_name(self, rid):
        """Best-effort name for a MemberRef or MethodDef token."""
        base = self.row(10, rid)
        return self.s(u32(base + self.coded(2, (2, 1, 26))))


def rva_to_offset(rva):
    sections = u16(pe + 6)
    opt_size = u16(pe + 20)
    sec = pe + 24 + opt_size
    for _ in range(sections):
        vaddr = u32(sec + 12)
        vsize = u32(sec + 8)
        raw = u32(sec + 20)
        if vaddr <= rva < vaddr + max(vsize, u32(sec + 16)):
            return raw + (rva - vaddr)
        sec += 40
    raise ValueError("rva not mapped")


def main():
    global data, pe, cli
    path = sys.argv[1]
    needle = sys.argv[2].lower()
    data = open(path, "rb").read()

    pe = u32(0x3C)
    opt_size = u16(pe + 20)

    # Two hops are needed, and skipping the first one is what produced "rva not mapped" twice:
    #   data directory 14 -> RVA of the CLI header
    #   CLI header + 8    -> RVA of the metadata root
    # Reading the metadata RVA straight out of the data directory lands on the Reserved entry 15
    # (which is zero here), so the value read is 0x2008 - the CLI header itself - not the metadata.
    magic = u16(pe + 24)
    dir_start = pe + 24 + (112 if magic == 0x20B else 96)
    cli_dir = dir_start + 14 * 8
    cli_rva = u32(cli_dir)
    cli_off = rva_to_offset(cli_rva)
    metadata_rva = u32(cli_off + 8)

    root = rva_to_offset(metadata_rva)

    t = Tables(root)
    t.setup()
    print("TypeDef rows: " + str(t.rowcount.get(2, 0)) + "   MethodDef rows: " + str(t.rowcount.get(6, 0)))
    print()

    for rid in range(1, t.rowcount.get(2, 0) + 1):
        tname = t.type_name(rid)
        for mrid in t.type_methods(rid):
            mname = t.method_name(mrid)
            full = tname + "." + mname
            if needle in full.lower():
                print("=== " + full + "  (MethodDef row " + str(mrid) + ")")
                decode_body(t, t.method_rva(mrid))
                print()


def decode_body(t, rva):
    if rva == 0:
        print("  (no body)")
        return
    off = rva_to_offset(rva)
    first = data[off]
    if (first & 3) == 2:
        # Tiny format: the whole header is one byte.
        size = first >> 2
        code_off = off + 1
    else:
        flags = u16(off)
        hdr = (flags >> 12) & 0xF
        size = u32(off + 4)
        code_off = off + 4 * (hdr + 1)
        # LocalVarSigTok sits at the end of the fat header. Skipping it was the last thing keeping
        # this decoder from reading method bodies at all: without the skip, every instruction after
        # the header was read four bytes early and decoded as garbage.
        if hdr >= 2:
            print("  (fat header, code size " + str(size) + " bytes)")
    code = data[code_off:code_off + size]

    i = 0
    while i < len(code):
        op = code[i]
        start = i
        i += 1
        name, operand = OPCODES.get(op, ("op_" + hex(op), None))
        if op == 0xFE:
            op2 = code[i]
            i += 1
            name, operand = OPCODES2.get(op2, ("op2_" + hex(op2), None))

        val = None
        if operand == "i1":
            val = struct.unpack_from("<b", code, i)[0]
            i += 1
        elif operand == "u1":
            val = code[i]
            i += 1
        elif operand == "i4":
            val = struct.unpack_from("<i", code, i)[0]
            i += 4
        elif operand == "i8":
            val = struct.unpack_from("<q", code, i)[0]
            i += 8
        elif operand == "r4":
            val = struct.unpack_from("<f", code, i)[0]
            i += 4
        elif operand == "r8":
            val = struct.unpack_from("<d", code, i)[0]
            i += 8
        elif operand == "switch":
            n = u32(i)
            i += 4 + n * 4
            val = "switch(" + str(n) + ")"
        elif operand == "token":
            tok = u32(i)
            i += 4
            val = describe_token(t, tok)
        elif operand == "str":
            idx = u32(i)
            i += 4
            val = '"' + t.s(idx) + '"'

        line = "  " + format(start, "04x") + "  " + name
        if val is not None:
            line += "  " + str(val)
        print(line)


def describe_token(t, tok):
    table = tok >> 24
    rid = tok & 0xFFFFFF
    try:
        if table == 0x0A:
            return "[MemberRef] " + t.member_name(rid)
        if table == 0x06:
            return "[MethodDef] " + t.method_name(rid)
        if table == 0x04:
            base = t.row(4, rid)
            return "[Field] " + t.s(u32(base + 2))
        if table == 0x01:
            base = t.row(1, rid)
            return "[TypeRef] " + t.s(u32(base + 2 * t.coded(2, (2, 1, 26))))
        if table == 0x02:
            return "[TypeDef] " + t.type_name(rid)
        if table == 0x2B:
            return "[MethodSpec] " + str(rid)
        if table == 0x70:
            return "[String] " + t.s(rid)
    except Exception as exc:  # noqa: BLE001 - a probe should report, not crash
        return "[tok " + hex(tok) + " decode failed: " + str(exc) + "]"
    return "[tok " + hex(tok) + "]"


OPCODES = {
    0x00: ("nop", None), 0x01: ("break", None), 0x02: ("ldarg.0", None), 0x03: ("ldarg.1", None),
    0x04: ("ldarg.2", None), 0x05: ("ldarg.3", None), 0x06: ("ldloc.0", None), 0x07: ("ldloc.1", None),
    0x08: ("ldloc.2", None), 0x09: ("ldloc.3", None), 0x0A: ("stloc.0", None), 0x0B: ("stloc.1", None),
    0x0C: ("stloc.2", None), 0x0D: ("stloc.3", None), 0x0E: ("ldarg.s", "u1"), 0x0F: ("ldarga.s", "u1"),
    0x10: ("starg.s", "u1"), 0x11: ("ldloc.s", "u1"), 0x12: ("ldloca.s", "u1"), 0x13: ("stloc.s", "u1"),
    0x14: ("ldnull", None), 0x15: ("ldc.i4.m1", None), 0x16: ("ldc.i4.0", None), 0x17: ("ldc.i4.1", None),
    0x18: ("ldc.i4.2", None), 0x19: ("ldc.i4.3", None), 0x1A: ("ldc.i4.4", None), 0x1B: ("ldc.i4.5", None),
    0x1C: ("ldc.i4.6", None), 0x1D: ("ldc.i4.7", None), 0x1E: ("ldc.i4.8", None), 0x1F: ("ldc.i4.s", "i1"),
    0x20: ("ldc.i4", "i4"), 0x21: ("ldc.i8", "i8"), 0x22: ("ldc.r4", "r4"), 0x23: ("ldc.r8", "r8"),
    0x25: ("dup", None), 0x26: ("pop", None), 0x27: ("jmp", "token"), 0x28: ("call", "token"),
    0x29: ("calli", "token"), 0x2A: ("ret", None), 0x2B: ("br.s", "i1"), 0x2C: ("brfalse.s", "i1"),
    0x2D: ("brtrue.s", "i1"), 0x2E: ("beq.s", "i1"), 0x2F: ("bge.s", "i1"), 0x30: ("bgt.s", "i1"),
    0x31: ("ble.s", "i1"), 0x32: ("blt.s", "i1"), 0x33: ("bne.un.s", "i1"), 0x34: ("bge.un.s", "i1"),
    0x35: ("bgt.un.s", "i1"), 0x36: ("ble.un.s", "i1"), 0x37: ("blt.un.s", "i1"), 0x38: ("br", "i4"),
    0x39: ("brfalse", "i4"), 0x3A: ("brtrue", "i4"), 0x3B: ("beq", "i4"), 0x3C: ("bge", "i4"),
    0x3D: ("bgt", "i4"), 0x3E: ("ble", "i4"), 0x3F: ("blt", "i4"), 0x40: ("bne.un", "i4"),
    0x41: ("bge.un", "i4"), 0x42: ("bgt.un", "i4"), 0x43: ("ble.un", "i4"), 0x44: ("blt.un", "i4"),
    0x45: ("switch", "switch"), 0x46: ("ldind.i1", None), 0x47: ("ldind.u1", None), 0x48: ("ldind.i2", None),
    0x49: ("ldind.u2", None), 0x4A: ("ldind.i4", None), 0x4B: ("ldind.i8", None), 0x4C: ("ldind.r4", None),
    0x4D: ("ldind.r8", None), 0x4E: ("ldind.ref", None), 0x4F: ("stind.ref", None), 0x50: ("stind.i1", None),
    0x51: ("stind.i2", None), 0x52: ("stind.i4", None), 0x53: ("stind.i8", None), 0x54: ("stind.r4", None),
    0x55: ("stind.r8", None), 0x58: ("add", None), 0x59: ("sub", None), 0x5A: ("mul", None),
    0x5B: ("div", None), 0x5C: ("div.un", None), 0x5D: ("rem", None), 0x5E: ("rem.un", None),
    0x5F: ("and", None), 0x60: ("or", None), 0x61: ("xor", None), 0x62: ("shl", None),
    0x63: ("shr", None), 0x64: ("shr.un", None), 0x65: ("neg", None), 0x66: ("not", None),
    0x67: ("conv.i1", None), 0x68: ("conv.i2", None), 0x69: ("conv.i4", None), 0x6A: ("conv.i8", None),
    0x6B: ("conv.r4", None), 0x6C: ("conv.r8", None), 0x6D: ("conv.u4", None), 0x6E: ("conv.u8", None),
    0x6F: ("callvirt", "token"), 0x70: ("cpobj", "token"), 0x71: ("ldobj", "token"),
    0x72: ("ldstr", "str"), 0x73: ("newobj", "token"), 0x74: ("castclass", "token"),
    0x75: ("isinst", "token"), 0x76: ("conv.r.un", None), 0x79: ("unbox", "token"),
    0x7A: ("throw", None), 0x7B: ("ldfld", "token"), 0x7C: ("ldflda", "token"), 0x7D: ("stfld", "token"),
    0x7E: ("ldsfld", "token"), 0x7F: ("ldsflda", "token"), 0x80: ("stsfld", "token"),
    0x81: ("stobj", "token"), 0x82: ("conv.ovf.i1.un", None), 0x83: ("conv.ovf.i2.un", None),
    0x84: ("conv.ovf.i4.un", None), 0x85: ("conv.ovf.i8.un", None), 0x86: ("conv.ovf.u1.un", None),
    0x87: ("conv.ovf.u2.un", None), 0x88: ("conv.ovf.u4.un", None), 0x89: ("conv.ovf.u8.un", None),
    0x8A: ("conv.ovf.i.un", None), 0x8B: ("conv.ovf.u.un", None), 0x8C: ("box", "token"),
    0x8D: ("newarr", "token"), 0x8E: ("ldlen", None), 0x8F: ("ldelema", "token"),
    0x90: ("ldelem.i1", None), 0x91: ("ldelem.u1", None), 0x92: ("ldelem.i2", None),
    0x93: ("ldelem.u2", None), 0x94: ("ldelem.i4", None), 0x95: ("ldelem.i8", None),
    0x96: ("ldelem.r4", None), 0x97: ("ldelem.r8", None), 0x98: ("ldelem.ref", None),
    0x99: ("stelem.i", None), 0x9A: ("stelem.i1", None), 0x9B: ("stelem.i2", None),
    0x9C: ("stelem.i4", None), 0x9D: ("stelem.i8", None), 0x9E: ("stelem.r4", None),
    0x9F: ("stelem.r8", None), 0xA0: ("stelem.ref", None), 0xA1: ("ldelem", "token"),
    0xA2: ("stelem", "token"), 0xA3: ("ldelema", "token"), 0xA4: ("unbox.any", "token"),
    0xB3: ("conv.ovf.i1", None), 0xB4: ("conv.ovf.u1", None), 0xB5: ("conv.ovf.i2", None),
    0xB6: ("conv.ovf.u2", None), 0xB7: ("conv.ovf.i4", None), 0xB8: ("conv.ovf.u4", None),
    0xB9: ("conv.ovf.i8", None), 0xBA: ("conv.ovf.u8", None), 0xC2: ("refanyval", "token"),
    0xC3: ("ckfinite", None), 0xC6: ("mkrefany", "token"), 0xD0: ("ldtoken", "token"),
    0xD1: ("conv.u2", None), 0xD2: ("conv.u1", None), 0xD3: ("conv.i", None), 0xD4: ("conv.ovf.i", None),
    0xD5: ("conv.ovf.u", None), 0xD6: ("add.ovf", None), 0xD7: ("add.ovf.un", None),
    0xD8: ("mul.ovf", None), 0xD9: ("mul.ovf.un", None), 0xDA: ("sub.ovf", None),
    0xDB: ("sub.ovf.un", None), 0xDC: ("endfinally", None), 0xDD: ("leave", "i4"),
    0xDE: ("leave.s", "i1"), 0xDF: ("stind.i", None), 0xE0: ("conv.u", None),
}

OPCODES2 = {
    0x00: ("arglist", None), 0x01: ("ceq", None), 0x02: ("cgt", None), 0x03: ("cgt.un", None),
    0x04: ("clt", None), 0x05: ("clt.un", None), 0x06: ("ldftn", "token"), 0x07: ("ldvirtftn", "token"),
    0x09: ("ldarg", "u1"), 0x0A: ("ldarga", "u1"), 0x0B: ("starg", "u1"), 0x0C: ("ldloc", "u1"),
    0x0D: ("ldloca", "u1"), 0x0E: ("stloc", "u1"), 0x0F: ("localloc", None), 0x11: ("endfilter", None),
    0x12: ("unaligned.", "u1"), 0x13: ("volatile.", None), 0x14: ("tail.", None),
    0x15: ("initobj", "token"), 0x16: ("constrained.", "token"), 0x17: ("cpblk", None),
    0x18: ("initblk", None), 0x19: ("no.", "u1"), 0x1C: ("sizeof", "token"), 0x1D: ("refanytype", None),
    0x1E: ("readonly.", None),
}

if __name__ == "__main__":
    main()
