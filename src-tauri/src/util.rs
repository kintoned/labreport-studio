use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

pub type R<T> = Result<T, String>;

/// コンソール窓を出さずに外部コマンドを起動する。
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// TeX Live の実行ファイルを探す。PATH に無ければ C:\texlive\<年>\bin\windows を見る。
pub fn tex_bin(name: &str) -> PathBuf {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    let dir = DIR.get_or_init(|| {
        if command("lualatex").arg("--version").output().is_ok() {
            return None; // PATH にある
        }
        let mut best: Option<PathBuf> = None;
        for root in ["C:\\texlive", "D:\\texlive"] {
            if let Ok(rd) = std::fs::read_dir(root) {
                for e in rd.flatten() {
                    let p = e.path().join("bin").join("windows");
                    if p.join("lualatex.exe").exists() && best.as_ref().map_or(true, |b| p > *b) {
                        best = Some(p);
                    }
                }
            }
        }
        best
    });
    match dir {
        Some(d) => d.join(format!("{name}.exe")),
        None => PathBuf::from(name),
    }
}

/// 同期フォルダ（Google Drive ストリーミング等）を想定した読み込み。
/// 未ダウンロードのファイルは開いた時点でダウンロードが走るため、失敗時は少し待って再試行する。
pub fn read_bytes(path: &Path) -> R<Vec<u8>> {
    let mut last = String::new();
    for i in 0..4u64 {
        match std::fs::read(path) {
            Ok(b) => return Ok(b),
            Err(e) => {
                if e.kind() == std::io::ErrorKind::NotFound {
                    return Err(format!("ファイルが見つかりません: {}", path.display()));
                }
                last = e.to_string();
                std::thread::sleep(std::time::Duration::from_millis(300 * (i + 1)));
            }
        }
    }
    Err(format!(
        "ファイルを読み込めませんでした: {}\n同期フォルダ上でまだダウンロードされていない可能性があります。オンラインであることを確認し、少し待ってから開き直してください。\n({})",
        path.display(),
        last
    ))
}

pub fn read_text(path: &Path) -> R<String> {
    let b = read_bytes(path)?;
    let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(&b);
    Ok(String::from_utf8_lossy(b).into_owned())
}

/// 内容が変わったときだけ書き込む（同期フォルダへの無駄な書き込みを避ける）。変更があれば true。
pub fn write_if_changed(path: &Path, data: &[u8]) -> R<bool> {
    if let Ok(old) = std::fs::read(path) {
        if old == data {
            return Ok(false);
        }
    }
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("フォルダを作成できません: {} ({e})", p.display()))?;
    }
    std::fs::write(path, data).map_err(|e| format!("書き込めませんでした: {} ({e})", path.display()))?;
    Ok(true)
}

/// プロジェクト内の相対パスだけを許可して結合する。
pub fn join_rel(dir: &Path, rel: &str) -> R<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty()
        || p.is_absolute()
        || p.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("プロジェクト内の相対パスではありません: {rel}"));
    }
    Ok(dir.join(p))
}

pub fn fnv(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in data {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

pub fn hash_hex(data: &[u8]) -> String {
    format!("{:016x}", fnv(data))
}

pub fn slashes(s: &str) -> String {
    s.replace('\\', "/")
}

/// 図名などに使える安全なファイル名か
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 80
        && !name.starts_with('.')
        && !name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
}
