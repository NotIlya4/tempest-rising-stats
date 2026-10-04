// keycheck: tells whether the AES key you supplied is valid for the installed Tempest Rising
// build. Read-only: it only opens the .utoc file for reading.
//
// Usage:
//   dotnet run keycheck.cs -- [--game <dir> | --utoc <file>] [--key 0x<hex>] [more keys...]
//
// Keys come from (in order): --key / extra positional args, env TR_AES_KEY.
using System.Runtime.CompilerServices;
using System.Security.Cryptography;

var cli = new Cli(args);
var utoc = cli.Opt("utoc") ?? Path.Combine(Paths.PaksDir(cli.Opt("game")), "pakchunk0-Windows.utoc");
var keys = new List<string>(cli.Positional);
if (cli.Opt("key") is { } k1) keys.Insert(0, k1);
if (keys.Count == 0 && Paths.DefaultKey() is { } k2) keys.Add(k2);

var dir = Utoc.ReadDirectoryIndexHead(utoc, verbose: true);
Console.WriteLine($"first 16 bytes of encrypted directory index: {Convert.ToHexString(dir[..16])}");
int good = 0;
foreach (var k in keys)
{
    var hex = k.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? k[2..] : k;
    if (hex.Length != 64 || !hex.All(Uri.IsHexDigit)) { Console.WriteLine($"skipping malformed key (expected 64 hex digits, got {hex.Length})"); continue; }
    var kb = Convert.FromHexString(hex);
    using var aes = Aes.Create(); aes.Key = kb;
    var dec = aes.DecryptEcb(dir[..32], PaddingMode.None);
    int len = BitConverter.ToInt32(dec, 0);
    bool ok = len > 0 && len < 1024 && (dec[4] == '.' || dec[4] == '/');
    if (ok) good++;
    // never echo the full key: only a short prefix
    Console.WriteLine($"key {k[..Math.Min(6, k.Length)]}...: {(ok ? "VALID" : "invalid")}  decrypted={Convert.ToHexString(dec)} ascii='{new string(dec.Skip(4).Select(b => b >= 32 && b < 127 ? (char)b : '.').ToArray())}'");
}
if (keys.Count == 0) Console.WriteLine("no key supplied (use --key or TR_AES_KEY)");
return keys.Count == 0 || good > 0 ? 0 : 1;

static class Utoc
{
    // Parses the .utoc header and returns the first (up to 64) bytes of the encrypted directory index.
    public static byte[] ReadDirectoryIndexHead(string path, bool verbose)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
        var br = new BinaryReader(fs);
        br.ReadBytes(16); // magic
        byte version = br.ReadByte(); br.ReadByte(); br.ReadUInt16();
        uint headerSize = br.ReadUInt32(), entryCount = br.ReadUInt32(), blockCount = br.ReadUInt32(), blockEntrySize = br.ReadUInt32();
        uint cmCount = br.ReadUInt32(), cmLen = br.ReadUInt32(), blockSize = br.ReadUInt32(), dirIdxSize = br.ReadUInt32(), partCount = br.ReadUInt32();
        br.ReadUInt64(); var guid = br.ReadBytes(16); // container id, encryption key guid
        byte flags = br.ReadByte(); br.ReadByte(); br.ReadUInt16();
        uint seedsCount = br.ReadUInt32(); br.ReadUInt64(); uint noHashCount = br.ReadUInt32();
        if (verbose) Console.WriteLine($"{Path.GetFileName(path)}: ver={version} hdr={headerSize} entries={entryCount} blocks={blockCount} blockSize={blockSize} dirIdx={dirIdxSize} parts={partCount} flags=0x{flags:X} guid={Convert.ToHexString(guid)}");
        // chunk ids (12) + offset/lengths (10) + perfect-hash seeds + no-hash indices + compression blocks (12)
        long pos = headerSize + entryCount * 22L + seedsCount * 4L + noHashCount * 4L + blockCount * 12L;
        fs.Position = pos;
        var names = br.ReadBytes((int)(cmCount * cmLen));
        if (verbose) Console.WriteLine("compression methods: " + System.Text.Encoding.ASCII.GetString(names).Replace("\0", " ").Trim());
        pos += cmCount * (long)cmLen;
        if ((flags & 4) != 0) // signed container: skip TOC/block signatures
        {
            fs.Position = pos; int hs = br.ReadInt32(); pos += 4 + hs * 2L + blockCount * 20L;
        }
        if ((flags & 2) == 0) throw new Exception("container is not encrypted; nothing to check"); // EIoContainerFlags::Encrypted
        fs.Position = pos;
        return br.ReadBytes((int)Math.Min(dirIdxSize, 64));
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
