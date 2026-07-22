//! AppKit material host for the standalone macOS player window.
//!
//! The React player remains the interactive content, but AppKit owns the
//! surface around it. On macOS 26+ that surface is `NSGlassEffectView`, so the
//! refraction, highlights, tinting, and active-window response are genuinely
//! native Liquid Glass rather than a CSS approximation.

use objc2::runtime::AnyClass;
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSGlassEffectView, NSGlassEffectViewStyle,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindow,
};
use objc2_foundation::MainThreadMarker;

const PLAYER_CORNER_RADIUS: f64 = 16.0;

/// The material name is included in the player URL before its web content is
/// created, allowing React to remove its old fake-glass background immediately.
pub fn material_name() -> &'static str {
    if AnyClass::get(c"NSGlassEffectView").is_some() {
        "liquid-glass"
    } else {
        "visual-effect"
    }
}

pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let liquid_glass = material_name() == "liquid-glass";

    window
        .with_webview(move |webview| unsafe {
            // Tauri guarantees this callback runs on AppKit's main thread.
            let Some(mtm) = MainThreadMarker::new() else {
                eprintln!("[player] native material callback was not on the main thread");
                return;
            };
            let ns_window: &NSWindow = &*webview.ns_window().cast();
            let Some(content) = ns_window.contentView() else {
                eprintln!("[player] native window has no content view");
                return;
            };
            let frame = content.frame();
            let autoresizing = NSAutoresizingMaskOptions::ViewWidthSizable
                | NSAutoresizingMaskOptions::ViewHeightSizable;

            content.setFrame(frame);
            content.setAutoresizingMask(autoresizing);

            if liquid_glass {
                let glass = NSGlassEffectView::initWithFrame(mtm.alloc(), frame);
                glass.setAutoresizingMask(autoresizing);
                glass.setCornerRadius(PLAYER_CORNER_RADIUS);
                glass.setStyle(NSGlassEffectViewStyle::Regular);
                glass.setContentView(Some(&content));
                ns_window.setContentView(Some(&glass));
                eprintln!("[player] native Liquid Glass installed");
            } else {
                let effect = NSVisualEffectView::initWithFrame(mtm.alloc(), frame);
                effect.setAutoresizingMask(autoresizing);
                effect.setMaterial(NSVisualEffectMaterial::HUDWindow);
                effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
                effect.setState(NSVisualEffectState::FollowsWindowActiveState);
                effect.addSubview(&content);
                ns_window.setContentView(Some(&effect));
                eprintln!("[player] native visual-effect fallback installed");
            }
        })
        .map_err(|error| format!("install native player material: {error}"))
}
