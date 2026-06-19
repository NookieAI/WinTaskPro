fn main() {
    // IMPORTANT (perf/admin fix 2026-06-11):
    // `tauri_build::build()` does NOT embed our custom `app.manifest` — it
    // embeds Tauri's built-in *default* manifest, which uses `asInvoker` (no
    // elevation). That is why the app was launching non-elevated despite
    // app.manifest declaring requireAdministrator, forcing the user to click
    // "Restart as Admin" and pay the task-enumeration cost twice.
    //
    // To actually force elevation we must pass the manifest explicitly via
    // WindowsAttributes::app_manifest (the documented tauri-build API). The
    // manifest itself MUST include the Microsoft.Windows.Common-Controls v6
    // dependency, because supplying a custom manifest REPLACES Tauri's default
    // (which provides it) — see app.manifest and tauri issue #6926.
    //
    // Do NOT also compile resources.rc with embed-resource/winres: that would
    // embed a SECOND manifest and cause LNK1123 / CVT1100. app_manifest below
    // is the single manifest path. resources.rc is intentionally not compiled.
    #[cfg(windows)]
    {
        let windows = tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("app.manifest"));
        tauri_build::try_build(
            tauri_build::Attributes::new().windows_attributes(windows),
        )
        .expect("failed to run tauri-build");
    }

    #[cfg(not(windows))]
    tauri_build::build();
}
