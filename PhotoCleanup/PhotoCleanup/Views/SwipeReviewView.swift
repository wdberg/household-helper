import Photos
import SwiftUI

/// Months with photos, newest first. Pick one to swipe through it.
struct MonthsView: View {
    @Environment(PhotoLibrary.self) var library

    private struct Month: Identifiable {
        let id: String
        let title: String
        let assets: [PHAsset]
    }

    private var months: [Month] {
        let calendar = Calendar.current
        let all = (library.photos + library.videos).sorted { ($0.creationDate ?? .distantPast) > ($1.creationDate ?? .distantPast) }
        var order: [String] = []
        var buckets: [String: [PHAsset]] = [:]
        var titles: [String: String] = [:]
        for asset in all {
            let date = asset.creationDate ?? .distantPast
            let parts = calendar.dateComponents([.year, .month], from: date)
            let key = "\(parts.year ?? 0)-\(parts.month ?? 0)"
            if buckets[key] == nil {
                order.append(key)
                titles[key] = date.formatted(.dateTime.month(.wide).year())
            }
            buckets[key, default: []].append(asset)
        }
        return order.map { Month(id: $0, title: titles[$0] ?? $0, assets: buckets[$0] ?? []) }
    }

    var body: some View {
        List(months) { month in
            NavigationLink {
                SwipeReviewView(title: month.title, assets: month.assets)
            } label: {
                HStack {
                    Text(month.title)
                    Spacer()
                    Text("\(month.assets.count)").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Swipe Review")
        .overlay {
            if months.isEmpty { ContentUnavailableView("No Photos", systemImage: "photo") }
        }
    }
}

/// One photo at a time. Swipe left to mark for deletion, right to keep.
struct SwipeReviewView: View {
    let title: String
    let assets: [PHAsset]

    @Environment(PhotoLibrary.self) var library
    @Environment(\.dismiss) var dismiss
    @State var index = 0
    @State var toDelete: [PHAsset] = []
    /// What each step decided, so Undo can step back.
    @State var history: [Bool] = []
    @State var offset: CGSize = .zero
    @State var preview: AssetRef?
    @State var animating = false

    private var current: PHAsset? { index < assets.count ? assets[index] : nil }

    var body: some View {
        VStack(spacing: 16) {
            if let current {
                Text("\(index + 1) of \(assets.count)")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)

                card(for: current)
                    .id(current.localIdentifier)

                HStack(spacing: 36) {
                    roundButton("xmark", color: .red, label: "Delete") { decide(delete: true) }
                    roundButton("arrow.uturn.backward", color: .gray, label: "Undo") { undo() }
                        .disabled(history.isEmpty)
                    roundButton("heart.fill", color: .green, label: "Keep") { decide(delete: false) }
                }
            } else {
                finished
            }
        }
        .padding()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if current != nil && !toDelete.isEmpty {
                ActionBar {
                    DeleteButton(assets: toDelete) { toDelete.removeAll(); history.removeAll() }
                }
            }
        }
        .sheet(item: $preview) { AssetDetailView(asset: $0.asset) }
    }

    private func card(for asset: PHAsset) -> some View {
        AssetThumbnail(asset: asset, targetSide: 900, contentMode: .fit)
            .background(Color.black)
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .overlay(alignment: .topLeading) {
                stamp("DELETE", color: .red).opacity(Double(-offset.width / 100)).padding(20)
            }
            .overlay(alignment: .topTrailing) {
                stamp("KEEP", color: .green).opacity(Double(offset.width / 100)).padding(20)
            }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 2) {
                    if let date = asset.creationDate {
                        Text(date.formatted(date: .abbreviated, time: .shortened))
                    }
                    Text(library.bytes(of: asset).formattedBytes + (asset.mediaType == .video ? " · \(asset.duration.durationText)" : ""))
                }
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .padding(8)
                .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                .padding(12)
            }
            .offset(x: offset.width, y: offset.height * 0.2)
            .rotationEffect(.degrees(Double(offset.width / 20)))
            .gesture(
                DragGesture()
                    .onChanged { offset = $0.translation }
                    .onEnded { value in
                        if value.translation.width < -110 { decide(delete: true) }
                        else if value.translation.width > 110 { decide(delete: false) }
                        else { withAnimation(.spring) { offset = .zero } }
                    }
            )
            .onTapGesture { preview = AssetRef(asset: asset) }
            .accessibilityLabel("Photo \(index + 1) of \(assets.count). Tap to preview.")
    }

    private var finished: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "checkmark.circle.fill").font(.system(size: 64)).foregroundStyle(.green)
            Text("All done with \(title)").font(.title2.bold())
            if toDelete.isEmpty {
                Text("Nothing marked for deletion.").foregroundStyle(.secondary)
                Button("Back to months") { dismiss() }.buttonStyle(.bordered)
            } else {
                Text("\(toDelete.count) marked for deletion, \(library.bytes(of: toDelete).formattedBytes).")
                    .foregroundStyle(.secondary)
                DeleteButton(assets: toDelete) { toDelete.removeAll(); dismiss() }
                Button("Start over") { index = 0; toDelete.removeAll(); history.removeAll() }
            }
            Spacer()
        }
    }

    private func decide(delete: Bool) {
        guard let current, !animating else { return }
        animating = true
        withAnimation(.easeIn(duration: 0.2)) {
            offset = CGSize(width: delete ? -600 : 600, height: 0)
        }
        if delete { toDelete.append(current) }
        history.append(delete)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            index += 1
            offset = .zero
            animating = false
        }
    }

    private func undo() {
        guard !animating, index > 0, let last = history.popLast() else { return }
        index -= 1
        if last { toDelete.removeLast() }
        offset = .zero
    }

    private func stamp(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.title.weight(.heavy))
            .foregroundStyle(color)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(color, lineWidth: 4))
            .rotationEffect(.degrees(text == "KEEP" ? 12 : -12))
    }

    private func roundButton(_ icon: String, color: Color, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.title2.weight(.bold))
                .foregroundStyle(color)
                .frame(width: 64, height: 64)
                .background(Circle().fill(Color(.secondarySystemBackground)))
        }
        .accessibilityLabel(label)
    }
}
