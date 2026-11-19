import AVKit
import Photos
import SwiftUI

/// Wraps a PHAsset so it can drive `.sheet(item:)`.
struct AssetRef: Identifiable {
    let asset: PHAsset
    var id: String { asset.localIdentifier }
}

/// Loads a photo thumbnail asynchronously. Size it with a frame or aspectRatio from the outside.
struct AssetThumbnail: View {
    let asset: PHAsset
    var targetSide: CGFloat = 200
    var contentMode: ContentMode = .fill

    @Environment(\.displayScale) var displayScale
    @State var image: UIImage?
    @State var requestID: PHImageRequestID?

    var body: some View {
        Rectangle()
            .fill(Color(.secondarySystemFill))
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: contentMode)
                }
            }
            .clipped()
            .onAppear(perform: load)
            .onDisappear {
                if let requestID { PHImageManager.default().cancelImageRequest(requestID) }
                requestID = nil
            }
    }

    private func load() {
        let options = PHImageRequestOptions()
        options.deliveryMode = .opportunistic
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true
        let side = targetSide * displayScale
        requestID = PHImageManager.default().requestImage(
            for: asset,
            targetSize: CGSize(width: side, height: side),
            contentMode: contentMode == .fill ? .aspectFill : .aspectFit,
            options: options
        ) { result, _ in
            if let result { image = result }
        }
    }
}

/// A square thumbnail that toggles selection on tap and opens a preview on long press.
struct SelectableThumbnail: View {
    let asset: PHAsset
    let isSelected: Bool
    var badge: String? = nil
    var caption: String? = nil
    var selectedIcon = "trash.circle.fill"
    var selectedColor = Color.red
    let toggle: () -> Void
    let preview: () -> Void

    var body: some View {
        AssetThumbnail(asset: asset)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if isSelected {
                    Rectangle().fill(.black.opacity(0.25))
                    Rectangle().strokeBorder(selectedColor, lineWidth: 3)
                }
            }
            .overlay(alignment: .topLeading) {
                if let badge {
                    Text(badge)
                        .font(.caption2.bold())
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(.green, in: Capsule())
                        .foregroundStyle(.white)
                        .padding(5)
                }
            }
            .overlay(alignment: .topTrailing) {
                Image(systemName: isSelected ? selectedIcon : "circle")
                    .font(.title3)
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, isSelected ? selectedColor : Color.black.opacity(0.3))
                    .shadow(radius: 2)
                    .padding(5)
            }
            .overlay(alignment: .bottom) {
                let text = caption ?? mediaCaption
                if let text {
                    HStack(spacing: 3) {
                        if asset.mediaType == .video { Image(systemName: "video.fill") }
                        if asset.isLivePhoto { Image(systemName: "livephoto") }
                        Text(text)
                        Spacer(minLength: 0)
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 6).padding(.vertical, 4)
                    .background(LinearGradient(colors: [.clear, .black.opacity(0.6)], startPoint: .top, endPoint: .bottom))
                }
            }
            .contentShape(Rectangle())
            .onTapGesture(perform: toggle)
            .onLongPressGesture(perform: preview)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityText)
            .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction(named: "Preview", preview)
    }

    private var mediaCaption: String? {
        asset.mediaType == .video ? asset.duration.durationText : nil
    }

    private var accessibilityText: String {
        var parts = [asset.mediaType == .video ? "Video" : "Photo"]
        if let date = asset.creationDate { parts.append(date.formatted(date: .abbreviated, time: .shortened)) }
        if let badge { parts.append(badge) }
        if let caption { parts.append(caption) }
        return parts.joined(separator: ", ")
    }
}

/// An adaptive grid of selectable thumbnails.
struct AssetGrid: View {
    let assets: [PHAsset]
    @Binding var selection: Set<String>
    @Binding var preview: AssetRef?
    var caption: ((PHAsset) -> String?)? = nil
    var selectedIcon = "trash.circle.fill"
    var selectedColor = Color.red

    private let columns = [GridItem(.adaptive(minimum: 105), spacing: 2)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 2) {
            ForEach(assets, id: \.localIdentifier) { asset in
                SelectableThumbnail(
                    asset: asset,
                    isSelected: selection.contains(asset.localIdentifier),
                    caption: caption?(asset),
                    selectedIcon: selectedIcon,
                    selectedColor: selectedColor,
                    toggle: { selection.toggle(asset.localIdentifier) },
                    preview: { preview = AssetRef(asset: asset) }
                )
            }
        }
    }
}

/// The bar pinned to the bottom of a clean-up screen with its main buttons.
struct ActionBar<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        HStack(spacing: 12) { content }
            .padding(.horizontal)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
    }
}

struct DeleteButton: View {
    @Environment(PhotoLibrary.self) var library
    let assets: [PHAsset]
    var onDeleted: () -> Void = {}

    var body: some View {
        Button(role: .destructive) {
            Task {
                if await library.delete(assets) { onDeleted() }
            }
        } label: {
            VStack(spacing: 1) {
                Text(assets.isEmpty ? "Delete" : "Delete \(assets.count)")
                    .font(.headline)
                if !assets.isEmpty {
                    Text(library.bytes(of: assets).formattedBytes).font(.caption)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(.red)
        .controlSize(.large)
        .disabled(assets.isEmpty)
    }
}

/// Full-size preview with details. Plays videos and Live Photos' motion isn't needed here.
struct AssetDetailView: View {
    @Environment(PhotoLibrary.self) var library
    @Environment(\.dismiss) var dismiss
    let asset: PHAsset
    @State var player: AVPlayer?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Group {
                    if asset.mediaType == .video {
                        if let player {
                            VideoPlayer(player: player)
                        } else {
                            AssetThumbnail(asset: asset, targetSide: 900, contentMode: .fit)
                                .overlay { ProgressView() }
                        }
                    } else {
                        AssetThumbnail(asset: asset, targetSide: 1200, contentMode: .fit)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color.black)

                List {
                    if let date = asset.creationDate {
                        LabeledContent("Taken", value: date.formatted(date: .long, time: .shortened))
                    }
                    LabeledContent("Size", value: library.bytes(of: asset).formattedBytes)
                    LabeledContent("Dimensions", value: "\(asset.pixelWidth) × \(asset.pixelHeight)")
                    if asset.mediaType == .video {
                        LabeledContent("Length", value: asset.duration.durationText)
                    }
                    if asset.isLivePhoto {
                        LabeledContent("Live Photo video", value: library.liveVideoBytes(of: asset).formattedBytes)
                    }
                    if asset.isFavorite {
                        Label("Favourite", systemImage: "heart.fill").foregroundStyle(.pink)
                    }
                }
                .listStyle(.plain)
                .frame(height: 220)
            }
            .navigationTitle(asset.mediaType == .video ? "Video" : "Photo")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button(role: .destructive) {
                        Task { if await library.delete([asset]) { dismiss() } }
                    } label: {
                        Image(systemName: "trash")
                    }
                    .tint(.red)
                }
            }
            .task { await loadPlayer() }
            .onDisappear { player?.pause() }
        }
    }

    private func loadPlayer() async {
        guard asset.mediaType == .video else { return }
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = true
        options.deliveryMode = .automatic
        let item: AVPlayerItem? = await withCheckedContinuation { continuation in
            PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { item, _ in
                continuation.resume(returning: item)
            }
        }
        if let item { player = AVPlayer(playerItem: item) }
    }
}

extension Set {
    mutating func toggle(_ element: Element) {
        if contains(element) { remove(element) } else { insert(element) }
    }
}

extension TimeInterval {
    var durationText: String {
        let total = Int(rounded())
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }
}
