import Photos
import SwiftUI

struct HomeView: View {
    @Environment(PhotoLibrary.self) var library
    @State var showSettings = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SummaryCard()
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)

                if library.authorization == .limited {
                    Section {
                        Label("You've only shared some photos. Allow full access in Settings to scan everything.",
                              systemImage: "exclamationmark.triangle")
                            .font(.subheadline)
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                }

                Section("Clean up") {
                    NavigationLink { GroupsView(kind: .duplicates) } label: {
                        CategoryRow(title: "Duplicates", icon: "square.on.square.fill", color: .blue,
                                    detail: groupDetail(library.duplicates, bytes: library.duplicateBytes))
                    }
                    NavigationLink { GroupsView(kind: .similar) } label: {
                        CategoryRow(title: "Similar Photos", icon: "square.stack.3d.up.fill", color: .indigo,
                                    detail: groupDetail(library.similar, bytes: library.similarBytes))
                    }
                    NavigationLink { LivePhotosView() } label: {
                        CategoryRow(title: "Live Photos", icon: "livephoto", color: .orange,
                                    detail: detail(library.livePhotos.count, "Live Photo", bytes: library.liveVideoBytesTotal, verb: "of video"))
                    }
                    NavigationLink { ScreenshotsView() } label: {
                        CategoryRow(title: "Screenshots", icon: "camera.viewfinder", color: .teal,
                                    detail: detail(library.screenshots.count, "screenshot", bytes: library.bytes(of: library.screenshots)))
                    }
                    NavigationLink { BlurryView() } label: {
                        CategoryRow(title: "Blurry & Dark", icon: "camera.metering.unknown", color: .purple,
                                    detail: detail(library.blurry.count, "photo", bytes: library.bytes(of: library.blurry)))
                    }
                    NavigationLink { VideosView() } label: {
                        CategoryRow(title: "Large Videos", icon: "video.fill", color: .pink,
                                    detail: detail(library.largeVideos.count, "video", bytes: library.bytes(of: library.largeVideos)))
                    }
                }

                Section("Review") {
                    NavigationLink { MonthsView() } label: {
                        CategoryRow(title: "Swipe Review", icon: "hand.draw.fill", color: .green,
                                    detail: "Swipe through a month: left to delete, right to keep")
                    }
                }

                Section {
                    Text("Nothing is deleted without iOS asking you first. Deleted items stay in Recently Deleted in the Photos app for 30 days.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Photo Cleanup")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "slider.horizontal.3") }
                        .accessibilityLabel("Settings")
                }
            }
            .refreshable { await library.scan() }
            .sheet(isPresented: $showSettings) { SettingsView() }
            .task {
                if library.phase == .idle { await library.scan() }
            }
        }
    }

    private func groupDetail(_ groups: [AssetGroup], bytes: Int64) -> String? {
        guard library.phase == .finished else { return nil }
        if groups.isEmpty { return "None found" }
        let extras = groups.reduce(0) { $0 + $1.extras.count }
        return "\(groups.count) \(groups.count == 1 ? "set" : "sets") · \(extras) extra · \(bytes.formattedBytes)"
    }

    private func detail(_ count: Int, _ noun: String, bytes: Int64, verb: String = "") -> String? {
        guard library.phase == .finished else { return nil }
        if count == 0 { return "None found" }
        let suffix = verb.isEmpty ? "" : " \(verb)"
        return "\(count) \(noun)\(count == 1 ? "" : "s") · \(bytes.formattedBytes)\(suffix)"
    }
}

private struct SummaryCard: View {
    @Environment(PhotoLibrary.self) var library

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch library.phase {
            case .idle:
                Text("Getting ready…").font(.headline)
            case let .scanning(stage, progress):
                Text(stage).font(.headline)
                if let progress {
                    ProgressView(value: progress)
                    Text("\(Int(progress * 100))% · The first scan takes a few minutes. Later scans are quick.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    ProgressView().frame(maxWidth: .infinity, alignment: .leading)
                }
            case .finished:
                let reclaimable = library.duplicateBytes + library.liveVideoBytesTotal
                Text("You could free up").font(.subheadline).foregroundStyle(.secondary)
                Text(reclaimable.formattedBytes)
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .foregroundStyle(.tint)
                Text("by removing duplicates and converting Live Photos. Library: \(library.photos.count.formatted()) photos, \(library.videos.count.formatted()) videos, \(library.libraryBytes.formattedBytes).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button {
                    Task { await library.scan() }
                } label: {
                    Label("Scan again", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
    }
}

private struct CategoryRow: View {
    @Environment(PhotoLibrary.self) var library
    let title: String
    let icon: String
    let color: Color
    let detail: String?

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(color.gradient, in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.medium))
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Scanning…").font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
