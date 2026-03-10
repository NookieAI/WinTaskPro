# 1. Install Rust
winget install Rustlang.Rustup
rustup update stable

# 2. Install Node.js (for Tauri CLI)
winget install OpenJS.NodeJS.LTS

# 3. Install Tauri CLI
npm install -g @tauri-apps/cli@next

# 4. Install WebView2 (already present on Win10 21H1+ and Win11)
#    If not: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

# 5. Add Windows MSVC target (required for windows crate)
rustup target add x86_64-pc-windows-msvc