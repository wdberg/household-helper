# Photo Cleanup (iPhone app)

A native iPhone app that frees up space in your Photos library. Everything runs on the phone; nothing is uploaded.

## What it cleans up

| Screen | What it finds | What it does |
| --- | --- | --- |
| **Duplicates** | Exact and near-exact copies of photos *and* videos, including resized or re-saved copies (WhatsApp, AirDrop, imports) | Keeps the best copy (favourite → highest resolution → biggest file → oldest) and pre-selects the rest |
| **Similar Photos** | Bursts and lookalike shots taken within 3 minutes of each other | Marks the sharpest one as Best. You pick which to delete |
| **Live Photos** | Every Live Photo, biggest hidden video first | Converts it to a normal photo and keeps the date, location, favourite, hidden state and albums. Edits are baked in |
| **Screenshots** | All screenshots, newest first | Bulk select, or select only the ones older than 30 days |
| **Blurry & Dark** | Out-of-focus, shaky, black or blank photos | Sensitivity slider in Settings |
| **Large Videos** | All videos, biggest first | Delete, or compress to 4K HEVC, 1080p HEVC or 720p and replace the original |
| **Swipe Review** | Any month of your library | Swipe left to delete, right to keep, with undo |

**Safety:** every delete goes through iOS's own confirmation, and deleted items sit in *Recently Deleted* in the Photos app for 30 days. For Live Photo conversion and video compression, the new copy is saved first and the original is only removed once that succeeds.

## How it works

- **Duplicates:** each item gets a 64-bit *difference hash* from a small thumbnail. Items within 3 bits of each other with the same shape (and the same length, for videos) become candidates. Each candidate is then confirmed with Apple's Vision *feature print* so that lookalike but different photos aren't flagged.
- **Similar:** photos taken close together in time are compared with Vision feature prints. You can make the matching stricter or looser in Settings.
- **Blur:** variance of the Laplacian on a 256 px greyscale copy. Low variance means few sharp edges.
- **Live Photos:** the still image file is copied out with `PHAssetResourceManager` and saved as a new photo, then the original is deleted.
- **Speed:** results are cached, keyed by each asset's modification date, so only new or edited items are analysed again. The first scan of a big library takes a few minutes; scans after that take seconds.

## Install it on your iPhone

You need a Mac with **Xcode 16 or newer** (free from the Mac App Store) and an iPhone on **iOS 17 or newer**. A free Apple ID is enough.

1. Open `PhotoCleanup/PhotoCleanup.xcodeproj` in Xcode.
2. Click the **PhotoCleanup** project → **Signing & Capabilities** → choose your Apple ID under **Team** (add it in Xcode › Settings › Accounts if needed).
3. If Xcode says the bundle identifier is taken, change `com.householdhelper.photocleanup` to something unique, e.g. `com.yourname.photocleanup`.
4. Plug in your iPhone, select it at the top of the Xcode window, and press **Run** (⌘R).
5. The first time, on the iPhone go to **Settings › General › VPN & Device Management**, tap your Apple ID and choose **Trust**. You may also need to turn on **Developer Mode** (Settings › Privacy & Security).
6. Open the app and choose **Allow Full Access** to Photos.

With a free Apple ID, apps installed this way stop opening after 7 days. Press Run in Xcode again to renew. A paid Apple Developer account ($99/year) extends this to a year and lets you share it through TestFlight.

The Simulator works for trying the UI, but its photo library is tiny. Test the real thing on a device.

## Project layout

```
PhotoCleanup/
  PhotoCleanupApp.swift      App entry, permission screens, busy overlay
  Model/
    PhotoLibrary.swift       Scanning, categories, delete / convert / compress actions
    ImageAnalysis.swift      Thumbnail hashing, blur, Vision feature prints, on-disk cache
    Grouping.swift           Duplicate and similar-photo grouping and "best" ranking
    MediaTools.swift         PhotoKit changes: delete, Live Photo → still, video compression
  Views/
    HomeView.swift           Dashboard with every category and how much space it frees
    GroupsView.swift         Duplicates and Similar Photos sets
    CategoryScreens.swift    Screenshots, Blurry, Live Photos, Large Videos
    SwipeReviewView.swift    Month picker and swipe-to-delete review
    SettingsView.swift       Sensitivity sliders, rescan from scratch
    Components.swift         Thumbnails, grid, bottom bar, preview sheet
```

The project uses Xcode's folder-synced groups, so any new `.swift` file you put in `PhotoCleanup/` is picked up automatically.
