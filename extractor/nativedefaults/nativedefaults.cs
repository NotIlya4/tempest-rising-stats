#:package Iced@1.21.0
#:property JsonSerializerIsReflectionEnabledByDefault=true
// nativedefaults: reads the C++ class defaults of the game's definition classes
// (Ted*DefinitionAsset) from the shipping exe, without running it.
//
// Why: cooked packages store only the properties that differ from the class default object
// (UE delta serialization), so a field a definition does not store has the value the C++
// constructor gives it. That value lives only in the exe.
//
// How (read-only, the exe is read as bytes):
//   1. The reflection tables Unreal Header Tool compiles into the exe (the same ones usmapgen
//      reads) give every property of a class with its byte offset; bool properties give a
//      SetBit function that names their byte and mask.
//   2. Each class's StaticClass function calls GetPrivateStaticClassBody; its 10th argument
//      (stack slot rsp+0x48) is InternalConstructor<T>, which tail-calls the C++ constructor.
//   3. The constructor is disassembled (Iced) and executed symbolically along its straight
//      path: immediate and register stores to `this`, constants loaded from .rdata, the call
//      to the parent class's constructor, and gameplay tags built from string literals
//      (FName from a wide string -> RequestGameplayTag -> AddTag on a container member).
//      A store that sits behind a conditional branch is not trusted (value left unknown).
//   4. A property's default is reported only when every byte of it was written by that
//      straight path.
// Verification is done by extractor/build-stats.mjs against the definition data (a native
// default must never be stored explicitly, because the cooker drops values equal to it) and
// against UE's documented FRadialDamageParams defaults.
//
// Usage:
//   dotnet run nativedefaults.cs -- [--game <dir> | --exe <file>] [--out <file.json>] [--dis <ClassName>]
// Default output: extractor/out/native-defaults.json (git-ignored).
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Iced.Intel;

var cli = new Cli(args);
var exePath = cli.Opt("exe") ?? Paths.ExePath(cli.Opt("game"));
var outPath = cli.Opt("out") ?? Path.Combine(Paths.OutDir, "native-defaults.json");
Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
Console.Error.WriteLine($"exe: {exePath}");
var exe = File.ReadAllBytes(exePath);
var pe = new Pe(exe);

// ---------------------------------------------------------------- reflection tables
// FPropertyParams: {Name*, RepNotify*, u64 PropertyFlags, u8 GenFlags, i32 ObjFlags, Setter, Getter,
// u16 ArrayDim, u16 Offset, extra@56}; for bools u16 ElementSize @50, u32 SizeOfOuter @52, SetBitFunc @56.
var props = new Dictionary<long, (string name, int type, int arrayDim, int offset, long extra)>();
foreach (var s in pe.DataSecs)
    for (long f = s.raw; f + 64 <= s.raw + s.rs; f += 8)
    {
        long q0 = pe.Q(f); if (q0 < pe.Ib || q0 > pe.Ib + 0xB000000) continue;
        var name = pe.A(q0); if (string.IsNullOrEmpty(name)) continue;
        long q1 = pe.Q(f + 8); if (q1 != 0 && pe.A(q1) == null) continue;
        int tb = exe[f + 24]; if (exe[f + 25] != 0 || exe[f + 26] != 0 || exe[f + 27] != 0) continue;
        int type = tb & 0x3F; if (type > 0x22 || type == 8 || type == 9) continue;
        long q32 = pe.Q(f + 32), q40 = pe.Q(f + 40); if ((q32 != 0 && !pe.IsText(q32)) || (q40 != 0 && !pe.IsText(q40))) continue;
        int ad = BitConverter.ToUInt16(exe, (int)f + 48); if (ad < 1 || ad > 512) continue;
        props[pe.F2V(f)] = (name, type, ad, BitConverter.ToUInt16(exe, (int)f + 50), pe.Q(f + 56));
    }
bool PropArrayOk(long arrVa, int n) { long af = pe.V2F(arrVa); if (af < 0) return false; for (int k = 0; k < n; k++) if (!props.ContainsKey(pe.Q(af + 8 * k))) return false; return true; }
List<long> PropList(long arr, int n) { var l = new List<long>(); long af = pe.V2F(arr); for (int k = 0; k < n; k++) l.Add(pe.Q(af + 8 * k)); return l; }

var enumParams = new Dictionary<long, (string name, List<(long v, string n)> vals)>();
foreach (var s in pe.DataSecs)
    for (long f = s.raw; f + 48 <= s.raw + s.rs; f += 8)
    {
        if (!pe.IsText(pe.Q(f))) continue; long q1 = pe.Q(f + 8); if (q1 != 0 && !pe.IsText(q1)) continue;
        var name = pe.A(pe.Q(f + 16)); if (string.IsNullOrEmpty(name)) continue;
        if (pe.A(pe.Q(f + 24)) == null) continue;
        long ep = pe.V2F(pe.Q(f + 32)); int n = BitConverter.ToUInt16(exe, (int)f + 44); if (ep < 0 || n <= 0 || n > 5000) continue;
        var vals = new List<(long, string)>(); bool ok = true;
        for (int k = 0; k < n; k++) { var en = pe.A(pe.Q(ep + 16 * k)); if (en == null) { ok = false; break; } vals.Add((pe.Q(ep + 16 * k + 8), en)); }
        if (ok) enumParams[pe.F2V(f)] = (name, vals);
    }

var structParams = new Dictionary<long, (string name, long arr, int n, int size)>();
foreach (var s in pe.DataSecs)
    for (long f = s.raw; f + 48 <= s.raw + s.rs; f += 8)
    {
        long q0 = pe.Q(f); if (!pe.IsText(q0)) continue;
        long q1 = pe.Q(f + 8), q2 = pe.Q(f + 16); if ((q1 != 0 && !pe.IsText(q1)) || (q2 != 0 && !pe.IsText(q2))) continue;
        var name = pe.A(pe.Q(f + 24)); if (string.IsNullOrEmpty(name) || name.Contains(' ')) continue;
        long arr = pe.Q(f + 32); int n = BitConverter.ToUInt16(exe, (int)f + 40); int size = BitConverter.ToUInt16(exe, (int)f + 42);
        if (size == 0) continue; if (n > 0 ? !PropArrayOk(arr, n) : arr != 0) continue;
        structParams[pe.F2V(f)] = (name, arr, n, size);
    }

var classParams = new Dictionary<long, (long noreg, long deps, long arr, int n)>();
foreach (var s in pe.DataSecs)
    for (long f = s.raw; f + 64 <= s.raw + s.rs; f += 8)
    {
        if (!pe.IsText(pe.Q(f))) continue; long q1 = pe.Q(f + 8); if (q1 != 0 && pe.A(q1) == null) continue;
        if (pe.V2F(pe.Q(f + 16)) < 0) continue;
        long deps = pe.Q(f + 24); uint bf = BitConverter.ToUInt32(exe, (int)f + 56);
        int ndeps = (int)(bf & 0xF), nprop = (int)((bf >> 15) & 0x7FF);
        if (ndeps == 0 || pe.V2F(deps) < 0 || !pe.IsText(pe.Q(pe.V2F(deps)))) continue;
        long arr = pe.Q(f + 40); if (nprop > 0 ? !PropArrayOk(arr, nprop) : arr != 0) continue;
        classParams[pe.F2V(f)] = (pe.Q(f), deps, arr, nprop);
    }
Console.Error.WriteLine($"reflection: {props.Count} property params, {structParams.Count} structs, {classParams.Count} classes, {enumParams.Count} enums");

string? ClassName(long noreg)
{
    foreach (var fn in new[] { noreg, pe.JmpTarget(noreg) })
    {
        string? prev = null;
        foreach (var t in pe.Leas(fn, 220)) { var w = pe.W(t); if (w == null) continue; if (w.StartsWith("/Script/")) { if (prev != null) return prev; } else prev = w; }
    }
    return null;
}
var resolveCache = new Dictionary<long, object?>();
object? Resolve(long fnVa)
{
    if (fnVa == 0) return null; if (resolveCache.TryGetValue(fnVa, out var r)) return r;
    foreach (var fn in new[] { fnVa, pe.JmpTarget(fnVa) })
    {
        foreach (var t in pe.Leas(fn, 96))
        {
            if (structParams.TryGetValue(t, out var sp)) { r = sp; break; }
            if (enumParams.TryGetValue(t, out var ep)) { r = ep; break; }
            if (classParams.ContainsKey(t)) { r = t; break; }
        }
        if (r != null) break;
    }
    return resolveCache[fnVa] = r;
}

var classByName = new Dictionary<string, long>();
foreach (var (k, c) in classParams) { var n = ClassName(c.noreg); if (n != null) classByName.TryAdd(n, k); }
var targets = classByName.Keys.Where(n => Regex.IsMatch(n, @"^Ted\w*DefinitionAsset$")).OrderBy(n => n).ToList();
string? SuperOf(string name)
{
    var c = classParams[classByName[name]];
    return Resolve(pe.Q(pe.V2F(c.deps))) is long sk ? classByName.FirstOrDefault(kv => kv.Value == sk).Key : null;
}

// ---------------------------------------------------------------- constructors
// StaticClass -> GetPrivateStaticClassBody(Package, Name, ReturnClass, RegisterNatives, Size, Align,
// ClassFlags, CastFlags, Config, InternalConstructor, VTableHelperCtorCaller, CppStaticFuncs, Super, Within):
// arguments 5.. are on the stack at rsp+0x20, +0x28, ...; InternalConstructor is at rsp+0x48.
(long internalCtor, int size)? FindInternalCtor(string name, long noreg)
{
    foreach (var fn in new[] { noreg, pe.JmpTarget(noreg) })
    {
        var em = new Emu(pe, fn, 0x400);
        (long, int)? found = null;
        em.OnCall = (ins, st) =>
        {
            if (found != null) return;
            if (st.Reg(Register.RDX) is { Kind: VK.Global } rdx && pe.W(rdx.V) == name)
            {
                var ic = st.Load(st.Rsp.Add(0x48), 8); var sz = st.Load(st.Rsp.Add(0x20), 4);
                if (ic.Kind == VK.Global && pe.IsText(ic.V) && sz.Kind == VK.Const) found = (ic.V, (int)sz.V);
            }
        };
        em.Run(stopAtRet: true);
        if (found != null) return found;
    }
    return null;
}
long? CtorOf(long internalCtor)
{
    // InternalConstructor<T>: { obj = X.GetObj(); if (obj) T::T(obj) } -> the first branch or call leaving the stub
    foreach (var ins in pe.Decode(internalCtor, 0x40))
    {
        if (ins.FlowControl is FlowControl.ConditionalBranch or FlowControl.UnconditionalBranch or FlowControl.Call)
        {
            long t = (long)ins.NearBranchTarget;
            if (t != 0 && (t < internalCtor || t > internalCtor + 0x40)) return t;
        }
        if (ins.Mnemonic == Mnemonic.Int3) break;
    }
    return null;
}

var info = new Dictionary<string, (string? super, long internalCtor, long ctor, int size)>();
foreach (var n in targets)
{
    var c = classParams[classByName[n]];
    var ic = FindInternalCtor(n, c.noreg);
    if (ic == null) { Console.Error.WriteLine($"{n}: GetPrivateStaticClassBody call not found"); continue; }
    var ctor = CtorOf(ic.Value.internalCtor);
    if (ctor == null) { Console.Error.WriteLine($"{n}: constructor not found in InternalConstructor {ic.Value.internalCtor:X}"); continue; }
    info[n] = (SuperOf(n), ic.Value.internalCtor, ctor.Value, ic.Value.size);
}
var ctorClass = info.ToDictionary(kv => kv.Value.ctor, kv => kv.Key);

if (cli.Opt("dis") is string dis && info.TryGetValue(dis, out var di))
{
    foreach (var ins in pe.Decode(di.ctor, 0x1400)) { Console.WriteLine($"{ins.IP:X}: {ins}"); if (ins.Mnemonic == Mnemonic.Int3) break; }
    return;
}

var images = new Dictionary<string, Image>();
Image ImageOf(string n)
{
    if (images.TryGetValue(n, out var im)) return im;
    var (_, _, ctor, size) = info[n];
    im = new Image(size);
    var em = new Emu(pe, ctor, 0x2000) { ThisImage = im };
    em.OnCall = (ins, st) =>
    {
        long t = (long)ins.NearBranchTarget;
        // the parent class's constructor called on `this`: its image is the starting point
        if (t != 0 && ctorClass.TryGetValue(t, out var parent) && st.Reg(Register.RCX) is { Kind: VK.This, V: 0 })
        {
            var pim = ImageOf(parent);
            im.CopyFrom(pim);
            em.Note($"calls {parent} constructor");
        }
    };
    em.Run(stopAtRet: false);
    images[n] = im;
    return im;
}

// ---------------------------------------------------------------- defaults per property
object? ReadScalar(Image im, int type, int off, long extra, out string? why)
{
    why = null;
    switch (type)
    {
        case 0x03: { var b = im.Bytes(off, 4); if (b == null) { why = im.Why(off, 4); return null; } return BitConverter.ToInt32(b); }
        case 0x0A: { var b = im.Bytes(off, 4); if (b == null) { why = im.Why(off, 4); return null; } return (double)BitConverter.ToSingle(b); }
        case 0x0B: { var b = im.Bytes(off, 8); if (b == null) { why = im.Why(off, 8); return null; } return BitConverter.ToDouble(b); }
        case 0x00: case 0x1E:
            {
                var b = im.Bytes(off, 1); if (b == null) { why = im.Why(off, 1); return null; }
                if (Resolve(extra) is ValueTuple<string, List<(long v, string n)>> ep) return ep.Item2.FirstOrDefault(x => x.v == b[0]).n ?? $"{ep.Item1}::<{b[0]}>";
                return (int)b[0];
            }
        case 0x0C:
            {
                // extra = SetBitFunc: "mov byte [rcx+off],1" or "or byte [rcx+off],mask"
                var first = pe.Decode(extra, 16).FirstOrDefault();
                if (first.Op0Kind != OpKind.Memory || first.MemoryBase != Register.RCX || first.MemorySize != MemorySize.UInt8) { why = "bool setter not understood"; return null; }
                int bo = (int)first.MemoryDisplacement64; int mask = first.Mnemonic == Mnemonic.Or ? (int)first.Immediate8 : 0xFF;
                if (first.Mnemonic is not (Mnemonic.Or or Mnemonic.Mov)) { why = "bool setter not understood"; return null; }
                var b = im.Bytes(bo, 1); if (b == null) { why = im.Why(bo, 1); return null; }
                return (b[0] & mask) != 0;
            }
        default: why = "type not read"; return null;
    }
}
var output = new Dictionary<string, object?>();
foreach (var n in targets.Where(info.ContainsKey))
{
    var im = ImageOf(n);
    // own and inherited reflected properties (the parent chain within the target classes)
    var chain = new List<string>(); for (var c = n; c != null && info.ContainsKey(c); c = info[c].super) chain.Insert(0, c);
    var defaults = new SortedDictionary<string, object?>(); var unknown = new SortedDictionary<string, string>(); var declared = new Dictionary<string, string>();
    foreach (var cn in chain)
    {
        var cp = classParams[classByName[cn]];
        var stack = PropList(cp.arr, cp.n);
        // container and enum params are followed by their inner params (UHT order); only top-level
        // properties have a real name/offset pair we need: skip inner ones by name convention
        foreach (var pa in stack)
        {
            var p = props[pa];
            if (p.name == "UnderlyingType" || p.name.EndsWith("_Key") || p.name.EndsWith("_Inner")) continue;
            if (declared.ContainsKey(p.name) && p.type is 0x11 or 0x12 or 0x0D) continue; // inner element of a container with the same name
            declared[p.name] = cn;
            if (p.type == 0x19)
            {
                if (Resolve(p.extra) is not ValueTuple<string, long, int, int> sp) { unknown[p.name] = "struct type not resolved"; continue; }
                if (sp.Item1 == "GameplayTagContainer")
                {
                    if (im.Tags.TryGetValue(p.offset, out var tags)) defaults[p.name] = new { tags };
                    else if (im.Bytes(p.offset, 0x20) is byte[] z && z.All(x => x == 0)) defaults[p.name] = new { tags = new List<string>() };
                    else unknown[p.name] = im.Why(p.offset, 0x20) ?? "not a plain container";
                    continue;
                }
                if (sp.Item1 == "GameplayTag")
                {
                    if (im.TagValues.TryGetValue(p.offset, out var tag)) defaults[p.name] = new { tag };
                    else if (im.Bytes(p.offset, 8) is byte[] z && z.All(x => x == 0)) defaults[p.name] = new { tag = (string?)null };
                    else unknown[p.name] = im.Why(p.offset, 8) ?? "not a literal tag";
                    continue;
                }
                var fields = new SortedDictionary<string, object?>(); var fu = new List<string>();
                foreach (var fa in PropList(sp.Item2, sp.Item3))
                {
                    var fp = props[fa]; if (fp.name == "UnderlyingType") continue;
                    var v = ReadScalar(im, fp.type, p.offset + fp.offset, fp.extra, out var w);
                    if (fp.type == 0x0C) { v = null; w = "bool in struct not read"; }
                    if (v != null) fields[fp.name] = v; else if (w != "type not read") fu.Add($"{fp.name}: {w}");
                }
                if (fields.Count > 0) defaults[p.name] = fields;
                if (fu.Count > 0) unknown[p.name] = string.Join("; ", fu);
                continue;
            }
            if (p.type == 0x0C)
            {
                var v = ReadScalar(im, p.type, 0, p.extra, out var w); if (v != null) defaults[p.name] = v; else unknown[p.name] = w!; continue;
            }
            if (p.type is 0x03 or 0x0A or 0x0B or 0x00 or 0x1E)
            {
                var v = ReadScalar(im, p.type, p.offset, p.extra, out var w); if (v != null) defaults[p.name] = v; else unknown[p.name] = w!;
            }
        }
    }
    output[n] = new
    {
        super = info[n].super,
        internalConstructor = $"0x{info[n].internalCtor:X}",
        constructor = $"0x{info[n].ctor:X}",
        size = $"0x{info[n].size:X}",
        properties = declared.ToDictionary(kv => kv.Key, kv => kv.Value),
        defaults,
        unknown,
        notes = im.Notes,
    };
    Console.Error.WriteLine($"{n}: {defaults.Count} defaults, {unknown.Count} not determined (constructor 0x{info[n].ctor:X})");
}

var fi = new FileInfo(exePath);
var doc = new
{
    source = "C++ constructors of the definition classes in Tempest-Win64-Shipping.exe, read statically by extractor/nativedefaults",
    exe = new { name = fi.Name, size = fi.Length, lastWriteUtc = fi.LastWriteTimeUtc.ToString("o") },
    classes = output,
};
File.WriteAllText(outPath, JsonSerializer.Serialize(doc, new JsonSerializerOptions { WriteIndented = true }));
Console.Error.WriteLine($"wrote {outPath}");

// ======================================================================== helpers

enum VK { Unknown, Const, This, Stack, Global, Name, Tag }
readonly record struct Val(VK Kind, long V = 0, string? S = null)
{
    public static readonly Val Unk = new(VK.Unknown);
    public Val Add(long d) => Kind is VK.Const or VK.This or VK.Stack or VK.Global ? this with { V = V + d } : Unk;
    public bool IsPtr => Kind is VK.This or VK.Stack or VK.Global;
}

/// Bytes of a new object as the constructor leaves them: known, unknown (written with an
/// unknown value or behind a branch), or never written. Tag containers and tag values separately.
sealed class Image(int size)
{
    readonly byte?[] bytes = new byte?[size];
    readonly string?[] why = new string?[size];
    public readonly SortedDictionary<int, List<string>> Tags = new();
    public readonly Dictionary<int, string> TagValues = new();
    public readonly List<string> Notes = new();
    public void Set(int off, byte[] b) { for (int i = 0; i < b.Length; i++) if (off + i >= 0 && off + i < bytes.Length) { bytes[off + i] = b[i]; why[off + i] = null; } TagValues.Remove(off); }
    public void Unknown(int off, int n, string reason) { for (int i = 0; i < n; i++) if (off + i >= 0 && off + i < bytes.Length) { bytes[off + i] = null; why[off + i] = reason; } TagValues.Remove(off); }
    public byte[]? Bytes(int off, int n) { if (off < 0 || off + n > bytes.Length) return null; var r = new byte[n]; for (int i = 0; i < n; i++) { if (bytes[off + i] is not byte b) return null; r[i] = b; } return r; }
    public string? Why(int off, int n) { for (int i = 0; i < n && off + i < bytes.Length; i++) if (bytes[off + i] == null) return why[off + i] ?? "not written by the constructor"; return null; }
    public byte? Byte(int off) => off >= 0 && off < bytes.Length ? bytes[off] : null;
    public void CopyFrom(Image o)
    {
        Array.Copy(o.bytes, bytes, Math.Min(o.bytes.Length, bytes.Length)); Array.Copy(o.why, why, Math.Min(o.why.Length, why.Length));
        foreach (var (k, v) in o.Tags) Tags[k] = new List<string>(v);
        foreach (var (k, v) in o.TagValues) TagValues[k] = v;
    }
}

/// Straight-line symbolic execution of one function. Tracks registers, stack and global cells as
/// constants or pointers (this / stack / global), stores to `this` into an Image, and the
/// gameplay-tag idiom FName(L"A.B") -> RequestGameplayTag -> AddTag.
sealed class Emu
{
    readonly Pe pe; readonly long start; readonly int maxLen;
    public Image? ThisImage;
    public Action<Instruction, Emu>? OnCall;
    readonly Dictionary<Register, Val> regs = new();
    readonly Dictionary<Register, byte[]> xmm = new();
    readonly Dictionary<(VK, long), Val> cells = new();
    static readonly Dictionary<long, Val> globalCells = new();
    long condUntil; bool cold; int depth;
    public Emu(Pe pe, long start, int maxLen, int depth = 0) { this.pe = pe; this.start = start; this.maxLen = maxLen; this.depth = depth; }
    public void Note(string s) { if (ThisImage != null && !ThisImage.Notes.Contains(s)) ThisImage.Notes.Add(s); }
    public Val Rsp => Reg(Register.RSP);
    public Val Reg(Register r) => regs.TryGetValue(r.GetFullRegister(), out var v) ? v : Val.Unk;
    void SetReg(Register r, Val v)
    {
        var full = r.GetFullRegister();
        if (r.GetSize() >= 4 || v.Kind != VK.Const) { regs[full] = r.GetSize() == 4 && v.Kind == VK.Const ? v with { V = v.V & 0xFFFFFFFF } : (r.GetSize() < 4 ? Val.Unk : v); return; }
        var old = Reg(full); if (old.Kind != VK.Const) { regs[full] = Val.Unk; return; }
        long mask = r.GetSize() == 1 ? 0xFF : 0xFFFF; regs[full] = new Val(VK.Const, (old.V & ~mask) | (v.V & mask));
    }
    Val Cell(Val p) => p.Kind == VK.Global ? (globalCells.TryGetValue(p.V, out var g) ? g : Val.Unk) : cells.TryGetValue((p.Kind, p.V), out var c) ? c : Val.Unk;
    void SetCell(Val p, Val v) { if (p.Kind == VK.Global) globalCells[p.V] = v; else if (p.IsPtr) cells[(p.Kind, p.V)] = v; }
    public Val Load(Val p, int size)
    {
        var c = Cell(p);
        if (c.Kind != VK.Unknown) return c;
        if (p.Kind == VK.This && ThisImage?.Bytes((int)p.V, size) is byte[] b) return new Val(VK.Const, size == 8 ? BitConverter.ToInt64(b) : size == 4 ? BitConverter.ToUInt32(b) : size == 2 ? BitConverter.ToUInt16(b) : b[0]);
        return Val.Unk;
    }
    Val Addr(in Instruction ins)
    {
        if (ins.IsIPRelativeMemoryOperand) return new Val(VK.Global, (long)ins.IPRelativeMemoryAddress);
        if (ins.MemoryIndex != Register.None || ins.MemorySegment is Register.GS or Register.FS) return Val.Unk;
        return Reg(ins.MemoryBase).Add((long)ins.MemoryDisplacement64);
    }
    Val Operand(in Instruction ins, int i)
    {
        switch (ins.GetOpKind(i))
        {
            case OpKind.Register:
                {
                    var r = ins.GetOpRegister(i); var v = Reg(r); int rs = r.GetSize();
                    return v.Kind == VK.Const && rs < 8 ? v with { V = v.V & (rs == 4 ? 0xFFFFFFFF : rs == 2 ? 0xFFFF : 0xFF) } : v;
                }
            case OpKind.Immediate8: case OpKind.Immediate16: case OpKind.Immediate32: case OpKind.Immediate64:
            case OpKind.Immediate8to16: case OpKind.Immediate8to32: case OpKind.Immediate8to64: case OpKind.Immediate32to64:
                return new Val(VK.Const, (long)ins.GetImmediate(i));
            case OpKind.Memory: return Load(Addr(ins), ins.MemorySize.GetSize());
            default: return Val.Unk;
        }
    }
    void StoreThis(long off, int size, byte[]? b, string reason)
    {
        if (ThisImage == null || cold) return;
        if (b == null) ThisImage.Unknown((int)off, size, reason);
        else if (condUntil > 0) ThisImage.Unknown((int)off, size, "written only on a conditional path");
        else ThisImage.Set((int)off, b);
    }
    void Store(in Instruction ins, Val v, byte[]? raw = null)
    {
        var p = Addr(ins); int size = ins.MemorySize.GetSize();
        if (p.Kind == VK.This)
        {
            if (v.Kind == VK.Tag && size == 8 && ThisImage != null && !cold && condUntil == 0) { ThisImage.Unknown((int)p.V, 8, "tag"); ThisImage.TagValues[(int)p.V] = v.S!; return; }
            byte[]? b = raw ?? (v.Kind == VK.Const ? BitConverter.GetBytes(v.V)[..size] : null);
            StoreThis(p.V, size, b, "written with a value not known statically");
        }
        else if (p.IsPtr) SetCell(p, v);
    }
    static bool TagLike(string? s) => s != null && Regex.IsMatch(s, @"^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$");
    public void Run(bool stopAtRet)
    {
        // two passes: the second sees the global cells (static tags) set by cold blocks of the first
        for (int pass = 0; pass < 2; pass++)
        {
            regs.Clear(); xmm.Clear(); cells.Clear(); condUntil = 0; cold = false;
            regs[Register.RCX] = new Val(VK.This, 0); regs[Register.RSP] = new Val(VK.Stack, 0);
            if (ThisImage != null && pass == 0) { var keep = ThisImage; ThisImage = null; Exec(stopAtRet); ThisImage = keep; continue; }
            Exec(stopAtRet);
            if (ThisImage == null && OnCall == null) break;
        }
    }
    public Val RunCallee()
    {
        regs[Register.RSP] = new Val(VK.Stack, 0);
        Val ret = Val.Unk;
        foreach (var ins in pe.Decode(start, maxLen))
        {
            if (ins.Mnemonic == Mnemonic.Int3) break;
            if (ins.FlowControl == FlowControl.Return) { if (!cold) ret = Reg(Register.RAX); cold = true; continue; }
            Step(ins);
        }
        return ret;
    }
    long hotEnd = long.MaxValue;
    List<Instruction>? code;
    void Exec(bool stopAtRet)
    {
        code ??= pe.Decode(start, maxLen).TakeWhile(i => i.Mnemonic != Mnemonic.Int3).ToList();
        hotEnd = code.FirstOrDefault(i => i.FlowControl == FlowControl.Return) is { IsInvalid: false } r && r.FlowControl == FlowControl.Return ? (long)r.IP : long.MaxValue;
        foreach (var ins in code)
        {
            if (ins.Mnemonic == Mnemonic.Int3) break;
            if ((long)ins.IP >= condUntil) condUntil = 0;
            if (ins.FlowControl == FlowControl.Return) { if (stopAtRet) return; cold = true; continue; }
            Step(ins);
        }
    }
    void Step(in Instruction ins)
    {
        switch (ins.FlowControl)
        {
            case FlowControl.ConditionalBranch:
            case FlowControl.UnconditionalBranch:
                {
                    long t = (long)ins.NearBranchTarget;
                    // A forward branch to a block placed after the function's return (e.g. the
                    // one-time initialization of a static) that jumps straight back to the next
                    // instruction is a detour, not a fork. Anything else forks the straight path:
                    // code between the branch and its target runs only on some paths.
                    if (t > hotEnd && !cold) { if (DetourReturn(t) != (long)ins.NextIP) condUntil = long.MaxValue; return; }
                    if (t > (long)ins.IP && !cold) condUntil = Math.Max(condUntil, t);
                    if (ins.FlowControl == FlowControl.UnconditionalBranch && t < (long)ins.IP) cold = true; // jumped back: what follows is a cold block
                    return;
                }
            case FlowControl.Call: Call(ins); return;
            case FlowControl.IndirectCall: Clobber(); return;
        }
        var m = ins.Mnemonic;
        if (m == Mnemonic.Push) { var sp = Rsp.Add(-8); regs[Register.RSP] = sp; SetCell(sp, Operand(ins, 0)); return; }
        if (m == Mnemonic.Pop) { var sp = Rsp; SetReg(ins.Op0Register, Load(sp, 8)); regs[Register.RSP] = sp.Add(8); return; }
        if ((m == Mnemonic.Sub || m == Mnemonic.Add) && ins.Op0Kind == OpKind.Register && ins.Op0Register == Register.RSP && Operand(ins, 1) is { Kind: VK.Const } d)
        { regs[Register.RSP] = Rsp.Add(m == Mnemonic.Sub ? -d.V : d.V); return; }
        if (m == Mnemonic.Lea) { SetReg(ins.Op0Register, Addr(ins)); return; }
        if (m == Mnemonic.Xor && ins.Op0Kind == OpKind.Register && ins.Op1Kind == OpKind.Register && ins.Op0Register == ins.Op1Register)
        { SetReg(ins.Op0Register, new Val(VK.Const, 0)); return; }
        if ((m == Mnemonic.Xorps || m == Mnemonic.Pxor || m == Mnemonic.Xorpd) && ins.Op0Register == ins.Op1Register) { xmm[ins.Op0Register] = new byte[16]; return; }
        if (m is Mnemonic.Mov or Mnemonic.Movzx)
        {
            if (ins.Op0Kind == OpKind.Register) { SetReg(ins.Op0Register, Operand(ins, 1)); return; }
            if (ins.Op0Kind == OpKind.Memory) { Store(ins, Operand(ins, 1)); return; }
        }
        if (m is Mnemonic.Movss or Mnemonic.Movsd or Mnemonic.Movups or Mnemonic.Movaps or Mnemonic.Movdqu or Mnemonic.Movdqa or Mnemonic.Movq or Mnemonic.Movd or Mnemonic.Movupd or Mnemonic.Movapd or Mnemonic.Movlps or Mnemonic.Movhps)
        {
            int size = ins.Op0Kind == OpKind.Memory ? ins.MemorySize.GetSize() : ins.Op1Kind == OpKind.Memory ? ins.MemorySize.GetSize() : 16;
            if (ins.Op0Kind == OpKind.Register && ins.Op0Register.IsXMM())
            {
                byte[]? v = null;
                if (ins.Op1Kind == OpKind.Memory && ins.IsIPRelativeMemoryOperand && m != Mnemonic.Movhps && m != Mnemonic.Movlps) { var f = pe.V2F((long)ins.IPRelativeMemoryAddress); if (f > 0) { v = new byte[16]; Array.Copy(pe.Exe, f, v, 0, size); } }
                else if (ins.Op1Kind == OpKind.Register && ins.Op1Register.IsXMM() && xmm.TryGetValue(ins.Op1Register, out var src)) v = (byte[])src.Clone();
                else if (ins.Op1Kind == OpKind.Register && !ins.Op1Register.IsXMM() && Reg(ins.Op1Register) is { Kind: VK.Const } g) { v = new byte[16]; BitConverter.GetBytes(g.V).AsSpan(0, size).CopyTo(v); }
                if (v != null) xmm[ins.Op0Register] = v; else xmm.Remove(ins.Op0Register);
                return;
            }
            if (ins.Op0Kind == OpKind.Memory && ins.Op1Kind == OpKind.Register && ins.Op1Register.IsXMM())
            {
                var p = Addr(ins);
                if (p.Kind == VK.This) StoreThis(p.V, size, xmm.TryGetValue(ins.Op1Register, out var v) ? v[..size] : null, "written from a register not known statically");
                return;
            }
            if (ins.Op0Kind == OpKind.Register) { SetReg(ins.Op0Register, Val.Unk); return; }
        }
        if ((m == Mnemonic.And || m == Mnemonic.Or) && ins.Op0Kind == OpKind.Memory && Addr(ins) is { Kind: VK.This } tp && Operand(ins, 1) is { Kind: VK.Const } imm && ins.MemorySize.GetSize() == 1)
        {
            var cur = ThisImage?.Byte((int)tp.V);
            StoreThis(tp.V, 1, cur is byte c ? new[] { (byte)(m == Mnemonic.And ? c & imm.V : c | imm.V) } : null, "bit operation on an unknown byte");
            return;
        }
        // anything else: whatever it writes becomes unknown
        if (ins.OpCount > 0 && ins.Op0Kind == OpKind.Register && !(m is Mnemonic.Cmp or Mnemonic.Test)) { if (ins.Op0Register.IsXMM()) xmm.Remove(ins.Op0Register); else SetReg(ins.Op0Register, Val.Unk); }
        else if (ins.OpCount > 0 && ins.Op0Kind == OpKind.Memory && !(m is Mnemonic.Cmp or Mnemonic.Test))
        { var p = Addr(ins); if (p.Kind == VK.This) StoreThis(p.V, Math.Max(1, ins.MemorySize.GetSize()), null, $"written by {m}"); }
    }
    long DetourReturn(long t)
    {
        foreach (var i in code ?? new List<Instruction>())
        {
            if ((long)i.IP < t) continue;
            if (i.FlowControl == FlowControl.UnconditionalBranch) return (long)i.NearBranchTarget;
            if (i.FlowControl == FlowControl.Return) return -1;
        }
        return -1;
    }
    void Clobber() { foreach (var r in new[] { Register.RAX, Register.RCX, Register.RDX, Register.R8, Register.R9, Register.R10, Register.R11 }) regs[r] = Val.Unk; for (var x = Register.XMM0; x <= Register.XMM5; x++) xmm.Remove(x); }
    void Call(in Instruction ins)
    {
        OnCall?.Invoke(ins, this);
        var rcx = Reg(Register.RCX); var rdx = Reg(Register.RDX);
        Val ret = Val.Unk;
        if (rdx.Kind == VK.Global && rcx.IsPtr && pe.W(rdx.V) is string w && TagLike(w))
            SetCell(rcx, new Val(VK.Name, 0, w)); // FName(L"A.B")
        else if (rdx.IsPtr && Cell(rdx) is { Kind: VK.Name } nm && rcx.IsPtr && rcx.Kind != VK.This)
        { SetCell(rcx, new Val(VK.Tag, 0, nm.S)); ret = rcx; } // RequestGameplayTag(FName) -> tag in *rcx
        else if (rcx.Kind == VK.This && rdx.IsPtr && Cell(rdx) is { Kind: VK.Tag } tg)
        {
            // AddTag(this->Container, Tag)
            if (ThisImage != null && !cold)
            {
                if (condUntil > 0) ThisImage.Unknown((int)rcx.V, 0x20, "tag added only on a conditional path");
                else { if (!ThisImage.Tags.TryGetValue((int)rcx.V, out var l)) ThisImage.Tags[(int)rcx.V] = l = new List<string>(); if (!l.Contains(tg.S!)) l.Add(tg.S!); }
            }
        }
        else if (depth < 2 && rcx.Kind != VK.This && ins.NearBranchTarget != 0)
        {
            // a small helper (e.g. a getter of a static tag): run it for its return value
            var callee = new Emu(pe, (long)ins.NearBranchTarget, 0x200, depth + 1);
            callee.regs[Register.RCX] = rcx; callee.regs[Register.RDX] = rdx;
            var r = callee.RunCallee();
            if (r.Kind == VK.Global) ret = r;
        }
        Clobber();
        regs[Register.RAX] = ret;
    }
}

sealed class Pe
{
    public readonly byte[] Exe; public readonly long Ib;
    public readonly List<(string n, long va, long vs, long raw, long rs)> Secs = new();
    public readonly (string n, long va, long vs, long raw, long rs) Text;
    public readonly List<(string n, long va, long vs, long raw, long rs)> DataSecs;
    readonly Dictionary<long, string?> strCache = new();
    public Pe(byte[] exe)
    {
        Exe = exe;
        int pe = BitConverter.ToInt32(exe, 0x3C); int nsec = BitConverter.ToUInt16(exe, pe + 6); int optSize = BitConverter.ToUInt16(exe, pe + 20);
        Ib = (long)BitConverter.ToUInt64(exe, pe + 48); int sh = pe + 24 + optSize;
        for (int i = 0; i < nsec; i++) { int o = sh + i * 40; Secs.Add((Encoding.ASCII.GetString(exe, o, 8).TrimEnd('\0'), BitConverter.ToUInt32(exe, o + 12), BitConverter.ToUInt32(exe, o + 8), BitConverter.ToUInt32(exe, o + 20), BitConverter.ToUInt32(exe, o + 16))); }
        Text = Secs.First(s => s.n == ".text");
        DataSecs = Secs.Where(s => s.n == ".rdata" || s.n == ".data").ToList();
    }
    public long V2F(long va) { long rva = va - Ib; foreach (var s in Secs) if (rva >= s.va && rva < s.va + s.rs) return s.raw + (rva - s.va); return -1; }
    public long F2V(long off) { foreach (var s in Secs) if (off >= s.raw && off < s.raw + s.rs) return Ib + s.va + (off - s.raw); return -1; }
    public bool IsText(long va) { long rva = va - Ib; return rva >= Text.va && rva < Text.va + Text.vs; }
    public long Q(long f) => BitConverter.ToInt64(Exe, (int)f);
    public string? A(long va)
    {
        if (strCache.TryGetValue(va, out var c)) return c;
        var f = V2F(va); string? r = null;
        if (f > 0)
        {
            int e = (int)f;
            while (e < Exe.Length && Exe[e] != 0 && e - f < 256) { if (Exe[e] < 32 || Exe[e] > 126) { e = -1; break; } e++; }
            if (e > f && e < Exe.Length && Exe[e] == 0) r = Encoding.ASCII.GetString(Exe, (int)f, e - (int)f);
        }
        return strCache[va] = r;
    }
    public string? W(long va)
    {
        var f = V2F(va); if (f < 0) return null; var sb = new StringBuilder();
        for (int k = 0; k < 256 && f + 2 * k + 1 < Exe.Length; k++) { char c = (char)BitConverter.ToUInt16(Exe, (int)f + 2 * k); if (c == 0) return sb.Length > 0 ? sb.ToString() : null; if (c < 32 || c > 126) return null; sb.Append(c); }
        return null;
    }
    public IEnumerable<long> Leas(long fnVa, int len)
    {
        long f = V2F(fnVa); if (f < 0) yield break;
        for (int i = 0; i < len; i++)
        {
            long p = f + i;
            if ((Exe[p] == 0x48 || Exe[p] == 0x4C) && Exe[p + 1] == 0x8D && (Exe[p + 2] & 0xC7) == 0x05)
                yield return F2V(p + 7) + BitConverter.ToInt32(Exe, (int)p + 3);
        }
    }
    public long JmpTarget(long fnVa) { long f = V2F(fnVa); if (f > 0 && Exe[f] == 0xE9) return F2V(f + 5) + BitConverter.ToInt32(Exe, (int)f + 1); return fnVa; }
    public IEnumerable<Instruction> Decode(long va, int len)
    {
        long f = V2F(va); if (f < 0) yield break;
        var dec = Iced.Intel.Decoder.Create(64, new ByteArrayCodeReader(Exe, (int)f, (int)Math.Min(len, Exe.Length - f)));
        dec.IP = (ulong)va;
        while (dec.IP < (ulong)(va + len)) { var ins = dec.Decode(); if (ins.IsInvalid) yield break; yield return ins; }
    }
}

// ---- shared helpers (duplicated in each single-file tool on purpose) ----
sealed class Cli
{
    readonly Dictionary<string, string> opts = new(StringComparer.OrdinalIgnoreCase);
    public readonly List<string> Positional = new();
    public readonly HashSet<string> Flags = new(StringComparer.OrdinalIgnoreCase);
    public Cli(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (!a.StartsWith("--")) { Positional.Add(a); continue; }
            var eq = a.IndexOf('=');
            if (eq > 0) opts[a[2..eq]] = a[(eq + 1)..];
            else if (i + 1 < args.Length && !args[i + 1].StartsWith("--")) opts[a[2..]] = args[++i];
            else Flags.Add(a[2..]);
        }
    }
    public string? Opt(string name) => opts.TryGetValue(name, out var v) ? v : null;
}

static class Paths
{
    // extractor/ folder, derived from this source file's location at compile time
    public static string ExtractorDir([CallerFilePath] string here = "") =>
        File.Exists(here) ? Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..")) : Directory.GetCurrentDirectory();
    public static string OutDir => Path.Combine(ExtractorDir(), "out");

    // Game root: --game, then env TR_GAME_DIR, then the Steam libraries listed in libraryfolders.vdf.
    public static string GameDir(string? opt)
    {
        var cands = new List<string>();
        if (!string.IsNullOrWhiteSpace(opt)) cands.Add(opt);
        else
        {
            var env = Environment.GetEnvironmentVariable("TR_GAME_DIR");
            if (!string.IsNullOrWhiteSpace(env)) cands.Add(env);
            else
            {
                var steam = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam");
                var libs = new List<string> { steam };
                var vdf = Path.Combine(steam, "steamapps", "libraryfolders.vdf");
                if (File.Exists(vdf))
                    foreach (Match m in Regex.Matches(File.ReadAllText(vdf), "\"path\"\\s+\"(.+?)\""))
                        libs.Add(m.Groups[1].Value.Replace("\\\\", "\\"));
                cands.AddRange(libs.Select(l => Path.Combine(l, "steamapps", "common", "Tempest Rising")));
            }
        }
        foreach (var c in cands)
            foreach (var root in new[] { c, Path.Combine(c, ".."), Path.Combine(c, "..", "..", "..") })
                if (Directory.Exists(Path.Combine(root, "Tempest", "Content", "Paks"))) return Path.GetFullPath(root);
        throw new DirectoryNotFoundException("Tempest Rising not found. Pass --game <dir> or set TR_GAME_DIR. Tried: " + string.Join("; ", cands));
    }
    public static string ExePath(string? opt) => Path.Combine(GameDir(opt), "Tempest", "Binaries", "Win64", "Tempest-Win64-Shipping.exe");
}
