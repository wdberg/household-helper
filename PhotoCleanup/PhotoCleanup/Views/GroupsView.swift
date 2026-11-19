import Photos
import SwiftUI

/// Duplicates and Similar Photos: sets of matching items with the best one marked "Best".
struct GroupsView: View {
    enum Kind { case duplicates, similar }

    let kind: Kind
    @Environment(PhotoLibrary.self) var library
    @State var selection: Set<String> = []
    @State var preview: AssetRef?
    @State var didPreselect = false

    private var groups: [AssetGroup] { kind == .duplicates ? library.duplicates : library.similar }
    private var selectedAssets: [PHAsset] { groups.flatMap(\.assets).filter { selection.contains($0.localIdentifier) } }

    var body: some View {
        List {
            Section {
                Text(intro).font(.subheadline).foregroundStyle(.secondary)
                Button("Select all extras (keep the best of each)") {
                    selection = Set(groups.flatMap { $0.extras.map(\.localIdentifier) })
                }
                if !selection.isEmpty {
                    Button("Deselect all") { selection.removeAll() }
                }
            }
            ForEach(groups) { group in
                Section {
                    GroupRow(group: group, selection: $selection, preview: $preview)
                } header: {
                    Text(header(for: group))
                }
            }
        }
        .overlay {
            if groups.isEmpty {
                ContentUnavailableView(kind == .duplicates ? "No Duplicates" : "No Similar Photos",
                                       systemImage: "checkmark.seal",
                                       description: Text(library.isScanning ? "Still scanning…" : "Nothing to clean up here."))
            }
        }
        .navigationTitle(kind == .duplicates ? "Duplicates" : "Similar Photos")
        .safeAreaInset(edge: .bottom) {
            if !groups.isEmpty {
                ActionBar {
                    DeleteButton(assets: selectedAssets) { selection.removeAll() }
                }
            }
        }
        .sheet(item: $preview) { AssetDetailView(asset: $0.asset) }
        .onAppear {
            // Exact duplicates are safe to pre-select. Similar photos are a judgement call, so they start unselected.
            guard kind == .duplicates, !didPreselect else { return }
            didPreselect = true
            selection = Set(groups.flatMap { $0.extras.map(\.localIdentifier) })
        }
    }

    private var intro: String {
        switch kind {
        case .duplicates:
            "Exact or near-exact copies, including resized and re-saved ones. The best copy of each set "
                + "(favourite, then highest resolution) is kept. Tap to change what gets deleted; hold to preview."
        case .similar:
            "Shots taken moments apart that look alike, such as bursts. The sharpest is marked Best. "
                + "Tap the ones you don't need; hold to preview."
        }
    }

    private func header(for group: AssetGroup) -> String {
        let date = group.best.creationDate?.formatted(date: .abbreviated, time: .shortened) ?? ""
        return "\(group.assets.count) items · \(date)"
    }
}

private struct GroupRow: View {
    @Environment(PhotoLibrary.self) var library
    let group: AssetGroup
    @Binding var selection: Set<String>
    @Binding var preview: AssetRef?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(group.assets, id: \.localIdentifier) { asset in
                        SelectableThumbnail(
                            asset: asset,
                            isSelected: selection.contains(asset.localIdentifier),
                            badge: asset == group.best ? "Best" : nil,
                            caption: library.bytes(of: asset).formattedBytes,
                            toggle: { selection.toggle(asset.localIdentifier) },
                            preview: { preview = AssetRef(asset: asset) }
                        )
                        .frame(width: 112, height: 112)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            HStack {
                Button("Keep best only") {
                    group.extras.forEach { selection.insert($0.localIdentifier) }
                    selection.remove(group.best.localIdentifier)
                }
                Spacer()
                Button("Keep all") {
                    group.assets.forEach { selection.remove($0.localIdentifier) }
                }
            }
            .font(.subheadline)
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }
}
