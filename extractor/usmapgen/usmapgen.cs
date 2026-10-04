#:package CUE4Parse@1.2.2.202610
// usmapgen: builds a .usmap (unversioned property mappings) for Tempest Rising statically,
// without running the game. It reads the reflection tables that Unreal Header Tool generates
// (FClassParams / FStructParams / FEnumParams / FPropertyParams) straight from the shipping
// exe. Read-only: the exe is read as bytes and never executed.
// Property order mirrors UECodeGen_Private::ConstructFProperties.
// Types that are not present in the exe (engine plugins etc.) can be taken from an older
// community usmap passed with --fallback; without it those types are simply missing.
//
// Usage:
//   dotnet run usmapgen.cs -- [--game <dir> | --exe <file>] [--fallback <old.usmap>] [--out <file.usmap>] [--diff Class1,Class2]
// Default output: extractor/out/Tempest.usmap (git-ignored).
using System.Runtime.CompilerServices;
using System.Text;
using CUE4Parse.MappingsProvider;
using CUE4Parse.MappingsProvider.Usmap;

var cli = new Cli(args);
var exePath = cli.Opt("exe") ?? Paths.ExePath(cli.Opt("game"));
var outPath = cli.Opt("out") ?? Path.Combine(Paths.OutDir, "Tempest.usmap");
Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
Console.Error.WriteLine($"exe: {exePath}");
var exe = File.ReadAllBytes(exePath);
var fallbackPath = cli.Opt("fallback");
var old = fallbackPath != null ? new UsmapParser(fallbackPath).Mappings! : new TypeMappings();
if (fallbackPath == null) Console.Error.WriteLine("no --fallback usmap: types missing from the exe will be absent");
int pe = BitConverter.ToInt32(exe, 0x3C); int nsec = BitConverter.ToUInt16(exe, pe + 6); int optSize = BitConverter.ToUInt16(exe, pe + 20);
long ib = (long)BitConverter.ToUInt64(exe, pe + 48); int sh = pe + 24 + optSize;
var secs = new List<(string n, long va, long vs, long raw, long rs)>();
for (int i = 0; i < nsec; i++) { int o = sh + i * 40; secs.Add((Encoding.ASCII.GetString(exe, o, 8).TrimEnd('\0'), BitConverter.ToUInt32(exe, o + 12), BitConverter.ToUInt32(exe, o + 8), BitConverter.ToUInt32(exe, o + 20), BitConverter.ToUInt32(exe, o + 16))); }
var text = secs.First(s => s.n == ".text");
var dataSecs = secs.Where(s => s.n == ".rdata" || s.n == ".data").ToList();
long V2F(long va) { long rva = va - ib; foreach (var s in secs) if (rva >= s.va && rva < s.va + s.rs) return s.raw + (rva - s.va); return -1; }
long F2V(long off) { foreach (var s in secs) if (off >= s.raw && off < s.raw + s.rs) return ib + s.va + (off - s.raw); return -1; }
bool IsText(long va) { long rva = va - ib; return rva >= text.va && rva < text.va + text.vs; }
long Q(long f) => BitConverter.ToInt64(exe, (int)f);
var strCache = new Dictionary<long, string?>();
string? A(long va)
{
    if (strCache.TryGetValue(va, out var c)) return c;
    var f = V2F(va); string? r = null;
    if (f > 0)
    {
        int e = (int)f;
        while (e < exe.Length && exe[e] != 0 && e - f < 256) { if (exe[e] < 32 || exe[e] > 126) { e = -1; break; } e++; }
        if (e > f && e < exe.Length && exe[e] == 0) r = Encoding.ASCII.GetString(exe, (int)f, e - (int)f);
    }
    return strCache[va] = r;
}
string? W(long va)
{
    var f = V2F(va); if (f < 0) return null; var sb = new StringBuilder();
    for (int k = 0; k < 256; k++) { char c = (char)BitConverter.ToUInt16(exe, (int)f + 2 * k); if (c == 0) return sb.Length > 0 ? sb.ToString() : null; if (c < 32 || c > 126) return null; sb.Append(c); }
    return null;
}
IEnumerable<long> Leas(long fnVa, int len)
{
    long f = V2F(fnVa); if (f < 0) yield break;
    for (int i = 0; i < len; i++)
    {
        long p = f + i;
        if ((exe[p] == 0x48 || exe[p] == 0x4C) && exe[p + 1] == 0x8D && (exe[p + 2] & 0xC7) == 0x05)
            yield return F2V(p + 7) + BitConverter.ToInt32(exe, (int)p + 3);
    }
}
long JmpTarget(long fnVa) { long f = V2F(fnVa); if (f > 0 && exe[f] == 0xE9) return F2V(f + 5) + BitConverter.ToInt32(exe, (int)f + 1); return fnVa; }

// ---- 1. FPropertyParams: {Name*, RepNotify*, u64 PropertyFlags, u8 GenFlags, i32 ObjFlags, Setter, Getter, u16 ArrayDim, u16 Offset, extra@56}
var props = new Dictionary<long, (string name, int type, int arrayDim, long extra)>();
foreach (var s in dataSecs)
{
    for (long f = s.raw; f + 64 <= s.raw + s.rs; f += 8)
    {
        long q0 = Q(f); if (q0 < ib || q0 > ib + 0xB000000) continue;
        var name = A(q0); if (string.IsNullOrEmpty(name)) continue;
        long q1 = Q(f + 8); if (q1 != 0 && A(q1) == null) continue;
        int tb = exe[f + 24]; if (exe[f + 25] != 0 || exe[f + 26] != 0 || exe[f + 27] != 0) continue;
        int type = tb & 0x3F; if (type > 0x22 || type == 8 || type == 9) continue;
        long q32 = Q(f + 32), q40 = Q(f + 40); if ((q32 != 0 && !IsText(q32)) || (q40 != 0 && !IsText(q40))) continue;
        int ad = BitConverter.ToUInt16(exe, (int)f + 48); if (ad < 1 || ad > 512) continue;
        props[F2V(f)] = (name, type, ad, Q(f + 56));
    }
}
Console.Error.WriteLine($"prop param candidates: {props.Count}");

// ---- 2. FEnumParams {Outer, DisplayNameFunc, Name, CppType, Enumerators*, i32 ObjFlags, u16 Num, u8 EnumFlags, u8 CppForm}; FEnumeratorParam {Name*, i64 Value}
var enumParams = new Dictionary<long, (string name, List<(long v, string n)> vals)>();
foreach (var s in dataSecs)
{
    for (long f = s.raw; f + 48 <= s.raw + s.rs; f += 8)
    {
        if (!IsText(Q(f))) continue; long q1 = Q(f + 8); if (q1 != 0 && !IsText(q1)) continue;
        var name = A(Q(f + 16)); if (string.IsNullOrEmpty(name)) continue;
        if (A(Q(f + 24)) == null) continue;
        long ep = V2F(Q(f + 32)); int n = BitConverter.ToUInt16(exe, (int)f + 44); if (ep < 0 || n <= 0 || n > 5000) continue;
        var vals = new List<(long, string)>(); bool ok = true;
        for (int k = 0; k < n; k++)
        {
            var en = A(Q(ep + 16 * k)); if (en == null) { ok = false; break; }
            vals.Add((Q(ep + 16 * k + 8), en.Contains("::") ? en[(en.LastIndexOf("::") + 2)..] : en));
        }
        if (ok) enumParams[F2V(f)] = (name, vals);
    }
}
Console.Error.WriteLine($"enums: {enumParams.Count}");

bool PropArrayOk(long arrVa, int n)
{
    long af = V2F(arrVa); if (af < 0) return false;
    for (int k = 0; k < n; k++) if (!props.ContainsKey(Q(af + 8 * k))) return false;
    return true;
}

// ---- 3. FStructParams {Outer, Super, StructOps, Name, PropArray, u16 Num, u16 SizeOf, ...}
var structParams = new Dictionary<long, (string name, long superFn, long arr, int n)>();
foreach (var s in dataSecs)
{
    for (long f = s.raw; f + 48 <= s.raw + s.rs; f += 8)
    {
        long q0 = Q(f); if (!IsText(q0)) continue;
        long q1 = Q(f + 8), q2 = Q(f + 16); if ((q1 != 0 && !IsText(q1)) || (q2 != 0 && !IsText(q2))) continue;
        var name = A(Q(f + 24)); if (string.IsNullOrEmpty(name) || name.Contains(' ')) continue;
        long arr = Q(f + 32); int n = BitConverter.ToUInt16(exe, (int)f + 40); int size = BitConverter.ToUInt16(exe, (int)f + 42);
        if (size == 0) continue;
        if (n > 0 ? !PropArrayOk(arr, n) : arr != 0) continue;
        structParams[F2V(f)] = (name, q1, arr, n);
    }
}
Console.Error.WriteLine($"structs: {structParams.Count}");

// ---- 4. FClassParams {Noreg, Config, CppInfo, Deps, Funcs, PropArray, Ifaces, u32 bitfield(deps:4,funcs:11,props:11,ifaces:6), flags}
var classParams = new Dictionary<long, (long noreg, long deps, long arr, int n)>();
foreach (var s in dataSecs)
{
    for (long f = s.raw; f + 64 <= s.raw + s.rs; f += 8)
    {
        if (!IsText(Q(f))) continue; long q1 = Q(f + 8); if (q1 != 0 && A(q1) == null) continue;
        if (V2F(Q(f + 16)) < 0) continue;
        long deps = Q(f + 24); uint bf = BitConverter.ToUInt32(exe, (int)f + 56);
        int ndeps = (int)(bf & 0xF), nprop = (int)((bf >> 15) & 0x7FF);
        if (ndeps == 0 || V2F(deps) < 0 || !IsText(Q(V2F(deps)))) continue;
        long arr = Q(f + 40);
        if (nprop > 0 ? !PropArrayOk(arr, nprop) : arr != 0) continue;
        classParams[F2V(f)] = (Q(f), deps, arr, nprop);
    }
}
Console.Error.WriteLine($"classes: {classParams.Count}");

// ---- name resolution
string? ClassName(long noreg)
{
    foreach (var fn in new[] { noreg, JmpTarget(noreg) })
    {
        string? prev = null;
        foreach (var t in Leas(fn, 220))
        {
            var w = W(t); if (w == null) continue;
            if (w.StartsWith("/Script/")) { if (prev != null) return prev; }
            else prev = w;
        }
    }
    return null;
}
var fnCache = new Dictionary<long, object?>();
object? Resolve(long fnVa)
{
    if (fnVa == 0) return null; if (fnCache.TryGetValue(fnVa, out var r)) return r;
    r = null;
    foreach (var fn in new[] { fnVa, JmpTarget(fnVa) })
    {
        foreach (var t in Leas(fn, 96))
        {
            if (structParams.TryGetValue(t, out var sp)) { r = sp; break; }
            if (enumParams.TryGetValue(t, out var ep)) { r = ep; break; }
            if (classParams.ContainsKey(t)) { r = t; break; }
        }
        if (r != null) break;
    }
    return fnCache[fnVa] = r;
}

var classNames = new Dictionary<long, string>();
foreach (var (k, c) in classParams) { var n = ClassName(c.noreg); if (n != null) classNames[k] = n; }
Console.Error.WriteLine($"classes named: {classNames.Count}");

PropertyType? OldType(string owner, string pname) => old.Types.TryGetValue(owner, out var s) ? s.Properties.Values.FirstOrDefault(x => x.Name == pname)?.MappingType : null;
PropertyType T(string t, string? st = null, PropertyType? inner = null, PropertyType? val = null, string? en = null) => new PropertyType(t, st, inner, val, en, null, null);
int unresolved = 0;
// mirrors UECodeGen_Private::ConstructFProperties: walk the array backwards; containers consume their inner params
PropertyType MakeType(List<long> stack, string owner, string pname)
{
    var a = stack[^1]; stack.RemoveAt(stack.Count - 1); var p = props[a];
    string? Sname() { if (Resolve(p.extra) is ValueTuple<string, long, long, int> sp) return sp.Item1; unresolved++; return OldType(owner, pname)?.StructType; }
    string? Ename() { if (Resolve(p.extra) is ValueTuple<string, List<(long, string)>> ep) return ep.Item1; if (p.extra != 0) unresolved++; return null; }
    switch (p.type)
    {
        case 0x00: { var en = p.extra != 0 ? Ename() : null; return en != null ? T("EnumProperty", inner: T("ByteProperty"), en: en) : T("ByteProperty"); }
        case 0x01: return T("Int8Property");
        case 0x02: return T("Int16Property");
        case 0x03: return T("IntProperty");
        case 0x04: return T("Int64Property");
        case 0x05: return T("UInt16Property");
        case 0x06: return T("UInt32Property");
        case 0x07: return T("UInt64Property");
        case 0x0A: return T("FloatProperty");
        case 0x0B: case 0x20: return T("DoubleProperty");
        case 0x0C: return T("BoolProperty");
        case 0x0D: case 0x10: return T("SoftObjectProperty");
        case 0x0E: return T("WeakObjectProperty");
        case 0x0F: return T("LazyObjectProperty");
        case 0x11: case 0x12: return T("ObjectProperty");
        case 0x13: return T("InterfaceProperty");
        case 0x14: return T("NameProperty");
        case 0x15: return T("StrProperty");
        case 0x1D: return T("TextProperty");
        case 0x1A: return T("DelegateProperty");
        case 0x1B: case 0x1C: return T("MulticastDelegateProperty");
        case 0x1F: return T("FieldPathProperty");
        case 0x16: return T("ArrayProperty", inner: MakeType(stack, owner, pname));
        case 0x18: return T("SetProperty", inner: MakeType(stack, owner, pname));
        case 0x21: return T("OptionalProperty", inner: MakeType(stack, owner, pname));
        case 0x17: { var key = MakeType(stack, owner, pname); var val = MakeType(stack, owner, pname); return T("MapProperty", inner: key, val: val); }
        case 0x19: return T("StructProperty", st: Sname());
        case 0x1E: { var en = Ename(); var under = MakeType(stack, owner, pname); return T("EnumProperty", inner: under, en: en); }
        default: throw new Exception($"type {p.type:X} in {owner}.{pname}");
    }
}
List<(string name, int dim, PropertyType t)> BuildProps(long arr, int n, string owner)
{
    var res = new List<(string, int, PropertyType)>(); if (n == 0) return res;
    long af = V2F(arr); var stack = new List<long>(); for (int k = 0; k < n; k++) stack.Add(Q(af + 8 * k));
    while (stack.Count > 0) { var p = props[stack[^1]]; res.Add((p.name, p.arrayDim, MakeType(stack, owner, p.name))); }
    res.Reverse(); return res;
}

var outStructs = new Dictionary<string, (string? super, List<(string name, int dim, PropertyType t)> props)>();
foreach (var (k, c) in classParams)
{
    if (!classNames.TryGetValue(k, out var name)) continue;
    string? super = null;
    if (Resolve(Q(V2F(c.deps))) is long sk && classNames.TryGetValue(sk, out var sn)) super = sn;
    else if (old.Types.TryGetValue(name, out var os)) super = os.SuperType;
    outStructs[name] = (super, BuildProps(c.arr, c.n, name));
}
foreach (var (k, s) in structParams)
{
    string? super = null;
    if (s.superFn != 0)
    {
        if (Resolve(s.superFn) is ValueTuple<string, long, long, int> sp) super = sp.Item1;
        else if (old.Types.TryGetValue(s.name, out var os)) super = os.SuperType;
    }
    if (!outStructs.ContainsKey(s.name)) outStructs[s.name] = (super, BuildProps(s.arr, s.n, s.name));
}
Console.Error.WriteLine($"from exe: {outStructs.Count} structs/classes, unresolved type refs: {unresolved}");
int fromOld = 0;
foreach (var (n, s) in old.Types)
{
    if (outStructs.ContainsKey(n)) continue;
    fromOld++;
    var list = s.Properties.OrderBy(kv => kv.Key).Where(kv => kv.Value.Index == 0).Select(kv => (kv.Value.Name, kv.Value.ArraySize ?? 1, kv.Value.MappingType)).ToList();
    outStructs[n] = (s.SuperType, list);
}
Console.Error.WriteLine($"kept from old usmap: {fromOld}");
var enums = new Dictionary<string, List<(long v, string n)>>();
foreach (var e in enumParams.Values) enums.TryAdd(e.name, e.vals);
foreach (var (n, e) in old.Enums) enums.TryAdd(n, e.Select(kv => (kv.Key, kv.Value)).ToList());

// ---- diff report: fields added/removed compared with the fallback usmap
var diffNames = cli.Opt("diff")?.Split(',', StringSplitOptions.RemoveEmptyEntries) ?? new[] { "TedEntityDefinitionAsset", "TedUnitDefinitionAsset" };
foreach (var cn in diffNames)
{
    if (!outStructs.TryGetValue(cn, out var ns)) { Console.WriteLine($"{cn}: NOT FOUND"); continue; }
    var on = old.Types.TryGetValue(cn, out var os) ? os.Properties.Values.Select(p => p.Name).Distinct().ToList() : new List<string>();
    Console.WriteLine($"{cn} : {ns.super}  new={ns.props.Count} old={on.Count}  added=[{string.Join(",", ns.props.Select(p => p.name).Except(on))}] removed=[{string.Join(",", on.Except(ns.props.Select(p => p.name)))}]");
}

// ---- write usmap v4 (ExplicitEnumValues, LongFName, LargeEnums), uncompressed
var names = new List<string>(); var nameIdx = new Dictionary<string, int>();
int N(string s) { if (!nameIdx.TryGetValue(s, out var i)) { i = names.Count; names.Add(s); nameIdx[s] = i; } return i; }
void WT(BinaryWriter w, PropertyType t)
{
    w.Write((byte)Enum.Parse<EPT>(t.Type));
    switch (t.Type)
    {
        case "EnumProperty": WT(w, t.InnerType ?? T("ByteProperty")); w.Write(N(t.EnumName ?? "None")); break;
        case "StructProperty": w.Write(N(t.StructType ?? "None")); break;
        case "ArrayProperty": case "SetProperty": case "OptionalProperty": WT(w, t.InnerType!); break;
        case "MapProperty": WT(w, t.InnerType!); WT(w, t.ValueType!); break;
    }
}
var enumBlob = new MemoryStream(); var ew = new BinaryWriter(enumBlob);
ew.Write((uint)enums.Count);
foreach (var (n, vals) in enums) { ew.Write(N(n)); ew.Write((ushort)vals.Count); foreach (var (v, en) in vals) { ew.Write((ulong)v); ew.Write(N(en)); } }
var structBlob = new MemoryStream(); var sw = new BinaryWriter(structBlob);
sw.Write((uint)outStructs.Count);
foreach (var (n, s) in outStructs)
{
    sw.Write(N(n)); sw.Write(s.super == null ? uint.MaxValue : (uint)N(s.super));
    sw.Write((ushort)s.props.Sum(p => p.dim)); sw.Write((ushort)s.props.Count);
    int idx = 0;
    foreach (var p in s.props) { sw.Write((ushort)idx); sw.Write((byte)p.dim); sw.Write(N(p.name)); WT(sw, p.t); idx += p.dim; }
}
var body = new MemoryStream(); var bw = new BinaryWriter(body);
bw.Write((uint)names.Count);
foreach (var s in names) { var b = Encoding.UTF8.GetBytes(s); bw.Write((ushort)b.Length); bw.Write(b); }
bw.Write(enumBlob.ToArray()); bw.Write(structBlob.ToArray());
var data = body.ToArray();
using (var o = new BinaryWriter(File.Create(outPath)))
{
    o.Write((ushort)0x30C4); o.Write((byte)4); o.Write(0); o.Write((byte)0);
    o.Write((uint)data.Length); o.Write((uint)data.Length); o.Write(data);
}
Console.Error.WriteLine($"wrote {outPath}: {names.Count} names, {enums.Count} enums, {outStructs.Count} structs");

enum EPT : byte { ByteProperty, BoolProperty, IntProperty, FloatProperty, ObjectProperty, NameProperty, DelegateProperty, DoubleProperty, ArrayProperty, StructProperty, StrProperty, TextProperty, InterfaceProperty, MulticastDelegateProperty, WeakObjectProperty, LazyObjectProperty, AssetObjectProperty, SoftObjectProperty, UInt64Property, UInt32Property, UInt16Property, Int64Property, Int16Property, Int8Property, MapProperty, SetProperty, EnumProperty, FieldPathProperty, OptionalProperty, Utf8StrProperty, AnsiStrProperty }

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
    public static string KeyFile => Path.Combine(OutDir, "aes-key.txt");

    public static string? DefaultKey()
    {
        var env = Environment.GetEnvironmentVariable("TR_AES_KEY");
        if (!string.IsNullOrWhiteSpace(env)) return env.Trim();
        return File.Exists(KeyFile) ? File.ReadAllText(KeyFile).Trim() : null;
    }

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
                    foreach (System.Text.RegularExpressions.Match m in System.Text.RegularExpressions.Regex.Matches(File.ReadAllText(vdf), "\"path\"\\s+\"(.+?)\""))
                        libs.Add(m.Groups[1].Value.Replace("\\\\", "\\"));
                cands.AddRange(libs.Select(l => Path.Combine(l, "steamapps", "common", "Tempest Rising")));
            }
        }
        foreach (var c in cands)
        {
            // accept the game root, its Tempest/ folder or the Paks folder itself
            foreach (var root in new[] { c, Path.Combine(c, ".."), Path.Combine(c, "..", "..", "..") })
                if (Directory.Exists(Path.Combine(root, "Tempest", "Content", "Paks"))) return Path.GetFullPath(root);
        }
        throw new DirectoryNotFoundException("Tempest Rising not found. Pass --game <dir> or set TR_GAME_DIR. Tried: " + string.Join("; ", cands));
    }
    public static string PaksDir(string? opt) => Path.Combine(GameDir(opt), "Tempest", "Content", "Paks");
    public static string ExePath(string? opt) => Path.Combine(GameDir(opt), "Tempest", "Binaries", "Win64", "Tempest-Win64-Shipping.exe");
}
