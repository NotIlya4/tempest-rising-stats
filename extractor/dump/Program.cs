// trdump: read-only exporter for Tempest Rising game data, built on CUE4Parse.
// Opens the IoStore containers of an installed copy, decrypts them with the AES key you
// supply, and writes JSON exports / localization tables to an output folder (default
// extractor/out/export, git-ignored). It never writes into the game folder.
//
// Usage:
//   dotnet run --project extractor/dump -c Release -- <command> [options] [patterns...]
//
// Commands:
//   list                 write the full package list to <out>/filelist.txt
//   json <pattern>...    export packages as JSON to <out>/json/<package path>.json
//                        pattern = package path without extension, "re:<regex>" matched
//                        against the .uasset path, or a preset: @definitions, @texts, @pawns,
//                        @montages (run after @pawns: every AnimMontage referenced by the
//                        exported pawn blueprints)
//   locres               export every .locres to <out>/locres/<Game..>/<lang>/<Game..>.json
//                        as {namespace: {key: text}}
//   png <pattern>...     decode Texture2D packages to PNG under <out> (default extractor/out/icons):
//                        <out>/<package path minus Tempest/Content/>.png, plus <out>/index.json.
//                        Kept at original size when both sides are <= 256 px, otherwise scaled
//                        down so the longer side is 128 px (UI icons). Preset: @icons
//   raw <regex>...       copy raw package bytes to <out>/raw/ (debugging only)
//
// Options:
//   --game <dir>    game root (or env TR_GAME_DIR; default: Steam libraries)
//   --key <0x...>   AES key you supply (or env TR_AES_KEY)
//   --usmap <file>  mappings (or env TR_USMAP; default: extractor/out/Tempest.usmap)
//   --out <dir>     output folder (default: extractor/out/export; for png: extractor/out/icons)
//   --export <dir>  folder whose json/ the refs:/softrefs:/objrefs: patterns read (default: the
//                   json output folder, i.e. --out for json, extractor/out/export otherwise)
//   --oodle <file>  Oodle DLL; downloaded by CUE4Parse into extractor/out/oodle/ if missing
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using CUE4Parse.Compression;
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Versions;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse_Conversion.Textures;
using Newtonsoft.Json.Linq;
using SkiaSharp;
using Newtonsoft.Json;

var presets = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
{
    // unit / structure / weapon definitions, abilities, upgrades... (skips input, achievements etc.)
    ["@definitions"] = ["re:^Tempest/Content/Tempest/DataAssets/(?!Input/|Achievements/|Profanity/|MapMarkerConfigs/)"],
    // string tables (English source text + keys, and their namespaces)
    ["@texts"] = ["re:^Tempest/Content/Tempest/UI/Texts/"],
    // pawn and structure blueprints (WeaponAnimMontageSets: weapon class -> attack montages) and
    // weapon blueprints: every PawnClass and WeaponClass of the exported @definitions, plus all
    // faction unit/structure blueprints.
    // Parent blueprints are always exported too (see "json" below), for inherited CDO values.
    ["@pawns"] = ["softrefs:PawnClass@definitions", "softrefs:WeaponClass@definitions",
                  @"re:^Tempest/Content/Tempest/(GDF|DYN|VETI|VETI_DLC|CIV)/(Vehicles|Infantry|Structures|Aircraft)/BP_[^/]*\.uasset$"],
    // attack montages (AnimNotify_GameplayEvent Event.ShootProjectile / Event.DealDamage -> hits
    // per attack): exactly the AnimMontage assets referenced by the exported blueprint JSON
    ["@montages"] = ["refs:AnimMontage@blueprints"],
    // command blueprints (with Name / Description / Icon): every class in the SupportedCommands
    // lists of the exported @definitions (TedCmd_*: unit and structure abilities) and in the
    // per-faction lists of SupportPowersCollection (TedPlayerCmd_*: support powers).
    // Needs @definitions first.
    ["@commands"] = ["objrefs:SupportedCommands@definitions", "objrefs:GDF_SupportCommands@definitions",
                     "objrefs:DYN_SupportCommands@definitions", "objrefs:VETI_SupportCommands@definitions"],
    // for "png": every texture in an Icon property of the exported definitions (units, structures,
    // passive abilities, status effects, doctrines, equipment, upgrades) and command blueprints.
    // Needs json @definitions @commands first.
    ["@icons"] = ["objrefs:Icon@definitions", "objrefs:Icon@commands"],
};
// sources for refs:/softrefs: patterns, over JSON already exported to --out
var refSources = new Dictionary<string, Func<string, string, bool>>(StringComparer.OrdinalIgnoreCase)
{
    ["@definitions"] = (rel, text) => rel.StartsWith("Tempest/Content/Tempest/DataAssets/"),
    ["@blueprints"] = (rel, text) => text.Contains("\"Type\": \"BlueprintGeneratedClass\""),
    ["@commands"] = (rel, text) => rel.StartsWith("Tempest/Content/Tempest/Blueprints/Commands/"),
};

var cli = new Cli(args);
if (cli.Positional.Count == 0 || cli.Flags.Contains("help"))
{
    Console.WriteLine("usage: trdump <list|json|png|locres|raw> [--game dir] [--key 0x..] [--usmap file] [--out dir] [patterns...]");
    Console.WriteLine("presets for json: " + string.Join(", ", presets.Keys));
    return 1;
}
var mode = cli.Positional[0];
var patterns = cli.Positional.Skip(1).SelectMany(p => presets.TryGetValue(p, out var v) ? v : [p]).ToList();

var gameDir = Paths.GameDir(cli.Opt("game"));
var paks = Path.Combine(gameDir, "Tempest", "Content", "Paks");
var outDir = Path.GetFullPath(cli.Opt("out") ?? Path.Combine(Paths.OutDir, mode == "png" ? "icons" : "export"));
if ((outDir + Path.DirectorySeparatorChar).StartsWith(gameDir.TrimEnd('\\', '/') + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
    throw new InvalidOperationException("refusing to write into the game folder");
var key = cli.Opt("key") ?? Paths.DefaultKey()
    ?? throw new InvalidOperationException("no AES key: pass --key or set TR_AES_KEY");

var oodlePath = cli.Opt("oodle") ?? Path.Combine(Paths.OutDir, "oodle", OodleHelper.OODLE_NAME_CURRENT);
Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(oodlePath))!);
if (!File.Exists(oodlePath)) OodleHelper.DownloadOodleDll(ref oodlePath);
OodleHelper.Initialize(oodlePath);

var provider = new DefaultFileProvider(paks, SearchOption.TopDirectoryOnly, new VersionContainer(EGame.GAME_UE5_4), StringComparer.OrdinalIgnoreCase);
var usmap = cli.Opt("usmap") ?? Environment.GetEnvironmentVariable("TR_USMAP");
if (string.IsNullOrWhiteSpace(usmap))
{
    var def = Path.Combine(Paths.OutDir, "Tempest.usmap");
    usmap = File.Exists(def) ? def : null;
}
if (usmap != null)
{
    provider.MappingsContainer = new FileUsmapTypeMappingsProvider(usmap, StringComparer.OrdinalIgnoreCase);
    Console.Error.WriteLine("mappings: " + usmap);
}
else Console.Error.WriteLine("WARNING: no .usmap; property values will be missing or wrong (run usmapgen first)");
provider.Initialize();
provider.SubmitKey(new FGuid(), new FAesKey(key));
provider.PostMount();
Console.Error.WriteLine($"game: {paks}");
Console.Error.WriteLine($"files: {provider.Files.Count}, output: {outDir}");
if (provider.Files.Count == 0) { Console.Error.WriteLine("no files mounted: wrong AES key?"); return 2; }

int ok = 0, fail = 0;
// JSON that refs:/softrefs:/objrefs: patterns read: the json output of this run, or of an earlier one
var jsonRoot = Path.Combine(Path.GetFullPath(cli.Opt("export") ?? (mode == "json" ? outDir : Path.Combine(Paths.OutDir, "export"))), "json");

// refs:<Class>@<source>     every <Class>'...' object reference (ObjectName + ObjectPath)
// softrefs:<Prop>@<source>  every "<Prop>": { "AssetPathName": "/Game/..." } soft reference
// objrefs:<Prop>@<source>   every object or soft reference anywhere inside a "<Prop>" property
//                           (a single reference or an array of them), at any depth
// found in the already exported JSON files that <source> (refSources) selects
List<string> Refs(string a)
{
    var kind = a[..a.IndexOf(':')];
    var at = a.IndexOf('@');
    var name = a[(kind.Length + 1)..at];
    var src = refSources[a[at..]];
    var refRx = kind == "softrefs"
        ? new Regex("\"" + Regex.Escape(name) + "\":\\s*\\{\\s*\"AssetPathName\":\\s*\"/Game/([^\".]+)")
        : new Regex("\"ObjectName\":\\s*\"" + Regex.Escape(name) + "'[^']*'\",\\s*\"ObjectPath\":\\s*\"/Game/([^\".]+)");
    var files = 0;
    var found = new List<string>();
    if (Directory.Exists(jsonRoot))
        foreach (var f in Directory.EnumerateFiles(jsonRoot, "*.json", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(jsonRoot, f).Replace('\\', '/');
            var text = File.ReadAllText(f);
            if (!src(rel, text)) continue;
            files++;
            if (kind == "objrefs")
            {
                if (!text.Contains("\"" + name + "\"")) continue;
                foreach (var prop in JToken.Parse(text).SelectTokens("$.." + name))
                    foreach (var v in (prop is JContainer c ? c.DescendantsAndSelf() : [prop]).OfType<JValue>())
                        if (v.Parent is JProperty { Name: "ObjectPath" or "AssetPathName" } && v.Value is string path && path.StartsWith("/Game/"))
                            found.Add("Tempest/Content/" + path[6..].Split('.')[0]);
            }
            else found.AddRange(refRx.Matches(text).Select(m => "Tempest/Content/" + m.Groups[1].Value));
        }
    found = found.Distinct(StringComparer.OrdinalIgnoreCase).Where(t => provider.Files.ContainsKey(t + ".uasset")).ToList();
    Console.Error.WriteLine($"{a}: {found.Count} packages referenced by {files} exported files"
        + (files == 0 ? $"; export {a[at..]} first" : ""));
    return found;
}
// one pattern -> package paths (without extension)
List<string> Targets(string a)
{
    if (a.StartsWith("re:"))
    {
        var rx = new Regex(a[3..], RegexOptions.IgnoreCase);
        return provider.Files.Keys.Where(k => k.EndsWith(".uasset") && rx.IsMatch(k)).Select(k => k[..^7]).ToList();
    }
    return a.StartsWith("refs:") || a.StartsWith("softrefs:") || a.StartsWith("objrefs:") ? Refs(a) : [a];
}

switch (mode)
{
    case "list":
    {
        Directory.CreateDirectory(outDir);
        var p = Path.Combine(outDir, "filelist.txt");
        File.WriteAllLines(p, provider.Files.Keys.OrderBy(x => x, StringComparer.Ordinal));
        Console.WriteLine($"wrote {p}"); ok++;
        break;
    }
    case "json":
    {
        // Patterns are expanded and exported in order, so "json @definitions @pawns @montages" works
        // in one run: refs:/softrefs: read the JSON that earlier patterns (or earlier runs) wrote.
        var done = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Blueprint parents (BlueprintGeneratedClass Super under /Game/) are always exported too,
        // because a child CDO only stores the values it overrides.
        var superRx = new Regex("\"Super\":\\s*\\{\\s*\"ObjectName\":\\s*\"BlueprintGeneratedClass'[^']*'\",\\s*\"ObjectPath\":\\s*\"/Game/([^\".]+)");
        void Export(string t)
        {
            var queue = new Queue<string>([t]);
            while (queue.Count > 0)
            {
                var pkg = queue.Dequeue();
                if (!done.Add(pkg)) continue;
                try
                {
                    var exports = provider.LoadPackage(pkg).GetExports();
                    var p = Path.Combine(jsonRoot, pkg + ".json");
                    Directory.CreateDirectory(Path.GetDirectoryName(p)!);
                    var text = JsonConvert.SerializeObject(exports, Formatting.Indented);
                    File.WriteAllText(p, text);
                    Console.WriteLine("OK " + pkg); ok++;
                    foreach (Match m in superRx.Matches(text)) queue.Enqueue("Tempest/Content/" + m.Groups[1].Value);
                }
                catch (Exception e) { Console.WriteLine($"FAIL {pkg}: {e.GetType().Name}: {e.Message}"); fail++; }
            }
        }
        var any = false;
        foreach (var a in patterns)
        {
            var targets = Targets(a);
            any |= targets.Count > 0;
            foreach (var t in targets) Export(t);
        }
        if (!any) Console.Error.WriteLine("nothing matched");
        break;
    }
    case "png":
    {
        // Texture2D -> PNG. UI icons only: original size when both sides are <= 256 px, otherwise
        // scaled down so the longer side is 128 px. <out>/index.json records every texture.
        const int Keep = 256, Target = 128;
        Directory.CreateDirectory(outDir);
        var index = new SortedDictionary<string, object>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var any = false;
        foreach (var a in patterns)
            foreach (var pkg in Targets(a))
            {
                any = true;
                if (!seen.Add(pkg)) continue;
                try
                {
                    var tex = provider.LoadPackage(pkg).GetExports().OfType<UTexture2D>().FirstOrDefault();
                    if (tex == null) { Console.WriteLine($"SKIP {pkg}: not a Texture2D"); continue; }
                    var decoded = tex.Decode(ETexturePlatform.DesktopMobile) ?? throw new InvalidDataException("decode returned null");
                    using var bmp = decoded.ToSkBitmap();
                    int w = bmp.Width, h = bmp.Height;
                    SKBitmap outBmp = bmp;
                    if (w > Keep || h > Keep)
                    {
                        var k = (double)Target / Math.Max(w, h);
                        var info = bmp.Info.WithSize(Math.Max(1, (int)Math.Round(w * k)), Math.Max(1, (int)Math.Round(h * k)));
                        outBmp = bmp.Resize(info, SKFilterQuality.High) ?? throw new InvalidDataException("resize failed");
                    }
                    var rel = pkg.StartsWith("Tempest/Content/") ? pkg["Tempest/Content/".Length..] : pkg;
                    var p = Path.Combine(outDir, rel + ".png");
                    Directory.CreateDirectory(Path.GetDirectoryName(p)!);
                    int ow = outBmp.Width, oh = outBmp.Height;
                    var scaled = !ReferenceEquals(outBmp, bmp);
                    using (var img = SKImage.FromBitmap(outBmp))
                    using (var data = img.Encode(SKEncodedImageFormat.Png, 100))
                    using (var fs = File.Create(p)) data.SaveTo(fs);
                    index["/Game/" + rel] = new { file = rel + ".png", width = ow, height = oh, sourceWidth = w, sourceHeight = h, format = tex.Format.ToString() };
                    if (scaled) outBmp.Dispose();
                    Console.WriteLine($"PNG {pkg} {w}x{h}" + (scaled ? $" -> {ow}x{oh}" : "")); ok++;
                }
                catch (Exception e) { Console.WriteLine($"FAIL {pkg}: {e.GetType().Name}: {e.Message}"); fail++; }
            }
        File.WriteAllText(Path.Combine(outDir, "index.json"), JsonConvert.SerializeObject(index, Formatting.Indented));
        if (!any) Console.Error.WriteLine("nothing matched");
        break;
    }
    case "locres":
    {
        foreach (var k in provider.Files.Keys.Where(k => k.StartsWith("Tempest/Content/Localization/") && k.EndsWith(".locres")))
        {
            if (!provider.TryCreateReader(k, out var ar)) { Console.WriteLine("FAIL " + k); fail++; continue; }
            var res = new CUE4Parse.UE4.Localization.FTextLocalizationResource(ar);
            var dict = res.Entries.ToDictionary(ns => ns.Key.Str, ns => ns.Value.ToDictionary(e => e.Key.Str, e => e.Value.LocalizedString));
            var p = Path.Combine(outDir, "locres", k.Replace("Tempest/Content/Localization/", "").Replace(".locres", ".json"));
            Directory.CreateDirectory(Path.GetDirectoryName(p)!);
            File.WriteAllText(p, JsonConvert.SerializeObject(dict, Formatting.Indented));
            Console.WriteLine($"LOCRES {k}: {dict.Sum(d => d.Value.Count)} strings"); ok++;
        }
        break;
    }
    case "raw":
    {
        foreach (var a in patterns)
        {
            var rx = new Regex(a, RegexOptions.IgnoreCase);
            foreach (var k in provider.Files.Keys.Where(k => rx.IsMatch(k)))
            {
                var p = Path.Combine(outDir, "raw", k);
                Directory.CreateDirectory(Path.GetDirectoryName(p)!);
                File.WriteAllBytes(p, provider.SaveAsset(k));
                Console.WriteLine("RAW " + k); ok++;
            }
        }
        break;
    }
    default:
        Console.Error.WriteLine("unknown command: " + mode);
        return 1;
}
Console.Error.WriteLine($"done: {ok} ok, {fail} failed");
return fail > 0 ? 3 : 0;

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
