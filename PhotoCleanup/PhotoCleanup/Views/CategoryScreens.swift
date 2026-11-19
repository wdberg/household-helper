import Photos
import SwiftUI

/// Shared layout for a single-list clean-up screen: an intro, a grid, a bottom bar.
private struct GridScreen<Bar: View, Menu: View>: View {
    let title: String
    let intro: String
    let emptyTitle: String
    let assets: [PHAsset]
    @Binding var selection: Set<String>
    var caption: ((PHAsset) -> String?)? = nil
    var selectedIcon = "trash.circle.fill"
    var selectedColor = Color.red
    @ViewBuilder var bar: Bar
    @ViewBuilder var menu: Menu

    @Environment(PhotoLibrary.self) var library
    @State var preview: AssetRef?

    var body: some View {
        ScrollView {
            Text(intro)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            AssetGrid(assets: assets, selection: $selection, preview: $preview, caption: caption,
                      selectedIcon: selectedIcon, selectedColor: selectedColor)
        }
        .overlay {
            if assets.isEmpty {
                ContentUnavailableView(emptyTitle, systemImage: "checkmark.seal",
                                       description: Text(library.isScanning ? "Still scanning…" : "Nothing to clean up here."))
            }
        }
        .navigationTitle(title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                SwiftUI.Menu {
                    Button("Select all") { selection = Set(assets.map(\.localIdentifier)) }
                    menu
                    Button("Deselect all") { selection.removeAll() }
                } label: {
                    Image(systemName: "checklist")
                }
                .disabled(assets.isEmpty)
                .accessibilityLabel("Selection options")
            }
        }
        .safeAreaInset(edge: .bottom) {
            if !assets.isEmpty { ActionBar { bar } }
        }
        .sheet(item: $preview) { AssetDetailView(asset: $0.asset) }
        .onChange(of: assets.map(\.localIdentifier)) { _, ids in
            selection.formIntersection(ids)
        }
    }
}

private func selected(_ assets: [PHAsset], in selection: Set<String>) -> [PHAsset] {
    assets.filter { selection.contains($0.localIdentifier) }
}

// MARK: - Screenshots

struct ScreenshotsView: View {
    @Environment(PhotoLibrary.self) var library
    @State var selection: Set<String> = []

    var body: some View {
        GridScreen(
            title: "Screenshots",
            intro: "Screenshots pile up fast and are rarely needed later. Tap to select, hold to preview.",
            emptyTitle: "No Screenshots",
            assets: library.screenshots,
            selection: $selection
        ) {
            DeleteButton(assets: selected(library.screenshots, in: selection)) { selection.removeAll() }
        } menu: {
            Button("Select older than 30 days") {
                let cutoff = Calendar.current.date(byAdding: .day, value: -30, to: .now) ?? .now
                selection = Set(library.screenshots.filter { ($0.creationDate ?? .now) < cutoff }.map(\.localIdentifier))
            }
        }
    }
}

// MARK: - Blurry & dark

struct BlurryView: View {
    @Environment(PhotoLibrary.self) var library
    @State var selection: Set<String> = []

    var body: some View {
        GridScreen(
            title: "Blurry & Dark",
            intro: "Out-of-focus, shaky, black or blank shots, blurriest first. Favourites are never selected for you. "
                + "Adjust the blur sensitivity in Settings.",
            emptyTitle: "No Blurry Photos",
            assets: library.blurry,
            selection: $selection
        ) {
            DeleteButton(assets: selected(library.blurry, in: selection)) { selection.removeAll() }
        } menu: {
            Button("Select all except favourites") {
                selection = Set(library.blurry.filter { !$0.isFavorite }.map(\.localIdentifier))
            }
        }
    }
}

// MARK: - Live Photos

struct LivePhotosView: View {
    @Environment(PhotoLibrary.self) var library
    @State var selection: Set<String> = []
    @State var confirm = false

    private var chosen: [PHAsset] { selected(library.livePhotos, in: selection) }
    private var savings: Int64 { chosen.reduce(0) { $0 + library.liveVideoBytes(of: $1) } }

    var body: some View {
        GridScreen(
            title: "Live Photos",
            intro: "Each Live Photo keeps a 3-second video next to the photo. Converting saves a normal photo "
                + "(same date, location, favourite and albums) and removes the Live Photo, which frees the video's space. "
                + "Biggest savings first.",
            emptyTitle: "No Live Photos",
            assets: library.livePhotos,
            selection: $selection,
            caption: { library.liveVideoBytes(of: $0).formattedBytes },
            selectedIcon: "checkmark.circle.fill",
            selectedColor: .orange
        ) {
            Button {
                confirm = true
            } label: {
                VStack(spacing: 1) {
                    Text(chosen.isEmpty ? "Convert" : "Convert \(chosen.count)").font(.headline)
                    if !chosen.isEmpty { Text("Saves about \(savings.formattedBytes)").font(.caption) }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(.orange)
            .controlSize(.large)
            .disabled(chosen.isEmpty)
        } menu: {
            Button("Select all except favourites") {
                selection = Set(library.livePhotos.filter { !$0.isFavorite }.map(\.localIdentifier))
            }
        }
        .confirmationDialog("Convert \(chosen.count) Live Photos?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Convert to Still Photos") {
                let assets = chosen
                selection.removeAll()
                Task { await library.convertLivePhotos(assets) }
            }
        } message: {
            Text("Still copies are saved first, then iOS asks you to confirm removing the originals. "
                 + "Edits are kept as part of the photo. Originals stay in Recently Deleted for 30 days.")
        }
    }
}

// MARK: - Large videos

struct VideosView: View {
    @Environment(PhotoLibrary.self) var library
    @State var selection: Set<String> = []
    @State var showCompress = false

    private var chosen: [PHAsset] { selected(library.largeVideos, in: selection) }

    var body: some View {
        GridScreen(
            title: "Large Videos",
            intro: "All videos, biggest first. Delete the ones you don't need, or compress them to save space and keep a smaller copy.",
            emptyTitle: "No Videos",
            assets: library.largeVideos,
            selection: $selection,
            caption: { "\($0.duration.durationText) · \(library.bytes(of: $0).formattedBytes)" },
            selectedIcon: "checkmark.circle.fill",
            selectedColor: .accentColor
        ) {
            Button {
                showCompress = true
            } label: {
                Text(chosen.isEmpty ? "Compress" : "Compress \(chosen.count)")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(chosen.isEmpty)

            DeleteButton(assets: chosen) { selection.removeAll() }
        } menu: {
            Button("Select over 100 MB") {
                selection = Set(library.largeVideos.filter { library.bytes(of: $0) > 100_000_000 }.map(\.localIdentifier))
            }
            Button("Select longer than 5 minutes") {
                selection = Set(library.largeVideos.filter { $0.duration > 300 }.map(\.localIdentifier))
            }
        }
        .confirmationDialog("Compress \(chosen.count) videos to…", isPresented: $showCompress, titleVisibility: .visible) {
            ForEach(VideoQuality.allCases) { quality in
                Button("\(quality.rawValue) – \(quality.detail)") {
                    let assets = chosen
                    selection.removeAll()
                    Task { await library.compressVideos(assets, quality: quality) }
                }
            }
        } message: {
            Text("A smaller copy is saved with the same date and location, then iOS asks to remove the original. "
                 + "Large videos can take a while; keep the app open.")
        }
    }
}
